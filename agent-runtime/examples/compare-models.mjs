// Runs the same campaign review (evidence, schema, prompt, verifier) on several local models and keeps every call in the vault.
// Usage: node examples/compare-models.mjs <seed.json> <pr> <worktree> <model> [model...]
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { validateSpec, git } from '../src/workspace.mjs';
import { machineLock } from '../src/guard.mjs';
import { ollamaChat } from '../src/worker.mjs';
import { reviewSchema, reviewMessages, correction, buildEvidence, assessReview, runTests } from '../src/review.mjs';

const [seedFile, prArg, root, ...models] = process.argv.slice(2);
if (!models.length) throw Error('Usage: compare-models.mjs <seed.json> <pr> <worktree> <model> [model...]');
const c = config();
const job = JSON.parse(fs.readFileSync(seedFile, 'utf8')).jobs.find(j => j.pr === Number(prArg));
if (git(root, ['rev-parse', 'HEAD']) !== job.baseCommit) throw Error('Worktree is not at the PR head');
const tests = job.test ? [`mascota_py/${job.test}`] : [];
const spec = validateSpec({ goal: job.objective, profile: 'reviewer', files: [...new Set([...job.files, ...tests])], tests, criteria: job.criteria ?? [],
  baseCommit: job.baseCommit, diffBase: git(c.repo, ['merge-base', 'origin/main', job.baseCommit]) });
const unlock = machineLock(c.lockDir);
if (!unlock) throw Error('Another local worker is active; try again when it is idle');
const out = path.join(c.vault, 'evidence', `compare-pr${job.pr}-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
try {
  spec.testResults = runTests(c, root, spec);
  const evidence = buildEvidence(root, spec, Math.floor((c.context - c.output - c.margin - 600) * 2.5));
  const body = { messages: reviewMessages(spec, evidence), stream: false, think: false, format: reviewSchema(spec.criteria), keep_alive: '2m',
    options: { num_ctx: c.context, num_predict: c.output, temperature: 0 } };
  const summary = [];
  for (const model of models) {
    if (/cloud/i.test(model)) throw Error('Cloud models are disabled');
    const started = Date.now();
    // Same policy as the worker: one re-ask for format problems only, never for wrong evidence.
    let messages = body.messages, response, content, verdict, attempts = 0;
    for (; attempts < 2; attempts++) {
      response = await ollamaChat({ ...c, requestMs: 900000 }, { ...body, messages, model}, new AbortController().signal);
      content = String(response.message?.content ?? '');
      verdict = response.done_reason === 'length' ? { ok: false, reasons: ['output limit'] } : assessReview(root, spec, content);
      fs.writeFileSync(path.join(out, `${model.replace(/[:/]/g, '_')}-call${attempts + 1}.json`), JSON.stringify({ model, request: { ...body, messages, model }, response: { content, done_reason: response.done_reason },
        prompt_tokens: response.prompt_eval_count, output_tokens: response.eval_count, ms: Date.now() - started, assessment: verdict }, null, 2), { mode: 0o600 });
      if (verdict.ok || !verdict.retryable) break;
      messages = [...messages, { role: 'assistant', content: content.slice(0, 4000) }, { role: 'user', content: correction(verdict.reasons) }];
    }
    summary.push({ model, attempts: Math.min(attempts + 1, 2), ms: Date.now() - started, prompt_tokens: response.prompt_eval_count, output_tokens: response.eval_count, grounded: verdict.ok, reasons: verdict.reasons,
      verdict: verdict.review?.verdict, criteria: verdict.review?.criteria?.map(a => ({ answer: a.answer, met: a.met, at: `${a.file}:${a.line}`, evidence: a.evidence })) });
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ pr: job.pr, commit: job.baseCommit, tests: spec.testResults.map(t => `${t.path}: ${t.exit}`), summary }, null, 2));
  console.log(JSON.stringify({ evidence: out, summary }, null, 2));
} finally { unlock(); }
