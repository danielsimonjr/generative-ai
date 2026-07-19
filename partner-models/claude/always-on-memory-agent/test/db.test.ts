import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Point the store at a throwaway database before importing it
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-agent-test-"));
process.env.MEMORY_DB = path.join(tmpDir, "test.db");
const db = await import("../src/db.js");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("stores and reads memories", () => {
  const r = db.storeMemory({
    raw_text: "AI agents are growing fast",
    summary: "AI agent growth",
    entities: ["AI agents"],
    topics: ["AI"],
    importance: 0.8,
    source: "test",
  });
  assert.equal(r.status, "stored");
  const all = db.readAllMemories();
  assert.equal(all.count, 1);
  assert.equal(all.memories[0].summary, "AI agent growth");
  assert.deepEqual(all.memories[0].entities, ["AI agents"]);
});

test("full-text search finds memories by content, entities, and topics", () => {
  db.storeMemory({
    raw_text: "Quarterly revenue target is 2 million dollars",
    summary: "Revenue target set",
    entities: ["finance team"],
    topics: ["revenue", "planning"],
    importance: 0.7,
  });
  assert.equal(db.searchMemories("revenue").count, 1);
  assert.equal(db.searchMemories("finance").count, 1);
  assert.ok(db.searchMemories("nonexistent-term-xyz").count === 0);
  // Special characters in the query must not break FTS syntax
  assert.equal(db.searchMemories('revenue "quoted" (parens) *star').count, 1);
  assert.equal(db.searchMemories("").count, 0);
});

test("updates a memory in place and re-queues it for consolidation", () => {
  const r = db.storeMemory({
    raw_text: "Ship date is March 15",
    summary: "Ship date March 15",
    entities: ["launch"],
    topics: ["schedule"],
    importance: 0.6,
  });
  db.storeConsolidation({ source_ids: [r.memory_id], summary: "s", insight: "i", connections: [] });
  assert.equal(db.readUnconsolidatedMemories().memories.some((m) => m.id === r.memory_id), false);

  const u = db.updateMemory({ memory_id: r.memory_id, summary: "Ship date moved to April 1" });
  assert.equal(u.status, "updated");
  const updated = db.readAllMemories().memories.find((m) => m.id === r.memory_id);
  assert.equal(updated?.summary, "Ship date moved to April 1");
  assert.equal(updated?.consolidated, false); // re-queued
  assert.equal(db.searchMemories("April").count, 1); // FTS index updated by trigger

  assert.equal(db.updateMemory({ memory_id: 9999, summary: "x" }).status, "not_found");
  assert.equal(db.updateMemory({ memory_id: r.memory_id }).status, "no_changes");
});

test("consolidation links connections on both memories", () => {
  const a = db.storeMemory({ raw_text: "a", summary: "memory a", entities: [], topics: [], importance: 0.5 });
  const b = db.storeMemory({ raw_text: "b", summary: "memory b", entities: [], topics: [], importance: 0.5 });
  db.storeConsolidation({
    source_ids: [a.memory_id, b.memory_id],
    summary: "combined",
    insight: "linked",
    connections: [{ from_id: a.memory_id, to_id: b.memory_id, relationship: "relates" }],
  });
  const memories = db.readAllMemories().memories;
  const memA = memories.find((m) => m.id === a.memory_id);
  const memB = memories.find((m) => m.id === b.memory_id);
  assert.deepEqual(memA?.connections, [{ linked_to: b.memory_id, relationship: "relates" }]);
  assert.deepEqual(memB?.connections, [{ linked_to: a.memory_id, relationship: "relates" }]);
  assert.equal(memA?.consolidated, true);
});

test("deletes memories and reports missing ids", () => {
  const r = db.storeMemory({ raw_text: "temp", summary: "temp", entities: [], topics: [], importance: 0.1 });
  assert.equal(db.deleteMemory(r.memory_id).status, "deleted");
  assert.equal(db.deleteMemory(r.memory_id).status, "not_found");
  assert.equal(db.searchMemories("temp").count, 0); // FTS row removed by trigger
});

test("tracks processed files by path and mtime", () => {
  assert.equal(db.isFileProcessed("/x/a.txt", 100), false);
  db.markFileProcessed("/x/a.txt", 100);
  assert.equal(db.isFileProcessed("/x/a.txt", 100), true);
  assert.equal(db.isFileProcessed("/x/a.txt", 200), false); // modified later -> re-ingest
  db.markFileProcessed("/x/a.txt", 200);
  assert.equal(db.isFileProcessed("/x/a.txt", 200), true);
});

test("clearAllMemories wipes every table", () => {
  db.storeMemory({ raw_text: "x", summary: "x", entities: [], topics: [], importance: 0.5 });
  const removed = db.clearAllMemories();
  assert.ok(removed >= 1);
  assert.equal(db.readAllMemories().count, 0);
  assert.equal(db.getMemoryStats().consolidations, 0);
  assert.equal(db.isFileProcessed("/x/a.txt", 200), false);
});
