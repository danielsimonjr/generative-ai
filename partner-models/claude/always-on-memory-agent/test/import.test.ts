/**
 * Import-script test against a stub Message Batches API. Verifies file
 * collection, hash-dedup before submission, request shape (structured
 * outputs, no tools), result parsing, and DB insertion.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-agent-import-"));
process.env.MEMORY_DB = path.join(tmpDir, "test.db");

const requests: any[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = req.url ?? "";
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const batchObject = {
      id: "msgbatch_test",
      type: "message_batch",
      processing_status: "ended",
      request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 },
      created_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-02T00:00:00Z",
      ended_at: "2026-01-01T00:10:00Z",
      cancel_initiated_at: null,
      archived_at: null,
      results_url: `${baseUrl}/v1/messages/batches/msgbatch_test/results`,
    };

    if (req.method === "POST" && url.includes("/v1/messages/batches")) {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(batchObject));
    }
    if (url.includes("/results")) {
      const line = (customId: string, summary: string) =>
        JSON.stringify({
          custom_id: customId,
          result: {
            type: "succeeded",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-haiku-4-5",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    summary,
                    entities: ["batch"],
                    topics: ["import"],
                    importance: 0.6,
                  }),
                },
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
        });
      res.writeHead(200, { "Content-Type": "application/x-jsonl" });
      // custom_ids must match the non-skipped files (indices 0 and 2)
      return res.end(`${line("file-0", "alpha summary")}\n${line("file-2", "gamma summary")}\n`);
    }
    if (url.includes("/v1/messages/batches/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(batchObject));
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
process.env.ANTHROPIC_API_KEY = "test-key";

const db = await import("../src/db.js");
const { runImport } = await import("../src/importer.js");

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("imports a directory via the Batch API, skipping known content", async () => {
  const corpus = path.join(tmpDir, "corpus");
  fs.mkdirSync(corpus);
  fs.writeFileSync(path.join(corpus, "alpha.txt"), "alpha content");
  fs.writeFileSync(path.join(corpus, "beta.md"), "beta content — already known");
  fs.writeFileSync(path.join(corpus, "gamma.txt"), "gamma content");
  fs.writeFileSync(path.join(corpus, "photo.png"), "not text"); // ignored: media
  // beta's content hash is pre-recorded — must be skipped before submission
  db.recordIngestHash(createHash("sha256").update("beta content — already known").digest("hex"));

  const summary = await runImport([corpus]);

  assert.deepEqual(summary, { imported: 2, skipped: 1, errored: 0 });

  // Only the two unknown files were submitted, with structured outputs, no tools
  const batchRequests = requests[0].requests;
  assert.equal(batchRequests.length, 2);
  assert.deepEqual(
    batchRequests.map((r: any) => r.custom_id),
    ["file-0", "file-2"],
  );
  assert.ok(batchRequests[0].params.output_config.format.schema.required.includes("summary"));
  assert.equal(batchRequests[0].params.tools, undefined);
  assert.match(batchRequests[0].params.messages[0].content, /<content>/);

  // Results landed in the store with source + hash recorded
  const memories = db.readAllMemories().memories;
  assert.equal(memories.length, 2);
  const alpha = memories.find((m) => m.source === "alpha.txt");
  assert.equal(alpha?.summary, "alpha summary");
  assert.equal(db.hasIngestHash(createHash("sha256").update("alpha content").digest("hex")), true);

  // Re-running imports nothing new — everything hash-skips
  const rerun = await runImport([corpus]);
  assert.deepEqual(rerun, { imported: 0, skipped: 3, errored: 0 });
});
