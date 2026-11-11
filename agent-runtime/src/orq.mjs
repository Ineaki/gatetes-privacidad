// Encargos de Fox para Claude Code y Codex CLI, ejecutados a través de orq (Ineaki/orquestacion-ia).
// Ollama sigue en worker.mjs; aquí solo entran implementer+claude y reviewer+codex.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { runTests } from './review.mjs';
import { scrub, containsSecret } from './guard.mjs';
import { checkRepo, repoClones } from './repos.mjs';

export const ORQ_ENGINES = ['claude', 'codex'];
const PROTECTED = new Set(['main', 'master']);
const git = (repo, args, timeout = 60000) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4_000_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Decide quién ejecuta un encargo remoto. Devuelve 'ollama', 'claude' o 'codex', o lanza el motivo de rechazo.
export function routeEngine(profile, engine) {
  if (engine === 'llamacpp') return 'llamacpp';
  if (profile === 'checker' || engine === 'ollama') return 'ollama';
  if (engine === undefined || engine === null) {
    if (profile === 'reviewer') return 'ollama';
    if (profile === 'implementer') return 'claude';
  }
  if (profile === 'implementer' && engine === 'claude') return 'claude';
  if (profile === 'reviewer' && engine === 'codex') return 'codex';
  if (profile === 'implementer') throw Error(`profile "implementer" runs on engine "claude" (got "${engine}")`);
  if (profile === 'reviewer') throw Error(`profile "reviewer" runs on engine "codex" or "ollama" (got "${engine}")`);
  throw Error(`profile "${profile}" not accepted; use implementer, reviewer or checker`);
}

// Ajustes de orq. Rutas por variables de entorno para no tocar settings.json del vault.
export function orqSettings(c) {
  const repos = repoClones(c);
  return {
    script: process.env.AGENT_ORQ_SCRIPT ?? path.join(process.env.USERPROFILE ?? '', 'orquestacion-ia', 'scripts', 'orq.ps1'),
    pwsh: process.env.AGENT_PWSH ?? 'pwsh',
    repos,
    maxSeconds: Number(process.env.AGENT_ORQ_MAX_SECONDS ?? 2700),
    // Primero lo más barato que suele bastar; un solo escalón si falla.
    ladder: {
      // objetivo.md: Haiku por defecto, Sonnet si no basta; Opus nunca en automático.
      claude: [{ model: 'haiku' }, { model: 'sonnet' }],
      codex: [{ effort: 'low' }, { effort: 'medium' }],
    },
    maxOpenPrs: 2,
    engines: engineAvailability(c),
  };
}

// Motores activables por configuración: AGENT_ORQ_ENGINES="claude,codex" y <vault>/orq-engines.json
// {"codex":{"enabled":false,"until":"2026-11-05T04:20:00+01:00","reason":"sin cuota"}}. Sin relevo a otro motor de pago.
export function engineAvailability(c, now = Date.now()) {
  const listed = (process.env.AGENT_ORQ_ENGINES ?? 'claude,codex').split(',').map(x => x.trim()).filter(Boolean);
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(c.vault, 'orq-engines.json'), 'utf8')); } catch { /* sin archivo: todo según la variable */ }
  const out = {};
  for (const e of ORQ_ENGINES) {
    const f = file[e] ?? {};
    const until = f.until ? Date.parse(f.until) : NaN;
    const paused = Number.isFinite(until) && until > now;
    const enabled = listed.includes(e) && f.enabled !== false && !paused;
    out[e] = { enabled, until: paused ? new Date(until).toISOString() : null, reason: enabled ? null : (paused ? `${f.reason ?? 'en pausa'} hasta ${f.until}` : (f.reason ?? 'desactivado por configuración')) };
  }
  return out;
}

const cleanFile = p => {
  if (typeof p !== 'string' || !p || p.length > 240 || p.includes('\\') || p.includes(':') || path.isAbsolute(p) ||
      p.split('/').some((x, i, all) => x === '..' || x === '.' || (!x && i !== all.length - 1)) ||
      /(^|\/)(\.git|\.env[^/]*|\.orq|credentials[^/]*|[^/]*\.(?:pem|key|token|sqlite[^/]*))($|\/)/i.test(p)) throw Error(`Forbidden file path: ${String(p).slice(0, 80)}`);
  return p;
};

// Valida un encargo de Fox para claude/codex y lo deja fijado al commit exacto de la rama o PR.
export function parseOrqInstruction(value, c, engine, resolveFor) {
  const t = value.task, o = orqSettings(c);
  const repo = checkRepo(c, t.repo === undefined || t.repo === null || t.repo === '' ? c.repoName : t.repo);
  if (!o.repos[repo]) throw Error(`repo "${repo}" has no local clone for orq (known: ${Object.keys(o.repos).join(', ')})`);
  if (typeof t.goal !== 'string' || t.goal.trim().length < 20 || t.goal.length > 4000) throw Error('goal must be 20-4000 characters');
  if (!Array.isArray(t.files) || t.files.length < 1 || t.files.length > 10) throw Error('files must list 1-10 explicit paths');
  if (!Array.isArray(t.acceptance) || t.acceptance.length < 1 || t.acceptance.length > 8) throw Error('acceptance must list 1-8 criteria');
  if (t.acceptance.some(a => typeof a !== 'string' || a.length > 400)) throw Error('acceptance items must be strings of at most 400 characters');
  if (t.pr !== undefined && (!Number.isInteger(t.pr) || t.pr < 1)) throw Error('pr must be a positive integer');
  if (t.branch !== undefined && (typeof t.branch !== 'string' || !/^[\w./-]{1,120}$/.test(t.branch) || t.branch.includes('..'))) throw Error('invalid branch name');
  const files = [...new Set(t.files.map(cleanFile))].sort();
  const tests = [];
  for (const a of t.acceptance) { const m = /^\s*(?:python -m\s+)?pytest\s+(\S+\.py)\b/.exec(a); if (m && files.includes(m[1]) && /(^|\/)tests\/test_[\w-]+\.py$/.test(m[1])) tests.push(m[1]); }
  const { baseCommit, diffBase } = resolveFor(o.repos[repo])({ pr: t.pr, branch: t.branch });
  const spec = { goal: t.goal.trim(), profile: engine === 'claude' ? 'implementer' : 'reviewer', engine, repo, key: value.key,
    files, criteria: t.acceptance.map(a => a.trim()), baseCommit, origin: String(t.origin ?? 'grokbot-remoto').slice(0, 40) };
  if (diffBase) spec.diffBase = diffBase;
  if (t.branch) spec.branch = t.branch;
  if (t.pr) spec.pr = t.pr;
  if (tests.length) spec.tests = [...new Set(tests)].slice(0, 3);
  return spec;
}

function runProcess(file, args, { cwd, signal, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    let out = '', err = '', done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(r); } };
    const kill = () => { try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch { child.kill(); } };
    const onAbort = () => { kill(); finish({ code: null, out, err: err + '\naborted', aborted: true }); };
    const timer = setTimeout(() => { kill(); finish({ code: null, out, err: err + '\ntimeout', timedOut: true }); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', d => { out = (out + d).slice(-400_000); });
    child.stderr.on('data', d => { err = (err + d).slice(-100_000); });
    child.on('error', e => finish({ code: null, out, err: String(e.message) }));
    child.on('close', code => finish({ code, out, err }));
  });
}

// Las CLI usan su propia sesión guardada; las variables de una sesión anfitriona de Claude Code las romperían.
function childEnv() {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|ANTHROPIC_BASE_URL$)/.test(k)) delete env[k];
  return env;
}

const lastJson = text => { const i = text.indexOf('{'); if (i < 0) return null; try { return JSON.parse(text.slice(i)); } catch { return null; } };

function openPrCount(repo) {
  try { return JSON.parse(execFileSync('gh', ['pr', 'list', '-R', repo, '--state', 'open', '--json', 'number'], { encoding: 'utf8', timeout: 30000, windowsHide: true })).length; }
  catch { return Infinity; } // Sin saber cuántas hay, no se abre ninguna.
}

function prepareWorktree(c, task, repoPath) {
  // Nombre corto: los snapshots de orq anidan rutas largas y Windows corta en 260 caracteres.
  const root = path.join(c.vault, 'worktrees', `orq-${task.id.slice(0, 8)}`);
  const branch = `orq/${task.spec.key}`.slice(0, 100);
  if (!fs.existsSync(root)) git(repoPath, ['worktree', 'add', '-q', '-B', branch, root, task.spec.baseCommit]);
  if (git(root, ['rev-parse', '--show-toplevel']).replaceAll('\\', '/').toLowerCase() !== root.replaceAll('\\', '/').toLowerCase()) throw Error('Wrong worktree');
  // El estado de orq vive en .orq/ y nunca se versiona.
  const exclude = path.join(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])), 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!/^\.orq\/$/m.test(current)) fs.appendFileSync(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}.orq/\n`);
  return { root, branch };
}

function writeOrqConfig(root, spec, step) {
  const config = {
    schemaVersion: '1.0.0', mode: spec.engine === 'codex' ? 'codex_first' : 'adaptive', baseBranch: 'origin/main',
    protectedBranches: ['main', 'master'],
    allowedModels: { claude: step.model ? [step.model] : [], codex: [], cursor: [] },
    // Encargo para Claude: implementa Claude o se bloquea; sin reserva en Cursor ni Codex.
    implementers: ['claude'],
    providers: { claude: { permissionMode: 'acceptEdits', outputFormat: 'json' }, codex: { implementSandbox: null, reasoningEffort: step.effort ?? null }, cursor: { implementExtraFlags: [] } },
    timeouts: { implementSeconds: 1200, reviewSeconds: 900, preflightSeconds: 30, checkSeconds: 120 },
    scope: { include: spec.files.map(f => f.endsWith('/') ? `${f}**` : f), exclude: [] },
  };
  fs.mkdirSync(path.join(root, '.orq'), { recursive: true });
  fs.writeFileSync(path.join(root, '.orq', 'config.json'), JSON.stringify(config, null, 2));
}

function description(spec) {
  return [spec.goal, '', `Archivos permitidos (lee y toca solo estos): ${spec.files.join(', ')}`,
    'Criterios de aceptación:', ...spec.criteria.map(a => `- ${a}`), '',
    'Reglas: contexto mínimo, un solo intento, sin commit, push, merge ni deploy, nada de secretos. ' +
    (spec.profile === 'reviewer' ? 'Revisión única, sin cambiar código.' : 'Deja los cambios sin commitear en este worktree.')].join('\n');
}

function failureClasses(root, id) {
  try {
    return fs.readFileSync(path.join(root, '.orq', 'tickets', id, 'attempts.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
      .map(l => JSON.parse(l).attempt).filter(a => a && !a.ok).map(a => `${a.provider}: ${a.failureClass}`);
  } catch { return []; }
}
const AUTH_HELP = { claude: 'la CLI claude de este PC no tiene sesión: abre una terminal, ejecuta `claude` y haz /login', codex: 'la CLI codex no tiene sesión: ejecuta `codex login`', cursor: 'Cursor CLI sin sesión: ejecuta `cursor-agent login`' };

function readTicket(root, id) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.orq', 'tickets', id, 'ticket.json'), 'utf8')); } catch { return null; }
}

// Ejecuta un encargo claude/codex de principio a fin. ctx viene de runOne (lease, eventos y límites).
export async function runOrqTask(store, c, task, ctx) {
  const o = orqSettings(c), spec = task.spec, started = Date.now();
  const avail = o.engines[spec.engine];
  if (!avail?.enabled) {
    // La cola no se para: el encargo queda bloqueado con el motivo y Fox decide (sin relevo silencioso).
    const result = { engine: spec.engine, attempts: [], branch: null, elapsed_ms: 0, metrics: [], reason: 'engine_unavailable',
      error: `Motor ${spec.engine} no disponible: ${avail?.reason ?? 'desconocido'}. No se pasa a otro motor de pago sin orden de Fox.`,
      headline: `${engineName(spec.engine)} no disponible; ${spec.key} queda bloqueado` };
    store.event(task.id, 'engine_unavailable', { engine: spec.engine, reason: avail?.reason });
    result.report_md = reportMd(spec, result, null);
    return { state: 'blocked', result };
  }
  if (!fs.existsSync(o.script)) throw Error(`orq not found at ${o.script} (set AGENT_ORQ_SCRIPT)`);
  const repoPath = o.repos[spec.repo];
  if (!repoPath) throw Error(`repo ${spec.repo} has no local clone`);
  ctx.guard();
  const { root, branch } = prepareWorktree(c, task, repoPath);
  ctx.setRoot(root);
  store.event(task.id, 'orq_started', { engine: spec.engine, profile: spec.profile, repo: spec.repo, branch, commit: spec.baseCommit });
  const orq = async (args, timeoutMs) => {
    ctx.guard();
    const r = await runProcess(o.pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', o.script, ...args, '--repo', root, '--json'], { cwd: root, signal: ctx.signal, timeoutMs });
    return { ...r, json: lastJson(r.out) };
  };
  const ladder = o.ladder[spec.engine], attempts = [];
  let final = null;
  for (let i = 0; i < Math.min(2, ladder.length); i++) {
    const step = ladder[i], ticketId = `orq-${task.id.slice(0, 8)}-a${i + 1}`;
    writeOrqConfig(root, spec, step);
    const startArgs = ['ticket', 'start', '--title', spec.key, '--description', description(spec), '--risk', 'medium', '--id', ticketId];
    if (spec.profile === 'reviewer') startArgs.push('--review-only');
    const t0 = Date.now();
    const start = await orq(startArgs, 120000);
    let run = start;
    if (start.json && [0].includes(start.json.exitCode ?? start.code)) {
      run = await orq([spec.profile === 'reviewer' ? 'review' : 'implement', '--ticket', ticketId], (spec.profile === 'reviewer' ? 900 : 1200) * 1000 + 60000);
    }
    const ticket = readTicket(root, ticketId);
    const phases = ticket?.metrics?.phases ?? [];
    for (const d of phases.filter(p => ['implement', 'review'].includes(p.phase))) {
      const provider = d.provider ?? (Array.isArray(d.providers) ? d.providers.join('+') : spec.engine);
      store.metric(task.id, { run_id: ticketId, model: `${provider}:${d.model ?? step.model ?? (step.effort ? `effort-${step.effort}` : 'default')}`,
        input_tokens: d.tokens ?? null, output_tokens: d.outputTokens ?? null, duration_ms: d.durationMs ?? Date.now() - t0, cloud: true, cost_usd: d.cost ?? null });
    }
    if (!phases.length) store.metric(task.id, { run_id: ticketId, model: `${spec.engine}:${step.model ?? step.effort ?? 'default'}`, input_tokens: null, output_tokens: null, duration_ms: Date.now() - t0, cloud: true, error: 'sin métricas de orq' });
    const state = run.json?.state ?? ticket?.state ?? 'UNKNOWN';
    const ok = spec.profile === 'reviewer' ? state === 'READY_FOR_HUMAN' : state === 'CHECKPOINTED';
    const failures = failureClasses(root, ticketId);
    const raw = String(run.json?.message ?? run.err ?? '');
    // La salida de pwsh llega en la página de códigos de la consola; si los acentos se rompen, se usa el estado del ticket.
    const text = raw.includes('�') ? `${state}${ticket?.blockedReason ? ` (${ticket.blockedReason})` : ''}` : raw;
    const help = [...new Set(failures.filter(f => f.endsWith(': auth')).map(f => AUTH_HELP[f.split(':')[0]]).filter(Boolean))];
    const message = [text, failures.length ? `fallos: ${failures.join(', ')}` : '', ...help].filter(Boolean).join(' · ');
    const attempt = { ticket: ticketId, step, state, exit: run.json?.exitCode ?? run.code, message: scrub(message.slice(0, 600)), failures, reportPath: run.json?.reportPath ?? null, implementer: ticket?.implementer ?? null };
    attempts.push(attempt);
    store.event(task.id, 'orq_finished', { engine: spec.engine, ticket: ticketId, step: i + 1, ...step, state, exit: attempt.exit, message: attempt.message.slice(0, 200) });
    ctx.checkpoint({ orq: attempts });
    if (ok) { final = { ...attempt, ticketData: ticket }; break; }
    if (run.aborted) break;
    // Riesgo crítico, bloqueo de preflight o falta de sesión: subir de modelo no lo arregla.
    if (/critical|Preflight bloqueante/i.test(attempt.message)) break;
    if (failures.length && failures.every(f => /: (auth|quota_exhausted|cli_not_found)$/.test(f))) { attempt.noEscalation = 'subir de modelo no arregla un fallo de sesión, cuota o CLI'; break; }
  }
  const result = { engine: spec.engine, attempts, workspace: root, branch, elapsed_ms: Date.now() - started, metrics: store.metrics(task.id) };
  if (!final) {
    const last = attempts.at(-1);
    result.error = `orq ${spec.profile === 'reviewer' ? 'review' : 'implement'} no terminó (${last?.state}): ${last?.message ?? ''}`.slice(0, 600);
    result.reason = 'orq_failed';
    result.headline = spec.profile === 'reviewer' ? `${engineName(spec.engine)} no pudo revisar ${spec.key}` : `${engineName(spec.engine)} no pudo implementar ${spec.key}`;
    result.report_md = reportMd(spec, result, null);
    return { state: 'blocked', result };
  }
  if (spec.profile === 'reviewer') {
    const summary = readReviewSummary(root, final.ticket);
    result.review = summary;
    result.summary = summary.text?.slice(0, 2000);
    result.summary_source = 'orq_consolidated_review';
    const reviewers = (final.ticketData?.metrics?.phases ?? []).find(p => p.phase === 'review')?.providers ?? [spec.engine];
    result.reviewers = reviewers;
    result.headline = `${engineName(reviewers[0] ?? spec.engine)} revisó ${spec.pr ? `la PR #${spec.pr}` : spec.key}: ${summary.counts}`;
    result.report_md = reportMd(spec, result, final);
    return { state: 'completed', result };
  }
  // Implementer: pruebas pedidas, commit en la rama propia y push solo de orq/<key>.
  const changed = [...new Set([...git(root, ['diff', '--name-only', 'HEAD']).split('\n'), ...git(root, ['ls-files', '--others', '--exclude-standard']).split('\n')])]
    .map(l => l.trim()).filter(l => l && !l.startsWith('.orq/'));
  result.changed = changed.slice(0, 50);
  if (spec.tests?.length) result.tests = runTests(c, root, { ...spec, files: [...spec.files, ...spec.tests] });
  const failed = (result.tests ?? []).filter(t => t.exit !== 0);
  if (!changed.length) {
    result.error = 'El implementador terminó sin cambiar ningún archivo'; result.reason = 'no_changes';
    result.headline = `${engineName(spec.engine)} terminó ${spec.key} sin cambios`;
    result.report_md = reportMd(spec, result, final);
    return { state: 'blocked', result };
  }
  const outside = result.changed.filter(f => !spec.files.some(a => a.endsWith('/') ? f.startsWith(a) : f === a));
  if (outside.length) result.warnings = [`Cambió archivos fuera de "files": ${outside.join(', ')}`];
  if (containsSecret(git(root, ['diff']))) {
    result.error = 'El diff contiene algo con forma de secreto; no se sube'; result.reason = 'secret_in_diff';
    result.headline = `Cambios de ${spec.key} retenidos por posible secreto`;
    result.report_md = reportMd(spec, result, final);
    return { state: 'blocked', result };
  }
  git(root, ['add', '-A']); // .orq/ está en info/exclude
  git(root, ['-c', 'user.name=Claude (orq)', '-c', 'user.email=noreply@anthropic.com', 'commit', '-q', '-m', `${spec.key}: ${spec.goal.slice(0, 60)}\n\nEncargo de Fox ejecutado por orq implement (${final.step.model ?? 'claude'}).\n\nCo-Authored-By: Claude <noreply@anthropic.com>`]);
  result.commit = git(root, ['rev-parse', 'HEAD']);
  if (PROTECTED.has(branch)) throw Error('Refusing to push a protected branch');
  if (process.env.AGENT_ORQ_NO_PUSH === '1') result.pushed = false;
  else {
    git(root, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], 120000);
    result.pushed = true;
    if (!spec.pr) {
      const open = openPrCount(spec.repo);
      if (open < o.maxOpenPrs) {
        try {
          result.pr = execFileSync('gh', ['pr', 'create', '-R', spec.repo, '--draft', '--head', branch, '--base', spec.branch && !PROTECTED.has(spec.branch) ? spec.branch : 'main',
            '--title', `${spec.key}: ${spec.goal.slice(0, 60)}`, '--body', `Encargo \`${spec.key}\` de Fox, implementado por orq (Claude).\n\nNo fusionar sin la revisión única de Codex y CI en verde.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`],
          { encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
        } catch (e) { result.warnings = [...(result.warnings ?? []), `No se pudo abrir la PR: ${String(e.message).slice(0, 160)}`]; }
      } else result.warnings = [...(result.warnings ?? []), `No se abre PR: ya hay ${open === Infinity ? 'un número desconocido de' : open} PR abiertas en ${spec.repo} (máximo ${o.maxOpenPrs})`];
    }
  }
  result.acceptance = failed.length ? 'tests_failed' : (spec.tests?.length ? 'tests_passed' : 'human_review_required');
  result.headline = failed.length ? `Claude implementó ${spec.key}, pero fallan pruebas` : `Claude implementó ${spec.key} en ${branch}`;
  result.report_md = reportMd(spec, result, final);
  return { state: failed.length ? 'blocked' : 'completed', result };
}

const engineName = e => ({ claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }[e] ?? e);

function readReviewSummary(root, ticketId) {
  const dir = path.join(root, '.orq', 'tickets', ticketId);
  const summaryFile = path.join(dir, 'summary.md');
  let findings = [], quality = null;
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'reviews', 'consolidation.json'), 'utf8')); findings = j.findings ?? []; quality = j.reviewQuality ?? null; } catch { /* sin consolidación */ }
  const by = s => findings.filter(x => x.severity === s).length;
  const counts = findings.length ? `${findings.length} hallazgos (P0 ${by('P0')}, P1 ${by('P1')})` : 'sin hallazgos';
  return { counts, quality, findings: findings.slice(0, 20).map(f => ({ severity: f.severity, file: f.file, line: f.line, finding: String(f.finding ?? '').slice(0, 300) })),
    text: fs.existsSync(summaryFile) ? scrub(fs.readFileSync(summaryFile, 'utf8')).slice(0, 6000) : null };
}

function reportMd(spec, r, final) {
  // Regla de los informes: titular de 10 palabras o menos.
  const words = String(r.headline).split(/\s+/).filter(Boolean);
  r.headline = words.slice(0, 10).join(' ');
  const lines = [r.headline, '', `- Encargo: \`${spec.key}\` · ${spec.profile} · motor ${spec.engine} vía orq`, `- Repo: ${spec.repo} · commit base ${spec.baseCommit.slice(0, 7)}${spec.pr ? ` · PR #${spec.pr}` : ''}`,
    `- Rama de trabajo: \`${r.branch}\`${r.commit ? ` · commit ${r.commit.slice(0, 7)}` : ''}${r.pushed ? ' (subida)' : ''}${r.pr ? ` · PR ${r.pr}` : ''}`, ''];
  lines.push('## Intentos', '', '| # | Ticket orq | Modelo/esfuerzo | Estado | Mensaje |', '| --- | --- | --- | --- | --- |');
  r.attempts.forEach((a, i) => lines.push(`| ${i + 1} | ${a.ticket} | ${a.step.model ?? a.step.effort} | ${a.state} | ${a.message.replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 160)} |`));
  if (r.attempts.length > 1) lines.push('', 'Se subió de nivel una vez porque el primer intento no terminó.');
  lines.push('', '## Métricas', '', '| Modelo | Tokens entrada | Tokens salida | Duración |', '| --- | --- | --- | --- |');
  for (const m of r.metrics) lines.push(`| ${m.model} | ${m.input_tokens ?? 'n/d'} | ${m.output_tokens ?? 'n/d'} | ${Math.round((m.duration_ms ?? 0) / 1000)} s |`);
  if (r.changed?.length) lines.push('', '## Archivos tocados', '', ...r.changed.map(f => `- \`${f}\``));
  if (r.tests?.length) { lines.push('', '## Pruebas (salida real)', ''); for (const t of r.tests) lines.push(`- \`${t.path}\` → exit ${t.exit}`, '', '```', t.output.split('\n').slice(-6).join('\n'), '```'); }
  if (r.review) { lines.push('', '## Revisión', '', `Revisores: ${(r.reviewers ?? []).join(', ')} · calidad ${r.review.quality ?? 'n/d'} · ${r.review.counts}.`); for (const f of r.review.findings) lines.push(`- ${f.severity} \`${f.file}:${f.line}\` ${f.finding}`); }
  if (r.warnings?.length) lines.push('', '## Avisos', '', ...r.warnings.map(w => `- ${w}`));
  if (r.error) lines.push('', '## Motivo del bloqueo', '', r.error);
  lines.push('', 'Nadie ha fusionado ni aprobado nada; la aprobación es de una persona.');
  return lines.join('\n');
}
