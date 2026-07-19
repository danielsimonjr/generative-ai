/**
 * Memory tools for the Anthropic SDK tool runner.
 *
 * Each tool wraps a synchronous SQLite operation from db.ts and returns its
 * result as JSON text. The tool runner executes the `run` function in-process
 * and feeds the result back to the model automatically.
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import * as db from "./db.js";

const jsonText = (data: unknown) => JSON.stringify(data);

export const storeMemory = betaZodTool({
  name: "store_memory",
  description:
    "Store a processed memory in the database. Call this after extracting structure from new information.",
  inputSchema: z.object({
    raw_text: z.string().describe("The original input text or full content description"),
    summary: z.string().describe("A concise 1-2 sentence summary"),
    entities: z.array(z.string()).describe("Key people, companies, products, or concepts"),
    topics: z.array(z.string()).describe("2-4 topic tags"),
    importance: z.number().min(0).max(1).describe("Importance from 0.0 to 1.0"),
    source: z.string().optional().describe("Where this memory came from (filename, URL, etc.)"),
  }),
  run: async (input) => jsonText(db.storeMemory(input)),
});

export const searchMemories = betaZodTool({
  name: "search_memories",
  description:
    "Full-text search over stored memories (summaries, content, entities, topics). " +
    "Call this to find memories relevant to a question, or to check whether " +
    "information is already stored before creating a new memory.",
  inputSchema: z.object({
    query: z.string().describe("Search terms — key words, entity names, or topics"),
    limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
  }),
  run: async (input) => jsonText(db.searchMemories(input.query, input.limit ?? 10)),
});

export const updateMemory = betaZodTool({
  name: "update_memory",
  description:
    "Update an existing memory in place. Use this instead of store_memory when new " +
    "information duplicates or corrects an already-stored memory. Only the fields " +
    "you pass are changed; the memory is re-queued for consolidation.",
  inputSchema: z.object({
    memory_id: z.number().int().describe("ID of the memory to update"),
    raw_text: z.string().optional().describe("Replacement full content"),
    summary: z.string().optional().describe("Replacement 1-2 sentence summary"),
    entities: z.array(z.string()).optional().describe("Replacement entity list"),
    topics: z.array(z.string()).optional().describe("Replacement topic tags"),
    importance: z.number().min(0).max(1).optional().describe("Replacement importance"),
  }),
  run: async (input) => jsonText(db.updateMemory(input)),
});

export const readAllMemories = betaZodTool({
  name: "read_all_memories",
  description: "Read all stored memories from the database, most recent first.",
  inputSchema: z.object({}),
  run: async () => jsonText(db.readAllMemories()),
});

export const readUnconsolidatedMemories = betaZodTool({
  name: "read_unconsolidated_memories",
  description: "Read memories that haven't been consolidated yet.",
  inputSchema: z.object({}),
  run: async () => jsonText(db.readUnconsolidatedMemories()),
});

export const storeConsolidation = betaZodTool({
  name: "store_consolidation",
  description: "Store a consolidation result and mark source memories as consolidated.",
  inputSchema: z.object({
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
  }),
  run: async (input) => jsonText(db.storeConsolidation(input)),
});

export const readConsolidationHistory = betaZodTool({
  name: "read_consolidation_history",
  description: "Read past consolidation insights, highest level (most abstract) first.",
  inputSchema: z.object({}),
  run: async () => jsonText(db.readConsolidationHistory()),
});

export const readUnconsolidatedConsolidations = betaZodTool({
  name: "read_unconsolidated_consolidations",
  description: "Read insights that haven't been rolled up into a higher-level insight yet.",
  inputSchema: z.object({}),
  run: async () => jsonText(db.readUnconsolidatedConsolidations()),
});

export const storeMetaConsolidation = betaZodTool({
  name: "store_meta_consolidation",
  description:
    "Roll several existing insights up into one higher-level insight and mark them as consolidated.",
  inputSchema: z.object({
    source_consolidation_ids: z.array(z.number().int()).describe("IDs of the insights being rolled up"),
    summary: z.string().describe("A synthesized summary across the source insights"),
    insight: z.string().describe("The single higher-level pattern that emerges"),
  }),
  run: async (input) => jsonText(db.storeMetaConsolidation(input)),
});
