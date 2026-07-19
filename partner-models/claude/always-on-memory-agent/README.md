# Always On Memory Agent (TypeScript + Claude Agent SDK)

**An always-on AI memory agent built with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) + Claude Haiku**

This is a TypeScript port of the [Google ADK + Gemini original](../../../gemini/agents/always-on-memory-agent/), rebuilt on Anthropic's Claude Agent SDK. Most AI agents have amnesia — they process information when asked, then forget everything. This project gives an agent a persistent, evolving memory that runs 24/7 as a lightweight background process, continuously processing, consolidating, and connecting information.

No vector database. No embeddings. Just an LLM that reads, thinks, and writes structured memory.

## Architecture

The Google ADK concepts map directly onto the Claude Agent SDK:

| Google ADK (original)                | Claude Agent SDK (this port)                          |
| ------------------------------------ | ----------------------------------------------------- |
| `Agent` + `sub_agents` + LLM routing | Three specialist `query()` configurations, routed deterministically in code |
| Python function tools                | In-process MCP server (`createSdkMcpServer` + `tool`) |
| Gemini 3.1 Flash-Lite                | Claude Haiku (`claude-haiku-4-5`)                     |
| `Runner` + `InMemorySessionService`  | One stateless `query()` call per operation            |
| Inline multimodal bytes              | Built-in `Read` tool (images, PDFs)                   |
| aiohttp HTTP API                     | Node built-in `http` server                           |
| SQLite via `sqlite3`                 | SQLite via built-in `node:sqlite`                     |

Three specialist agents share one SQLite memory store, exposed to them as an in-process MCP server:

- **ingest-agent** — extracts summary, entities, topics, and importance from new input, then calls `store_memory` (with a verification retry so ingestion never fails silently)
- **consolidate-agent** — periodically reviews unconsolidated memories, finds connections, and stores cross-cutting insights
- **query-agent** — answers questions from stored memories with `[Memory N]` citations

Each specialist is a scoped `query()` call: its own system prompt, its own tool allowlist (`allowedTools`), same shared memory server. The original used an LLM orchestrator with `sub_agents` to route requests; here every entry point (file watcher, HTTP endpoint, consolidation timer) already knows its intent, so routing happens in code — one less model hop per request, which matters for an agent that runs 24/7. (The Agent SDK's subagent mechanism also currently runs subagents as background tasks and does not expose in-process SDK MCP servers to them, which rules out a faithful `Task`-tool orchestrator for this design.)

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

> **Note:** unlike the Gemini original, audio and video files are not supported — Claude models do not process audio or video input. Media files are ingested via the SDK's built-in `Read` tool rather than inline bytes.

**Two ways to ingest:**

- **File watcher**: drop a supported file in the `./inbox` folder — the agent picks it up within ~5 seconds
- **HTTP API**: `POST /ingest` with text content

### 2. Consolidate

The **consolidate-agent** runs on a timer (default: every 30 minutes). Like the human brain during sleep, it reviews unconsolidated memories, finds connections between them, generates cross-cutting insights, and compresses related information.

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

Get a key from the [Claude Console](https://platform.claude.com/). The Claude Agent SDK also picks up an existing Claude Code login automatically.

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

  --watch DIR              Folder to watch (default: ./inbox)
  --port PORT              HTTP API port (default: 8888)
  --consolidate-every MIN  Consolidation interval (default: 30)
```

Environment variables: `MODEL` (default `claude-haiku-4-5`), `MEMORY_DB` (default `memory.db`).

## Project Structure

```
always-on-memory-agent/
├── src/
│   ├── main.ts        # Entry point: watcher + timer + HTTP server
│   ├── agent.ts       # Orchestrator + subagents (Claude Agent SDK)
│   ├── tools.ts       # Memory tools as an in-process MCP server
│   ├── db.ts          # SQLite memory store (node:sqlite)
│   ├── filetypes.ts   # Supported ingestion file types
│   ├── watcher.ts     # Inbox folder watcher
│   └── server.ts      # HTTP API
├── inbox/             # Drop files here for auto-ingestion
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

- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (`@anthropic-ai/claude-agent-sdk`) for agent orchestration, subagents, and tools
- [Claude Haiku](https://platform.claude.com/docs/en/about-claude/models/overview) for all LLM operations
- `node:sqlite` for persistent memory storage
- Node built-in `http` for the API
