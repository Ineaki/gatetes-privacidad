import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const repoDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function config(overrides = {}) {
  const repo = fs.realpathSync(overrides.repo ?? process.env.AGENT_REPO ?? repoDefault);
  const vault = path.resolve(overrides.vault ?? process.env.AGENT_VAULT ?? path.join(os.homedir(), 'Documents/Codex/agent-private/gatetes'));
  if (vault === repo || vault.startsWith(repo + path.sep)) throw Error('Vault must be outside repository');
  const settingsFile=path.join(vault,'settings.json');
  const saved=fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile,'utf8')):{};
  const supported=['model','context','output','margin','maxSteps','maxSeconds','requestMs','leaseMs','maxAttempts','cpuOnly','port'];
  for(const key of Object.keys(saved)) if(!supported.includes(key)) throw Error(`Unknown setting ${key}`);
  const c = { repo, vault, model: 'qwen2.5:3b', ollama: 'http://127.0.0.1:11434', port: 4317, cpuOnly:false,
    context: 8192, output: 1536, margin: 512, maxSteps: 16, maxSeconds: 600,
    requestMs: 120000, leaseMs: 45000, maxAttempts: 3, ...saved, ...overrides };
  c.repo = repo; c.vault = vault;
  const url = new URL(c.ollama);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw Error('Only loopback Ollama allowed');
  if (/cloud/i.test(c.model)) throw Error('Cloud models are disabled');
  if(typeof c.cpuOnly!=='boolean'||!Number.isInteger(c.port)||c.port<1024||c.port>65535) throw Error('Invalid CPU or port setting');
  for (const key of ['context', 'output', 'margin', 'maxSteps', 'maxSeconds', 'requestMs', 'leaseMs', 'maxAttempts']) {
    if (!Number.isSafeInteger(c[key]) || c[key] < 1) throw Error(`Invalid ${key}`);
  }
  if (c.output + c.margin >= c.context) throw Error('No input budget');
  return c;
}
export function ensureVault(c) {
  for (const dir of ['', 'reports', 'evidence', 'worktrees', 'stable']) fs.mkdirSync(path.join(c.vault, dir), { recursive: true, mode: 0o700 });
}
