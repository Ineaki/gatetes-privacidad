import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, modelFor } from '../src/config.mjs';

function withSettings(settings) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'models-vault-'));
  fs.writeFileSync(path.join(vault, 'settings.json'), JSON.stringify(settings));
  return vault;
}

test('per-profile models fall back to the default model', () => {
  const c = config({ vault: withSettings({ model: 'qwen3:30b-a3b', models: { checker: 'qwen2.5-coder:7b' } }) });
  assert.equal(modelFor(c, 'checker'), 'qwen2.5-coder:7b');
  assert.equal(modelFor(c, 'reviewer'), 'qwen3:30b-a3b');
});

test('without models every profile uses model', () => {
  const c = config({ vault: withSettings({ model: 'qwen2.5:3b' }) });
  assert.deepEqual(c.models, {});
  assert.equal(modelFor(c, 'coder'), 'qwen2.5:3b');
});

test('cloud or malformed per-profile models are rejected', () => {
  assert.throws(() => config({ vault: withSettings({ models: { reviewer: 'gpt-oss:120b-cloud' } }) }), /Cloud/);
  assert.throws(() => config({ vault: withSettings({ models: ['x'] }) }), /Invalid models/);
  assert.throws(() => config({ vault: withSettings({ models: { reviewer: '' } }) }), /Invalid model/);
});
