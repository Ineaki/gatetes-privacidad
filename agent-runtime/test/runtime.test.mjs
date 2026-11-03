import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.mjs';
import { Store,hash } from '../src/store.mjs';
import { validateSpec,safeFile,taskWorkspace,writeFile,reconcile,readFile } from '../src/workspace.mjs';
import { buildContext,estimate } from '../src/context.mjs';
import { runOne,toolsFor } from '../src/worker.mjs';
import { makeServer,credentials,dispatch } from '../src/server.mjs';

function fixture(t,overrides={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-test-')),repo=path.join(dir,'repo');fs.mkdirSync(repo);
  const g=(...a)=>execFileSync('git',['-C',repo,...a],{stdio:'pipe',windowsHide:true});
  g('init');g('config','user.name','Synthetic Test');g('config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(repo,'input.txt'),'original');g('add','.');g('commit','-m','fixture');
  const c=config({repo,vault:path.join(dir,'private'),...overrides}),s=new Store(c);
  t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {c,s,repo,dir};
}
const spec=extra=>validateSpec({goal:'Create a greeting',profile:'coder',files:['hello.mjs'],...extra});

test('idempotent submissions reject conflicting reuse',t=>{
  const {s}=fixture(t);const first=s.submit(spec(),'same');assert.equal(s.submit(spec(),'same').id,first.id);
  assert.throws(()=>s.submit(spec({goal:'different'}),'same'),/different/);
});
test('global lease excludes second connection and fences expired generation',t=>{
  const {s,c}=fixture(t);s.submit(spec());s.submit(spec());const a=s.acquire('a');
  const other=new Store(c);try{
    assert.equal(other.acquire('b'),null);
    s.db.prepare('UPDATE tasks SET lease=0 WHERE id=?').run(a.id);s.db.exec('UPDATE worker SET lease=0');
    const b=other.acquire('b');assert.equal(b.id,a.id);assert.ok(b.generation>a.generation);
    assert.throws(()=>s.assert(a),/lease/);assert.throws(()=>s.finish(a,'completed',{}),/lease/);
  }finally{other.close();}
});
test('cancel fences live writer and retains exclusion until exit',t=>{
  const {s,c}=fixture(t);const submitted=s.submit(spec()),a=s.acquire('a'),root=taskWorkspace(c,a);
  s.cancel(submitted.id);assert.throws(()=>writeFile(s,a,root,{path:'hello.mjs',text:'bad',expected_hash:null}),/cancelled/);
  assert.equal(s.acquire('b'),null);assert.equal(s.get(a.id).state,'cancelled');
});
test('write intent is idempotent and stale hashes cannot overwrite',t=>{
  const {s,c}=fixture(t);s.submit(spec());const a=s.acquire('a'),root=taskWorkspace(c,a);
  const args={path:'hello.mjs',text:'export const hello = 1;',expected_hash:null};
  const result=writeFile(s,a,root,args);assert.equal(result.hash,hash(args.text));
  assert.equal(writeFile(s,a,root,args).replayed,true);
  assert.throws(()=>writeFile(s,a,root,{...args,text:'overwrite'}),/changed/);
  assert.equal(fs.existsSync(path.join(c.repo,'hello.mjs')),false);
});
test('crash after disk write is reconciled without rewriting',t=>{
  const {s,c}=fixture(t);s.submit(spec());const a=s.acquire('a'),root=taskWorkspace(c,a),body='recovered';
  s.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,'pending')").run('crash',a.id,'hello.mjs',null,hash(body),body);
  fs.writeFileSync(path.join(root,'hello.mjs'),body);reconcile(s,a,root);
  assert.equal(s.db.prepare('SELECT state FROM operations WHERE id=?').get('crash').state,'done');
});
test('uncertain external edits block reconciliation',t=>{
  const {s,c}=fixture(t);s.submit(spec());const a=s.acquire('a'),root=taskWorkspace(c,a);
  s.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,'pending')").run('crash',a.id,'hello.mjs',null,hash('wanted'),'wanted');
  fs.writeFileSync(path.join(root,'hello.mjs'),'external');assert.throws(()=>reconcile(s,a,root),/Reconciliation/);
});
test('allowlist rejects traversal, secrets and Windows stream paths',()=>{
  for(const p of ['../x','.git/config','.env','foo.key','C:/x','x:secret','a\\b','logs/a','a/../b']) assert.throws(()=>spec({files:[p]}));
});
test('symlinks cannot escape even when task file is allowlisted',t=>{
  const {repo,dir}=fixture(t);const link=path.join(repo,'linked');
  try{fs.symlinkSync(dir,link,'junction');}catch{t.skip('OS cannot create test junction');return;}
  assert.throws(()=>safeFile(repo,'linked/private.txt',['linked/private.txt']),/Symlink/);
});
test('read-only profiles cannot write',t=>{
  const {s,c}=fixture(t);s.submit(spec({profile:'researcher'}));const a=s.acquire('a'),root=taskWorkspace(c,a);
  assert.throws(()=>writeFile(s,a,root,{path:'hello.mjs',text:'x',expected_hash:null}),/Read-only/);
  assert.equal(toolsFor('researcher').some(x=>x.function.name==='write_file'),false);
});
test('context rejects oversize contract and selects bounded complete tool groups',t=>{
  const {c}=fixture(t),task={id:'x',spec:spec(),checkpoint:{}};
  assert.throws(()=>buildContext({...c,context:2000},task,toolsFor('coder'),[]),/budget/);
  const history=[{role:'assistant',content:'',tool_calls:[{function:{name:'read_file',arguments:{path:'hello.mjs'}}}]},{role:'tool',tool_name:'read_file',content:'x'.repeat(15000)}];
  const built=buildContext(c,task,toolsFor('coder'),[],history);
  assert.ok(built.estimatedInput<=c.context-c.output-c.margin);
  assert.equal(built.messages.filter(m=>m.role==='tool').length,0);
});
test('private reports survive reopen and search returns excerpts',t=>{
  const {s,c}=fixture(t);s.addReport('synthetic',{summary:'quartz unique memory',evidence:'abc'});s.flushReports();
  const other=new Store(c);try{assert.equal(other.search('quartz')[0].task,'synthetic');}finally{other.close();}
  assert.equal(fs.readdirSync(path.join(c.repo)).includes('reports'),false);
});
test('real agent loop executes tools, validates and omits hidden reasoning',async t=>{
  const {s,c}=fixture(t);const task=s.submit(spec({acceptance:[{path:'hello.mjs',contains:'export const greet'}]}));
  const messages=[
    {tool_calls:[{function:{name:'read_file',arguments:{path:'hello.mjs'}}}]},
    {tool_calls:[{function:{name:'write_file',arguments:{path:'hello.mjs',expected_hash:null,text:'export const greet = "Hola";'}}}]},
    {tool_calls:[{function:{name:'check_syntax',arguments:{path:'hello.mjs'}}}]},
    {content:'Wrote greeting and checked syntax.',thinking:'DO NOT PERSIST THIS'}
  ];
  const result=await runOne(s,c,{chat:async()=>({message:messages.shift(),prompt_eval_count:10,eval_count:5})});
  assert.equal(result.state,'completed');assert.equal(s.metrics(task.id).length,4);
  assert.ok(!JSON.stringify(s.db.prepare('SELECT body FROM reports').all()).includes('DO NOT PERSIST'));
});
test('failed acceptance blocks completion',async t=>{
  const {s,c}=fixture(t);s.submit(spec({acceptance:[{path:'hello.mjs',contains:'needed'}]}));
  const result=await runOne(s,c,{chat:async()=>({message:{content:'done'}})});
  assert.equal(result.state,'blocked');assert.equal(result.result.assertions[0].passed,false);
});
test('step budget stops repeated model activity',async t=>{
  const {s,c}=fixture(t,{maxSteps:2});s.submit(spec());
  const result=await runOne(s,c,{chat:async()=>({message:{tool_calls:[{function:{name:'read_file',arguments:{path:'hello.mjs'}}}]}})});
  assert.equal(result.state,'blocked');assert.match(result.result.error,/step limit/);assert.equal(result.steps,2);
});
test('timeout cancels inference and records checkpoint',async t=>{
  const {s,c}=fixture(t,{maxSeconds:1});s.submit(spec());
  const result=await runOne(s,c,{chat:async(_c,_b,signal)=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}))});
  assert.equal(result.state,'blocked');assert.ok(result.checkpoint.workspace);
});
test('cloud quota exhaustion cannot prevent persisted local task execution',async t=>{
  const {s,c}=fixture(t);const queued=dispatch(s,'submit',{key:'before-quota',task:spec({origin:'grokbot'})});
  // Cloud provider is unavailable after submission; independent worker requires no cloud callback.
  const cloud=()=>{throw Object.assign(Error('quota exhausted'),{status:429});};assert.throws(cloud,/quota/);
  const completed=await runOne(s,c,{chat:async()=>({message:{content:'Local inspection finished; no cloud calls.'}})});
  assert.equal(completed.id,queued.id);assert.equal(completed.state,'completed');
});
test('restart retains task checkpoint and reclaims expired lease',async t=>{
  const {s,c}=fixture(t);s.submit(spec());const a=s.acquire('crashed');
  s.checkpoint(a,{last:{tool:'read_file',result:{hash:'known'}},next:'continue'},1,50);
  s.db.exec('UPDATE tasks SET lease=0; UPDATE worker SET lease=0');
  const other=new Store(c);try {
    const result=await runOne(other,c,{chat:async(_c,b)=>{assert.ok(JSON.stringify(b.messages).includes('known'));return {message:{content:'resumed'}};}});
    assert.equal(result.state,'completed');assert.equal(result.attempts,2);
  }finally{other.close();}
});
test('authenticated gateway rejects anonymous and browser-origin requests',async t=>{
  const {s,c}=fixture(t),server=makeServer(s,c);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const url=`http://127.0.0.1:${server.address().port}/rpc`;
    assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
    const token=credentials(c).delegate,headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://example.invalid'},body:'{}'})).status,403);
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'submit',args:{task:spec(),key:'http'}})});
    assert.equal(response.status,200);assert.equal((await response.json()).result.state,'queued');
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'resume',args:{id:'x'}})})).status,400);
  }finally{await new Promise(r=>server.close(r));}
});
