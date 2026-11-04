import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { safeFile, git } from './workspace.mjs';
import { simulatedToolCall } from './guard.mjs';
export { REVIEW_VERSION } from './guard.mjs';

// Review profiles get their evidence from the orchestrator; the model never needs to call tools.
export const reviewProfiles = ['reviewer', 'checker'];

export function reviewSchema(criteria = []) {
  // Bounded arrays and strings keep the JSON inside the output budget (an unbounded "checked" list overflowed on PR #34).
  const text = n => ({ type: 'string', maxLength: n });
  const finding = { type: 'object', required: ['file', 'line', 'quote', 'severity', 'issue'], properties: {
    file: text(120), line: { type: 'integer' }, quote: text(120),
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, issue: text(400) } };
  const schema = { type: 'object', required: ['verdict', 'summary', 'findings', 'checked'], properties: {
    verdict: { type: 'string', enum: ['issues', 'no_issues', 'cannot_determine'] },
    summary: text(600), findings: { type: 'array', maxItems: 6, items: finding },
    checked: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', required: ['file', 'line', 'quote', 'observation'], properties: {
      file: text(120), line: { type: 'integer' }, quote: text(120), observation: text(300) } } } } };
  if (criteria.length) {
    schema.required.push('criteria');
    schema.properties.criteria = { type: 'array', minItems: criteria.length, maxItems: criteria.length, items: { type: 'object', required: ['criterion', 'answer', 'met', 'file', 'line', 'quote', 'evidence'], properties: {
      criterion: text(300), answer: text(300), met: { type: 'string', enum: ['yes', 'no', 'unknown'] },
      file: text(120), line: { type: 'integer' }, quote: text(160), evidence: text(400) } } };
  }
  return schema;
}

const numbered = (lines, from = 1) => lines.map((l, i) => `${String(from + i).padStart(5)}| ${l}`).join('\n');
// Diff hunks are rewritten with new-file line numbers so findings can be checked against the worktree.
function numberedDiff(diff) {
  const out = []; let line = 0;
  for (const raw of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (h) { line = Number(h[1]); out.push(raw); continue; }
    if (/^(diff |index |--- |\+\+\+ )/.test(raw)) { if (raw.startsWith('+++ ')) out.push(raw); continue; }
    if (raw.startsWith('-')) out.push(`     | ${raw}`);
    else if (raw.startsWith('+') || raw.startsWith(' ')) out.push(`${String(line++).padStart(5)}| ${raw}`);
  }
  return out.join('\n');
}

export function buildEvidence(root, spec, budgetBytes) {
  const parts = [], coverage = [];
  let used = 0;
  const add = (label, text, file) => {
    const room = budgetBytes - used;
    if (room < 400) { coverage.push({ file, included: false, reason: 'context budget' }); return; }
    const body = text.length > room ? text.slice(0, room) + '\n[...TRUNCATED: context budget reached...]' : text;
    parts.push(`### ${label}\n${body}`); used += body.length + label.length + 8;
    coverage.push({ file, included: true, truncated: text.length > room, bytes: body.length });
  };
  for (const t of spec.testResults ?? []) add(`TEST ${t.path} (exit ${t.exit})`, t.output, t.path);
  for (const p of spec.files) {
    const file = safeFile(root, p, spec.files);
    if (!fs.existsSync(file)) { add(`FILE ${p}`, '(file does not exist at this commit)', p); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const diff = spec.diffBase ? git(root, ['diff', '-U6', spec.diffBase, 'HEAD', '--', p]) : '';
    if (diff) add(`DIFF ${p} (base ${spec.diffBase.slice(0, 7)}; left column = line number in current file)`, numberedDiff(diff), p);
    else if (Buffer.byteLength(text) <= budgetBytes - used) add(`FILE ${p}`, numbered(text.split('\n')), p);
    else {
      const lines = text.split('\n');
      add(`FILE ${p} (first lines only; file has ${lines.length} lines)`, numbered(lines.slice(0, 200)), p);
    }
  }
  return { text: parts.join('\n\n'), coverage };
}

const norm = s => String(s).replace(/\s+/g, ' ').trim();
const squash = s => String(s).replace(/\s+/g, '');
// A cited point counts only if its quote really exists in the file. Whitespace and line breaks are ignored;
// a quote found uniquely at another line is accepted and the line is corrected (small models miscount lines).
function grounded(root, spec, item) {
  if (!spec.files.includes(item.file)) return `file ${item.file} not in allowlist`;
  const lines = fs.readFileSync(safeFile(root, item.file, spec.files), 'utf8').split('\n');
  const quote = squash(item.quote);
  if (quote.length < 6) return `${item.file}:${item.line} quote too short`;
  // A quote starts at line i when it is inside lines i..i+3 but not inside i+1..i+4.
  const at = i => squash(lines.slice(i, i + 4).join('')).includes(quote);
  const starts = lines.map((_, i) => i).filter(i => at(i) && !at(i + 1)).map(i => i + 1);
  const near = starts.filter(s => Math.abs(s - item.line) <= 3);
  const pick = near.length === 1 ? near[0] : (!near.length && starts.length === 1 ? starts[0] : null);
  if (pick === null) return `${item.file}:${item.line} quote ${starts.length ? 'ambiguous' : 'not found'} in file`;
  if (pick !== item.line) { item.cited_line = item.line; item.line = pick; }
  return null;
}

export function assessReview(root, spec, content) {
  const reasons = [];
  const fake = simulatedToolCall(content);
  if (fake) return { ok: false, reasons: [`reply only simulated a tool call as text (${fake.excerpt.slice(0, 120)})`] };
  let r;
  try { r = JSON.parse(content); } catch { return { ok: false, reasons: ['reply is not the required JSON object'] }; }
  if (!['issues', 'no_issues', 'cannot_determine'].includes(r.verdict)) reasons.push('missing verdict');
  if (norm(r.summary).length < 40) reasons.push('summary under 40 characters');
  const findings = Array.isArray(r.findings) ? r.findings : [], checked = Array.isArray(r.checked) ? r.checked : [];
  if (r.verdict === 'issues' && !findings.length) reasons.push('verdict "issues" without findings');
  if (r.verdict === 'no_issues' && findings.some(f => f.severity !== 'minor')) reasons.push('verdict "no_issues" contradicts blocker/major findings');
  if (checked.length < 2) reasons.push('fewer than 2 checked code points');
  for (const f of findings) { const bad = grounded(root, spec, f); if (bad) reasons.push(`finding ${bad}`); if (norm(f.issue).length < 20) reasons.push('finding without explanation'); }
  for (const c of checked) { const bad = grounded(root, spec, c); if (bad) reasons.push(`checked ${bad}`); }
  if (spec.criteria?.length) {
    const answered = Array.isArray(r.criteria) ? r.criteria : [];
    if (answered.length !== spec.criteria.length) reasons.push(`answered ${answered.length}/${spec.criteria.length} acceptance criteria`);
    for (const a of answered) {
      if (norm(a.evidence).length < 15) reasons.push('criterion without evidence');
      const bad = grounded(root, spec, a); if (bad) reasons.push(`criterion evidence ${bad}`);
    }
  }
  for (const t of spec.testResults ?? []) if (t.exit !== 0 && r.verdict === 'no_issues') reasons.push(`verdict "no_issues" although ${t.path} failed`);
  return { ok: !reasons.length, reasons: [...new Set(reasons)].slice(0, 8), review: r };
}

// Tests are run by the orchestrator, never by the model. Only allowlisted test files are accepted.
export function runTests(c, root, spec) {
  const results = [];
  for (const p of spec.tests ?? []) {
    safeFile(root, p, spec.files);
    if (!c.python) { results.push({ path: p, exit: -1, output: 'Python interpreter not configured (AGENT_PYTHON)' }); continue; }
    const i = p.lastIndexOf('tests/'), cwd = i > 0 ? path.join(root, p.slice(0, i)) : root, arg = i > 0 ? p.slice(i) : p;
    try {
      const out = execFileSync(c.python, ['-m', 'pytest', arg, '-q', '-p', 'no:cacheprovider'], { cwd, timeout: 180000, windowsHide: true, encoding: 'utf8', maxBuffer: 2_000_000, env: { ...process.env, QT_QPA_PLATFORM: 'offscreen', PYTHONDONTWRITEBYTECODE: '1' } });
      results.push({ path: p, exit: 0, output: out.trim().slice(-1500) });
    } catch (e) {
      results.push({ path: p, exit: typeof e.status === 'number' ? e.status : -1, output: String((e.stdout ?? '') + (e.stderr ?? '') || e.message).trim().slice(-1500) });
    }
  }
  return results;
}

export function reviewMarkdown(spec, review, tests, coverage) {
  const lines = [`**Veredicto:** ${review.verdict}`, '', review.summary, ''];
  if (tests.length) { lines.push('**Pruebas ejecutadas por el orquestador:**'); for (const t of tests) lines.push(`- \`${t.path}\` → exit ${t.exit}: ${t.output.split('\n').at(-1)}`); lines.push(''); }
  lines.push('**Hallazgos (verificados contra el archivo):**');
  if (!review.findings.length) lines.push('- Ninguno.');
  for (const f of review.findings) lines.push(`- [${f.severity}] \`${f.file}:${f.line}\` — ${f.issue}`);
  lines.push('', '**Puntos comprobados:**');
  for (const c of review.checked) lines.push(`- \`${c.file}:${c.line}\` — ${c.observation}`);
  if (review.criteria?.length) { lines.push('', '**Criterios de aceptación:**'); for (const a of review.criteria) lines.push(`- ${a.criterion} → **${a.answer}** (${a.met}) — \`${a.file}:${a.line}\` ${a.evidence}`); }
  const moved = [...review.findings, ...review.checked, ...(review.criteria ?? [])].filter(x => x.cited_line);
  if (moved.length) lines.push('', `_Líneas corregidas por el verificador (cita encontrada en otra línea): ${moved.map(x => `${x.cited_line}→${x.line}`).join(', ')}._`);
  lines.push('', `**Cobertura del contexto:** ${coverage.map(c => `${c.file}${c.included ? (c.truncated ? ' (truncado)' : '') : ' (no incluido)'}`).join(', ')}`);
  return lines.join('\n');
}
