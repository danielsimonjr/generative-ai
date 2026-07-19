# Always On Memory Agent (TypeScript + Anthropic SDK)

**An always-on AI memory agent built with the [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) tool runner + Claude Haiku**

This is a TypeScript port of the [Google ADK + Gemini original](../../../gemini/agents/always-on-memory-agent/), rebuilt on the Anthropic SDK's tool runner. Most AI agents have amnesia — they process information when asked, then forget everything. This project gives an agent a persistent, evolving memory that runs 24/7 as a lightweight background process, continuously processing, consolidating, and connecting information.

No vector database. No embeddings. Just an LLM that reads, thinks, and writes structured memory.

## Architecture

The Google ADK concepts map directly onto the Anthropic SDK:

| Google ADK (original)                | Anthropic SDK (this port)                             |
| ------------------------------------ | ----------------------------------------------------- |
| `Agent` + `sub_agents` + LLM routing | Three specialist tool-runner configurations, routed deterministically in code |
| Python function tools                | Runnable tools (`betaZodTool` + Zod schemas)          |
| Gemini 3.1 Flash-Lite                | Claude Haiku (`claude-haiku-4-5`)                     |
| `Runner` + `InMemorySessionService`  | One stateless `toolRunner()` call per operation       |
| Inline multimodal bytes              | Inline base64 content blocks (images, PDFs)           |
| aiohttp HTTP API                     | Node built-in `http` server                           |
| SQLite via `sqlite3`                 | SQLite via built-in `node:sqlite`                     |

Each operation is one direct Messages API loop — no subprocess, no coding-agent harness — which keeps per-operation latency and token overhead to a minimum for a service that runs 24/7. Three specialist agents share one SQLite memory store through their tools:

- **ingest-agent** — extracts summary, entities, topics, and importance from new input, then searches for closely related existing memories: duplicates and corrections **update the existing memory in place** (`update_memory`); genuinely new information is stored (`store_memory`). A verification retry ensures ingestion never fails silently.
- **consolidate-agent** — periodically reviews unconsolidated memories, finds connections, and stores cross-cutting insights
- **meta-consolidate-agent** — once enough insights accumulate, rolls them up into **higher-level insights** (hierarchical consolidation — insights of insights)
- **query-agent** — retrieves memories via **full-text search** (SQLite FTS5) and answers with `[Memory N]` citations. Search-based retrieval scales to large memory stores instead of loading everything into context.

Memories also **decay**: once consolidated, a memory's effective importance fades with age, and low-importance old memories are archived — the details are forgotten, the insights remain.

Every operation logs its turn count, duration, and cost, so you can watch what 24/7 operation actually costs.

Each specialist is a scoped tool-runner call: its own system prompt, its own tool set, same shared memory store. The original used an LLM orchestrator with `sub_agents` to route requests; here every entry point (file watcher, HTTP endpoint, consolidation timer) already knows its intent, so routing happens in code — one less model hop per request, which matters for an agent that runs 24/7.

## How It Works

### 1. Ingest

Feed the agent text, images, or PDFs. The **ingest-agent** extracts structured information:

```
Input: "Anthropic reports 62% of Claude usage is code-related.
        AI agents are the fastest growing category."
           │
           ▼
   ┌─────────────────────────────────────────────┐
   │ Summary:  Anthropic reports 62% of Claude   │
   │           usage is code-related...          │
   │ Entities: [Anthropic, Claude, AI agents]    │
   │ Topics:   [AI, code generation, agents]     │
   │ Importance: 0.8                             │
   └─────────────────────────────────────────────┘
```

**Supported file types:**

| Category  | Extensions                                                     |
| --------- | -------------------------------------------------------------- |
| Text      | `.txt`, `.md`, `.json`, `.csv`, `.log`, `.xml`, `.yaml`, `.yml` |
| Images    | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`                       |
| Documents | `.pdf`                                                         |

> **Note:** unlike the Gemini original, audio and video files are not supported — Claude models do not process audio or video input. Images and PDFs are sent inline as base64 content blocks, just like the original does with Gemini.

Ingestion has three layers of protection against waste and loss:

- **Exact duplicates never reach the model** — input content is hashed (SHA-256), and re-drops or repeated posts of identical content are skipped for free
- **Fuzzy duplicates and corrections update in place** — the ingest agent searches existing memories first; if the new input covers or corrects something already stored (e.g. "the launch slipped from March 15 to April 1"), it updates that memory instead of creating a near-duplicate, and re-queues it for consolidation
- **Failures are retried, not swallowed** — a file that fails to ingest (e.g. transient API outage) stays unmarked and is retried on later polls, up to 3 attempts per file version

Modified inbox files are re-ingested automatically (the watcher tracks modification times). **Ingestion is parallel** — up to 3 ingests run concurrently (bulk drops don't queue serially), while the consolidation cycle takes exclusive access via a reader-writer gate so it never overlaps with in-flight writes. Read-only queries run unrestricted.

**Four ways to ingest:**

- **File watcher**: drop supported files in the inbox folder — the agent picks them up within ~5 seconds, in parallel
- **HTTP API**: `POST /ingest` with text content
- **Dashboard**: the built-in web UI at `http://127.0.0.1:8888/`
- **Bulk import**: `npm run import -- ./corpus` submits a directory of text files through the [Message Batches API](https://platform.claude.com/docs/en/build-with-claude/batch-processing) at **50% of standard prices** — ideal for one-time backfills. Batch requests use structured outputs instead of the tool loop; results are inserted directly into the store, and the same hash-dedup applies, so re-running an import only processes new files.

### 2. Consolidate

The consolidation cycle runs on a timer (default: every 30 minutes). Like the human brain during sleep, it works in three stages:

1. **Consolidate** — the consolidate-agent reviews unconsolidated memories, finds connections between them, and stores a cross-cutting insight
2. **Roll up (hierarchical consolidation)** — once 3+ insights have accumulated, the meta-consolidate-agent rolls them up into a single higher-level insight ("insights of insights"); levels stack as knowledge accumulates, and the query agent sees the most abstract insights first
3. **Decay** — consolidated memories are archived once their age-discounted importance falls below a threshold (importance halves every 30 days by default). Archived memories disappear from reads and search, but their essence lives on in the insights — like the brain forgetting episodic detail while keeping the lesson. Tune or disable via the `[decay]` settings.

### 3. Query

Ask any question. The **query-agent** reads all memories and consolidation insights, then synthesizes an answer with source citations:

```
Q: "What should I focus on?"

A: "Based on your memories, prioritize:
   1. Ship the API by March 15 [Memory 2]
   2. The agent reliability gap [Memory 1] could be addressed
      by the reconstructive memory approach [Memory 3]"
```

## Quick Start

### 1. Install

Requires **Node.js >= 22.13** (for the built-in `node:sqlite` module).

```bash
cd partner-models/claude/always-on-memory-agent
npm install
```

### 2. Set your API key

```bash
export ANTHROPIC_API_KEY="your-anthropic-api-key"
```

Get a key from the [Claude Console](https://platform.claude.com/). The SDK also accepts `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile.

### 3. Start the agent

```bash
npm start
```

The agent is now running:

- Watching `./inbox/` for new files (text, images, PDFs)
- Consolidating every 30 minutes
- Serving queries at `http://localhost:8888`

### 4. Feed it information

**Option A: drop a file**

```bash
echo "Some important information" > inbox/notes.txt
cp photo.jpg inbox/
cp report.pdf inbox/
# Agent auto-ingests within ~5 seconds
```

**Option B: HTTP API**

```bash
curl -X POST http://localhost:8888/ingest \
  -H "Content-Type: application/json" \
  -d '{"text": "AI agents are the future", "source": "article"}'
```

### 5. Query

```bash
curl "http://localhost:8888/query?q=what+do+you+know"
```

## API Reference

| Endpoint       | Method | Description                                     |
| -------------- | ------ | ----------------------------------------------- |
| `/`            | GET    | Web dashboard (ingest, query, browse, delete)   |
| `/status`      | GET    | Memory statistics (counts)                      |
| `/memories`    | GET    | List all stored memories                        |
| `/ingest`      | POST   | Ingest new text (`{"text": "...", "source": "..."}`) |
| `/query?q=...` | GET    | Query memory with a question                    |
| `/consolidate` | POST   | Trigger manual consolidation                    |
| `/delete`      | POST   | Delete a memory (`{"memory_id": 1}`)            |
| `/clear`       | POST   | Delete all memories (full reset)                |

## CLI Options

```bash
npm start -- [options]

  --watch DIR              Folder to watch (default: inbox from config.ini)
  --port PORT              HTTP API port (default: 8888)
  --consolidate-every MIN  Consolidation interval (default: 30)
```

## Configuration

### The `config.ini` file

The agent reads `config.ini` from the directory it is started in (the project root when using `npm start`). **This file is the canonical source for the database and inbox paths — there are no built-in defaults.** The shipped file provides working values; edit it to relocate either path:

```ini
; Always On Memory Agent configuration

[memory]
; Path to the SQLite database file (env: MEMORY_DB)
db = memory.db

; Folder to watch for new files (env: MEMORY_INBOX, flag: --watch)
inbox = ./inbox
```

**File format:**

- Settings live under the `[memory]` section as `key = value` pairs
- Lines starting with `;` or `#` are comments; blank lines are ignored
- Values may optionally be wrapped in single or double quotes (useful for paths containing `;` or `#`)
- Section and key names are case-insensitive; unknown keys are ignored

**Settings:**

| `[memory]` key | Env var        | Shipped value | Description |
| -------------- | -------------- | ------------- | ----------- |
| `db`           | `MEMORY_DB`    | `memory.db`   | Path to the SQLite database file. Created automatically on first use, along with its three tables (`memories`, `consolidations`, `processed_files`). |
| `inbox`        | `MEMORY_INBOX` | `./inbox`     | Folder watched for new files to ingest. Created automatically if it doesn't exist. |

Relative paths are resolved against the directory the agent is started from.

If a setting is missing everywhere — not in `config.ini`, not in the environment, and (for the inbox) no `--watch` flag — the agent exits at startup with a message naming the missing key.

**Decay settings** (optional, under `[decay]`):

| `[decay]` key    | Env var                       | Default | Description |
| ---------------- | ----------------------------- | ------- | ----------- |
| `half_life_days` | `MEMORY_DECAY_HALF_LIFE_DAYS` | `30`    | Effective importance halves every this many days |
| `threshold`      | `MEMORY_DECAY_THRESHOLD`      | `0.15`  | Consolidated memories below this effective importance are archived. Set `0` to disable decay. |

**Server settings** (optional, under `[server]`):

| `[server]` key | Env var            | Default     | Description |
| -------------- | ------------------ | ----------- | ----------- |
| `host`         | `MEMORY_HOST`      | `127.0.0.1` | Interface the HTTP API binds to. Set `0.0.0.0` to expose on the network — configure a token if you do. |
| `token`        | `MEMORY_API_TOKEN` | *(unset)*   | When set, every API request must send `Authorization: Bearer <token>`. The dashboard page itself loads without auth (it holds no data) and has a token field. |

To load the INI file from somewhere other than the working directory, point the `MEMORY_CONFIG` environment variable at it:

```bash
MEMORY_CONFIG=/etc/memory-agent/config.ini npm start
```

### Precedence

Every setting resolves in this order — the first source that provides a value wins:

1. **CLI flag** (`--watch` for the inbox)
2. **Environment variable** (`MEMORY_DB`, `MEMORY_INBOX`)
3. **`config.ini`** (the canonical source)

For example, with `inbox = /var/data/inbox` in `config.ini`, running `MEMORY_INBOX=/tmp/drop npm start` watches `/tmp/drop`, and adding `-- --watch ./local-inbox` watches `./local-inbox`.

### Other environment variables

| Variable | Default            | Description                     |
| -------- | ------------------ | ------------------------------- |
| `MODEL`  | `claude-haiku-4-5` | Claude model used by all agents |

The Anthropic SDK reads `ANTHROPIC_API_KEY` for authentication (see Quick Start).

## Security Notes

- The HTTP API binds `127.0.0.1` by default and supports bearer-token auth (see Server settings above) — turn the token on before exposing it beyond localhost.
- The agents have no filesystem, shell, or network tools at all — the app itself reads inbox files and sends media inline, so a malicious dropped file can't instruct the agent to read elsewhere on disk.
- Everything the agents can do goes through the memory tools, which only touch the SQLite database.
- Ingested content is framed as untrusted data (`<content>` tags plus an explicit instruction), so text that *looks like* commands is recorded as a memory rather than acted on.
- Request bodies are capped at 1 MB — oversized uploads get a clean `413` (rejected before the body is even sent when the client uses `Expect: 100-continue`).
- The database runs in SQLite WAL mode for crash durability.

## Tests

```bash
npm test        # unit tests for the memory store and INI parser (node:test)
npm run typecheck
```

## Project Structure

```
always-on-memory-agent/
├── src/
│   ├── main.ts        # Entry point: watcher + timer + HTTP server
│   ├── agent.ts       # Specialist agents + operation gate (SDK tool runner)
│   ├── tools.ts       # Memory tools (betaZodTool definitions)
│   ├── importer.ts    # Bulk import via the Message Batches API
│   ├── import.ts      # CLI entry for npm run import
│   ├── db.ts          # SQLite memory store + FTS5 search (node:sqlite)
│   ├── config.ts      # INI config loader (config.ini)
│   ├── dashboard.ts   # Single-page web dashboard (served at GET /)
│   ├── filetypes.ts   # Supported ingestion file types
│   ├── watcher.ts     # Inbox folder watcher (mtime-aware)
│   └── server.ts      # HTTP API + auth
├── test/              # Unit tests (node:test)
├── inbox/             # Drop files here for auto-ingestion
├── config.ini         # Config: db + inbox paths (canonical source)
├── package.json
├── tsconfig.json
└── memory.db          # SQLite database (created automatically)
```

## Why Claude Haiku?

This agent runs continuously. Cost and speed matter more than raw intelligence for background processing:

- **Fast**: low-latency ingestion and retrieval, designed for continuous background operation
- **Cheap**: Haiku is Anthropic's most cost-effective model ($1/$5 per million tokens), making 24/7 operation practical
- **Smart enough**: extracts structure, finds connections, synthesizes answers — and handles images and PDFs natively

## Built With

- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) (`@anthropic-ai/sdk`) — tool runner + Zod tools for the agentic loops
- [Claude Haiku](https://platform.claude.com/docs/en/about-claude/models/overview) for all LLM operations
- `node:sqlite` for persistent memory storage
- Node built-in `http` for the API
