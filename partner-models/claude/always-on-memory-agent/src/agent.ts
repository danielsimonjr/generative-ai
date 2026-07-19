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
  prompt: string;
  tools: string[];
}

const INGEST_AGENT: Specialist = {
  prompt: [
    "You are a Memory Ingest Agent. You handle text, images, and PDF documents.",
    "The user's message IS the content to ingest — never ask for input, offer",
    "your capabilities, or wait for more information. Process exactly what is",
    "given and call store_memory before responding.",
    "",
    "For any input you receive:",
    "1. Thoroughly describe what the content contains",
    "2. Create a concise 1-2 sentence summary",
    "3. Extract key entities (people, companies, products, concepts, objects, locations)",
    "4. Assign 2-4 topic tags",
    "5. Rate importance from 0.0 to 1.0",
    "6. Call store_memory with all extracted information",
    "",
    "If given a file path, use the Read tool to read it first. For images:",
    "describe the scene, objects, text, people, and any visual details. For",
    "PDFs: extract and summarize the document content (read long PDFs in",
    "page ranges).",
    "",
    "Use the full description as raw_text in store_memory so the context is",
    "preserved. Always call store_memory. Be concise and accurate.",
    "After storing, confirm what was stored in one sentence.",
  ].join("\n"),
  tools: ["Read", "mcp__memory__store_memory"],
};

const CONSOLIDATE_AGENT: Specialist = {
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
  prompt: [
    "You are a Memory Query Agent. When asked a question:",
    "1. Call read_all_memories to access the memory store",
    "2. Call read_consolidation_history for higher-level insights",
    "3. Synthesize an answer based ONLY on stored memories",
    "4. Reference memory IDs: [Memory 1], [Memory 2], etc.",
    "5. If no relevant memories exist, say so honestly",
    "",
    "Be thorough but concise. Always cite sources.",
  ].join("\n"),
  tools: ["mcp__memory__read_all_memories", "mcp__memory__read_consolidation_history"],
};

export class MemoryAgent {
  /** Run one specialist with a message and return the final text response. */
  private async runSpecialist(specialist: Specialist, message: string): Promise<string> {
    let result = "";
    for await (const sdkMessage of query({
      prompt: message,
      options: {
        model: MODEL,
        systemPrompt: specialist.prompt,
        mcpServers: { memory: memoryServer },
        allowedTools: specialist.tools,
        permissionMode: "dontAsk",
        settingSources: [],
        maxTurns: 12,
      },
    })) {
      if (sdkMessage.type === "result") {
        result = sdkMessage.subtype === "success" ? sdkMessage.result : `Error: ${sdkMessage.subtype}`;
      }
    }
    return result;
  }

  /**
   * Run the ingest agent and verify a memory was actually stored — a memory
   * agent must not fail silently. Retries once with a firmer instruction.
   */
  private async runIngest(message: string): Promise<string> {
    const before = getMemoryStats().total_memories;
    let result = await this.runSpecialist(INGEST_AGENT, message);
    if (getMemoryStats().total_memories === before) {
      console.warn(`[${time()}] ⚠️  Ingest did not store a memory — retrying once`);
      result = await this.runSpecialist(
        INGEST_AGENT,
        `You MUST call the store_memory tool for the following content.\n\n${message}`,
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

  /** Ingest a media file (image or PDF) by having the agent Read it. */
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
