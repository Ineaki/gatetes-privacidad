import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// A model that cannot emit real tool calls often prints them as text. That text is never a result.
const toolText = [
  /"name"\s*:\s*"[A-Za-z_][\w.-]*"\s*,\s*"(?:arguments|parameters)"\s*:/,
  /<\/?tool_call>|<\|?tool_call\|?>|<function[=\s]/i,
  /\b(?:functions\.)?(?:read_file|write_file|check_syntax|run_test|run_tests)\s*\(\s*["'{a-z]/i,
  /"(?:tool|function|tool_name)"\s*:\s*"(?:read_file|write_file|check_syntax)"/,
];
export function simulatedToolCall(text) {
  const value = String(text ?? '');
  const hit = toolText.find(r => r.test(value));
  if (!hit) return null;
  // Short replies made mostly of call-shaped JSON are simulations even if they add a sentence.
  return { pattern: hit.source.slice(0, 60), excerpt: value.slice(0, 300) };
}

const stable = v => JSON.stringify(v, Object.keys(v).sort());
export const sha = v => createHash('sha256').update(typeof v === 'string' ? v : stable(v)).digest('hex');
export const normalizeGoal = g => String(g).toLowerCase().replace(/\s+/g, ' ').trim();
// Bump when review validation changes: a retry under new rules is not a repeated microtask.
export const REVIEW_VERSION = 4;
// Same profile, goal, files, tests, exact file contents and validation rules means the same microtask.
export function fingerprint(spec, blobs) {
  return sha(JSON.stringify([spec.profile, normalizeGoal(spec.goal), spec.files, spec.tests ?? [], spec.criteria ?? [], spec.diffBase ?? null, blobs, REVIEW_VERSION]));
}

const secretPatterns = [
  /\b(?:gh[opsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /("?(?:admin|delegate|token|password|secret|api[_-]?key)"?\s*[:=]\s*")[^"]{8,}(")/gi,
];
export function scrub(text) {
  let s = String(text);
  s = s.replace(secretPatterns[0], '[REDACTED]').replace(secretPatterns[1], 'Bearer [REDACTED]').replace(secretPatterns[2], '$1[REDACTED]$2');
  // Local absolute paths reveal the machine layout; the mirror only needs relative evidence.
  for (const base of [os.homedir(), os.homedir().replaceAll('\\', '/'), os.homedir().replaceAll('\\', '\\\\')]) s = s.split(base).join('~');
  return s;
}
export function containsSecret(text) {
  return /\b(?:gh[opsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,})\b/.test(String(text));
}

// Single worker per machine, across every vault and process that uses this runtime.
export function machineLock(dir = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'gatetes-agents')) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'worker.lock');
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (pid === process.pid) return null;
      try { process.kill(pid, 0); return null; } catch (k) { if (k.code === 'EPERM') return null; fs.rmSync(file, { force: true }); }
    }
  }
  return null;
}
