import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildContext } from './context.mjs';
import { modelFor } from './config.mjs';
import { taskWorkspace, reconcile, readFile, writeFile, checkSyntax, verify, fileHash, safeFile } from './workspace.mjs';
import { simulatedToolCall, machineLock, sha } from './guard.mjs';
import { runOrqTask, orqSettings, ORQ_ENGINES } from './orq.mjs';
import { runDeterministic } from './deterministic.mjs';
import { reviewProfiles, reviewSchema, reviewMessages, correction, buildEvidence, assessReview, runTests, reviewMarkdown } from './review.mjs';

const tool=(name,description,properties,required)=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const str={type:'string'};
export function toolsFor(profile) {
  if(reviewProfiles.includes(profile)) return [];
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
// Thrown when the model's answer is not a usable result; the task blocks with this explicit reason.
class Unusable extends Error {}

export async function runOne(store,c,{chat=ollamaChat,signal=new AbortController().signal}={}) {
  const unlock=machineLock(c.lockDir);
  if(!unlock) return null;
  const owner=randomUUID();
  let task;
  try { task=store.acquire(owner); } catch(e) { unlock(); throw e; }
  if(!task) { unlock(); return null; }
  const controller=new AbortController(), combined=AbortSignal.any([signal,controller.signal]);
  const started=Date.now(); let steps=task.steps, root, history=[], last=task.checkpoint.last??null, reprompted=task.checkpoint.reprompted??false;
  const model=modelFor(c,task.spec.profile);
  const isOrq=ORQ_ENGINES.includes(task.spec.engine), maxSeconds=isOrq?orqSettings(c).maxSeconds:c.maxSeconds;
  const elapsed=()=>task.elapsed+Date.now()-started;
  const guard=()=>{ if(combined.aborted) throw Error('Worker stopped'); store.assert(task); if(elapsed()>=maxSeconds*1000) throw Error('Task time limit'); };
  const heartbeat=setInterval(()=>{try{store.heartbeat(task);}catch{controller.abort();}},Math.max(50,Math.floor(c.leaseMs/3)));
  const cancelWatch=setInterval(()=>{if(store.get(task.id)?.state!=='running') controller.abort();},200);
  const deadline=setTimeout(()=>controller.abort(),Math.max(1,maxSeconds*1000-task.elapsed));
  const checkpoint=()=>store.checkpoint(task,{ workspace:root, branch:`agent/task-${task.id}`, last:compactLast(last), reprompted,
    hashes:root?Object.fromEntries(task.spec.files.map(p=>{try{return [p,fileHash(safeFile(root,p,task.spec.files))];}catch{return [p,'unavailable'];}})):{}, next:'Resume from current files; do not repeat verified operations.' },steps,elapsed());
  // Every model call is kept whole in the private vault; only a digest goes into events.
  const callModel=async(body)=>{
    guard(); const requestStart=Date.now(); steps++; checkpoint(); // Failed/aborted requests still consume a step.
    let response;
    try { response=await chat(c,body,combined); }
    catch(e){store.metric(task.id,{run_id:owner,model:model,input_tokens:null,output_tokens:null,duration_ms:Date.now()-requestStart,error:String(e.message).slice(0,300),cloud:false});store.event(task.id,'model_error',{step:steps,error:String(e.message).slice(0,300)});throw e;}
    guard();
    const content=String(response.message?.content??'');
    const dir=path.join(c.vault,'evidence',task.id); fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,`call-${String(steps).padStart(2,'0')}.json`);
    fs.writeFileSync(file,JSON.stringify({at:new Date().toISOString(),request:body,response:{content,tool_calls:response.message?.tool_calls??null,done_reason:response.done_reason??null}},null,2),{mode:0o600});
    store.metric(task.id,{run_id:owner,model:model,input_tokens:response.prompt_eval_count??null,output_tokens:response.eval_count??null,duration_ms:Date.now()-requestStart,cloud:false});
    store.event(task.id,'model_call',{step:steps,model:model,prompt_sha:sha(JSON.stringify(body.messages)),response_sha:sha(content),tool_calls:response.message?.tool_calls?.length??0,excerpt:content.slice(0,400),evidence:path.basename(file)});
    return response;
  };
  try {
    if(isOrq) {
      // Claude/Codex vía orq: el proceso corre en segundo plano y el lease se mantiene con el heartbeat.
      let orqData={};
      const done=await runOrqTask(store,c,task,{guard,signal:combined,setRoot:r=>{root=r;},checkpoint:data=>{orqData=data;store.checkpoint(task,{workspace:root,branch:`orq/${task.spec.key}`,...data},steps,elapsed());}});
      store.finish(task,done.state,{...done.result,steps,elapsed_ms:elapsed()});
      return store.get(task.id);
    }
    guard(); root=taskWorkspace(c,task); reconcile(store,task,root); checkpoint();
    if(reviewProfiles.includes(task.spec.profile)) return await review();
    const tools=toolsFor(task.spec.profile);
    const memory=store.memory(task.spec.goal,root,task.spec.files);
    while(steps<c.maxSteps) {
      guard(); task.checkpoint=store.get(task.id).checkpoint;
      const context=buildContext(c,task,tools,memory,history);
      const response=await callModel({model:model,messages:context.messages,tools,stream:false,think:false,keep_alive:'5m',options:{num_ctx:c.context,num_predict:c.output,temperature:0,...(c.cpuOnly?{num_gpu:0}:{})}});
      const msg=response.message;
      if(!msg||typeof msg!=='object') throw Error('Invalid model message');
      // Hidden reasoning is never persisted or returned to another model.
      const clean={role:'assistant',content:String(msg.content??'').slice(0,10000)};
      if(msg.tool_calls?.length) clean.tool_calls=msg.tool_calls;
      if(response.done_reason==='length') throw Error('Output limit reached; task needs splitting');
      if(!clean.tool_calls?.length) {
        if(!clean.content.trim()) throw new Unusable('Empty model result');
        const fake=simulatedToolCall(clean.content);
        if(fake) {
          store.event(task.id,'simulated_tool_call',{step:steps,excerpt:fake.excerpt,reprompted});
          if(reprompted) throw new Unusable(`Model wrote tool calls as text twice instead of calling them; no review was produced (${fake.excerpt.slice(0,160)})`);
          reprompted=true; history.push(clean,{role:'user',content:correction(['it contained tool calls written as plain text'])}); checkpoint(); continue;
        }
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
        const result={summary:clean.content,summary_source:'unverified_model_statement',assertions,checks,acceptance:assertions.length?'assertions_only':'human_review_required',workspace:root,branch:`agent/task-${task.id}`,steps,elapsed_ms:elapsed(),model:model,metrics:store.metrics(task.id)};
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
      const reason=e instanceof Unusable?'unusable_result':'error';
      try { store.event(task.id,'blocked',{reason,error:String(e.message).slice(0,500)}); checkpoint(); store.finish(task,'blocked',{error:String(e.message).slice(0,2000),reason,workspace:root,steps,elapsed_ms:elapsed(),next:'Inspect evidence; create a smaller follow-up task or explicitly resume.'}); } catch { /* Lost lease: fenced executor must not publish a result. */ }
    }
    return store.get(task.id);
  } finally {
    clearInterval(heartbeat); clearInterval(cancelWatch); clearTimeout(deadline); controller.abort(); store.release(owner); unlock();
    store.flushReports();
  }

  // Review/check: the orchestrator runs tests and reads files; the model only judges evidence it was given.
  async function review() {
    const spec={...task.spec};
    if(spec.deterministic) {
      // Solo pytest: sin modelo, sin citas; el resultado es la salida real del comando.
      guard(); const t0=Date.now();
      const det=await runDeterministic(c,root,spec,combined);
      for(const t of det.results) store.event(task.id,'test',{path:t.path,exit:t.exit,tail:t.output.split('\n').slice(-2).join(' ').slice(0,300)});
      store.metric(task.id,{run_id:owner,model:'ninguno (pytest en el PC)',input_tokens:0,output_tokens:0,duration_ms:Date.now()-t0,cloud:false});
      guard(); checkpoint();
      const result={headline:det.headline,summary:det.headline,summary_source:'deterministic_command_output',report_md:det.report_md,tests:det.results.map(r=>({path:r.path,exit:r.exit,output:r.output})),
        acceptance:det.ok?'tests_passed':'tests_failed',workspace:root,branch:`agent/task-${task.id}`,steps,elapsed_ms:elapsed(),model:'ninguno',metrics:store.metrics(task.id)};
      store.finish(task,det.ok?'completed':'blocked',det.ok?result:{...result,error:det.headline,reason:'tests_failed'});
      return store.get(task.id);
    }
    guard(); spec.testResults=runTests(c,root,spec);
    for(const t of spec.testResults) store.event(task.id,'test',{path:t.path,exit:t.exit,tail:t.output.split('\n').slice(-2).join(' ').slice(0,300)});
    guard();
    const budget=Math.floor((c.context-c.output-c.margin-600)*2.5);
    const evidence=buildEvidence(root,spec,budget);
    store.event(task.id,'evidence',{coverage:evidence.coverage});
    const schema=reviewSchema(spec.criteria??[]);
    const messages=reviewMessages(spec,evidence);
    for(let attempt=0;;attempt++) {
      if(steps>=c.maxSteps) throw Error('Task step limit');
      const response=await callModel({model:model,messages,stream:false,think:false,format:schema,keep_alive:'5m',options:{num_ctx:c.context,num_predict:c.output,temperature:0,...(c.cpuOnly?{num_gpu:0}:{})}});
      if(response.done_reason==='length') throw new Unusable('Output limit reached before the review JSON was complete');
      const content=String(response.message?.content??'');
      const verdict=response.message?.tool_calls?.length?{ok:false,retryable:true,reasons:['reply requested tools, which this profile does not have']}:assessReview(root,spec,content);
      store.event(task.id,'assessment',{step:steps,ok:verdict.ok,retryable:verdict.retryable,reasons:verdict.reasons});
      if(verdict.ok) {
        const tests=spec.testResults, failed=tests.filter(t=>t.exit!==0);
        const report=reviewMarkdown(spec,verdict.review,tests,evidence.coverage);
        const result={summary:verdict.review.summary,summary_source:'model_review_grounded_in_files',review:verdict.review,report_md:report,tests,coverage:evidence.coverage,
          acceptance:failed.length?'tests_failed':'grounded_review',workspace:root,branch:`agent/task-${task.id}`,steps,elapsed_ms:elapsed(),model:model,metrics:store.metrics(task.id)};
        checkpoint(); store.finish(task,failed.length?'blocked':'completed',result);
        return store.get(task.id);
      }
      if(!verdict.retryable) throw new Unusable(`Review rejected for wrong evidence (not re-asked: repeating the query returns the same citation): ${verdict.reasons.join('; ')}`);
      if(attempt>=1||reprompted) throw new Unusable(`Review rejected after one bounded retry: ${verdict.reasons.join('; ')}`);
      reprompted=true; checkpoint();
      messages.push({role:'assistant',content:content.slice(0,4000)},{role:'user',content:correction(verdict.reasons)});
    }
  }
}
function compactLast(last) {
  if(!last) return null;
  const value=structuredClone(last);
  if(value.result?.text) value.result.text=value.result.text.slice(0,600);
  if(value.result?.output) value.result.output=value.result.output.slice(0,600);
  return value;
}
