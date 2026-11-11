// JSON escrito por PowerShell 5 (UTF-8 con BOM): settings, semilla, submit y RPC usan parseJsonText.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseJsonText, stripBom } from '../src/json.mjs';
import { config } from '../src/config.mjs';

test('parseJsonText accepts a UTF-8 BOM and labels invalid JSON',()=>{
  assert.deepEqual(parseJsonText('\uFEFF{"a":1}'),{a:1});
  assert.deepEqual(parseJsonText('{"a":1}'),{a:1});
  assert.equal(stripBom('\uFEFFx\uFEFF'),'x\uFEFF','only a leading BOM is removed');
  assert.throws(()=>parseJsonText('{"a":','settings'),/^Error: settings: invalid JSON \(/);
  assert.throws(()=>parseJsonText('\uFEFF'),/JSON: invalid JSON/);
});

test('config reads a settings.json saved with BOM and rejects a broken one with its label',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'json-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200}));
  const repo=path.join(dir,'repo');fs.mkdirSync(repo);execFileSync('git',['-C',repo,'init','-q'],{windowsHide:true});
  const vault=path.join(dir,'vault');fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault,'settings.json'),'\uFEFF{"model":"qwen2.5:7b","models":{"checker":"qwen2.5-coder:7b"}}');
  const c=config({repo,vault});assert.equal(c.model,'qwen2.5:7b');assert.equal(c.models.checker,'qwen2.5-coder:7b');
  fs.writeFileSync(path.join(vault,'settings.json'),'{"model":');
  assert.throws(()=>config({repo,vault}),/settings: invalid JSON/);
});