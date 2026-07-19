# AGENTS.md — Always On Memory Agent

Instructions for AI coding agents working on this project. Read this before
changing anything.

## What this project is

A 24/7 background memory service: an LLM (Claude Haiku) that reads, thinks,
and writes structured memory into SQLite. No vector database, no embeddings.
It is a TypeScript port of `gemini/agents/always-on-memory-agent` (Google ADK
+ Gemini), rebuilt on the **plain Anthropic TypeScript SDK's tool runner**
(`client.beta.messages.toolRunner()` + `betaZodTool`). It is a published
sample in a public repo — favor clarity and small dependency count over
cleverness.

Three inputs feed one memory store: an inbox folder watcher, an HTTP API
with a small dashboard, and a Batch API bulk-import script. A timer runs a
consolidation cycle ("sleep cycles") that synthesizes insights, rolls
insights up into higher-level insights, and archives decayed memories.

## Commands

All run from this directory (`partner-models/claude/always-on-memory-agent/`):

| Command | What it does |
| --- | --- |
| `npm install` | Install (Node **>= 22.13** required — `node:sqlite` is built in) |
| `npm start` | Run the agent (watcher + consolidation timer + HTTP server) |
| `npm start -- --watch DIR --port N --consolidate-every MIN` | CLI overrides |
| `npm run import -- <dir-or-files>` | Bulk import text files via the Message Batches API (50% pricing) |
| `npm test` | Full test suite — **runs offline, no API key needed** |
| `npm run typecheck` | `tsc --noEmit` (strict mode) |

Always run `npm run typecheck && npm test` before committing. CI
(`.github/workflows/always-on-memory-agent.yaml`) runs exactly these on
Node 22.

## File map

```
src/
├── main.ts        Entry point. Parses CLI args, resolves config, wires
│                  watcher + consolidation timer + HTTP server, handles
│                  SIGINT/SIGTERM graceful shutdown.
├── agent.ts       The heart. MemoryAgent class, four specialist configs
│                  (ingest / consolidate / meta-consolidate / query), the
│                  OperationGate (reader-writer concurrency), hash dedup,
│                  ingest verification retry, per-op cost logging.
├── tools.ts       Memory tools as betaZodTool definitions (Zod schemas +
│                  run functions calling db.ts). Bare names: store_memory,
│                  search_memories, update_memory, read_all_memories,
│                  read_unconsolidated_memories, store_consolidation,
│                  read_consolidation_history,
│                  read_unconsolidated_consolidations,
│                  store_meta_consolidation.
├── db.ts          SQLite store via node:sqlite (DatabaseSync). Schema,
│                  migrations, FTS5 index + sync triggers, WAL, decay,
│                  ingest-hash ledger, processed-file ledger.
├── config.ts      Minimal INI parser + setting()/requireSetting().
├── importer.ts    Batch API bulk import (structured outputs, no tool loop).
├── import.ts      Thin CLI wrapper for importer.ts.
├── watcher.ts     Inbox poller (5s): collects eligible files, ingests in
│                  parallel, retries failures, tracks mtime for re-ingestion.
├── server.ts      HTTP API (node:http): auth, 1MB body cap, endpoints.
├── dashboard.ts   Single-page HTML dashboard served at GET / (template
│                  string; no build step).
└── filetypes.ts   Supported extensions and MIME map.
test/              node:test suites — see "Testing" below.
config.ini         Canonical config (see "Configuration").
```

## Architecture rules — preserve these

1. **Routing is deterministic, in code.** There is no LLM orchestrator.
   Every entry point already knows its intent and calls the matching
   specialist. Do not add a routing agent or reintroduce subagents.
2. **Each operation = one scoped tool-runner call.** A specialist gets its
   own system prompt and its own tool array — never hand a specialist tools
   it doesn't need (the query agent must not be able to write).
3. **Agents have no filesystem, shell, or network tools.** The app reads
   inbox files itself; images/PDFs are sent inline as base64 content blocks
   (`document` block for PDFs, `image` block otherwise, 20MB cap). Never
   give the model a file-reading tool — this is a security boundary.
4. **Ingested content is untrusted.** Text is wrapped in `<content>` tags
   and the ingest prompt instructs the model to treat it as data, never
   instructions. Keep that framing when touching ingest prompts.
5. **The model at runtime is Haiku** (`claude-haiku-4-5`, override with
   `MODEL` env var). It is chosen for cost/speed on a 24/7 loop. Don't
   silently upgrade the runtime model; pricing constants in agent.ts
   (`INPUT_PRICE`/`OUTPUT_PRICE`) must match the model if you do.
6. **Zero runtime dependencies beyond `@anthropic-ai/sdk` and `zod`.**
   SQLite is `node:sqlite`, HTTP is `node:http`, hashing is `node:crypto`.
   Don't add packages without a strong reason.
7. **ESM with `.js` import suffixes.** `import ... from "./db.js"` (not
   `./db`). `type: "module"`, TS `NodeNext` resolution, strict mode.

## Concurrency model — the OperationGate

`agent.ts` defines a reader-writer gate:

- **Ingests are shared** — up to `INGEST_CONCURRENCY` (3) run at once.
- **The consolidation cycle is exclusive** — it waits for in-flight ingests
  to drain and blocks new ones while it runs.
- **Admission is FIFO** — a waiting exclusive op cannot be starved by a
  stream of new shared ops. Don't "optimize" this away.
- **Queries take no lock** (read-only).

Two invariants that exist *because* of parallelism — do not regress them:

- **Ingest verification must be concurrency-safe.** Success is detected by
  tracking whether the run actually called `store_memory`/`update_memory`
  (tool_use blocks in the runner messages). It must NOT compare global
  memory stats before/after — under parallel ingests another run's write
  masks your failure. This bug existed once; don't reintroduce it.
- **The in-flight hash set** (`MemoryAgent.inFlight`) prevents two
  concurrent identical ingests from both calling the model. The persistent
  hash ledger (`ingest_hashes` table) covers already-completed content.
  A hash is recorded **only after a verified successful write**, so failed
  ingests stay retryable.

## Memory lifecycle semantics

- **Exact dedup (free):** SHA-256 of the raw input (text or file bytes) is
  checked before any model call. `/clear` wipes the hash ledger.
- **Fuzzy dedup (model-driven):** the ingest agent searches first and calls
  `update_memory` for duplicates/corrections instead of `store_memory`.
  Updates reset `consolidated = 0` (re-queued for consolidation).
- **Consolidation cycle** (timer + `POST /consolidate`), three stages, each
  self-skipping when there's nothing to do:
  1. Memory consolidation — needs >= 2 unconsolidated memories.
  2. Meta-consolidation — needs >= `META_CONSOLIDATION_MIN` (3)
     unconsolidated insights; produces a `level = max(source levels) + 1`
     insight and marks sources consolidated.
  3. Decay — archives consolidated memories whose
     `importance * 0.5^(ageDays / halfLifeDays)` < threshold. Stored
     importance is never mutated; effective importance is computed at sweep
     time. `threshold = 0` or `halfLifeDays <= 0` disables.
- **Archived memories** must stay invisible to `read_all_memories`,
  `search_memories`, and `read_unconsolidated_memories` (every read path
  filters `archived = 0`), but they still count in `getMemoryStats().archived`.
  If you add a new read path, filter it.

## Database (db.ts)

- `node:sqlite` `DatabaseSync`, singleton connection, WAL mode
  (`memory.db-wal`/`-shm` sidecars — gitignored via `memory.db*`).
- Tables: `memories` (with `archived`), `consolidations` (with `level`,
  `consolidated`), `processed_files` (path + `mtime_ms`), `ingest_hashes`.
- **Migrations:** additive `ALTER TABLE ... ADD COLUMN` statements wrapped
  in try/catch (fail harmlessly if the column exists). Follow this pattern
  for any schema change — existing user databases must keep working.
- **FTS5:** `memories_fts` is a contentless-sync index over
  summary/raw_text/entities/topics, kept in sync by AFTER INSERT/DELETE/
  UPDATE triggers, rebuilt on startup for pre-FTS databases. If you add or
  rename indexed columns, update the virtual table AND all three triggers
  AND the rebuild.
- **FTS query safety:** `searchMemories` quotes each user term
  (`"term"` with `""` escaping) and ORs them — raw user text must never be
  passed to `MATCH` (FTS syntax injection breaks queries). Keep this.

## Configuration

Precedence for every setting: **CLI flag > environment variable >
`config.ini` > built-in default**. `config.ini` is read from the CWD at
startup (`MEMORY_CONFIG` env var points elsewhere).

**`db` and `inbox` have NO built-in defaults** — `config.ini` is their
canonical source; if unset everywhere, startup exits with an error naming
the key (`requireSetting`). Everything else has defaults (`setting`).

| Setting | INI key | Env var | Default |
| --- | --- | --- | --- |
| Database path | `[memory] db` | `MEMORY_DB` | *(none — shipped ini says `memory.db`)* |
| Inbox path | `[memory] inbox` | `MEMORY_INBOX` (flag `--watch`) | *(none — shipped ini says `./inbox`)* |
| Decay half-life | `[decay] half_life_days` | `MEMORY_DECAY_HALF_LIFE_DAYS` | `30` |
| Decay threshold | `[decay] threshold` | `MEMORY_DECAY_THRESHOLD` | `0.15` (`0` disables) |
| Bind host | `[server] host` | `MEMORY_HOST` | `127.0.0.1` |
| API token | `[server] token` | `MEMORY_API_TOKEN` | *(unset = no auth)* |
| Model | — | `MODEL` | `claude-haiku-4-5` |

INI format (config.ts): `[section]` + `key = value`, `;`/`#` comments,
optional quoting, case-insensitive keys, flat map keyed `section.key`.
When adding a setting: add the INI key + env var pair, document it in
README's Configuration section, and add a parser test only if you extend
the syntax.

## HTTP API (server.ts)

`GET /` (dashboard, unauthenticated — it holds no data), `GET /status`,
`GET /memories`, `GET /query?q=`, `POST /ingest`, `POST /consolidate`,
`POST /delete`, `POST /clear`.

- **Auth:** when a token is configured, every route except `GET /` requires
  `Authorization: Bearer <token>`, compared with `timingSafeEqual`. Keep
  new endpoints behind this gate.
- **Body cap (1MB):** enforced three ways — a `checkContinue` listener
  rejects oversized `Expect: 100-continue` uploads with a clean 413
  *before* the body is sent; a Content-Length precheck handles declared
  bodies; a streaming counter (destroys the socket) backstops undeclared
  chunked bodies. New POST routes must use `readJsonBody` to inherit this.
- Binds `127.0.0.1` by default. Do not change the default bind.

## Prompt engineering notes (learned the hard way)

- **Haiku under-triggers tools.** Prompts must *mandate* tool calls:
  "The user's message IS the content — never ask for input", "You MUST
  retrieve memories with your tools before answering", and the query agent
  must call `read_all_memories` before ever claiming the store is empty.
  These lines fix observed failures (conversational replies instead of
  storing; "the store is empty" hallucinations). Don't soften them.
- The ingest verification retry exists because even with those prompts the
  model occasionally skips the tool. Belt and suspenders — keep both.
- **Prompt caching is intentionally absent:** Haiku 4.5's minimum cacheable
  prefix is 4096 tokens; our tools + system prompts are well under that, so
  `cache_control` would silently no-op. Don't add it unless prompts grow
  past the minimum.

## Bulk import (importer.ts)

The Batches API cannot run a multi-turn tool loop, so import uses
**structured outputs** (`output_config.format` json_schema) — one request
per file, the response is memory JSON, inserted directly via
`db.storeMemory` + `recordIngestHash`. Notes:

- Structured-output schemas must not use numeric `minimum`/`maximum` (not
  supported) — importance is clamped in code instead.
- Hash dedup runs before submission; re-running an import only pays for
  new files.
- `runImport(paths, client?)` takes an injectable client for testing.

## Testing

`npm test` = `tsx --test test/*.test.ts`. Each test file runs in its own
process, so each sets `process.env.MEMORY_DB` (temp dir) **before**
dynamically importing `../src/db.js` / `../src/agent.js` — follow this
pattern in new test files (static imports would race the env setup).

- `db.test.ts` — store layer: CRUD, FTS search (incl. query-syntax edge
  cases), consolidation links, meta-consolidation, decay, hashes, mtime.
- `gate.test.ts` — OperationGate: concurrency cap, exclusive ordering,
  error release.
- `agent.test.ts` — specialists against a **stub Messages API** (a local
  `http.Server` returning scripted responses). Verifies tool declaration,
  real tool execution against SQLite, tool_result feedback, verification
  retry, hash skip, consolidation cycle.
- `import.test.ts` — importer against a **stub Batches API** (batch object
  needs `results_url`; results endpoint returns JSONL).

**Tests must stay offline** — CI has no API key. If you add an agent
behavior, extend the stub scripts; never write a test that hits the real
API. When stubbing: responses are plain Messages-API JSON; the runner sends
one POST per turn; scripted responders are consumed FIFO, so keep each test
sequential (parallel ingests against the FIFO stub are nondeterministic —
test parallelism via the gate, not via stubs).

Live verification (needs `ANTHROPIC_API_KEY`): `npm start`, ingest a fact,
ingest a correction of it (expect update-in-place, not a duplicate), drop a
PDF in the inbox, `POST /consolidate`, then query. Watch the `💰` log lines
for turns/tokens/cost per operation.

## Operational gotchas

- **Zombie servers:** killing the `npm start`/`npx` wrapper PID can orphan
  the child `node` process, which keeps the port. If a port seems haunted
  or old behavior persists after "restart", `pkill -f "src/main.ts"` and
  verify with a curl before debugging anything else.
- Startup **warns** (doesn't exit) when no `ANTHROPIC_API_KEY`/
  `ANTHROPIC_AUTH_TOKEN` is set — the SDK may resolve an `ant auth login`
  profile; the error would otherwise surface on first request.
- `node:sqlite` prints an ExperimentalWarning on Node 22 — harmless.
- The watcher gives up on a failing file after 3 attempts per
  `path:mtime` version (in-memory counter — restarts reset it).

## Repo conventions

- This directory lives inside a fork of `GoogleCloudPlatform/generative-ai`.
  Upstream runs a strict Super Linter on PRs — keep Markdown tables tidy
  and don't introduce trailing whitespace.
- Development branch: `claude/typescript-claude-agent-memory-lr7oek`
  (PR #7). Commit messages: imperative summary line + body explaining why.
- Update README.md in the same commit as any behavior, endpoint, or
  configuration change — it is the user-facing contract. AGENTS.md (this
  file) is the agent-facing contract; update it when invariants change.
- Never commit `memory.db*`, `node_modules/`, or inbox contents
  (`.gitignore` covers them). Never log or echo API keys/tokens.
