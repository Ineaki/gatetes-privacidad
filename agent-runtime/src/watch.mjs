import { config } from './config.mjs';
import { Store } from './store.mjs';

const store=new Store(config());
const draw=()=>{
  const tasks=store.list().slice(0,12);
  const events=store.db.prepare('SELECT task,kind,body,created FROM events ORDER BY created DESC,id DESC LIMIT 12').all();
  const lines=['Gatetes · actividad local (sin llamadas al modelo)',new Date().toLocaleString(),'',...tasks.map(t=>`${t.state.padEnd(10)} ${t.id}  pasos ${t.steps}`),'','Eventos recientes:',...events.map(e=>`${new Date(e.created).toLocaleTimeString()} ${e.kind.padEnd(18)} ${e.task?.slice(0,8)??'-'} ${JSON.stringify(JSON.parse(e.body)).slice(0,105)}`),'','Ctrl+C para salir'];
  process.stdout.write('\x1b[2J\x1b[H'+lines.join('\n')+'\n');
};
draw();const timer=setInterval(draw,3000);
process.once('SIGINT',()=>{clearInterval(timer);store.close();process.exit(0);});
