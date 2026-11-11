// Repos que el puente acepta en un encargo remoto (CEO-029).
// El clon propio del PC (AGENT_REPO) se acepta como antes; cualquier otro repo tiene que estar en la
// lista de permitidos, que solo admite repos del owner Ineaki, y tener un clon local conocido.
export const OWNER = 'Ineaki';
export const DEFAULT_ALLOWED = ['Ineaki/gatetes', 'Ineaki/gatetes-agent-vault', 'Ineaki/generacion-de-demanda'];
const NAME = /^Ineaki\/[A-Za-z0-9_.-]{1,100}$/;

// AGENT_ALLOWED_REPOS="Ineaki/a,Ineaki/b" sustituye la lista por defecto; un repo de otro owner es un error de configuración.
export function allowedRepos(env = process.env) {
  const raw = env.AGENT_ALLOWED_REPOS;
  const list = raw === undefined || !raw.trim() ? DEFAULT_ALLOWED : raw.split(',').map(x => x.trim()).filter(Boolean);
  for (const r of list) if (!NAME.test(r) || r.includes('..')) throw Error(`AGENT_ALLOWED_REPOS only accepts ${OWNER}/<repo> entries (got "${r.slice(0, 80)}")`);
  return [...new Set(list)];
}

// Clones locales: el del PC, el espejo del vault (AGENT_REMOTE) y AGENT_ORQ_REPOS {"Ineaki/x":"C:\\ruta"}.
export function repoClones(c, env = process.env) {
  const repos = {};
  if (c.repoName) repos[c.repoName] = c.repo;
  if (env.AGENT_REMOTE) repos['Ineaki/gatetes-agent-vault'] = env.AGENT_REMOTE;
  if (env.AGENT_ORQ_REPOS) Object.assign(repos, JSON.parse(env.AGENT_ORQ_REPOS));
  return repos;
}

export function checkRepo(c, name, env = process.env) {
  if (typeof name !== 'string' || !name) throw Error('repo is required as "owner/name"');
  if (name === c.repoName) return name;
  const allowed = allowedRepos(env);
  if (!allowed.includes(name)) throw Error(`repo "${name.slice(0, 100)}" not allowed (allowed: ${[...new Set([c.repoName, ...allowed].filter(Boolean))].join(', ')})`);
  return name;
}

// Ruta del clon donde se trabaja un repo ya validado; sin repo o con el propio, el del PC.
export function repoPath(c, name, env = process.env) {
  if (!name || name === c.repoName) return c.repo;
  checkRepo(c, name, env);
  const clones = repoClones(c, env), p = clones[name];
  if (!p) throw Error(`repo "${name}" has no local clone (known: ${Object.keys(clones).join(', ')})`);
  return p;
}
