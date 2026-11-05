import test from 'node:test';
import assert from 'node:assert/strict';
import { llamaCppChat } from '../src/providers.mjs';
import { routeEngine } from '../src/orq.mjs';

test('llamacpp is an explicit local route and does not alter default routing', () => {
  assert.equal(routeEngine('reviewer', 'llamacpp'), 'llamacpp');
  assert.equal(routeEngine('reviewer'), 'ollama');
  assert.equal(routeEngine('implementer'), 'claude');
});

test('llama.cpp adapter maps OpenAI response and preserves tool payload', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8080/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.stream, false);
    assert.equal(body.tools[0].function.name, 'read_file');
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'ok'}}],usage:{prompt_tokens:11,completion_tokens:3}}), {status:200});
  };
  try {
    const result = await llamaCppChat({llamacpp:'http://127.0.0.1:8080',requestMs:1000}, {model:'qwen3',messages:[],tools:[{type:'function',function:{name:'read_file'}}]}, new AbortController().signal);
    assert.deepEqual(result.message, {role:'assistant',content:'ok'});
    assert.equal(result.prompt_eval_count, 11);
    assert.equal(result.eval_count, 3);
  } finally { globalThis.fetch = old; }
});
