/**
 * Integration test for the specialist agents against a stub Messages API.
 * Verifies the tool-runner wiring end to end without network or API costs:
 * tools are declared on the request, tool calls execute against the real
 * SQLite store, results are fed back, and the ingest verification retry
 * fires when the model stores nothing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-agent-int-"));
process.env.MEMORY_DB = path.join(tmpDir, "test.db");

// Scripted responses: each entry answers one POST /v1/messages request
type Responder = () => unknown;
let script: Responder[] = [];
const requests: any[] = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const responder = script.shift();
    if (!responder) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "script exhausted" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responder()));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
process.env.ANTHROPIC_API_KEY = "test-key";

// Import after env is set — the client reads base URL and key at construction
const { MemoryAgent } = await import("../src/agent.js");
const db = await import("../src/db.js");

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const message = (content: unknown[], stopReason: string) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

test("ingest drives the tool runner: search, store, confirm", async () => {
  script = [
    () =>
      message(
        [{ type: "tool_use", id: "toolu_1", name: "search_memories", input: { query: "quarterly revenue" } }],
        "tool_use",
      ),
    () =>
      message(
        [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "store_memory",
            input: {
              raw_text: "Quarterly revenue target is 2 million dollars",
              summary: "Revenue target 2M",
              entities: ["finance"],
              topics: ["revenue"],
              importance: 0.7,
              source: "test",
            },
          },
        ],
        "tool_use",
      ),
    () => message([{ type: "text", text: "Stored the revenue target." }], "end_turn"),
  ];

  const agent = new MemoryAgent();
  const result = await agent.ingest("Quarterly revenue target is 2 million dollars", "test");

  assert.equal(result, "Stored the revenue target.");
  assert.equal(db.readAllMemories().count, 1); // tool actually ran against SQLite
  assert.equal(script.length, 0); // all three turns consumed — no spurious retry

  // First request declares the ingest specialist's tools and system prompt
  assert.ok(requests[0].tools.some((t: any) => t.name === "store_memory"));
  assert.ok(requests[0].tools.some((t: any) => t.name === "search_memories"));
  assert.match(String(requests[0].system), /Memory Ingest Agent/);

  // The runner fed the search result back as a tool_result for toolu_1
  const followUp = requests[1].messages.at(-1);
  const toolResult = followUp.content.find((b: any) => b.type === "tool_result");
  assert.equal(toolResult.tool_use_id, "toolu_1");
});

test("ingest retries once when the model stores nothing", async () => {
  script = [
    // First run: chats instead of storing — verification must catch this
    () => message([{ type: "text", text: "Happy to help! What should I remember?" }], "end_turn"),
    // Retry run: stores properly
    () =>
      message(
        [
          {
            type: "tool_use",
            id: "toolu_3",
            name: "store_memory",
            input: {
              raw_text: "Bob joins as QA lead in May",
              summary: "Bob QA lead May",
              entities: ["Bob"],
              topics: ["team"],
              importance: 0.6,
            },
          },
        ],
        "tool_use",
      ),
    () => message([{ type: "text", text: "Stored on retry." }], "end_turn"),
  ];

  const agent = new MemoryAgent();
  const result = await agent.ingest("Bob joins as QA lead in May");

  assert.equal(result, "Stored on retry.");
  assert.equal(db.readAllMemories().count, 2);
  assert.equal(script.length, 0);
});

test("identical content is skipped without any API call", async () => {
  script = []; // any request would fail with "script exhausted"
  const requestsBefore = requests.length;

  const agent = new MemoryAgent();
  // Same text as the first ingest test — its hash was recorded on success
  const result = await agent.ingest("Quarterly revenue target is 2 million dollars", "test");

  assert.match(result, /already ingested/);
  assert.equal(requests.length, requestsBefore); // no model call happened
  assert.equal(db.readAllMemories().count, 2); // nothing new stored
});

test("query specialist gets search tools and returns the final answer", async () => {
  script = [
    () =>
      message(
        [{ type: "tool_use", id: "toolu_4", name: "search_memories", input: { query: "revenue" } }],
        "tool_use",
      ),
    () => message([{ type: "text", text: "The revenue target is 2M [Memory 1]." }], "end_turn"),
  ];

  const agent = new MemoryAgent();
  const answer = await agent.query("what is the revenue target?");

  assert.equal(answer, "The revenue target is 2M [Memory 1].");
  const queryRequest = requests.at(-2);
  assert.match(String(queryRequest.system), /Memory Query Agent/);
  assert.ok(!queryRequest.tools.some((t: any) => t.name === "store_memory")); // scoped tools
  // The real search result (from the memories stored above) was fed back
  const fed = requests.at(-1).messages.at(-1).content.find((b: any) => b.type === "tool_result");
  assert.match(JSON.stringify(fed.content), /Revenue target 2M/);
});
