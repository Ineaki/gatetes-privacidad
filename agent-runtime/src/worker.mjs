import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildContext } from './context.mjs';
import { taskWorkspace, reconcile, readFile, writeFile, checkSyntax, verify, fileHash, safeFile } from './workspace.mjs';

const tool=(name,description,properties,required)=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const str={type:'string'};
export function toolsFor(profile) {
  const list=[tool('read_file','Read allowed file lines and SHA256. Missing file returns hash null.',{path:str,start:{type:'integer'},end:{type:'integer'}},['path']),
    tool('check_syntax','Check JavaScript syntax without executing the file.',{path:str},['path'])];
  if(profile==='coder') list.push(tool('write_file','Replace a small allowed text file; expected_hash must be its last read hash, or null for a new file.',{path:str,expected_hash:{type:['string','null']},text:str},['path','expected_hash','text']));
  return list;
}
export async function ollamaChat(c,body,signal) {
  const combined=AbortSignal.any([signal,AbortSignal.timeout(c.requestMs)]);
  const response=await fetch(c.ollama+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:combined});
  if(!response.ok) throw Error(`Ollama HTTP ${response.status}`);
  const text=await response.text(); if(text.length>200000) throw Error('Model response too large');
  return JSON.parse(text);
}
export async function runOne(store,c,{chat=ollamaChat,signal=new AbortController().signal}={}) {
  const owner=randomUUID(), task=store.acquire(owner);
  if(!task) return null;
  const controller=new AbortController(), combined=AbortSignal.any([signal,controller.signal]);
  const started=Date.now(); let steps=task.steps, root, history=[], last=task.checkpoint.last??null;
  const elapsed=()=>task.elapsed+Date.now()-started;
  const guard=()=>{ if(combined.aborted) throw Error('Worker stopped'); store.assert(task); if(elapsed()>=c.maxSeconds*1000) throw Error('Task time limit'); };
  const heartbeat=setInterval(()=>{try{store.heartbeat(task);}catch{controller.abort();}},Math.max(50,Math.floor(c.leaseMs/3)));
  const cancelWatch=setInterval(()=>{if(store.get(task.id)?.state!=='running') controller.abort();},200);
  const deadline=setTimeout(()=>controller.abort(),Math.max(1,c.maxSeconds*1000-task.elapsed));
  const checkpoint=()=>store.checkpoint(task,{ workspace:root, branch:`agent/task-${task.id}`, last:compactLast(last),
    hashes:root?Object.fromEntries(task.spec.files.map(p=>{try{return [p,fileHash(safeFile(root,p,task.spec.files))];}catch{return [p,'unavailable'];}})):{}, next:'Resume from current files; do not repeat verified operations.' },steps,elapsed());
  try {
    guard(); root=taskWorkspace(c,task); reconcile(store,task,root); checkpoint();
    const tools=toolsFor(task.spec.profile);
    const memory=store.memory(task.spec.goal,root,task.spec.files);
    while(steps<c.maxSteps) {
      guard(); task.checkpoint=store.get(task.id).checkpoint;
      const context=buildContext(c,task,tools,memory,history);
      const requestStart=Date.now();
      steps++; checkpoint(); // Failed/aborted requests still consume a step.
      let response;
      try {
        response=await chat(c,{model:c.model,messages:context.messages,tools,stream:false,think:false,keep_alive:'5m',options:{num_ctx:c.context,num_predict:c.output,temperature:0,...(c.cpuOnly?{num_gpu:0}:{})}},combined);
      }catch(e){store.metric(task.id,{run_id:owner,model:c.model,estimated_input:context.estimatedInput,input_tokens:null,output_tokens:null,duration_ms:Date.now()-requestStart,error:String(e.message).slice(0,300),cloud:false});throw e;}
      guard();
      store.metric(task.id,{run_id:owner,model:c.model,estimated_input:context.estimatedInput,estimate_method:context.estimateMethod,
        input_tokens:response.prompt_eval_count??null,output_tokens:response.eval_count??null,duration_ms:Date.now()-requestStart,retrieved:context.retrieved,cloud:false});
      const msg=response.message;
      if(!msg||typeof msg!=='object') throw Error('Invalid model message');
      // Hidden reasoning is never persisted or returned to another model.
      const clean={role:'assistant',content:String(msg.content??'').slice(0,10000)};
      if(msg.tool_calls?.length) clean.tool_calls=msg.tool_calls;
      if(response.done_reason==='length') throw Error('Output limit reached; task needs splitting');
      if(!clean.tool_calls?.length) {
        if(!clean.content.trim()) throw Error('Empty model result');
        const assertions=verify(root,task.spec);
        const checks=[];
        for(const p of task.spec.files.filter(p=>/\.(mjs|cjs|js)$/.test(p))) {
          const changed=store.db.prepare("SELECT 1 FROM operations WHERE task=? AND file=? AND state='done' LIMIT 1").get(task.id,p);
          if(changed) {
            guard();
            try {checks.push(checkSyntax(root,task.spec,{path:p}));}
            catch(e){checks.push({path:p,passed:false,error:String(e.message).slice(0,1500)});}
          }
        }
        checkpoint();
        const passed=assertions.every(a=>a.passed)&&checks.every(a=>a.passed);
        const result={summary:clean.content,summary_source:'unverified_model_statement',assertions,checks,acceptance:assertions.length?'assertions_only':'human_review_required',workspace:root,branch:`agent/task-${task.id}`,steps,elapsed_ms:elapsed(),model:c.model,metrics:store.metrics(task.id)};
        store.finish(task,passed?'completed':'blocked',result);
        return store.get(task.id);
      }
      if(clean.tool_calls.length>4) throw Error('Too many tool calls');
      history.push(clean);
      for (const call of clean.tool_calls) {
        guard(); const f=call.function; let result;
        try {
          if(!f||!tools.some(t=>t.function.name===f.name)||!f.arguments||typeof f.arguments!=='object') throw Error('Invalid tool');
          if(f.name==='read_file') result=readFile(root,task.spec,f.arguments);
          else if(f.name==='write_file') result=writeFile(store,task,root,f.arguments);
          else if(f.name==='check_syntax') result=checkSyntax(root,task.spec,f.arguments);
        } catch(e) { result={error:String(e.message).slice(0,1000)}; }
        last={tool:f?.name,result};
        store.event(task.id,'tool',{run_id:owner,generation:task.generation,profile:task.spec.profile,name:f?.name,path:f?.arguments?.path,hash:result?.hash,passed:result?.passed,error:result?.error});
        history.push({role:'tool',tool_name:f?.name??'invalid',content:JSON.stringify(result)});
        checkpoint();
        const recent=history.filter(m=>m.role==='tool').slice(-3);
        if(recent.length===3&&recent.every(m=>m.content===recent[0].content)) throw Error('No progress: repeated tool result');
      }
      // Bound ephemeral history; checkpoints keep only last evidence and current hashes.
      if(history.length>20) history=history.slice(history.findIndex((m,i)=>i>=history.length-12&&m.role==='assistant'));
    }
    throw Error('Task step limit');
  } catch(e) {
    const row=store.get(task.id);
    if(row?.state==='running'&&row.generation===task.generation&&row.owner===owner) {
      try { checkpoint(); store.finish(task,'blocked',{error:String(e.message).slice(0,2000),workspace:root,steps,elapsed_ms:elapsed(),next:'Inspect evidence; create a smaller follow-up task or explicitly resume.'}); } catch { /* Lost lease: fenced executor must not publish a result. */ }
    }
    return store.get(task.id);
  } finally {
    clearInterval(heartbeat); clearInterval(cancelWatch); clearTimeout(deadline); controller.abort(); store.release(owner);
    store.flushReports();
  }
}
function compactLast(last) {
  if(!last) return null;
  const value=structuredClone(last);
  if(value.result?.text) value.result.text=value.result.text.slice(0,600);
  if(value.result?.output) value.result.output=value.result.output.slice(0,600);
  return value;
}
