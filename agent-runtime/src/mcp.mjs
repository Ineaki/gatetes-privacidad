import readline from 'node:readline';
import { dispatch } from './server.mjs';

const definitions=[
  {name:'tasks_submit',description:'Persist a bounded task for the independent local Ollama worker. Return task id immediately.',inputSchema:{type:'object',properties:{key:{type:'string'},task:{type:'object',properties:{goal:{type:'string'},profile:{enum:['coder','researcher','reviewer']},files:{type:'array',items:{type:'string'}},acceptance:{type:'array',items:{type:'object',properties:{path:{type:'string'},contains:{type:'string'}},required:['path','contains']}}},required:['goal','files']}},required:['task','key']}},
  {name:'tasks_status',description:'Read one task state and compact checkpoint; do not poll in a model loop.',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id']}},
  {name:'tasks_cancel',description:'Cancel a local task; prevents new writes.',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id']}},
  {name:'memory_search',description:'Retrieve up to three short private evidence excerpts.',inputSchema:{type:'object',properties:{query:{type:'string'},task:{type:'string'}},required:['query']}}
];
export function mcp(store) {
  const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  lines.on('line',line=>{
    let request;
    try {
      if(Buffer.byteLength(line)>24000) throw Error('Request too large');
      request=JSON.parse(line);
      if(!Object.hasOwn(request,'id')) return;
      let result;
      if(request.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'gatetes-local-agents',version:'0.1.0'}};
      else if(request.method==='ping') result={};
      else if(request.method==='tools/list') result={tools:definitions};
      else if(request.method==='tools/call') {
        const routes={tasks_submit:'submit',tasks_status:'status',tasks_cancel:'cancel',memory_search:'search'};
        const action=routes[request.params?.name];if(!action) throw Error('Unknown tool');
        const data=dispatch(store,action,request.params.arguments??{},'delegate');
        result={content:[{type:'text',text:JSON.stringify(data)}],isError:false};
      }else throw Error('Unsupported method');
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
    }catch(e){if(request&&Object.hasOwn(request,'id')) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:String(e.message)}})+'\n');}
  });
  lines.on('close',()=>store.close());
}
