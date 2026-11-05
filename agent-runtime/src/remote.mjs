import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateSpec } from './workspace.mjs';
import { scrub, containsSecret } from './guard.mjs';

const safeJson = v => scrub(JSON.stringify(v,null,2))+'\n';
const git = (repo,args) => execFileSync('git',['-C',repo,...args],{encoding:'utf8',timeout:60000,windowsHide:true,maxBuffer:1_000_000,stdio:['ignore','pipe','pipe']}).trim();
const writeChanged = (file,body) => {fs.mkdirSync(path.dirname(file),{recursive:true});if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==body) fs.writeFileSync(file,body,{mode:0o600});};
const push = remote => git(remote,['-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push','origin','main']);
export const keyPattern=/^[a-z0-9][a-z0-9._-]{2,79}$/i;

// Grok Bot / Fox contract (conocimiento/protocolo.md), restricted to what runs locally on Ollama.
export function parseInstruction(value,c,resolveCommit) {
  if(!value||value.kind!=='task'||typeof value.key!=='string'||!keyPattern.test(value.key)) throw Error('Expected {"kind":"task","key":"<3-80 chars a-z0-9._->"}');
  const t=value.task;
  if(!t||typeof t!=='object') throw Error('Missing task object');
  if(t.engine!==undefined&&t.engine!=='ollama') throw Error(`engine "${t.engine}" is not local; only "ollama" (or no engine) is accepted`);
  const profile={reviewer:'reviewer',checker:'checker'}[t.profile];
  if(!profile) throw Error(`profile "${t.profile}" not accepted; use "reviewer" or "checker" (implementer needs a cloud engine)`);
  if(typeof t.goal!=='string'||t.goal.trim().length<20||t.goal.length>1000) throw Error('goal must be 20-1000 characters');
  if(!Array.isArray(t.files)||t.files.length<1||t.files.length>4) throw Error('files must list 1-4 explicit paths');
  if(!Array.isArray(t.acceptance)||t.acceptance.length<1||t.acceptance.length>5) throw Error('acceptance must list 1-5 criteria');
  if(t.repo!==undefined&&t.repo!==c.repoName) throw Error(`repo must be ${c.repoName}`);
  const tests=[],criteria=[],acceptance=[];
  for(const a of t.acceptance) {
    if(a&&typeof a==='object'&&typeof a.path==='string') {acceptance.push({path:a.path,contains:a.contains});continue;}
    if(typeof a!=='string') throw Error('acceptance items must be strings or {path,contains}');
    const m=/^\s*(?:python -m\s+)?pytest\s+(\S+\.py)\b/.exec(a);
    if(m) tests.push(m[1]); else criteria.push(a.trim());
  }
  if(t.pr!==undefined&&(!Number.isInteger(t.pr)||t.pr<1)) throw Error('pr must be a positive integer');
  if(t.branch!==undefined&&(typeof t.branch!=='string'||!/^[\w./-]{1,120}$/.test(t.branch)||t.branch.includes('..'))) throw Error('invalid branch name');
  const {baseCommit,diffBase}=resolveCommit({pr:t.pr,branch:t.branch});
  return validateSpec({goal:t.goal,profile,files:t.files,tests,criteria,acceptance,baseCommit,diffBase,origin:String(t.origin??'grokbot-remoto').slice(0,40)});
}

// Instructions name a PR or branch; work is always pinned to the exact fetched commit.
function commitResolver(repo) {
  return ({pr,branch})=>{
    if(pr) {
      git(repo,['fetch','-q','origin','main',`+refs/pull/${pr}/head:refs/remotes/pr/${pr}`]);
      const head=git(repo,['rev-parse',`refs/remotes/pr/${pr}^{commit}`]);
      return {baseCommit:head,diffBase:git(repo,['merge-base','origin/main',head])};
    }
    if(branch) {
      git(repo,['fetch','-q','origin','main',`+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      const head=git(repo,['rev-parse',`refs/remotes/origin/${branch}^{commit}`]);
      return {baseCommit:head,diffBase:git(repo,['merge-base','origin/main',head])};
    }
    git(repo,['fetch','-q','origin','main']);
    return {baseCommit:git(repo,['rev-parse','origin/main^{commit}'])};
  };
}

export function repoName(repo) {
  const url=git(repo,['remote','get-url','origin']);
  return /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url)?.[1]??null;
}
const latestReport=(store,id)=>store.db.prepare('SELECT id FROM reports WHERE task=? ORDER BY created DESC LIMIT 1').get(id)?.id??null;

export function syncRemote(store,c,remote) {
  if(!remote||!fs.existsSync(path.join(remote,'.git'))) throw Error('Private remote checkout required');
  git(remote,['pull','-q','--rebase','origin','main']);
  c.repoName??=repoName(c.repo);
  const inbox=path.join(remote,'inbox'),receipts=path.join(remote,'receipts');
  fs.mkdirSync(inbox,{recursive:true});fs.mkdirSync(receipts,{recursive:true});
  const resolve=commitResolver(c.repo);
  for(const name of fs.readdirSync(inbox)) {
    if(!name.endsWith('.json')||fs.existsSync(path.join(receipts,name))) continue;
    const file=path.join(inbox,name), receivedAt=new Date().toISOString();
    let receipt;
    try {
      if(!/^[a-zA-Z0-9._-]{1,84}\.json$/.test(name)||!fs.statSync(file).isFile()) throw Error('Invalid inbox file name');
      if(fs.statSync(file).size>8000) throw Error('Instruction too large (max 8 KB)');
      const raw=fs.readFileSync(file,'utf8');
      if(containsSecret(raw)) throw Error('Instruction contains a credential-like value; rejected without processing');
      const value=JSON.parse(raw);
      if(`${value.key}.json`!==name) throw Error('File name must be <key>.json');
      const spec=parseInstruction(value,c,resolve);
      const task=store.submitUnique(spec,`remote-${value.key}`);
      store.event(task.id,'remote_instruction',{file:name,key:value.key,origin:spec.origin,instruction:value});
      receipt={key:value.key,status:'accepted',taskId:task.id,state:task.state,receivedAt,commit:spec.baseCommit,task:`tasks/${task.id}.json`};
    } catch(e) {
      store.event(null,'remote_rejected',{file:name,error:String(e.message).slice(0,300)});
      receipt={key:name.replace(/\.json$/,''),status:'rejected',reason:String(e.message).slice(0,300),receivedAt};
    }
    writeChanged(path.join(receipts,name),safeJson(receipt));
  }
  // Receipts double as the per-instruction status page and are refreshed until the task ends.
  for(const name of fs.readdirSync(receipts).filter(n=>n.endsWith('.json'))) {
    const receipt=JSON.parse(fs.readFileSync(path.join(receipts,name),'utf8'));
    if(receipt.status!=='accepted'||!receipt.taskId) continue;
    const row=store.get(receipt.taskId); if(!row) continue;
    const report=latestReport(store,row.id);
    writeChanged(path.join(receipts,name),safeJson({...receipt,state:row.state,steps:row.steps,updatedAt:new Date(row.updated).toISOString(),
      verdict:row.result?.review?.verdict,reason:row.result?.error,report:report&&['completed','blocked','failed','cancelled'].includes(row.state)?`reports/${report}.md`:undefined}));
  }
  const tasks=store.list();
  const campaignFile=path.join(c.vault,'campaign.json');
  if(fs.existsSync(campaignFile)) writeChanged(path.join(remote,'campaign.json'),scrub(fs.readFileSync(campaignFile,'utf8')));
  const flat=e=>safeJson({at:new Date(e.created).toISOString(),kind:e.kind,...JSON.parse(e.body)}).trim().replace(/\n\s*/g,'');
  const campaignEvents=store.db.prepare('SELECT kind,body,created FROM events WHERE task IS NULL ORDER BY created,id').all();
  writeChanged(path.join(remote,'campaign-events.jsonl'),campaignEvents.map(flat).join('\n')+'\n');
  writeChanged(path.join(remote,'status.json'),safeJson({updatedAt:new Date().toISOString(),worker:'local-ollama',model:c.model,
    tasks:tasks.map(t=>{const row=store.get(t.id);return {id:t.id,key:row.key,state:t.state,profile:row.spec.profile,steps:t.steps,attempts:t.attempts,updated:new Date(t.updated).toISOString(),verdict:row.result?.review?.verdict,reason:row.result?.error?.slice(0,200)};})}));
  for(const t of tasks) {
    const row=store.get(t.id), r=row.result;
    writeChanged(path.join(remote,'tasks',`${t.id}.json`),safeJson({id:t.id,key:row.key,state:row.state,goal:row.spec.goal,profile:row.spec.profile,files:row.spec.files,tests:row.spec.tests,criteria:row.spec.criteria,
      baseCommit:row.spec.baseCommit,diffBase:row.spec.diffBase,origin:row.spec.origin,steps:row.steps,attempts:row.attempts,
      result:r&&{summary:r.summary,summary_source:r.summary_source,error:r.error,reason:r.reason,review:r.review,tests:r.tests,coverage:r.coverage,acceptance:r.acceptance,assertions:r.assertions,checks:r.checks,branch:r.branch},
      report:latestReport(store,t.id)&&`reports/${latestReport(store,t.id)}.md`}));
    const events=store.db.prepare('SELECT kind,body,created FROM events WHERE task=? ORDER BY created,id').all(t.id);
    writeChanged(path.join(remote,'events',`${t.id}.jsonl`),events.map(flat).join('\n')+'\n');
    const metrics=store.metrics(t.id).map(m=>({at:m.at,model:m.model,input_tokens:m.input_tokens,output_tokens:m.output_tokens,duration_ms:m.duration_ms,cloud:m.cloud,error:m.error}));
    writeChanged(path.join(remote,'metrics',`${t.id}.json`),safeJson(metrics));
    for(const report of store.db.prepare('SELECT id,file FROM reports WHERE task=? ORDER BY created').all(t.id)) if(fs.existsSync(report.file)) writeChanged(path.join(remote,'reports',`${report.id}.md`),scrub(fs.readFileSync(report.file,'utf8')));
  }
  // Only the explicit mirror directories are staged. Credentials, prompts and raw SQLite never enter Git.
  const stage=['campaign.json','campaign-events.jsonl','status.json','tasks','events','metrics','reports','receipts'].filter(p=>fs.existsSync(path.join(remote,p)));
  git(remote,['add','--',...stage]);
  const staged=git(remote,['diff','--cached','--name-only']);
  if(!staged) return {tasks:tasks.length,pushed:false};
  if(staged.split('\n').some(p=>/\.sqlite|credentials|\.env/i.test(p))||containsSecret(git(remote,['diff','--cached']))) {
    git(remote,['reset','-q']);throw Error('Refusing to sync: staged mirror contains a forbidden file or credential-like value');
  }
  git(remote,['-c','user.name=Gatetes Local','-c','user.email=gatetes-local@users.noreply.github.com','commit','-q','-m','Sync local agent activity']);
  try { push(remote); } catch { git(remote,['pull','-q','--rebase','origin','main']); push(remote); }
  return {tasks:tasks.length,pushed:true};
}
