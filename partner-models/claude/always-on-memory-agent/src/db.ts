/**
 * SQLite-backed memory store.
 *
 * Uses the built-in `node:sqlite` module (Node >= 22.13) — no native
 * dependencies, no vector database. Memories, consolidations, and the
 * processed-file ledger all live in one file.
 */
import { DatabaseSync } from "node:sqlite";

import { requireSetting } from "./config.js";

export const DB_PATH = requireSetting("MEMORY_DB", "memory.db");

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL DEFAULT '',
        raw_text TEXT NOT NULL,
        summary TEXT NOT NULL,
        entities TEXT NOT NULL DEFAULT '[]',
        topics TEXT NOT NULL DEFAULT '[]',
        connections TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        consolidated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS consolidations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_ids TEXT NOT NULL,
        summary TEXT NOT NULL,
        insight TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_files (
        path TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL,
        mtime_ms REAL NOT NULL DEFAULT 0
      );
    `);
    // Migrate databases created before the mtime_ms column existed
    try {
      db.exec("ALTER TABLE processed_files ADD COLUMN mtime_ms REAL NOT NULL DEFAULT 0");
    } catch {
      // column already exists
    }
    // Full-text index over memories, kept in sync by triggers
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        summary, raw_text, entities, topics,
        content='memories', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
        VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
        VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
        VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
        VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;
    `);
    // Rebuild the index so databases from before the FTS table stay searchable
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
  }
  return db;
}

export interface Memory {
  id: number;
  source: string;
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
  connections: unknown[];
  created_at: string;
  consolidated: boolean;
}

export interface Connection {
  from_id: number;
  to_id: number;
  relationship: string;
}

export function storeMemory(args: {
  raw_text: string;
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
  source?: string;
}) {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `INSERT INTO memories (source, raw_text, summary, entities, topics, importance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.source ?? "",
      args.raw_text,
      args.summary,
      JSON.stringify(args.entities),
      JSON.stringify(args.topics),
      args.importance,
      now,
    );
  const memoryId = Number(result.lastInsertRowid);
  console.log(`[${time()}] 📥 Stored memory #${memoryId}: ${args.summary.slice(0, 60)}...`);
  return { memory_id: memoryId, status: "stored", summary: args.summary };
}

export function readAllMemories() {
  const rows = getDb()
    .prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT 50")
    .all() as Record<string, unknown>[];
  const memories = rows.map(rowToMemory);
  return { memories, count: memories.length };
}

function rowToMemory(r: Record<string, unknown>): Memory {
  return {
    id: r.id as number,
    source: r.source as string,
    summary: r.summary as string,
    entities: JSON.parse(r.entities as string),
    topics: JSON.parse(r.topics as string),
    importance: r.importance as number,
    connections: JSON.parse(r.connections as string),
    created_at: r.created_at as string,
    consolidated: Boolean(r.consolidated),
  };
}

/** Full-text search over summaries, raw text, entities, and topics. */
export function searchMemories(searchQuery: string, limit = 10) {
  // Quote each term so user text can't break FTS5 query syntax; OR them
  // together for recall — bm25 ranking sorts the best matches first.
  const terms = searchQuery
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`);
  if (terms.length === 0) return { memories: [], count: 0 };
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(terms.join(" OR "), limit) as Record<string, unknown>[];
  const memories = rows.map(rowToMemory);
  return { memories, count: memories.length };
}

/** Update an existing memory in place (dedup / correction). */
export function updateMemory(args: {
  memory_id: number;
  raw_text?: string;
  summary?: string;
  entities?: string[];
  topics?: string[];
  importance?: number;
}) {
  const database = getDb();
  const row = database.prepare("SELECT 1 FROM memories WHERE id = ?").get(args.memory_id);
  if (!row) {
    return { status: "not_found", memory_id: args.memory_id };
  }
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (args.raw_text !== undefined) (sets.push("raw_text = ?"), params.push(args.raw_text));
  if (args.summary !== undefined) (sets.push("summary = ?"), params.push(args.summary));
  if (args.entities !== undefined) (sets.push("entities = ?"), params.push(JSON.stringify(args.entities)));
  if (args.topics !== undefined) (sets.push("topics = ?"), params.push(JSON.stringify(args.topics)));
  if (args.importance !== undefined) (sets.push("importance = ?"), params.push(args.importance));
  if (sets.length === 0) {
    return { status: "no_changes", memory_id: args.memory_id };
  }
  // Content changed — surface it to the next consolidation cycle again
  sets.push("consolidated = 0");
  database.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params, args.memory_id);
  console.log(`[${time()}] ✏️  Updated memory #${args.memory_id}`);
  return { status: "updated", memory_id: args.memory_id };
}

export function readUnconsolidatedMemories() {
  const rows = getDb()
    .prepare("SELECT * FROM memories WHERE consolidated = 0 ORDER BY created_at DESC LIMIT 10")
    .all() as Record<string, unknown>[];
  const memories = rows.map((r) => ({
    id: r.id as number,
    summary: r.summary as string,
    entities: JSON.parse(r.entities as string),
    topics: JSON.parse(r.topics as string),
    importance: r.importance as number,
    created_at: r.created_at as string,
  }));
  return { memories, count: memories.length };
}

export function storeConsolidation(args: {
  source_ids: number[];
  summary: string;
  insight: string;
  connections: Connection[];
}) {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare("INSERT INTO consolidations (source_ids, summary, insight, created_at) VALUES (?, ?, ?, ?)")
    .run(JSON.stringify(args.source_ids), args.summary, args.insight, now);

  for (const conn of args.connections) {
    if (!conn.from_id || !conn.to_id) continue;
    for (const mid of [conn.from_id, conn.to_id]) {
      const row = database
        .prepare("SELECT connections FROM memories WHERE id = ?")
        .get(mid) as { connections: string } | undefined;
      if (row) {
        const existing = JSON.parse(row.connections) as unknown[];
        existing.push({
          linked_to: mid === conn.from_id ? conn.to_id : conn.from_id,
          relationship: conn.relationship ?? "",
        });
        database
          .prepare("UPDATE memories SET connections = ? WHERE id = ?")
          .run(JSON.stringify(existing), mid);
      }
    }
  }

  const placeholders = args.source_ids.map(() => "?").join(",");
  database
    .prepare(`UPDATE memories SET consolidated = 1 WHERE id IN (${placeholders})`)
    .run(...args.source_ids);

  console.log(
    `[${time()}] 🔄 Consolidated ${args.source_ids.length} memories. Insight: ${args.insight.slice(0, 80)}...`,
  );
  return {
    status: "consolidated",
    memories_processed: args.source_ids.length,
    insight: args.insight,
  };
}

export function readConsolidationHistory() {
  const rows = getDb()
    .prepare("SELECT * FROM consolidations ORDER BY created_at DESC LIMIT 10")
    .all() as Record<string, unknown>[];
  const consolidations = rows.map((r) => ({
    summary: r.summary as string,
    insight: r.insight as string,
    source_ids: r.source_ids as string,
  }));
  return { consolidations, count: consolidations.length };
}

export function getMemoryStats() {
  const database = getDb();
  const total = (database.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
  const unconsolidated = (
    database.prepare("SELECT COUNT(*) as c FROM memories WHERE consolidated = 0").get() as { c: number }
  ).c;
  const consolidations = (
    database.prepare("SELECT COUNT(*) as c FROM consolidations").get() as { c: number }
  ).c;
  return { total_memories: total, unconsolidated, consolidations };
}

export function deleteMemory(memoryId: number) {
  const database = getDb();
  const row = database.prepare("SELECT 1 FROM memories WHERE id = ?").get(memoryId);
  if (!row) {
    return { status: "not_found", memory_id: memoryId };
  }
  database.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
  console.log(`[${time()}] 🗑️  Deleted memory #${memoryId}`);
  return { status: "deleted", memory_id: memoryId };
}

/** A file needs (re-)ingestion when unseen or modified since last processed. */
export function isFileProcessed(path: string, mtimeMs: number): boolean {
  const row = getDb()
    .prepare("SELECT mtime_ms FROM processed_files WHERE path = ?")
    .get(path) as { mtime_ms: number } | undefined;
  return row !== undefined && row.mtime_ms >= mtimeMs;
}

export function markFileProcessed(path: string, mtimeMs: number): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO processed_files (path, processed_at, mtime_ms) VALUES (?, ?, ?)")
    .run(path, new Date().toISOString(), mtimeMs);
}

export function clearAllMemories() {
  const database = getDb();
  const memCount = (database.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
  database.exec("DELETE FROM memories; DELETE FROM consolidations; DELETE FROM processed_files;");
  return memCount;
}

export function time(): string {
  return new Date().toTimeString().slice(0, 5);
}
