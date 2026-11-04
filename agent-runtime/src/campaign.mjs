import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { Store } from './store.mjs';
import { validateSpec,git } from './workspace.mjs';
import { runOne } from './worker.mjs';
import { syncRemote } from './remote.mjs';

const c=config(),store=new Store(c),stateFile=path.join(c.vault,'campaign.json');
const remote=process.env.AGENT_REMOTE;
const save=s=>{const tmp=stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s,null,2),{mode:0o600,flush:true});fs.renameSync(tmp,stateFile);};
const read=()=>JSON.parse(fs.readFileSync(stateFile,'utf8'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const record=(kind,body)=>store.event(null,kind,body);

// A PR job is exactly one grounded review pinned to the PR head; there is no model planner to repeat it.
function jobSpec(item) {
  const tests=item.test?[item.test.startsWith('mascota_py/')?item.test:`mascota_py/${item.test}`]:[];
  return validateSpec({goal:item.objective,profile:'reviewer',files:[...new Set([...item.files,...tests])],tests,criteria:item.criteria??[],
    baseCommit:item.baseCommit,diffBase:item.diffBase,origin:`campaign-pr-${item.pr}`});
}
const prHead=pr=>git(c.repo,['ls-remote','origin',`refs/pull/${pr}/head`]).split(/\s+/)[0]||null;

async function cycle() {
  const state=read();
  if(state.status!=='running') return;
  const item=state.jobs[state.index];
  if(!item) {state.status='ready_for_review';save(state);record('campaign_ready',{jobs:state.jobs.map(j=>({pr:j.pr,state:j.state}))});return;}
  if(item.skip) {item.state='skipped';state.index++;save(state);record('job_skipped',{pr:item.pr,reason:item.skip});return;}
  // Stop instead of reviewing stale code: a moved PR head needs a new, explicit seed.
  const head=prHead(item.pr);
  if(head!==item.baseCommit) throw Error(`PR #${item.pr} head moved to ${head?.slice(0,7)??'unknown'} (seeded ${item.baseCommit.slice(0,7)}); re-seed before reviewing`);
  let task=state.currentTask?store.get(state.currentTask):null;
  if(!task) {
    task=store.submitUnique(jobSpec(item),`campaign-${state.id}-pr-${item.pr}`);
    state.currentTask=task.id;save(state);record('review_created',{pr:item.pr,task:task.id,files:task.spec.files});
  }
  while(['queued','running'].includes(task.state)) {const worked=await runOne(store,c);if(!worked) await pause(1000);task=store.get(task.id);}
  // An operator may have blocked or paused the campaign while the review ran: never overwrite that decision.
  if(read().status!=='running') return;
  if(task.state!=='completed') throw Error(`PR #${item.pr} review ${task.id} ${task.state}: ${task.result?.error??task.result?.acceptance??'inspect report'}`);
  const r=task.result.review;
  item.state='reviewed';item.review={task:task.id,verdict:r.verdict,findings:r.findings.length,tests:task.result.tests.map(t=>`${t.path}: exit ${t.exit}`)};
  state.currentTask=null;state.index++;save(state);record('job_reviewed',{pr:item.pr,task:task.id,verdict:r.verdict,findings:r.findings.length});
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
  const sync=()=>{if(!remote)return;try{syncRemote(store,c,remote);}catch(e){fs.appendFileSync(path.join(c.vault,'remote-errors.log'),new Date().toISOString()+' '+String(e.message).slice(0,300)+'\n');}};
  // Idle loop touches only SQLite and Git; the model is called only when a task is queued.
  while(true) {
    sync();
    try {if(fs.existsSync(stateFile)) await cycle();} catch(e) {const s=read();s.status='blocked';s.error=String(e.message).slice(0,500);save(s);record('campaign_blocked',{error:s.error});}
    while(store.list().some(t=>t.state==='queued')) {if(!await runOne(store,c)) break; sync();}
    await pause(fs.existsSync(stateFile)&&read().status==='running'?1000:60000);
  }
}

const command=process.argv[2];
try {
  if(command==='init') {
    if(fs.existsSync(stateFile)) {
      const old=read();
      if(old.status==='running') throw Error('Campaign is running; block it before re-seeding');
      fs.renameSync(stateFile,path.join(c.vault,`campaign.${old.id}.${Date.now()}.json`));
    }
    const seed=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
    if(!Array.isArray(seed.jobs)||seed.jobs.length<1||seed.jobs.length>8) throw Error('Seed must contain 1-8 jobs');
    git(c.repo,['fetch','-q','origin','main',...seed.jobs.map(j=>`+refs/pull/${j.pr}/head:refs/remotes/pr/${j.pr}`)]);
    const jobs=seed.jobs.map(j=>{
      if(!Number.isInteger(j.pr)||!/^[a-f0-9]{40}$/.test(j.baseCommit)||typeof j.objective!=='string'||j.objective.length>500||!Array.isArray(j.files)||j.files.length>4) throw Error('Invalid job');
      git(c.repo,['cat-file','-e',`${j.baseCommit}^{commit}`]);
      const job={...j,diffBase:git(c.repo,['merge-base','origin/main',j.baseCommit]),state:'pending'};
      if(!j.skip) jobSpec(job);
      return job;
    });
    save({id:seed.id,status:'paused',index:0,currentTask:null,jobs});record('campaign_seeded',{id:seed.id,jobs:jobs.map(j=>j.pr)});
    console.log('Campaign seeded (paused). Run "start" to begin.');
  } else if(command==='serve') await serve();
  else if(command==='status') console.log(JSON.stringify(read(),null,2));
  else if(command==='start') {const s=read();if(s.status==='running') throw Error('Already running');s.status='running';delete s.error;save(s);record('campaign_resumed',{index:s.index});console.log('Campaign set to running.');}
  else if(command==='block') {const s=read();const reason=process.argv.slice(3).join(' ').trim();if(!reason) throw Error('Reason required');s.status='blocked';s.error=reason.slice(0,700);if(s.currentTask) store.cancel(s.currentTask);save(s);record('campaign_blocked',{error:s.error,by:'operator',cancelled:s.currentTask});console.log('Campaign blocked.');}
  else if(command==='pause') {const s=read();s.status='paused';save(s);record('campaign_paused',{index:s.index});console.log('Campaign paused.');}
  else throw Error('Use init seed.json | start | pause | serve | status');
} catch(e) {console.error(e.message);process.exitCode=1;}
if(command!=='serve') store.close();
