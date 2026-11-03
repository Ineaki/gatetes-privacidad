import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { credentials } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

const c=config(),keys=credentials(c);
const rpc=async(action,args)=>{
  const r=await fetch(`http://127.0.0.1:${c.port}/rpc`,{method:'POST',headers:{Authorization:`Bearer ${keys.delegate}`,'Content-Type':'application/json'},body:JSON.stringify({action,args}),signal:AbortSignal.timeout(5000)});
  const x=await r.json();if(!r.ok)throw Error(x.error);return x.result;
};
const task=JSON.parse(fs.readFileSync(new URL('./task.json',import.meta.url),'utf8'));
const accepted=await rpc('submit',{task,key:'synthetic-http-'+Date.now()});
let result;
for(let i=0;i<180;i++){
  await new Promise(r=>setTimeout(r,1000));result=await rpc('status',{id:accepted.id});
  if(!['queued','running'].includes(result.state))break;
}
if(result.state!=='completed'||!result.result.checks?.every(x=>x.passed)||!result.result.checks?.length)throw Error('Smoke task failed: '+JSON.stringify(result));
const store=new Store(c),calls=store.metrics(accepted.id);store.close();
console.log(JSON.stringify({task_id:accepted.id,state:result.state,model:c.model,cpu_only:c.cpuOnly,
  checks:result.result.checks,assertions:result.result.assertions,steps:calls.length,
  input_tokens:calls.reduce((n,x)=>n+(x.input_tokens??0),0),output_tokens:calls.reduce((n,x)=>n+(x.output_tokens??0),0),
  inference_ms:calls.reduce((n,x)=>n+x.duration_ms,0),cloud_calls:0},null,2));
