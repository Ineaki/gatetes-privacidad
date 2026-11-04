import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateSpec } from './workspace.mjs';

const scrub = s => String(s).replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{16,})\b/g,'[REDACTED]').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]');
const safeJson = v => scrub(JSON.stringify(v,null,2))+'\n';
const git = (remote,args) => execFileSync('git',['-C',remote,...args],{encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:100000}).trim();
const writeChanged = (file,body) => {fs.mkdirSync(path.dirname(file),{recursive:true});if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==body) fs.writeFileSync(file,body,{mode:0o600});};

export function syncRemote(store,c,remote) {
  if(!remote||!fs.existsSync(path.join(remote,'.git'))) throw Error('Private remote checkout required');
  git(remote,['pull','--rebase','origin','main']);
  const inbox=path.join(remote,'inbox'),receipts=path.join(remote,'receipts');
  fs.mkdirSync(inbox,{recursive:true});fs.mkdirSync(receipts,{recursive:true});
  for(const name of fs.readdirSync(inbox)) {
    if(!/^[a-zA-Z0-9_-]{1,80}\.json$/.test(name)||fs.existsSync(path.join(receipts,name))) continue;
    const file=path.join(inbox,name);
    if(!fs.statSync(file).isFile()) continue;
    let receipt;
    try {
      if(fs.statSync(file).size>16000) throw Error('Instruction too large');
      const value=JSON.parse(fs.readFileSync(file,'utf8'));
      if(value.kind!=='task'||typeof value.key!=='string'||value.key.length>80) throw Error('Expected task with bounded key');
      const spec=validateSpec(value.task);
      if(spec.baseCommit&&!/^[a-f0-9]{40}$/.test(git(c.repo,['rev-parse',`${spec.baseCommit}^{commit}`]))) throw Error('Unknown base commit');
      const task=store.submit(spec,value.key);
      receipt={taskId:task.id,state:task.state,acceptedAt:new Date().toISOString()};
      store.event(task.id,'remote_instruction',{file:name});
    } catch(e) { receipt={error:String(e.message).slice(0,300),rejectedAt:new Date().toISOString()}; }
    writeChanged(path.join(receipts,name),safeJson(receipt));
  }
  const tasks=store.list();
  const campaignFile=path.join(c.vault,'campaign.json');
  if(fs.existsSync(campaignFile)) writeChanged(path.join(remote,'campaign.json'),scrub(fs.readFileSync(campaignFile,'utf8')));
  const campaignEvents=store.db.prepare('SELECT kind,body,created FROM events WHERE task IS NULL ORDER BY created,id').all();
  writeChanged(path.join(remote,'campaign-events.jsonl'),campaignEvents.map(e=>safeJson({at:new Date(e.created).toISOString(),kind:e.kind,...JSON.parse(e.body)}).trim().replace(/\n\s*/g,'')).join('\n')+'\n');
  writeChanged(path.join(remote,'status.json'),safeJson({updatedAt:tasks.length?new Date(Math.max(...tasks.map(t=>t.updated))).toISOString():null,tasks:tasks.map(t=>({id:t.id,state:t.state,steps:t.steps,attempts:t.attempts,updated:t.updated}))}));
  for(const t of tasks) {
    const row=store.get(t.id);
    writeChanged(path.join(remote,'tasks',`${t.id}.json`),safeJson({id:t.id,state:row.state,goal:row.spec.goal,profile:row.spec.profile,files:row.spec.files,baseCommit:row.spec.baseCommit,steps:row.steps,attempts:row.attempts,result:row.result&&{summary:row.result.summary,error:row.result.error,assertions:row.result.assertions,checks:row.result.checks,branch:row.result.branch}}));
    const events=store.db.prepare('SELECT kind,body,created FROM events WHERE task=? ORDER BY created,id').all(t.id);
    writeChanged(path.join(remote,'events',`${t.id}.jsonl`),events.map(e=>safeJson({at:new Date(e.created).toISOString(),kind:e.kind,...JSON.parse(e.body)}).trim().replace(/\n\s*/g,'')).join('\n')+'\n');
    const metrics=store.metrics(t.id).map(m=>({at:m.at,model:m.model,input_tokens:m.input_tokens,output_tokens:m.output_tokens,duration_ms:m.duration_ms,cloud:m.cloud,error:m.error}));
    writeChanged(path.join(remote,'metrics',`${t.id}.json`),safeJson(metrics));
    for(const report of store.db.prepare('SELECT id,file FROM reports WHERE task=? ORDER BY created').all(t.id)) if(fs.existsSync(report.file)) writeChanged(path.join(remote,'reports',`${report.id}.md`),scrub(fs.readFileSync(report.file,'utf8')));
  }
  // Only the explicit mirror directories are staged. Credentials and raw SQLite never enter Git.
  const stage=['campaign.json','campaign-events.jsonl','status.json','tasks','events','metrics','reports','receipts'].filter(p=>fs.existsSync(path.join(remote,p)));
  git(remote,['add','--',...stage]);
  if(git(remote,['diff','--cached','--name-only'])) {
    git(remote,['-c','user.name=Gatetes Local','-c','user.email=gatetes-local@users.noreply.github.com','commit','-m','Sync local agent activity']);
    try { git(remote,['-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push','origin','main']); }
    catch { git(remote,['pull','--rebase','origin','main']);git(remote,['-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push','origin','main']); }
  }
  return {tasks:tasks.length,accepted:fs.readdirSync(receipts).length};
}
