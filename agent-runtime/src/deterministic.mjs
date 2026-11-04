// Encargos checker deterministas: el PC ejecuta pytest y el resultado es su salida real, sin modelo ni citas.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { safeFile } from './workspace.mjs';

const TEST_FILE = /(^|\/)tests\/test_[\w-]+\.py$/;
const TEST_DIR = /(^|\/)tests\/?$/;
// Criterios que solo piden ejecutar pruebas. Si piden explicar, revisar o citar, ya no es determinista.
const ONLY_RUN = /pytest|prueba|tests?\b|salida real|pasa[n]?\b|ejecuta/i;
const NEEDS_MODEL = /explica|revisa|cita|archivo:l[ií]nea|por qu[eé]|indica si|comprueba si|resume/i;

export function detectDeterministic(files, criteria) {
  if (!Array.isArray(files) || !files.length || files.length > 4) return null;
  if (!files.every(f => typeof f === 'string' && (TEST_FILE.test(f) || TEST_DIR.test(f)))) return null;
  if (!criteria.every(a => ONLY_RUN.test(a) && !NEEDS_MODEL.test(a))) return null;
  return { kind: 'pytest', targets: files.map(f => f.replace(/\/$/, '')) };
}

export function validDeterministic(d, files) {
  if (!d || d.kind !== 'pytest' || !Array.isArray(d.targets) || !d.targets.length || d.targets.length > 4) throw Error('Invalid deterministic check');
  for (const t of d.targets) if (!files.includes(t) || !(TEST_FILE.test(t) || TEST_DIR.test(t))) throw Error('Deterministic targets must be listed test files or tests/ folders');
  return { kind: 'pytest', targets: [...d.targets] };
}

function pytest(c, root, target, signal) {
  safeFile(root, target, [target]);
  const i = target.lastIndexOf('tests');
  const cwd = i > 0 ? path.join(root, target.slice(0, i)) : root, arg = i > 0 ? target.slice(i) : target;
  return new Promise(resolve => {
    if (!c.python) return resolve({ path: target, exit: -1, output: 'Python interpreter not configured (AGENT_PYTHON)', ms: 0 });
    const t0 = Date.now();
    const child = spawn(c.python, ['-m', 'pytest', arg, '-q', '-p', 'no:cacheprovider'], { cwd, windowsHide: true, env: { ...process.env, QT_QPA_PLATFORM: 'offscreen', PYTHONDONTWRITEBYTECODE: '1' } });
    let out = '';
    const keep = d => { out = (out + d).slice(-20000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const stop = () => child.kill();
    const timer = setTimeout(stop, 600000);
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', e => { clearTimeout(timer); resolve({ path: target, exit: -1, output: String(e.message), ms: Date.now() - t0 }); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve({ path: target, exit: code ?? -1, output: out.trim().slice(-1500), ms: Date.now() - t0 }); });
  });
}

const count = (text, word) => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0);

export async function runDeterministic(c, root, spec, signal) {
  const results = [];
  for (const target of spec.deterministic.targets) results.push(await pytest(c, root, target, signal));
  const passed = results.reduce((n, r) => n + count(r.output, 'passed'), 0);
  const failed = results.reduce((n, r) => n + count(r.output, 'failed') + count(r.output, 'error'), 0);
  const ok = results.every(r => r.exit === 0);
  const headline = ok ? `El PC ejecutó pytest: ${passed} pasan, 0 fallan` : `Pytest falla: ${failed} fallos en ${results.filter(r => r.exit !== 0).length} archivos`;
  const lines = [headline, '', 'Encargo determinista: lo ejecutó el PC, sin modelo y sin citas.', '', '## Comandos y salida real', ''];
  for (const r of results) lines.push(`- \`python -m pytest ${r.path.slice(r.path.lastIndexOf('tests'))} -q\` (en \`${r.path.slice(0, Math.max(0, r.path.lastIndexOf('tests'))) || '.'}\`) → exit ${r.exit}, ${Math.round(r.ms / 1000)} s`, '', '```', r.output.split('\n').slice(-8).join('\n'), '```', '');
  lines.push(`Total: ${passed} pasan, ${failed} fallan o dan error.`);
  return { ok, passed, failed, results, headline, report_md: lines.join('\n') };
}
