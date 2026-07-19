/**
 * Agent Memory Layer — Always-On Claude Agent
 *
 * A lightweight, cost-effective background agent that continuously
 * processes, consolidates, and serves memory. Runs 24/7 on Claude Haiku
 * via the Claude Agent SDK.
 *
 * Usage:
 *     npm start                                     # watch ./inbox, serve on :8888
 *     npm start -- --watch ./docs --port 9000
 *     npm start -- --consolidate-every 15           # consolidate every 15 min
 *
 * Query:
 *     curl "http://localhost:8888/query?q=what+do+you+know"
 *     curl -X POST http://localhost:8888/ingest -d '{"text": "some info"}'
 */
import { parseArgs } from "node:util";

import { MemoryAgent, MODEL } from "./agent.js";
import { setting } from "./config.js";
import { DB_PATH, getDb, time } from "./db.js";
import { buildServer } from "./server.js";
import { startWatcher } from "./watcher.js";

const { values } = parseArgs({
  options: {
    watch: { type: "string", default: setting("MEMORY_INBOX", "memory.inbox", "./inbox") },
    port: { type: "string", default: "8888" },
    "consolidate-every": { type: "string", default: "30" },
  },
});

const watchDir = values.watch!;
const port = Number(values.port);
const consolidateEveryMin = Number(values["consolidate-every"]);

const agent = new MemoryAgent();

console.log(`[${time()}] 🧠 Agent Memory Layer starting`);
console.log(`   Model: ${MODEL}`);
console.log(`   Database: ${DB_PATH}`);
console.log(`   Watch: ${watchDir}`);
console.log(`   Consolidate: every ${consolidateEveryMin}m`);
console.log(`   API: http://localhost:${port}`);
console.log("");

// File watcher
const watcher = startWatcher(agent, watchDir);

// Consolidation timer — like sleep cycles
console.log(`[${time()}] 🔄 Consolidation: every ${consolidateEveryMin} minutes`);
const consolidationTimer = setInterval(
  async () => {
    try {
      const { c } = getDb()
        .prepare("SELECT COUNT(*) as c FROM memories WHERE consolidated = 0")
        .get() as { c: number };
      if (c >= 2) {
        console.log(`[${time()}] 🔄 Running consolidation (${c} unconsolidated memories)...`);
        const result = await agent.consolidate();
        console.log(`[${time()}] 🔄 ${result.slice(0, 100)}`);
      } else {
        console.log(`[${time()}] 🔄 Skipping consolidation (${c} unconsolidated memories)`);
      }
    } catch (err) {
      console.error(`[${time()}] Consolidation error:`, err);
    }
  },
  consolidateEveryMin * 60 * 1000,
);

// HTTP API
const server = buildServer(agent, watchDir);
server.listen(port, () => {
  console.log(
    `[${time()}] ✅ Agent running. Drop files in ${watchDir}/ or POST to http://localhost:${port}/ingest`,
  );
  console.log("   Supported: text, images, PDFs");
  console.log("");
});

// Graceful shutdown
function shutdown(sig: string): void {
  console.log(`\n[${time()}] 👋 Shutting down (${sig})...`);
  watcher.stop();
  clearInterval(consolidationTimer);
  server.close(() => {
    console.log(`[${time()}] 🧠 Agent stopped.`);
    process.exit(0);
  });
  // Force-exit if the server doesn't close promptly
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
