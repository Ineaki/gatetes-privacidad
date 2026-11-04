import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { validateSpec } from '../src/workspace.mjs';
import { runOne } from '../src/worker.mjs';
import { simulatedToolCall, scrub, machineLock } from '../src/guard.mjs';
import { parseInstruction, syncRemote } from '../src/remote.mjs';

const code=['def caer(altura):','    if altura > 40:','        return "paracaidas"','    return "salto"',''].join('\n');
function fixture(t,overrides={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orq-test-')),repo=path.join(dir,'repo');fs.mkdirSync(path.join(repo,'app'),{recursive:true});
  const g=(...a)=>execFileSync('git',['-C',repo,...a],{stdio:'pipe',windowsHide:true});
  g('init','-b','main');g('config','user.name','Synthetic Test');g('config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(repo,'app/caida.py'),code);g('add','.');g('commit','-m','fixture');
  const c=config({repo,vault:path.join(dir,'private'),lockDir:path.join(dir,'lock'),...overrides}),s=new Store(c);
  t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {c,s,repo,dir,g};
}
const fakeText='{"name": "read_file", "arguments": {"path": "app/caida.py"}}';
const goodReview=JSON.stringify({verdict:'issues',summary:'The threshold is a hard-coded pixel value that ignores DPI scaling, so high-DPI screens fall without parachute.',
  findings:[{file:'app/caida.py',line:2,quote:'if altura > 40:',severity:'major',issue:'Fixed 40 px threshold is not scaled by DPI, so the parachute may not open.'}],
  checked:[{file:'app/caida.py',line:3,quote:'return "paracaidas"',observation:'Parachute branch exists for tall drops.'},{file:'app/caida.py',line:4,quote:'return "salto"',observation:'Short drops jump instead.'}]});
const reviewSpec=extra=>validateSpec({goal:'Review the fall threshold logic for DPI problems',profile:'reviewer',files:['app/caida.py'],...extra});

test('text that only simulates tool calls is detected',()=>{
  assert.ok(simulatedToolCall(fakeText+'\n{"name": "read_file", "arguments": {"path": "x"}}'));
  assert.ok(simulatedToolCall('<tool_call>{"name":"read_file"}</tool_call>'));
  assert.ok(simulatedToolCall('I will call read_file("app/caida.py") now'));
  assert.equal(simulatedToolCall('The threshold at app/caida.py:2 ignores DPI.'),null);
});
test('simulated tool call is re-asked once, then blocks with explicit reason',async t=>{
  const {s,c}=fixture(t);s.submit(validateSpec({goal:'Inspect file',profile:'researcher',files:['app/caida.py']}));
  const result=await runOne(s,c,{chat:async()=>({message:{content:fakeText}})});
  assert.equal(result.state,'blocked');assert.equal(result.result.reason,'unusable_result');assert.match(result.result.error,/tool calls as text/);
  assert.equal(result.steps,2);
  assert.equal(s.db.prepare("SELECT count(*) n FROM events WHERE kind='simulated_tool_call'").get().n,2);
});
test('one bounded re-ask can recover a real answer',async t=>{
  const {s,c}=fixture(t);s.submit(validateSpec({goal:'Inspect file',profile:'researcher',files:['app/caida.py']}));
  const replies=[fakeText,'app/caida.py:2 uses a fixed 40 px threshold.'];
  const result=await runOne(s,c,{chat:async(_c,body)=>{if(replies.length===1) assert.match(JSON.stringify(body.messages),/NOT accepted/);return {message:{content:replies.shift()}};}});
  assert.equal(result.state,'completed');assert.equal(result.steps,2);
});
test('review gets file evidence without tools and completes only when grounded',async t=>{
  const {s,c}=fixture(t);s.submit(reviewSpec());
  const replies=[fakeText,goodReview];
  const result=await runOne(s,c,{chat:async(_c,body)=>{
    assert.equal(body.tools,undefined);assert.equal(body.format.type,'object');assert.match(body.messages[1].content,/ 2\| +if altura > 40:/);
    return {message:{content:replies.shift()}};}});
  assert.equal(result.state,'completed');assert.equal(result.result.summary_source,'model_review_grounded_in_files');
  assert.match(result.result.report_md,/app\/caida.py:2/);
  const report=fs.readFileSync(s.db.prepare('SELECT file FROM reports WHERE task=?').get(result.id).file,'utf8');
  assert.match(report,/## Resultado: completed/);
  assert.ok(fs.readdirSync(path.join(c.vault,'evidence',result.id)).length===2,'every model call kept in vault');
});
test('ungrounded review is rejected after one retry instead of completing',async t=>{
  const {s,c}=fixture(t);s.submit(reviewSpec());
  const invented=JSON.parse(goodReview);invented.findings[0].quote='if height_px >= dpi_scale:';
  const result=await runOne(s,c,{chat:async()=>({message:{content:JSON.stringify(invented)}})});
  assert.equal(result.state,'blocked');assert.match(result.result.error,/quote not found/);assert.equal(result.steps,2);
});
test('contradictory or empty reviews are not useful',async t=>{
  const {s,c}=fixture(t);s.submit(reviewSpec());
  const empty=JSON.stringify({verdict:'no_issues',summary:'ok',findings:[],checked:[]});
  const result=await runOne(s,c,{chat:async()=>({message:{content:empty}})});
  assert.equal(result.state,'blocked');assert.match(result.result.error,/summary under 40.*checked|checked/);
});
test('identical microtasks are refused using file hashes',t=>{
  const {s,repo,g}=fixture(t);const first=s.submitUnique(reviewSpec(),'a');
  assert.equal(s.submitUnique(reviewSpec(),'a').id,first.id,'same key stays idempotent');
  assert.throws(()=>s.submitUnique(reviewSpec(),'b'),/Duplicate microtask/);
  fs.writeFileSync(path.join(repo,'app/caida.py'),code+'# changed\n');g('commit','-am','change');
  assert.ok(s.submitUnique(reviewSpec(),'c').id,'new file contents are a new microtask');
});
test('remote contract accepts the Fox format only for local engines',t=>{
  const {c}=fixture(t);c.repoName='Ineaki/gatetes';
  const resolve=()=>({baseCommit:'a'.repeat(40),diffBase:'b'.repeat(40)});
  const base={kind:'task',key:'fox-2026-11-04-001',task:{goal:'Review the fall threshold for DPI problems',profile:'checker',repo:'Ineaki/gatetes',pr:34,
    files:['app/caida.py','app/tests/test_caida.py'],acceptance:['pytest app/tests/test_caida.py pasa','Explica si el umbral depende del DPI']}};
  const spec=parseInstruction(base,c,resolve);
  assert.deepEqual(spec.tests,['app/tests/test_caida.py']);assert.deepEqual(spec.criteria,['Explica si el umbral depende del DPI']);assert.equal(spec.profile,'checker');
  const bad=patch=>()=>parseInstruction({...base,task:{...base.task,...patch}},c,resolve);
  assert.throws(bad({engine:'claude'}),/not local/);
  assert.throws(bad({profile:'implementer'}),/not accepted/);
  assert.throws(bad({acceptance:[]}),/acceptance/);
  assert.throws(bad({files:['a','b','c','d','e']}),/1-4/);
  assert.throws(bad({repo:'Ineaki/otro'}),/repo must be/);
  assert.throws(()=>parseInstruction({...base,key:'../x'},c,resolve),/key/);
});
test('mirror scrubbing removes credentials and local home paths',()=>{
  const text=scrub(`token ghp_${'a'.repeat(30)} at ${os.homedir()}\\vault and "delegate": "${'f'.repeat(40)}"`);
  assert.ok(!text.includes('ghp_'));assert.ok(!text.includes(os.homedir()));assert.ok(!text.includes('f'.repeat(40)));
});
test('machine lock admits a single worker',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const release=machineLock(dir);assert.ok(release);
  fs.writeFileSync(path.join(dir,'worker.lock'),String(process.ppid));assert.equal(machineLock(dir),null,'live foreign holder blocks');
  fs.writeFileSync(path.join(dir,'worker.lock'),'999999');const again=machineLock(dir);assert.ok(again,'stale lock is reclaimed');again();
});
test('remote inbox round trip: receipt, local execution, report and private push',async t=>{
  const {s,c,repo,dir}=fixture(t);
  const sh=(cwd,...a)=>execFileSync('git',['-C',cwd,...a],{encoding:'utf8',stdio:'pipe',windowsHide:true}).trim();
  const origin=path.join(dir,'origin.git');execFileSync('git',['clone','-q','--bare',repo,origin],{windowsHide:true});sh(repo,'remote','add','origin',origin);sh(repo,'fetch','-q','origin');
  const vaultOrigin=path.join(dir,'vault.git'),mirror=path.join(dir,'mirror');sh(dir,'init','-q','--bare','-b','main',vaultOrigin);
  execFileSync('git',['clone','-q',vaultOrigin,mirror],{windowsHide:true});sh(mirror,'config','user.name','t');sh(mirror,'config','user.email','t@example.invalid');
  fs.mkdirSync(path.join(mirror,'inbox'));fs.writeFileSync(path.join(mirror,'inbox/.gitkeep'),'');sh(mirror,'add','.');sh(mirror,'commit','-qm','init');sh(mirror,'push','-q','origin','HEAD:main');
  c.repoName=null;sh(repo,'remote','set-url','origin',origin);
  const instruction={kind:'task',key:'sintetica-001',task:{goal:'Review the fall threshold logic for DPI problems',profile:'reviewer',files:['app/caida.py'],acceptance:['Indica si el umbral de 40 px escala con el DPI']}};
  fs.writeFileSync(path.join(mirror,'inbox/sintetica-001.json'),JSON.stringify(instruction));sh(mirror,'add','.');sh(mirror,'commit','-qm','encargo');sh(mirror,'push','-q','origin','HEAD:main');
  c.repoName='local/repo';
  syncRemote(s,c,mirror);
  let receipt=JSON.parse(fs.readFileSync(path.join(mirror,'receipts/sintetica-001.json'),'utf8'));
  assert.equal(receipt.status,'accepted');assert.equal(receipt.state,'queued');
  const review=JSON.parse(goodReview);review.criteria=[{criterion:'DPI',answer:'No, es un valor fijo',met:'no',file:'app/caida.py',line:2,quote:'if altura > 40:',evidence:'Compares against a fixed 40 without DPI.'}];
  const done=await runOne(s,c,{chat:async()=>({message:{content:JSON.stringify(review)}})});
  assert.equal(done.state,'completed');
  syncRemote(s,c,mirror);
  receipt=JSON.parse(fs.readFileSync(path.join(mirror,'receipts/sintetica-001.json'),'utf8'));
  assert.equal(receipt.state,'completed');assert.equal(receipt.verdict,'issues');assert.ok(fs.existsSync(path.join(mirror,receipt.report)));
  const pushed=sh(vaultOrigin,'ls-tree','-r','--name-only','main');
  assert.match(pushed,/receipts\/sintetica-001.json/);assert.doesNotMatch(pushed,/sqlite|credentials|evidence/);
  fs.writeFileSync(path.join(mirror,'inbox/nube-001.json'),JSON.stringify({...instruction,key:'nube-001',task:{...instruction.task,engine:'codex'}}));
  syncRemote(s,c,mirror);
  assert.match(JSON.parse(fs.readFileSync(path.join(mirror,'receipts/nube-001.json'),'utf8')).reason,/not local/);
});
test('grounding ignores line breaks and corrects a miscounted line, but rejects invented quotes',async t=>{
  const {s,c}=fixture(t);s.submit(reviewSpec());
  const r=JSON.parse(goodReview);r.checked[0]={file:'app/caida.py',line:1,quote:'if altura > 40: return "paracaidas"',observation:'Two-line quote cited at the wrong line.'};
  const result=await runOne(s,c,{chat:async()=>({message:{content:JSON.stringify(r)}})});
  assert.equal(result.state,'completed');assert.equal(result.result.review.checked[0].line,2);assert.match(result.result.report_md,/1→2/);
});
