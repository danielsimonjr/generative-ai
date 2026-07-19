/**
 * The memory agents: three specialists (ingest, consolidate, query), all
 * running on Claude Haiku and sharing one in-process MCP memory server.
 *
 * The Google ADK original used an LLM orchestrator with sub_agents to route
 * requests. In this port, routing is deterministic in code — every entry
 * point (file watcher, HTTP endpoint, consolidation timer) already knows
 * which specialist it needs, so each operation runs as a single scoped
 * `query()` call with that specialist's system prompt and tool allowlist.
 * This is cheaper (no routing hop) and more reliable for a 24/7 background
 * process.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";

import { getMemoryStats, time } from "./db.js";
import { MEDIA_EXTENSIONS } from "./filetypes.js";
import { memoryServer } from "./tools.js";

export const MODEL = process.env.MODEL ?? "claude-haiku-4-5";

interface Specialist {
  name: string;
  prompt: string;
  tools: string[];
}

const INGEST_AGENT: Specialist = {
  name: "ingest",
  prompt: [
    "You are a Memory Ingest Agent. You handle text, images, and PDF documents.",
    "The user's message IS the content to ingest — never ask for input, offer",
    "your capabilities, or wait for more information. Process exactly what is",
    "given and store it before responding.",
    "",
    "For any input you receive:",
    "1. Thoroughly describe what the content contains",
    "2. Create a concise 1-2 sentence summary",
    "3. Extract key entities (people, companies, products, concepts, objects, locations)",
    "4. Assign 2-4 topic tags",
    "5. Rate importance from 0.0 to 1.0",
    "6. Call search_memories with the key entities to check for closely related",
    "   existing memories",
    "7. Store or update:",
    "   - If an existing memory covers the SAME fact (duplicate), or the new",
    "     information CORRECTS or supersedes it, call update_memory on that",
    "     memory with the merged, corrected content",
    "   - Otherwise call store_memory to create a new memory",
    "",
    "If given a file path, use the Read tool to read it first. For images:",
    "describe the scene, objects, text, people, and any visual details. For",
    "PDFs: extract and summarize the document content (read long PDFs in",
    "page ranges).",
    "",
    "Use the full description as raw_text so the context is preserved.",
    "Always call store_memory or update_memory — exactly one of them.",
    "After storing, confirm in one sentence what was stored or updated.",
  ].join("\n"),
  tools: ["mcp__memory__search_memories", "mcp__memory__store_memory", "mcp__memory__update_memory"],
};

const CONSOLIDATE_AGENT: Specialist = {
  name: "consolidate",
  prompt: [
    "You are a Memory Consolidation Agent. You:",
    "1. Call read_unconsolidated_memories to see what needs processing",
    "2. If fewer than 2 memories, say nothing to consolidate",
    "3. Find connections and patterns across the memories",
    "4. Create a synthesized summary and one key insight",
    "5. Call store_consolidation with source_ids, summary, insight, and connections",
    "",
    "Connections: a list of objects with from_id, to_id, and relationship keys.",
    "Think deeply about cross-cutting patterns.",
  ].join("\n"),
  tools: ["mcp__memory__read_unconsolidated_memories", "mcp__memory__store_consolidation"],
};

const QUERY_AGENT: Specialist = {
  name: "query",
  prompt: [
    "You are a Memory Query Agent. You MUST retrieve memories with your tools",
    "before answering — never answer from assumptions, and never state that",
    "the memory store is empty without confirming via read_all_memories.",
    "",
    "When asked a question:",
    "1. Call search_memories with the question's key terms to find relevant",
    "   memories — this scales to large memory stores. For broad overview",
    "   questions ('what do you know?'), call read_all_memories instead.",
    "2. If search returns no results, call read_all_memories to double-check",
    "   before concluding nothing is stored",
    "3. Call read_consolidation_history for higher-level insights",
    "4. Run additional searches with different terms if the first results",
    "   look incomplete",
    "5. Synthesize an answer based ONLY on the retrieved memories",
    "6. Reference memory IDs: [Memory 1], [Memory 2], etc.",
    "7. If no relevant memories exist, say so honestly",
    "",
    "Be thorough but concise. Always cite sources.",
  ].join("\n"),
  tools: [
    "mcp__memory__search_memories",
    "mcp__memory__read_all_memories",
    "mcp__memory__read_consolidation_history",
  ],
};

export class MemoryAgent {
  constructor(private readonly inboxDir: string) {}

  /** Run one specialist with a message and return the final text response. */
  private async runSpecialist(
    specialist: Specialist,
    message: string,
    extra: { cwd?: string; extraTools?: string[] } = {},
  ): Promise<string> {
    let result = "";
    for await (const sdkMessage of query({
      prompt: message,
      options: {
        model: MODEL,
        systemPrompt: specialist.prompt,
        mcpServers: { memory: memoryServer },
        allowedTools: [...specialist.tools, ...(extra.extraTools ?? [])],
        permissionMode: "dontAsk",
        settingSources: [],
        maxTurns: 12,
        ...(extra.cwd ? { cwd: extra.cwd } : {}),
      },
    })) {
      if (sdkMessage.type === "result") {
        const cost = sdkMessage.total_cost_usd;
        const seconds = (sdkMessage.duration_ms / 1000).toFixed(1);
        console.log(
          `[${time()}] 💰 ${specialist.name}: ${sdkMessage.num_turns} turns, ${seconds}s` +
            (cost != null ? `, $${cost.toFixed(4)}` : ""),
        );
        result = sdkMessage.subtype === "success" ? sdkMessage.result : `Error: ${sdkMessage.subtype}`;
      }
    }
    return result;
  }

  /**
   * Run the ingest agent and verify a memory was actually stored or updated —
   * a memory agent must not fail silently. Retries once with a firmer
   * instruction. (An update bumps no count, so compare the full stats.)
   */
  private async runIngest(message: string, extra: { cwd?: string; extraTools?: string[] } = {}): Promise<string> {
    const statsBefore = JSON.stringify(getMemoryStats());
    let result = await this.runSpecialist(INGEST_AGENT, message, extra);
    if (JSON.stringify(getMemoryStats()) === statsBefore) {
      console.warn(`[${time()}] ⚠️  Ingest did not store or update a memory — retrying once`);
      result = await this.runSpecialist(
        INGEST_AGENT,
        `You MUST call store_memory (or update_memory) for the following content.\n\n${message}`,
        extra,
      );
    }
    return result;
  }

  async ingest(text: string, source = ""): Promise<string> {
    const msg = source
      ? `Remember this information (source: ${source}):\n\n${text}`
      : `Remember this information:\n\n${text}`;
    return this.runIngest(msg);
  }

  /**
   * Ingest a media file (image or PDF) by having the agent Read it. The Read
   * tool is granted for this call only, restricted to the inbox directory —
   * a malicious file can't instruct the agent to read elsewhere on disk.
   */
  async ingestFile(filePath: string): Promise<string> {
    const absPath = path.resolve(filePath);
    const name = path.basename(absPath);
    const mimeType = MEDIA_EXTENSIONS[path.extname(absPath).toLowerCase()] ?? "application/octet-stream";
    const kind = mimeType.split("/")[0];
    console.log(`[${time()}] 🔮 Ingesting ${kind}: ${name}`);
    return this.runIngest(
      `Remember this file (source: ${name}, type: ${mimeType}).\n\n` +
        `Read the file at ${absPath}, thoroughly analyze its content, and ` +
        `extract all meaningful information for memory storage.`,
      { cwd: path.resolve(this.inboxDir), extraTools: ["Read(./**)"] },
    );
  }

  async consolidate(): Promise<string> {
    return this.runSpecialist(
      CONSOLIDATE_AGENT,
      "Consolidate unconsolidated memories. Find connections and patterns.",
    );
  }

  async query(question: string): Promise<string> {
    return this.runSpecialist(QUERY_AGENT, `Based on my memories, answer: ${question}`);
  }
}
