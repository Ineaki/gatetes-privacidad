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
test('wrong evidence blocks at once without re-asking the model',async t=>{
  const {s,c}=fixture(t);s.submit(reviewSpec());
  const invented=JSON.parse(goodReview);invented.findings[0].quote='if height_px >= dpi_scale:';
  const result=await runOne(s,c,{chat:async()=>({message:{content:JSON.stringify(invented)}})});
  assert.equal(result.state,'blocked');assert.match(result.result.error,/wrong evidence.*quote not found/);assert.equal(result.steps,1);
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
test('remote contract routes engines: checker/ollama local, implementer+claude and reviewer+codex via orq',t=>{
  const {c}=fixture(t);c.repoName='Ineaki/gatetes';
  const resolve=()=>({baseCommit:'a'.repeat(40),diffBase:'b'.repeat(40)});
  const base={kind:'task',key:'fox-2026-11-04-001',task:{goal:'Review the fall threshold for DPI problems',profile:'checker',repo:'Ineaki/gatetes',pr:34,
    files:['app/caida.py','app/tests/test_caida.py'],acceptance:['pytest app/tests/test_caida.py pasa','Explica si el umbral depende del DPI']}};
  const spec=parseInstruction(base,c,resolve);
  assert.deepEqual(spec.tests,['app/tests/test_caida.py']);assert.deepEqual(spec.criteria,['Explica si el umbral depende del DPI']);assert.equal(spec.profile,'checker');
  const bad=patch=>()=>parseInstruction({...base,task:{...base.task,...patch}},c,resolve,()=>resolve);
  // checker siempre es local, aunque pida otro motor.
  assert.equal(bad({engine:'claude'})().profile,'checker');assert.equal(bad({engine:'claude'})().engine,undefined);
  const impl=bad({profile:'implementer',engine:'claude'})();
  assert.equal(impl.engine,'claude');assert.equal(impl.profile,'implementer');assert.equal(impl.repo,'Ineaki/gatetes');assert.equal(impl.pr,34);
  assert.deepEqual(impl.tests,['app/tests/test_caida.py']);assert.equal(impl.criteria.length,2);
  const rev=bad({profile:'reviewer',engine:'codex',files:['panel/']})();assert.equal(rev.engine,'codex');assert.deepEqual(rev.files,['panel/']);
  assert.equal(bad({profile:'implementer'})().engine,'claude');
  assert.throws(bad({profile:'implementer',engine:'codex'}),/runs on engine "claude"/);
  assert.throws(bad({profile:'reviewer',engine:'claude'}),/"codex" or "ollama"/);
  assert.throws(bad({engine:'gpt'}),/not accepted/);
  assert.throws(bad({profile:'implementer',engine:'claude',repo:'Ineaki/otro'}),/no local clone/);
  assert.throws(bad({profile:'implementer',engine:'claude',files:['.env']}),/Forbidden/);
  assert.throws(bad({profile:'nadie'}),/not accepted/);
  assert.throws(bad({acceptance:[]}),/acceptance/);
  assert.throws(bad({files:['a','b','c','d','e']}),/1-4/);
  assert.throws(bad({repo:'Ineaki/otro'}),/repo must be/);
  assert.throws(()=>parseInstruction({...base,key:'../x'},c,resolve),/key/);
});

test('remote repo: Ineaki/gatetes canonical, case-insensitive, blank = default, others rejected (ollama, claude, codex)',t=>{
  const {c}=fixture(t);c.repoName='Ineaki/gatetes';
  const saved=process.env.AGENT_REMOTE;delete process.env.AGENT_REMOTE;t.after(()=>{if(saved!==undefined) process.env.AGENT_REMOTE=saved;});
  const resolve=()=>({baseCommit:'a'.repeat(40)});
  const engines={ollama:{profile:'checker',engine:'ollama'},claude:{profile:'implementer',engine:'claude'},codex:{profile:'reviewer',engine:'codex'}};
  const mk=(engine,patch)=>()=>parseInstruction({kind:'task',key:'repo-check-001',task:{goal:'Revisa el umbral de la caida y cita archivo:linea',
    files:['app/caida.py'],acceptance:['Indica si depende del DPI'],...engines[engine],...patch}},c,resolve,()=>resolve);
  for(const engine of Object.keys(engines)) {
    const orq=engine!=='ollama';
    // válido exacto
    const ok=mk(engine,{repo:'Ineaki/gatetes'})();assert.equal(ok.engine,orq?engine:undefined,engine);
    if(orq) assert.equal(ok.repo,'Ineaki/gatetes');
    // mismas letras en otra caja: GitHub no distingue, se normaliza al canónico
    const low=mk(engine,{repo:'ineaki/GATETES'})();if(orq) assert.equal(low.repo,'Ineaki/gatetes',engine);
    // vacío, espacios, null o ausente: repo por defecto
    for(const repo of ['','  ',null,undefined]) { const s=mk(engine,{repo})();if(orq) assert.equal(s.repo,'Ineaki/gatetes',`${engine} ${repo}`); }
    // otro propietario (falta la "e"), otro repo o el vault: rechazados
    const why=orq?/no local clone/:/repo must be Ineaki\/gatetes \(got/;
    for(const repo of ['inaki/gatetes','Ineaki/otro','Ineaki/gatetes-agent-vault','Ineaki/gatetes/x']) assert.throws(mk(engine,{repo}),why,`${engine} ${repo}`);
    assert.throws(mk(engine,{repo:42}),/string/,engine);
  }
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
  fs.writeFileSync(path.join(mirror,'inbox/nube-001.json'),JSON.stringify({...instruction,key:'nube-001',task:{...instruction.task,engine:'gpt'}}));
  syncRemote(s,c,mirror);
  assert.match(JSON.parse(fs.readFileSync(path.join(mirror,'receipts/nube-001.json'),'utf8')).reason,/not accepted/);
  // PowerShell 5 (Set-Content/Out-File -Encoding UTF8) escribe un BOM: el encargo debe aceptarse igual.
  fs.writeFileSync(path.join(mirror,'inbox/bom-001.json'),'﻿'+JSON.stringify({...instruction,key:'bom-001',task:{...instruction.task,goal:'Review the fall threshold logic for DPI problems (BOM)'}}));
  syncRemote(s,c,mirror);
  assert.equal(JSON.parse(fs.readFileSync(path.join(mirror,'receipts/bom-001.json'),'utf8')).status,'accepted');
});
test('grounding ignores line breaks and corrects a miscounted line, but rejects invented quotes',async t=>{
  const {s,c}=fixture(t);s.submit(reviewSpec());
  const r=JSON.parse(goodReview);r.checked[0]={file:'app/caida.py',line:1,quote:'if altura > 40: return "paracaidas"',observation:'Two-line quote cited at the wrong line.'};
  const result=await runOne(s,c,{chat:async()=>({message:{content:JSON.stringify(r)}})});
  assert.equal(result.state,'completed');assert.equal(result.result.review.checked[0].line,2);assert.match(result.result.report_md,/1→2/);
});
test('a criterion that names a call must quote that call, not a nearby line',async t=>{
  const {s,c}=fixture(t);s.submit(reviewSpec({criteria:['¿Se llama a caer(altura) con la altura real?']}));
  const r=JSON.parse(goodReview);r.criteria=[{criterion:'x',answer:'sí',met:'yes',file:'app/caida.py',line:3,quote:'return "paracaidas"',evidence:'The parachute branch is reached for tall drops.'}];
  const result=await runOne(s,c,{chat:async()=>({message:{content:JSON.stringify(r)}})});
  assert.equal(result.state,'blocked');assert.match(result.result.error,/does not quote caer\(altura\)/);
});
test('backticked proof must be quoted; a repeated fragment resolves to the PR diff',async t=>{
  const {s,c,repo,g}=fixture(t);const base=g('rev-parse','HEAD').toString().trim();
  fs.writeFileSync(path.join(repo,'app/caida.py'),code+'def otro():\n    return caer(99)\n\ndef soltar():\n    return caer(99)\n');g('commit','-qam','base dup');
  const base2=g('rev-parse','HEAD').toString().trim();
  fs.writeFileSync(path.join(repo,'app/caida.py'),code+'def otro():\n    return caer(99)\n\ndef soltar():\n    return caer(99)\n\ndef nuevo():\n    return caer(99)\n');g('commit','-qam','pr');
  const head=g('rev-parse','HEAD').toString().trim();
  const spec=validateSpec({goal:'Review the release path',profile:'reviewer',files:['app/caida.py'],baseCommit:head,diffBase:base2,criteria:['¿nuevo llama a `caer(99)`?']});
  const r=JSON.parse(goodReview);
  r.criteria=[{criterion:'x',answer:'sí',met:'yes',file:'app/caida.py',line:40,quote:'return caer(99)',evidence:'nuevo returns caer(99) on release.'}];
  s.submit(spec);let result=await runOne(s,c,{chat:async()=>({message:{content:JSON.stringify(r)}})});
  assert.equal(result.state,'completed');assert.equal(result.result.review.criteria[0].line,12,'only the occurrence added by the PR');
  s.submit(validateSpec({...spec,goal:'Review the release path again'}));
  r.criteria[0].quote='return "salto"';result=await runOne(s,c,{chat:async()=>({message:{content:JSON.stringify(r)}})});
  assert.equal(result.state,'blocked');assert.match(result.result.error,/does not quote caer\(99\)/);assert.equal(result.steps,1);
  assert.ok(base);
});
test('every backticked fragment must appear in the criterion quote',async t=>{
  const {s,c}=fixture(t);s.submit(reviewSpec({criteria:['¿caer devuelve paracaidas? Cita `def caer(altura):` y `return "paracaidas"`.']}));
  const r=JSON.parse(goodReview);r.criteria=[{criterion:'x',answer:'sí',met:'yes',file:'app/caida.py',line:3,quote:'return "paracaidas"',evidence:'The tall-drop branch returns the parachute.'}];
  const result=await runOne(s,c,{chat:async()=>({message:{content:JSON.stringify(r)}})});
  assert.equal(result.state,'blocked');assert.match(result.result.error,/does not quote def caer\(altura\): and return "paracaidas"/);
});
test('a quote longer than four lines is still grounded',async t=>{
  const {s,c}=fixture(t);s.submit(reviewSpec());
  const r=JSON.parse(goodReview);r.checked[0]={file:'app/caida.py',line:1,quote:'def caer(altura):\n    if altura > 40:\n        return "paracaidas"\n    return "salto"',observation:'Whole function quoted across four lines.'};
  const result=await runOne(s,c,{chat:async()=>({message:{content:JSON.stringify(r)}})});
  assert.equal(result.state,'completed');
});

// orq falso (test/fixtures/fake-orq.ps1): imita ticket start / implement / review con un ticket.json como el real.
function orqFixture(t,extraEnv={}){
  const f=fixture(t);f.c.repoName='Ineaki/gatetes';
  fs.mkdirSync(path.join(f.repo,'app/tests'),{recursive:true});fs.writeFileSync(path.join(f.repo,'app/tests/test_caida.py'),'def test_ok():\n    assert True\n');f.g('add','.');f.g('commit','-m','tests');
  const env={AGENT_ORQ_SCRIPT:path.join(import.meta.dirname,'fixtures','fake-orq.ps1'),AGENT_ORQ_NO_PUSH:'1',AGENT_ORQ_REPOS:JSON.stringify({'Ineaki/gatetes':f.repo}),...extraEnv},saved={};
  for(const [k,v] of Object.entries(env)){saved[k]=process.env[k];process.env[k]=v;}
  t.after(()=>{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const head=execFileSync('git',['-C',f.repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const make=(key,task)=>parseInstruction({kind:'task',key,task:{goal:'Marca app/caida.py como revisado con un comentario corto',repo:'Ineaki/gatetes',files:['app/caida.py','app/tests/test_caida.py'],acceptance:['pytest app/tests/test_caida.py pasa'],...task}},f.c,()=>({baseCommit:head}),()=>()=>({baseCommit:head}));
  return {...f,make};
}
test('implementer+claude runs orq implement, records metrics and a short headline, commits on orq/<key> without push',async t=>{
  const {s,c,make}=orqFixture(t);
  const task=s.submit(make('orq-impl-001',{profile:'implementer',engine:'claude'}),'remote-orq-impl-001');
  const done=await runOne(s,c);
  assert.equal(done.state,c.python?'completed':'blocked',JSON.stringify(done.result).slice(0,400));
  assert.equal(done.result.engine,'claude');assert.equal(done.result.branch,'orq/orq-impl-001');assert.equal(done.result.pushed,false);
  assert.deepEqual(done.result.changed,['app/caida.py']);assert.match(done.result.commit,/^[a-f0-9]{40}$/);
  assert.equal(done.result.attempts.length,1);assert.equal(done.result.attempts[0].step.model,'haiku');
  const m=s.metrics(task.id);assert.equal(m[0].model,'claude:haiku');assert.equal(m[0].input_tokens,1200);assert.equal(m[0].output_tokens,300);
  assert.ok(done.result.headline.split(/\s+/).length<=10);
  const report=s.db.prepare('SELECT file FROM reports WHERE task=?').get(task.id).file;
  assert.equal(fs.readFileSync(report,'utf8').split('\n')[0],done.result.headline+'.');
  const kinds=s.db.prepare('SELECT kind FROM events WHERE task=?').all(task.id).map(e=>e.kind);
  assert.ok(kinds.includes('orq_started')&&kinds.includes('orq_finished'));
});
test('implementer escalates the model once when the cheap attempt fails',async t=>{
  const {s,c,make}=orqFixture(t,{FAKE_ORQ_FAIL_FIRST:'1'});
  s.submit(make('orq-impl-002',{profile:'implementer',engine:'claude'}),'remote-orq-impl-002');
  const done=await runOne(s,c);
  assert.deepEqual(done.result.attempts.map(a=>a.step.model),['haiku','sonnet']);
  assert.equal(done.result.attempts[0].state,'PARTIAL_RECOVERABLE');assert.equal(done.result.attempts[1].state,'CHECKPOINTED');
});
test('reviewer+codex runs a review-only orq ticket with codex_first and low effort',async t=>{
  const {s,c,make}=orqFixture(t);
  const task=s.submit(make('orq-rev-001',{profile:'reviewer',engine:'codex',pr:7}),'remote-orq-rev-001');
  const done=await runOne(s,c);
  assert.equal(done.state,'completed',JSON.stringify(done.result).slice(0,300));
  assert.match(done.result.attempts[0].message,/review codex_first low/);
  assert.deepEqual(done.result.reviewers,['codex']);assert.equal(done.result.review.findings[0].severity,'P2');
  assert.match(done.result.headline,/^Codex revisó la PR #7/);
  assert.equal(s.metrics(task.id)[0].model,'codex:effort-low');
});

test('a paused engine blocks the task with its reason and never relays to another paid engine',async t=>{
  const {s,c,make}=orqFixture(t);
  fs.writeFileSync(path.join(c.vault,'orq-engines.json'),JSON.stringify({codex:{until:new Date(Date.now()+3600e3).toISOString(),reason:'sin cuota'}}));
  const task=s.submit(make('orq-rev-002',{profile:'reviewer',engine:'codex',pr:7}),'remote-orq-rev-002');
  const done=await runOne(s,c);
  assert.equal(done.state,'blocked');assert.equal(done.result.reason,'engine_unavailable');assert.match(done.result.error,/sin cuota hasta/);
  assert.equal(done.result.attempts.length,0);assert.equal(s.metrics(task.id).length,0);
  fs.writeFileSync(path.join(c.vault,'orq-engines.json'),JSON.stringify({codex:{until:new Date(Date.now()-1000).toISOString()}}));
  s.submit(make('orq-rev-003',{profile:'reviewer',engine:'codex',pr:8}),'remote-orq-rev-003');
  assert.equal((await runOne(s,c)).state,'completed');
});

test('checker that only runs pytest is deterministic: no model call, real output, test folders accepted',async t=>{
  const {s,c,g,repo}=fixture(t,{python:process.env.AGENT_PYTHON??null});c.repoName='Ineaki/gatetes';
  fs.mkdirSync(path.join(repo,'app/tests'),{recursive:true});fs.writeFileSync(path.join(repo,'app/tests/test_a.py'),'def test_a():\n    assert True\n');g('add','.');g('commit','-m','t');
  const head=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const mk=task=>parseInstruction({kind:'task',key:'det-001',task:{goal:'Ejecuta las pruebas de la carpeta de tests y pega la salida',profile:'checker',repo:'Ineaki/gatetes',...task}},c,()=>({baseCommit:head}));
  const spec=mk({files:['app/tests/'],acceptance:['Salida real de pytest pegada en el informe']});
  assert.deepEqual(spec.deterministic,{kind:'pytest',targets:['app/tests']});assert.deepEqual(spec.files,['app/tests']);
  assert.equal(mk({files:['app/tests/test_a.py'],acceptance:['Explica por qué falla, con archivo:línea']}).deterministic,undefined);
  assert.equal(mk({files:['app/caida.py'],acceptance:['pytest pasa']}).deterministic,undefined);
  s.submit(spec);
  let called=false;
  const done=await runOne(s,c,{chat:async()=>{called=true;throw Error('no model expected');}});
  assert.equal(called,false);
  if(c.python){assert.equal(done.state,'completed',JSON.stringify(done.result).slice(0,300));assert.match(done.result.headline,/1 pasan, 0 fallan/);assert.match(done.result.report_md,/1 passed/);}
  else assert.equal(done.state,'blocked');
  assert.equal(s.metrics(done.id)[0].model,'ninguno (pytest en el PC)');
});
