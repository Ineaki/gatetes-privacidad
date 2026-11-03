import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureVault } from './config.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(c) {
    ensureVault(c); this.c = c;
    this.db = new DatabaseSync(path.join(c.vault, 'state.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, key TEXT UNIQUE, spec TEXT NOT NULL, state TEXT NOT NULL,
        owner TEXT, lease INTEGER, generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        steps INTEGER NOT NULL DEFAULT 0, elapsed INTEGER NOT NULL DEFAULT 0, checkpoint TEXT NOT NULL DEFAULT '{}',
        result TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worker(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, lease INTEGER);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, task TEXT NOT NULL, file TEXT NOT NULL,
        before_hash TEXT, after_hash TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, task TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, task TEXT, file TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS exported_reports(id TEXT PRIMARY KEY);
      CREATE VIRTUAL TABLE IF NOT EXISTS report_search USING fts5(id UNINDEXED, task UNINDEXED, body);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, task TEXT, body TEXT NOT NULL, created INTEGER NOT NULL);`);
    // One startup reconciliation handles deleted Markdown exports; idle ticks are incremental.
    for(const r of this.db.prepare('SELECT id,file FROM reports').all()) if(!fs.existsSync(r.file)) this.db.prepare('DELETE FROM exported_reports WHERE id=?').run(r.id);
    this.flushReports();
  }
  close() { this.db.close(); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  submit(spec, key = randomUUID()) {
    return this.tx(() => {
      const old = this.db.prepare('SELECT * FROM tasks WHERE key=?').get(key);
      if (old) {
        if (old.spec !== JSON.stringify(spec)) throw Error('Idempotency key reused with different task');
        return this.get(old.id);
      }
      const id = randomUUID(), now = Date.now();
      for(const dep of spec.dependencies??[]) if(!this.get(dep)) throw Error('Dependency must already exist');
      this.db.prepare("INSERT INTO tasks(id,key,spec,state,created,updated) VALUES(?,?,?,'queued',?,?)").run(id,key,JSON.stringify(spec),now,now);
      this.event(id,'submitted',{ profile: spec.profile }); return this.get(id);
    });
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) return null;
    return { ...row, spec: JSON.parse(row.spec), checkpoint: JSON.parse(row.checkpoint), result: row.result ? JSON.parse(row.result) : null };
  }
  list() { return this.db.prepare('SELECT id,state,steps,attempts,updated FROM tasks ORDER BY created DESC LIMIT 100').all(); }
  event(task,kind,body) { this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(randomUUID(),task,kind,JSON.stringify(body),Date.now()); }
  acquire(owner, now = Date.now()) {
    return this.tx(() => {
      const lock = this.db.prepare('SELECT * FROM worker WHERE id=1').get();
      if (lock && lock.lease > now && lock.owner !== owner) return null;
      this.db.prepare('INSERT INTO worker VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,lease=excluded.lease').run(owner,now+this.c.leaseMs);
      this.db.prepare("UPDATE tasks SET state='queued',owner=NULL,elapsed=elapsed+max(0,lease-updated),updated=? WHERE state='running' AND lease<=?").run(now,now);
      const row = this.db.prepare("SELECT * FROM tasks WHERE state='queued' ORDER BY created").all().find(t=>{
        const deps=(JSON.parse(t.spec).dependencies??[]).map(id=>this.get(id));
        if(deps.some(d=>!d||['failed','cancelled','blocked'].includes(d.state))) {
          this.db.prepare("UPDATE tasks SET state='blocked',result=?,updated=? WHERE id=?").run(JSON.stringify({error:'dependency not completed; explicit resume required'}),now,t.id);
          this.addReport(t.id,{status:'blocked',reason:'dependency not completed'});return false;
        }
        return deps.every(d=>d.state==='completed');
      });
      if (!row) { this.db.prepare('DELETE FROM worker WHERE owner=?').run(owner); return null; }
      if (row.attempts >= this.c.maxAttempts) {
        this.db.prepare("UPDATE tasks SET state='failed',result=?,updated=? WHERE id=?").run(JSON.stringify({error:'attempt limit'}),now,row.id);
        this.addReport(row.id, { status:'failed', reason:'attempt limit', checkpoint:JSON.parse(row.checkpoint) });
        return null;
      }
      this.db.prepare("UPDATE tasks SET state='running',owner=?,lease=?,generation=generation+1,attempts=attempts+1,updated=? WHERE id=?").run(owner,now+this.c.leaseMs,now,row.id);
      return this.get(row.id);
    });
  }
  assert(task, now = Date.now()) {
    const row = this.get(task.id);
    const lock = this.db.prepare('SELECT * FROM worker WHERE id=1').get();
    if (!row || row.state!=='running' || row.owner!==task.owner || row.generation!==task.generation || row.lease<=now || lock?.owner!==task.owner || lock.lease<=now) throw Error('Task cancelled or lease lost');
    return row;
  }
  heartbeat(task) {
    return this.tx(() => {
      this.assert(task); const until=Date.now()+this.c.leaseMs;
      this.db.prepare('UPDATE tasks SET lease=? WHERE id=?').run(until,task.id);
      this.db.prepare('UPDATE worker SET lease=? WHERE owner=?').run(until,task.owner);
    });
  }
  checkpoint(task,data,steps,elapsed) {
    this.tx(() => { this.assert(task); this.db.prepare('UPDATE tasks SET checkpoint=?,steps=?,elapsed=?,updated=? WHERE id=?').run(JSON.stringify(data),steps,elapsed,Date.now(),task.id); });
  }
  finish(task,state,result) {
    this.tx(() => {
      this.assert(task);
      this.addReport(task.id,{ status:state, task:{goal:task.spec.goal,profile:task.spec.profile,files:task.spec.files}, result, checkpoint:this.get(task.id).checkpoint,
        activities:this.db.prepare('SELECT kind,body,created FROM events WHERE task=? ORDER BY created').all(task.id).map(e=>({...e,body:JSON.parse(e.body)})), calls:this.metrics(task.id) });
      this.db.prepare('UPDATE tasks SET state=?,result=?,owner=NULL,lease=NULL,updated=? WHERE id=?').run(state,JSON.stringify(result),Date.now(),task.id);
      this.db.prepare('DELETE FROM worker WHERE owner=?').run(task.owner);
    });
    this.flushReports();
  }
  cancel(id) {
    this.tx(() => {
      const t=this.get(id); if (!t) throw Error('Unknown task');
      if (!['queued','running','blocked'].includes(t.state)) return;
      this.addReport(id,{status:'cancelled',checkpoint:t.checkpoint});
      this.db.prepare("UPDATE tasks SET state='cancelled',generation=generation+1,updated=? WHERE id=?").run(Date.now(),id);
      // Keep global lease until old worker exits or expires; cancellation cannot unlock a live writer.
    }); this.flushReports();
  }
  release(owner) { this.db.prepare('DELETE FROM worker WHERE owner=?').run(owner); }
  addReport(task,body) {
    const id=randomUUID(), text=JSON.stringify(body,null,2);
    const file=path.join(this.c.vault,'reports',`${id}.md`);
    this.db.prepare('INSERT INTO reports VALUES(?,?,?,?,?)').run(id,task,file,text,Date.now());
    this.db.prepare('INSERT INTO report_search VALUES(?,?,?)').run(id,task,text);
  }
  flushReports() {
    for (const r of this.db.prepare('SELECT * FROM reports WHERE id NOT IN (SELECT id FROM exported_reports)').all()) {
      if (!fs.existsSync(r.file)) {
        const body=`# Activity ${r.id}\n\nTask: ${r.task}\nDate: ${new Date(r.created).toISOString()}\n\n\`\`\`json\n${r.body}\n\`\`\`\n`;
        fs.writeFileSync(r.file,body,{flag:'wx',mode:0o600});
      }
      this.db.prepare('INSERT OR IGNORE INTO exported_reports VALUES(?)').run(r.id);
    }
  }
  search(query, task = null, limit = 3) {
    const words=String(query).match(/[\p{L}\p{N}_-]+/gu)?.slice(0,12) ?? [];
    if (!words.length) return [];
    const q=words.map(w=>'"'+w.replaceAll('"','""')+'"').join(' OR ');
    return this.db.prepare(`SELECT id,task,snippet(report_search,2,'','', ' … ',48) AS excerpt FROM report_search WHERE report_search MATCH ? ${task?'AND task=?':''} ORDER BY rank LIMIT ?`).all(...(task?[q,task,Math.min(limit,3)]:[q,Math.min(limit,3)]));
  }
  metric(task,body) { this.db.prepare('INSERT INTO calls VALUES(?,?,?,?)').run(randomUUID(),task,JSON.stringify(body),Date.now()); }
  metrics(task) { return this.db.prepare('SELECT body FROM calls WHERE task=?').all(task).map(r=>JSON.parse(r.body)); }
  memory(query,root,allowed) {
    return this.search(query).filter(hit=>{
      const r=this.db.prepare('SELECT body FROM reports WHERE id=?').get(hit.id);
      const hashes=JSON.parse(r.body).checkpoint?.hashes;
      if(!hashes||!Object.keys(hashes).length) return false;
      for(const [file,expected] of Object.entries(hashes)) {
        if(!allowed.includes(file)) return false;
        // Worktree path validation happens at every actual file access in worker/workspace.
        const target=path.resolve(root,file);
        if(!target.startsWith(path.resolve(root)+path.sep)) return false;
        let cursor=path.resolve(root);
        for(const part of file.split('/')) {cursor=path.join(cursor,part);if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink()) return false;}
        if(fs.existsSync(target)&&fs.statSync(target).size>1024*1024) return false;
        const actual=fs.existsSync(target)?hash(fs.readFileSync(target)):null;
        if(expected!==actual) return false;
      }
      return true;
    });
  }
}
