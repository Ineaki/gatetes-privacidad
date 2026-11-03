import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash } from './store.mjs';

const forbidden = /(^|\/)(\.git|\.env[^/]*|node_modules|vault|logs|worktrees|credentials[^/]*|[^/]*\.(?:pem|key|token|sqlite[^/]*))($|\/)/i;
export function validPath(p) {
  if (typeof p!=='string' || !p || p.length>240 || p.includes('\\') || p.includes(':') || p.includes('\0') || path.isAbsolute(p) || p.split('/').some(x=>x==='..'||x==='.'||!x) || forbidden.test(p)) throw Error('Forbidden file path');
  return p;
}
export function validateSpec(input) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw Error('Task object required');
  if (typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>5000) throw Error('Goal required (max 5000 characters)');
  const profile=input.profile??'researcher';
  if (!['coder','researcher','reviewer'].includes(profile)) throw Error('Invalid profile');
  if (!Array.isArray(input.files)||input.files.length>20) throw Error('Explicit files required (max 20)');
  const files=[...new Set(input.files.map(validPath))].sort();
  const acceptance=input.acceptance??[];
  if (!Array.isArray(acceptance)||acceptance.length>10) throw Error('Invalid acceptance');
  for (const a of acceptance) if (!files.includes(a.path)||typeof a.contains!=='string'||!a.contains||a.contains.length>2000) throw Error('Invalid acceptance assertion');
  return { goal:input.goal, profile, files, acceptance:acceptance.map(a=>({path:a.path,contains:a.contains})), origin:String(input.origin??'local').slice(0,80) };
}
export function safeFile(root, relative, allowed) {
  validPath(relative);
  if (!allowed.includes(relative)) throw Error('File outside task allowlist');
  const actualRoot=fs.realpathSync(root), target=path.resolve(actualRoot,relative);
  let cursor=actualRoot;
  for (const part of relative.split('/')) {
    cursor=path.join(cursor,part);
    if (fs.existsSync(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('Symlinks are forbidden');
      const real=fs.realpathSync(cursor);
      if (real!==actualRoot&&!real.startsWith(actualRoot+path.sep)) throw Error('Path escape');
    }
  }
  return target;
}
export function git(repo,args) { return execFileSync('git',['-C',repo,...args],{encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:256*1024}).trim(); }
export function taskWorkspace(c,task) {
  const root=path.join(c.vault,'worktrees',task.id);
  if (!fs.existsSync(root)) {
    git(c.repo,['worktree','add','-b',`agent/task-${task.id}`,root,'HEAD']);
  }
  if (git(root,['rev-parse','--show-toplevel']).replaceAll('\\','/').toLowerCase()!==root.replaceAll('\\','/').toLowerCase()) throw Error('Wrong worktree');
  return root;
}
export function fileHash(file) { return fs.existsSync(file)?hash(fs.readFileSync(file)):null; }
export function reconcile(store,task,root) {
  for (const op of store.db.prepare("SELECT * FROM operations WHERE task=? AND state='pending'").all(task.id)) {
    const file=safeFile(root,op.file,task.spec.files), current=fileHash(file);
    if (current===op.after_hash) store.db.prepare("UPDATE operations SET state='done' WHERE id=?").run(op.id);
    else if (current===op.before_hash) store.db.prepare("UPDATE operations SET state='not_applied' WHERE id=?").run(op.id);
    else throw Error(`Reconciliation needed for ${op.file}`);
  }
}
export function readFile(root,spec,args) {
  const file=safeFile(root,args.path,spec.files);
  if (!fs.existsSync(file)) return {path:args.path,exists:false,hash:null};
  if (fs.statSync(file).size>1024*1024) throw Error('File too large; split task');
  const text=fs.readFileSync(file,'utf8'); if (text.includes('\0')) throw Error('Binary file');
  const start=args.start??1, end=args.end??80;
  if (!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end-start>119) throw Error('Read 1-120 lines');
  return {path:args.path,hash:hash(text),start,end,text:text.split('\n').slice(start-1,end).join('\n').slice(0,5000)};
}
export function writeFile(store,task,root,args) {
  if (task.spec.profile!=='coder') throw Error('Read-only profile');
  if (typeof args.text!=='string'||Buffer.byteLength(args.text)>12000) throw Error('Write max 12000 bytes');
  if (!(args.expected_hash===null||/^[a-f0-9]{64}$/.test(args.expected_hash))) throw Error('Expected hash required (null for new file)');
  const file=safeFile(root,args.path,task.spec.files), after=hash(args.text);
  const id=hash(JSON.stringify([task.id,args.path,args.expected_hash,after]));
  return store.tx(() => {
    store.assert(task);
    const previous=store.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    if (previous?.state==='done' && fileHash(file)===after) return {path:args.path,hash:after,replayed:true};
    if (fileHash(file)!==args.expected_hash) throw Error('File changed; reread before writing');
    store.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(id) DO UPDATE SET state='pending'").run(id,task.id,args.path,args.expected_hash,after,args.text);
    // Commit intent before touching disk. SQLite transaction stays open only for the synchronous atomic replace below.
    return {id,file,after};
  }).id ? applyIntent(store,task,root,id) : {path:args.path,hash:after,replayed:true};
}
function applyIntent(store,task,root,id) {
  return store.tx(() => {
    store.assert(task);
    const op=store.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    const file=safeFile(root,op.file,task.spec.files);
    if (fileHash(file)!==op.before_hash) throw Error('File changed before replacement');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temp=file+`.${id}.tmp`;
    fs.writeFileSync(temp,op.body,{mode:0o600});
    fs.renameSync(temp,file);
    store.db.prepare("UPDATE operations SET state='done' WHERE id=?").run(id);
    store.event(task.id,'write',{path:op.file,before:op.before_hash,after:op.after_hash});
    return {path:op.file,hash:op.after_hash};
  });
}
export function checkSyntax(root,spec,args) {
  const file=safeFile(root,args.path,spec.files);
  if (!/\.(mjs|cjs|js)$/.test(args.path)) throw Error('Only JavaScript syntax checks supported');
  const output=execFileSync(process.execPath,['--check',file],{encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:12000});
  return {passed:true,path:args.path,output:output.slice(0,2000)};
}
export function verify(root,spec) {
  return spec.acceptance.map(a=>({ ...a, passed:fs.existsSync(safeFile(root,a.path,spec.files)) && fs.readFileSync(safeFile(root,a.path,spec.files),'utf8').includes(a.contains) }));
}
