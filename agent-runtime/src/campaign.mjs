import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from './config.mjs';
import { Store } from './store.mjs';
import { validateSpec,git } from './workspace.mjs';
import { ollamaChat,runOne } from './worker.mjs';
import { syncRemote } from './remote.mjs';

const c=config(),store=new Store(c),stateFile=path.join(c.vault,'campaign.json');
const remote=process.env.AGENT_REMOTE;
const python=process.env.AGENT_PYTHON??'py',pythonPrefix=python==='py'?['-3.13']:[];
const save=s=>{const tmp=stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s,null,2),{mode:0o600,flush:true});fs.renameSync(tmp,stateFile);};
const read=()=>JSON.parse(fs.readFileSync(stateFile,'utf8'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const record=(kind,body)=>store.event(null,kind,body);

async function plan(item,last,steps) {
  const task={objective:item.objective,pr:item.pr,baseCommit:item.currentCommit,allowedFiles:item.files,lastResult:last,steps,maxSteps:item.maxSteps??3};
  const response=await ollamaChat(c,{model:c.model,stream:false,format:'json',think:false,keep_alive:'5m',options:{num_ctx:4096,num_predict:420,temperature:0},messages:[
    {role:'system',content:'You are the local Gatetes orchestrator. Return JSON only: {"done":boolean,"goal":string,"profile":"coder"|"researcher"|"reviewer","files":string[],"acceptance":[]}. Produce ONE smallest useful microtask or done. First step must be reviewer. Max 2 files; use only exact allowed file names. No cloud, shell, delegation, credential access, merge, or publishing. Do not repeat completed work. If uncertain, use reviewer. Keep goal under 400 characters. /no_think'},
    {role:'user',content:JSON.stringify(task)}]},new AbortController().signal);
  store.metric(null,{kind:'planner',model:c.model,input_tokens:response.prompt_eval_count??null,output_tokens:response.eval_count??null,duration_ms:response.total_duration?Math.round(response.total_duration/1e6):null,cloud:false});
  if(response.done_reason==='length') throw Error('Planner output limit');
  const value=JSON.parse(response.message?.content??'');
  if(typeof value.done!=='boolean') throw Error('Planner decision missing');
  if(value.done) {if(!steps) throw Error('Planner cannot skip first review');return {done:true};}
  const files=value.files;
  if(!Array.isArray(files)||files.length<1||files.length>2||files.some(f=>!item.files.includes(f))) throw Error('Planner selected files outside job');
  const spec=validateSpec({goal:value.goal,profile:value.profile,files,acceptance:value.acceptance??[],baseCommit:item.currentCommit,origin:`campaign-pr-${item.pr}`});
  if(steps===0&&spec.profile!=='reviewer') throw Error('First microtask must review existing work');
  if(spec.goal.length>400) throw Error('Microtask too broad');
  return {done:false,spec};
}

function verifyAndCommit(item,task) {
  const root=task.result?.workspace;
  if(!root) throw Error('Task has no worktree');
  const changed=git(root,['diff','--name-only']);
  if(changed) {
    const paths=changed.split(/\r?\n/).filter(Boolean);
    if(paths.some(p=>!task.spec.files.includes(p))) throw Error('Change outside microtask allowlist');
    const py=paths.filter(p=>p.endsWith('.py'));
    if(py.length) execFileSync(python,[...pythonPrefix,'-m','py_compile',...py],{cwd:root,timeout:30000,windowsHide:true,stdio:'pipe'});
  }
  if(item.test) {
    const test=execFileSync(python,[...pythonPrefix,'-m','pytest',item.test,'-q'],{cwd:path.join(root,'mascota_py'),timeout:180000,windowsHide:true,encoding:'utf8',maxBuffer:30000});
    record('test_passed',{pr:item.pr,task:task.id,output:test.trim().slice(-500)});
  }
  if(!changed) return item.currentCommit;
  git(root,['add','--',...task.spec.files]);
  const staged=git(root,['diff','--cached','--name-only']);
  if(!staged) return item.currentCommit;
  git(root,['-c','user.name=Gatetes Local','-c','user.email=gatetes-local@users.noreply.github.com','commit','-m',`Local microtask for PR #${item.pr}`]);
  return git(root,['rev-parse','HEAD']);
}

async function cycle() {
  let state=read();
  if(state.status!=='running') return;
  const item=state.jobs[state.index];
  if(!item) {state.status='ready_for_review';save(state);record('campaign_ready',{jobs:state.jobs.length});return;}
  if(item.steps>=(item.maxSteps??3)) throw Error(`PR #${item.pr} reached microtask limit`);
  let task;
  if(state.currentTask) task=store.get(state.currentTask);
  else {
    const decision=await plan(item,item.lastResult??null,item.steps);
    if(decision.done) {item.state='reviewed';state.index++;save(state);record('job_reviewed',{pr:item.pr});return;}
    task=store.submit(decision.spec,`campaign-${state.id}-${item.pr}-${item.steps}`);
    state.currentTask=task.id;save(state);record('microtask_created',{pr:item.pr,task:task.id,profile:task.spec.profile,files:task.spec.files});
  }
  while(['queued','running'].includes(task.state)) {const worked=await runOne(store,c);if(!worked) await pause(1000);task=store.get(task.id);}
  if(task.state!=='completed') throw Error(`PR #${item.pr} task ${task.id} ${task.state}: ${task.result?.error??'inspect report'}`);
  item.currentCommit=verifyAndCommit(item,task);
  item.steps++;
  item.lastResult={task:task.id,summary:String(task.result?.summary??'').slice(0,600),assertions:task.result?.assertions,commit:item.currentCommit};
  state.currentTask=null;save(state);record('microtask_completed',{pr:item.pr,task:task.id,commit:item.currentCommit});
}

async function serve() {
  const lock=path.join(c.vault,'campaign.pid');
  if(fs.existsSync(lock)) {
    const old=Number(fs.readFileSync(lock,'utf8'));
    try {process.kill(old,0);throw Error(`Campaign already running (PID ${old})`);} catch(e) {if(e.code!=='ESRCH') throw e;}
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
  process.once('exit',()=>{try{fs.unlinkSync(lock);}catch{}});
  const sync=()=>{if(!remote)return;try{syncRemote(store,c,remote);}catch(e){fs.appendFileSync(path.join(c.vault,'remote-errors.log'),new Date().toISOString()+' '+e.message.slice(0,300)+'\n');}};
  setInterval(sync,60000);sync();
  while(true) {
    try {await cycle();} catch(e) {const s=read();s.status='blocked';s.error=String(e.message).slice(0,500);save(s);record('campaign_blocked',{error:s.error});}
    sync();
    const s=read();
    if(s.status!=='running') {
      const queued=store.list().some(t=>t.state==='queued');
      if(queued) await runOne(store,c);
      await pause(60000);
    }
  }
}

const command=process.argv[2];
try {
  if(command==='init') {
    if(fs.existsSync(stateFile)) throw Error('Campaign already initialized');
    const seed=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
    if(!Array.isArray(seed.jobs)||seed.jobs.length<1||seed.jobs.length>8) throw Error('Seed must contain 1-8 jobs');
    const jobs=seed.jobs.map(j=>{
      if(!Number.isInteger(j.pr)||!/^[a-f0-9]{40}$/.test(j.baseCommit)||typeof j.objective!=='string'||j.objective.length>500||!Array.isArray(j.files)||j.files.length>12) throw Error('Invalid job');
      j.files.forEach(f=>validateSpec({goal:'check',files:[f]}));
      git(c.repo,['cat-file','-e',`${j.baseCommit}^{commit}`]);
      return {...j,currentCommit:j.baseCommit,steps:0,state:'pending'};
    });
    save({id:seed.id,status:'running',index:0,currentTask:null,jobs});record('campaign_started',{id:seed.id,jobs:jobs.map(j=>j.pr)});console.log('Campaign initialized in private vault.');
  } else if(command==='serve') await serve();
  else if(command==='status') console.log(JSON.stringify(read(),null,2));
  else throw Error('Use init seed.json | serve | status');
} catch(e) {console.error(e.message);process.exitCode=1;}
if(command!=='serve') store.close();
