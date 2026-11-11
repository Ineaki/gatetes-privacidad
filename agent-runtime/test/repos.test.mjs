// CEO-029: el puente rechazaba con «repo must be Ineaki/gatetes» todo encargo local (checker/ollama)
// que nombrase otro repo de Ineaki, p. ej. los del panel con repo Ineaki/gatetes-agent-vault.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { taskWorkspace } from '../src/workspace.mjs';
import { parseInstruction } from '../src/remote.mjs';

const ENV=['AGENT_REMOTE','AGENT_ORQ_REPOS','AGENT_ALLOWED_REPOS'];
function gitRepo(dir,name,file,body) {
  const repo=path.join(dir,name);fs.mkdirSync(path.dirname(path.join(repo,file)),{recursive:true});
  const g=(...a)=>execFileSync('git',['-C',repo,...a],{encoding:'utf8',stdio:'pipe',windowsHide:true}).trim();
  g('init','-q');g('config','user.name','t');g('config','user.email','t@example.invalid');
  fs.writeFileSync(path.join(repo,file),body);g('add','.');g('commit','-qm','fixture');
  return {repo,head:g('rev-parse','HEAD')};
}
function fixture(t,env={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repos-test-'));
  const home=gitRepo(dir,'gatetes','app/caida.py','x = 1\n');
  const vault=gitRepo(dir,'vault-mirror','panel-contexto/actividad.md','- 05/11 actividad\n');
  const demanda=gitRepo(dir,'demanda','docs/WF01.md','# WF01\n');
  const saved={};for(const k of ENV){saved[k]=process.env[k];delete process.env[k];}
  const defaults={AGENT_REMOTE:vault.repo,AGENT_ORQ_REPOS:JSON.stringify({'Ineaki/generacion-de-demanda':demanda.repo})};
  for(const [k,v] of Object.entries({...defaults,...env})) if(v===null) delete process.env[k]; else process.env[k]=v;
  t.after(()=>{for(const k of ENV){if(saved[k]===undefined) delete process.env[k]; else process.env[k]=saved[k];}fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});});
  const c=config({repo:home.repo,vault:path.join(dir,'private'),lockDir:path.join(dir,'lock')});c.repoName='Ineaki/gatetes';
  return {c,dir,home,vault,demanda};
}
const panel=(repo,extra={})=>({kind:'task',key:'panel-20261105-221514',task:{goal:'Mensaje del usuario: ¿como vamos? Contesta en español en 2 frases.',
  profile:'checker',engine:'ollama',...(repo===undefined?{}:{repo}),files:['panel-contexto/actividad.md'],acceptance:['Responde en español en 2 frases'],origin:'usuario-panel',...extra}});
const pinned=head=>()=>({baseCommit:head});

test('panel checker on Ineaki/gatetes-agent-vault is accepted (was «repo must be Ineaki/gatetes») and runs in that clone',t=>{
  const {c,vault}=fixture(t);
  const spec=parseInstruction(panel('Ineaki/gatetes-agent-vault'),c,pinned('a'.repeat(40)),clone=>{assert.equal(clone,vault.repo);return pinned(vault.head);});
  assert.equal(spec.repo,'Ineaki/gatetes-agent-vault');
  assert.equal(parseInstruction(panel('ineaki/GATETES-agent-vault'),c,pinned('a'.repeat(40)),()=>pinned(vault.head)).repo,'Ineaki/gatetes-agent-vault','case-insensitive, canonical name');assert.equal(spec.baseCommit,vault.head);assert.equal(spec.profile,'checker');
  const s=new Store(c);
  const task=s.submitUnique(spec,'remote-panel-20261105-221514');
  const root=taskWorkspace(c,task);
  assert.ok(fs.existsSync(path.join(root,'panel-contexto/actividad.md')),'worktree comes from the gatetes-agent-vault clone');
  s.db.close();
});

test('Ineaki/generacion-de-demanda and Ineaki/gatetes are accepted; home repo keeps old spec shape',t=>{
  const {c,demanda}=fixture(t);
  const d=parseInstruction(panel('Ineaki/generacion-de-demanda',{files:['docs/WF01.md']}),c,pinned('a'.repeat(40)),clone=>{assert.equal(clone,demanda.repo);return pinned(demanda.head);});
  assert.equal(d.repo,'Ineaki/generacion-de-demanda');assert.equal(d.baseCommit,demanda.head);
  for(const repo of ['Ineaki/gatetes',undefined,'']) {
    const g=parseInstruction(panel(repo,{files:['app/caida.py']}),c,pinned('b'.repeat(40)),()=>assert.fail('home repo uses resolveCommit'));
    assert.equal(g.repo,undefined,'home repo is not stored, so old idempotency keys still match');assert.equal(g.baseCommit,'b'.repeat(40));
  }
});

test('repos outside the allowlist or outside owner Ineaki are still rejected, even with a local clone',t=>{
  const {c,dir}=fixture(t,{AGENT_ORQ_REPOS:JSON.stringify({'otro/gatetes':'x','Ineaki/otro':'y'})});
  const resolve=pinned('a'.repeat(40));
  for(const repo of ['otro/gatetes','Ineaki/otro','inaki/gatetes-agent-vault','Ineaki/gatetes/../x','Ineaki-fake/gatetes',42]) {
    assert.throws(()=>parseInstruction(panel(repo),c,resolve,()=>resolve),/not allowed|repo is required/,`local route rejects ${repo}`);
    assert.throws(()=>parseInstruction(panel(repo,{profile:'reviewer',engine:'codex'}),c,resolve,()=>resolve),/not allowed|repo is required/,`orq route rejects ${repo}`);
  }
  assert.ok(dir);
});

test('allowlist is configurable with AGENT_ALLOWED_REPOS but limited to owner Ineaki',t=>{
  const {c,dir}=fixture(t,{AGENT_ALLOWED_REPOS:'Ineaki/gatetes, Ineaki/nuevo'});
  const nuevo=gitRepo(dir,'nuevo','README.md','# nuevo\n');
  process.env.AGENT_ORQ_REPOS=JSON.stringify({'Ineaki/nuevo':nuevo.repo});
  const resolve=pinned('a'.repeat(40));
  assert.equal(parseInstruction(panel('Ineaki/nuevo',{files:['README.md']}),c,resolve,()=>pinned(nuevo.head)).repo,'Ineaki/nuevo');
  assert.throws(()=>parseInstruction(panel('Ineaki/gatetes-agent-vault'),c,resolve,()=>resolve),/not allowed/,'list replaces the default');
  process.env.AGENT_ALLOWED_REPOS='Ineaki/gatetes,otro/repo';
  assert.throws(()=>parseInstruction(panel('otro/repo'),c,resolve,()=>resolve),/only accepts Ineaki\//);
});

test('allowed repo without a local clone gets an explicit reason',t=>{
  const {c}=fixture(t,{AGENT_ORQ_REPOS:null});
  const resolve=pinned('a'.repeat(40));
  assert.throws(()=>parseInstruction(panel('Ineaki/generacion-de-demanda'),c,resolve,()=>resolve),/no local clone/);
});
