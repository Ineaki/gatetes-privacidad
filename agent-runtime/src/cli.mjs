import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config,ensureVault } from './config.mjs';
import { Store } from './store.mjs';
import { validateSpec,git } from './workspace.mjs';
import { credentials,dispatch,serve } from './server.mjs';
import { runOne } from './worker.mjs';
import { mcp } from './mcp.mjs';

const [command='help',...args]=process.argv.slice(2);
try {
  const c=config();
  if(command==='doctor') {
    let ollama;try {const r=await fetch(c.ollama+'/api/tags',{signal:AbortSignal.timeout(5000)});ollama=await r.json();}catch(e){ollama={error:e.message};}
    console.log(JSON.stringify({node:process.version,ram_gib:Math.round(os.totalmem()/1024**3),repo:c.repo,head:git(c.repo,['rev-parse','HEAD']),vault:c.vault,model:c.model,ollama},null,2));
  }else if(command==='help') {
    console.log('Commands: init | doctor | submit task.json [idempotency-key] | status ID | list | cancel ID | resume ID | search QUERY | run-once | serve | mcp | metrics ID | backup DEST | restore SOURCE');
  }else if(command==='backup'||command==='restore') {
    if(!args[0]) throw Error('Directory required. Stop all workers/MCP sessions first.');
    const source=command==='backup'?c.vault:path.resolve(args[0]),dest=command==='backup'?path.resolve(args[0]):c.vault;
    if(dest===c.repo||dest.startsWith(c.repo+path.sep)||dest===source||dest.startsWith(source+path.sep)) throw Error('Unsafe backup/restore destination');
    if(fs.existsSync(dest)&&fs.readdirSync(dest).length) throw Error('Destination must be empty; no overwrites');
    fs.cpSync(source,dest,{recursive:true,errorOnExist:true,force:false});
    console.log('Private snapshot copied. Contains secrets: protect destination and restore original worktree paths.');
  }else {
    const store=new Store(c);
    if(command==='serve') await serve(store,c);
    else if(command==='mcp') mcp(store);
    else {
      let value;
      if(command==='init') {ensureVault(c);credentials(c);value={vault:c.vault,model:c.model,credentials:'Created privately; never printed'};}
      else if(command==='submit') value=store.submit(validateSpec(JSON.parse(fs.readFileSync(args[0],'utf8'))),args[1]);
      else if(command==='run-once') value=await runOne(store,c);
      else if(command==='metrics') value=store.metrics(args[0]);
      else if(command==='search') value=store.search(args.join(' '));
      else if(['status','cancel','resume','list'].includes(command)) value=dispatch(store,command,{id:args[0]},'admin');
      else throw Error('Unknown command; use help');
      console.log(JSON.stringify(value,null,2));store.close();
    }
  }
}catch(e){console.error(e.message);process.exitCode=1;}
