import { config } from '../src/config.mjs';
import { ollamaChat } from '../src/worker.mjs';

// Synthetic retrieval comparison. No vault, repository or user data is sent.
const base=config();
const relevant='Verified task record: release-greeting has status READY.\n';
const full=Array.from({length:250},(_,i)=>`Archived unrelated task ${i}: completed routine index maintenance.\n`).join('')+relevant;
const results=[];
for(const context of [8192,16384]) {
  for(const [mode,data] of [['full',full],['selected',relevant]]) {
    const c={...base,context,output:24},start=Date.now();
    const response=await ollamaChat(c,{model:c.model,stream:false,think:false,keep_alive:'5m',options:{num_ctx:context,num_predict:24,temperature:0,...(c.cpuOnly?{num_gpu:0}:{})},
      messages:[{role:'system',content:'Answer the status of release-greeting using the provided record. Respond with one word.'},{role:'user',content:data}]},new AbortController().signal);
    results.push({context,mode,input_tokens:response.prompt_eval_count,output_tokens:response.eval_count,duration_ms:Date.now()-start,correct:response.message?.content.trim()==='READY'});
  }
}
console.log(JSON.stringify({model:base.model,cpu_only:base.cpuOnly,synthetic:true,results,limitations:'Single run, full runs precede selected runs; cache and warm-up affect latency. Retrieval fact extraction is not a coding-quality benchmark.'},null,2));
