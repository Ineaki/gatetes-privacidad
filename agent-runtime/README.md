# Local agents for Gatetes

Independent local task queue and bounded Ollama worker. Node 24+ and Git are
required; no npm install, Python, paid API, vector database or extra daemon.
The existing privacy page is unchanged. The runtime is unrelated to data
collection by the Gatetes desktop application.

## Start on Windows

From this directory:

```powershell
node src/cli.mjs init
node src/cli.mjs doctor
node src/cli.mjs serve
```

Install a compatible local model with Ollama first. Default: `qwen2.5:3b`.
`node windows/install.mjs` restricts the vault ACL and starts the gateway hidden.
`node windows/install.mjs --autostart` also adds a current-user login shortcut.
No administrator service, public port, firewall rule or execution-policy change
is needed. To stop use `node windows/control.mjs stop`; start again with
`node windows/control.mjs start`. Remove the specifically named
`Gatetes Local Agents.lnk` from your Startup folder to disable login startup.

The host's Ollama application must also be running. There is no periodic model
heartbeat. An idle gateway only checks SQLite once a second. The model expires
from memory five minutes after its last call.

## Private storage and settings

Default vault: `%USERPROFILE%/Documents/Codex/agent-private/gatetes`, outside
the public repository. Override with `AGENT_VAULT`; override repo with
`AGENT_REPO`. The Windows installer respects these overrides.
The vault includes `state.sqlite`, `credentials.json`, `settings.json`,
`reports/`, `stable/`, `evidence/` and isolated `worktrees/`. The `stable/`
directory is for human-maintained decisions; it is not injected wholesale.

Use `settings.json` for validated options, for example:

```json
{"model":"qwen2.5:3b","context":8192,"output":1536,"cpuOnly":false,"requestMs":180000}
```

The first machine tested has a CUDA kernel-load error with its current driver;
CPU mode avoids that error without changing the driver. CPU mode is slower.
`qwen3:4b` also exhausted the output budget without tools on that machine;
`qwen2.5:3b` completed the smoke task. Select another local tool-capable model
only after a real tool-use test. Cloud
models are forbidden. The model tag is configurable; record the actual digest
with `doctor` before an upgrade because a tag can change upstream.

## Submit and inspect

```powershell
node src/cli.mjs submit examples/task.json unique-task-key
node src/cli.mjs list
node src/cli.mjs status TASK-ID
node src/cli.mjs metrics TASK-ID
node src/cli.mjs search "greeting syntax"
node src/cli.mjs cancel TASK-ID
```

`run-once` runs one queued task in the foreground. `serve` runs the persistent
worker and the authenticated HTTP adapter at `127.0.0.1:4317`. Multiple server
or foreground processes share a database lease: only one local executor runs.

Profiles: coder can read and replace explicitly allowed text files and run
JavaScript syntax checks. Researcher and reviewer are read-only. There is no
general shell, web browser, automatic subagent, recursive delegation, paid
escalation, git push or automatic merge tool. Research here means inspecting
provided repository files; internet research requires a separately scoped tool.

Each task gets branch `agent/task-UUID` in a private worktree based on the local
repository's current HEAD at first execution. The runtime never automatically
fetches a moving branch. Update/review the coordinator checkout between tasks
when new upstream code is needed. Changes stay in the task worktree for review;
they are not automatically committed, pushed or merged into the privacy page.
Independent task worktrees do not automatically inherit each other's edits.
Dependencies ensure ordering only; explicitly review/merge prerequisite changes
before submitting dependent coding tasks that require those changes.

## Bounds, memory and recovery

The coordinator is deterministic code. Context uses a short contract, latest
checkpoint, up to three FTS5 excerpts and recent complete tool-call groups.
UTF-8 bytes plus overhead provide a conservative estimate, not an exact
model-specific tokenizer. The response reports actual Ollama token usage.
Input + reserved output + margin must fit before inference. Defaults: 8k
context, 1536 output, 512 margin, 16 model steps, 10 minutes per task, 3 total
attempts (initial + two recoveries). All defaults are configurable and enforced.

Read results are bounded and paged. Large files must be split into smaller
tasks; writes are capped at 12 KB and files at 1 MB. Failed tools are recorded.
Repeated identical results, timeouts, truncation and exhausted budgets block
the task rather than starting an endless repair loop.

SQLite is the authoritative state. Every write persists its before/after hash
intent before an atomic file replacement; interrupted writes are reconciled
with the actual file. Stale executors are fenced by generation and lease.
Manual concurrent editing of the private worktree is unsupported; conflicting
hashes block work. A crashed process's task becomes eligible after 45 seconds.
`resume TASK-ID` explicitly resumes a blocked task if its budgets remain.

Reports are immutable Markdown exports of transactional report rows, readable
in Obsidian without a plugin. Missing exports are regenerated after restart.
Tool events and metrics stay in SQLite. Hidden reasoning is not stored. The
runtime does not include old conversations in prompts. Memory is evidence,
never authority; current file hashes must be checked for consequential work.

`completed` means the model loop finished and configured literal assertions
passed. It is not a substitute for semantic review or a project's full tests.
Changed JavaScript files are independently syntax-checked by the coordinator
at completion even if the model omits or misstates its checks. Model summaries
are explicitly labelled unverified; the separate `checks` field is evidence.
The model has only a syntax check tool in this initial version, intentionally
avoiding arbitrary execution of model-generated code.

## Grok Bot and remote access

See [GROKBOT.md](GROKBOT.md) for the adapter contract. MCP uses newline JSON-RPC
over local stdio; HTTP uses a bearer token and rejects browser Origins. Submit,
status, cancel and memory search are available to the delegate identity; resume,
list and shutdown require the admin identity. Both are intended for the same
trusted owner's integrations, not separate users or adversarial agents.

Ollama and the gateway bind only to loopback. Remote access requires an existing
authenticated private tunnel, such as SSH forwarding or a managed private
network. This repository does not provision accounts, SSH servers or a public
tunnel. Do not expose either port directly. Never treat `localhost` on Grok
Bot's cloud computer as this Windows PC.

The daemon can complete tasks already delegated before cloud quota exhaustion.
It does not detect Grok Bot's billing state or change its internal model.
Availability of local commands/MCP/private networking must be verified in the
actual Grok Bot account. No live Grok Bot integration is claimed by unit tests.

## Allowed repositories (CEO-029)

Remote instructions may name `task.repo`. The PC's own clone (`AGENT_REPO`) is
always accepted; any other repo must be on the allowlist and have a local clone.
Default allowlist: `Ineaki/gatetes`, `Ineaki/gatetes-agent-vault`,
`Ineaki/generacion-de-demanda`. Replace it with
`AGENT_ALLOWED_REPOS="Ineaki/a,Ineaki/b"`; entries from another owner are a
configuration error. Clones: `AGENT_REMOTE` (vault mirror) and
`AGENT_ORQ_REPOS='{"Ineaki/generacion-de-demanda":"C:\\ruta"}'`. Before this,
local checker/reviewer tasks on any repo but the PC's own were rejected with
`repo must be Ineaki/gatetes` (the panel sends `Ineaki/gatetes-agent-vault`).

## Backup and restore

Stop the daemon and all MCP/CLI sessions. Copy the entire private vault to a
private destination with `node src/cli.mjs backup ABSOLUTE-EMPTY-DIRECTORY`.
Backups contain credentials and must be protected like the original vault.
Also back up the coordinator Git repository: worktrees refer to its Git data.
Restore with `restore SOURCE` only into an empty vault at its original path.
Keep the original repo path or repair worktree registrations deliberately with
Git before restarting. Reapply the Windows vault ACL after restore. Do not
take a live file-copy backup while SQLite or worktrees are being changed.

## Validation

`node --test test/*.test.mjs` covers queue idempotency, concurrent connections,
lease fencing, cancellation, write-intent recovery, path/junction restrictions,
context bounds, report retrieval, tool execution, time/step limits and local
continuation independent of a simulated unavailable cloud provider. These
tests use synthetic fixtures and a deterministic model stub. Actual-model
measurements and machine-specific limitations are recorded separately in
`VALIDATION.md`; do not confuse the two.
