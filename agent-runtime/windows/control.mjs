import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { credentials } from '../src/server.mjs';

export async function control(command,c=config()) {
  const store=new Store(c);store.close();const keys=credentials(c);
  const request=async(action)=>{
    const r=await fetch(`http://127.0.0.1:${c.port}/rpc`,{method:'POST',headers:{Authorization:`Bearer ${keys.admin}`,'Content-Type':'application/json'},body:JSON.stringify({action}),signal:AbortSignal.timeout(3000)});
    if(!r.ok) throw Error(`Gateway HTTP ${r.status}`);return r.json();
  };
  if(command==='stop'){await request('shutdown');console.log('Graceful shutdown requested.');return;}
  if(command!=='start') throw Error('Use start or stop');
  try{await request('list');console.log('Local runtime already running.');return;}catch{}
  const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/cli.mjs');
  const out=fs.openSync(path.join(c.vault,'server.stdout.log'),'a',0o600),err=fs.openSync(path.join(c.vault,'server.stderr.log'),'a',0o600);
  const child=spawn(process.execPath,[cli,'serve'],{detached:true,windowsHide:true,stdio:['ignore',out,err],env:{...process.env,AGENT_VAULT:c.vault,AGENT_REPO:c.repo}});
  child.unref();fs.closeSync(out);fs.closeSync(err);
  let ready=false;
  for(let i=0;i<15;i++){await new Promise(r=>setTimeout(r,200));try{await request('list');ready=true;break;}catch{}}
  if(!ready) throw Error('Runtime did not start; inspect private server.stderr.log');
  console.log(`Local runtime started (PID ${child.pid}).`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) control(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1;});
