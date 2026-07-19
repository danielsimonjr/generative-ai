/**
 * Custom memory tools exposed to the agents as an in-process MCP server.
 *
 * Each tool wraps a synchronous SQLite operation from db.ts and returns its
 * result as JSON text. Tool names surface to the agents as
 * `mcp__memory__<tool_name>`.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import * as db from "./db.js";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

const storeMemory = tool(
  "store_memory",
  "Store a processed memory in the database. Call this after extracting structure from new information.",
  {
    raw_text: z.string().describe("The original input text or full content description"),
    summary: z.string().describe("A concise 1-2 sentence summary"),
    entities: z.array(z.string()).describe("Key people, companies, products, or concepts"),
    topics: z.array(z.string()).describe("2-4 topic tags"),
    importance: z.number().min(0).max(1).describe("Importance from 0.0 to 1.0"),
    source: z.string().optional().describe("Where this memory came from (filename, URL, etc.)"),
  },
  async (args) => jsonResult(db.storeMemory(args)),
);

const searchMemories = tool(
  "search_memories",
  "Full-text search over stored memories (summaries, content, entities, topics). " +
    "Call this to find memories relevant to a question, or to check whether " +
    "information is already stored before creating a new memory.",
  {
    query: z.string().describe("Search terms — key words, entity names, or topics"),
    limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
  },
  async (args) => jsonResult(db.searchMemories(args.query, args.limit ?? 10)),
);

const updateMemory = tool(
  "update_memory",
  "Update an existing memory in place. Use this instead of store_memory when new " +
    "information duplicates or corrects an already-stored memory. Only the fields " +
    "you pass are changed; the memory is re-queued for consolidation.",
  {
    memory_id: z.number().int().describe("ID of the memory to update"),
    raw_text: z.string().optional().describe("Replacement full content"),
    summary: z.string().optional().describe("Replacement 1-2 sentence summary"),
    entities: z.array(z.string()).optional().describe("Replacement entity list"),
    topics: z.array(z.string()).optional().describe("Replacement topic tags"),
    importance: z.number().min(0).max(1).optional().describe("Replacement importance"),
  },
  async (args) => jsonResult(db.updateMemory(args)),
);

const readAllMemories = tool(
  "read_all_memories",
  "Read all stored memories from the database, most recent first.",
  {},
  async () => jsonResult(db.readAllMemories()),
);

const readUnconsolidatedMemories = tool(
  "read_unconsolidated_memories",
  "Read memories that haven't been consolidated yet.",
  {},
  async () => jsonResult(db.readUnconsolidatedMemories()),
);

const storeConsolidation = tool(
  "store_consolidation",
  "Store a consolidation result and mark source memories as consolidated.",
  {
    source_ids: z.array(z.number().int()).describe("Memory IDs that were consolidated"),
    summary: z.string().describe("A synthesized summary across all source memories"),
    insight: z.string().describe("One key pattern or insight discovered"),
    connections: z
      .array(
        z.object({
          from_id: z.number().int(),
          to_id: z.number().int(),
          relationship: z.string(),
        }),
      )
      .describe("Connections between memories"),
  },
  async (args) => jsonResult(db.storeConsolidation(args)),
);

const readConsolidationHistory = tool(
  "read_consolidation_history",
  "Read past consolidation insights.",
  {},
  async () => jsonResult(db.readConsolidationHistory()),
);

const getMemoryStats = tool(
  "get_memory_stats",
  "Get current memory statistics (counts of memories and consolidations).",
  {},
  async () => jsonResult(db.getMemoryStats()),
);

export const memoryServer = createSdkMcpServer({
  name: "memory",
  version: "1.0.0",
  tools: [
    storeMemory,
    searchMemories,
    updateMemory,
    readAllMemories,
    readUnconsolidatedMemories,
    storeConsolidation,
    readConsolidationHistory,
    getMemoryStats,
  ],
});
