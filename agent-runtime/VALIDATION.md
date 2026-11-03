# Validation — 3 November 2026

## Automated checks

23 tests passed on Windows with Node 24.22.1. Includes actual Git worktree
creation, SQLite connections, authenticated loopback HTTP and a separate MCP
stdio process. Model responses in unit tests are deterministic stubs.

## Actual local model

The installed HTTP daemon accepted a synthetic coding task with a delegate
credential and completed it using `qwen2.5:3b`, CPU inference, 8192 context:

- 4 model calls; 5716 input tokens and 451 output tokens in total.
- 44,084 ms total measured inference time.
- Generated an exported JavaScript greeting function in its private worktree.
- Literal acceptance passed; independent JavaScript syntax validation passed.
- No paid provider, cloud model or cloud API call was made by the runtime.

A preceding generated greeting was manually inspected and its behavior checked
with a synthetic name. This is a small smoke test, not evidence of general
coding quality or parity with Grok Bot.

`qwen3:4b` was rejected as the initial default: GPU loading failed with a CUDA
kernel image error, and CPU tool inference exhausted its output budget on the
test task. The current machine has 32 GiB RAM and an 8 GiB NVIDIA laptop GPU.
CPU mode is configured privately; system drivers were not changed.

## Context experiment

`node examples/benchmark.mjs` compared a synthetic archive with a selected
relevant record. In both 8192 and 16384 context runs the answer was correct.
Full input: 3431 measured tokens. Selected input: 41 measured tokens.
Full latency: 20,416 / 23,958 ms; selected latency: 191 / 193 ms.

These are single measurements with full runs preceding selected runs, so
cache and model warm-up affect latency. This only tests simple fact retrieval.
It does not establish a general cost reduction or coding-quality equivalence.
8192 is the initial default because 16384 offered no benefit in this test.

## Installed host integration

Private SQLite/vault and separate admin/delegate credentials created outside
the public repository. Current-user login startup and hidden Node gateway
installed. Windows execution policy was left unchanged; the installer uses a
Windows Script Host launcher rather than an unsigned PowerShell script file.

Grok Bot's UI showed local execution already allowed and local traffic routing
already enabled. Its usage indicator showed 100% consumed. No live task from
Grok Bot was executed during this validation. No Bot descriptions, permissions,
billing settings, messages or existing cloud tasks were changed.

The local HTTP and MCP bridges are tested; automatic replacement of Grok Bot's
internal model, billing/quota detection, cloud browser mirroring and recovery
of cloud work that was never delegated are not implemented. A task already
persisted in the local queue continues independently of cloud availability.

## Repository boundary

All implementation files are in `agent-runtime/`. Existing root README and
privacy page content are unchanged. Actual vault contents, credentials, logs,
worktrees and database files are excluded from publication. Changes are offered
on a separate branch; merging and production publishing are separate actions.
