import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateSpec } from './workspace.mjs';
import { runOne } from './worker.mjs';

export function credentials(c) {
  const file=path.join(c.vault,'credentials.json');
  if(!fs.existsSync(file)) fs.writeFileSync(file,JSON.stringify({admin:randomBytes(32).toString('hex'),delegate:randomBytes(32).toString('hex')},null,2),{flag:'wx',mode:0o600});
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function equal(a,b) { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length&&timingSafeEqual(x,y); }
export function dispatch(store,action,args={},role='delegate') {
  if(action==='submit') return store.submit(validateSpec(args.task),args.key);
  if(action==='status') { if(typeof args.id!=='string') throw Error('Task id required'); const t=store.get(args.id); if(!t) throw Error('Unknown task'); return t; }
  if(action==='cancel') { store.cancel(args.id); return store.get(args.id); }
  if(action==='search') return store.search(String(args.query??''),args.task??null);
  if(role==='admin'&&action==='list') return store.list();
  if(role==='admin'&&action==='resume') {
    return store.tx(()=>{
      const t=store.get(args.id); if(!t||t.state!=='blocked') throw Error('Only blocked tasks can be resumed');
      if(t.attempts>=store.c.maxAttempts||t.steps>=store.c.maxSteps||t.elapsed>=store.c.maxSeconds*1000) throw Error('Budget exhausted; create a smaller task');
      store.db.prepare("UPDATE tasks SET state='queued',owner=NULL,lease=NULL,updated=? WHERE id=?").run(Date.now(),t.id);
      store.event(t.id,'explicit_resume',{}); return store.get(t.id);
    });
  }
  throw Error('Action forbidden');
}
export function makeServer(store,c) {
  const keys=credentials(c);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Cache-Control','no-store');
    const send=(status,value)=>{res.writeHead(status);res.end(JSON.stringify(value));};
    if(req.headers.origin) return send(403,{error:'Browser origins forbidden'});
    const token=String(req.headers.authorization??'').replace(/^Bearer /,'');
    const role=equal(token,keys.admin)?'admin':equal(token,keys.delegate)?'delegate':null;
    if(!role) return send(401,{error:'Authentication required'});
    if(req.method!=='POST'||req.url!=='/rpc') return send(404,{error:'Use POST /rpc'});
    try {
      let bytes=0; const chunks=[];
      for await(const chunk of req) {bytes+=chunk.length;if(bytes>24000) throw Error('Request too large'); chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result=dispatch(store,body.action,body.args,role);
      send(200,{result});
    }catch(e){send(400,{error:String(e.message).slice(0,1000)});}
  });
  server.requestTimeout=15000; server.headersTimeout=10000;
  return server;
}
export async function serve(store,c) {
  const controller=new AbortController();
  const server=makeServer(store,c);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.port,'127.0.0.1',resolve);});
  console.log(`Local agent gateway listening on 127.0.0.1:${c.port}; credentials remain in private vault.`);
  let current=null;
  const tick=()=>{if(!current&&!controller.signal.aborted) current=runOne(store,c,{signal:controller.signal}).finally(()=>{current=null;});};
  // Timer only checks SQLite; no model is called while idle.
  const timer=setInterval(tick,1000);tick();
  const stop=async()=>{clearInterval(timer);controller.abort();server.close();await current;store.close();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  return {server,stop};
}
