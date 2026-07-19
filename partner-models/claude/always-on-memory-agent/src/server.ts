/**
 * HTTP API — same endpoints as the Python/aiohttp original, built on
 * Node's built-in http module, plus a minimal dashboard at GET /.
 *
 * Binds 127.0.0.1 by default. When a token is configured, every API
 * endpoint requires `Authorization: Bearer <token>`.
 */
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import type { MemoryAgent } from "./agent.js";
import {
  clearAllMemories,
  deleteMemory,
  getMemoryStats,
  readAllMemories,
  time,
} from "./db.js";
import { DASHBOARD_HTML } from "./dashboard.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return null;
  }
}

function isAuthorized(req: http.IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildServer(
  agent: MemoryAgent,
  watchPath: string,
  apiToken?: string,
): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method} ${url.pathname}`;

    // The dashboard page is static and holds no data; everything else is gated
    if (route === "GET /") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(DASHBOARD_HTML);
    }
    if (!isAuthorized(req, apiToken)) {
      return json(res, 401, { error: "unauthorized" });
    }

    try {
      switch (route) {
        case "GET /status": {
          return json(res, 200, getMemoryStats());
        }
        case "GET /memories": {
          return json(res, 200, readAllMemories());
        }
        case "GET /query": {
          const q = (url.searchParams.get("q") ?? "").trim();
          if (!q) return json(res, 400, { error: "missing ?q= parameter" });
          const answer = await agent.query(q);
          return json(res, 200, { question: q, answer });
        }
        case "POST /ingest": {
          const body = await readJsonBody(req);
          if (!body) return json(res, 400, { error: "invalid JSON" });
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) return json(res, 400, { error: "missing 'text' field" });
          const source = typeof body.source === "string" ? body.source : "api";
          const result = await agent.ingest(text, source);
          return json(res, 200, { status: "ingested", response: result });
        }
        case "POST /consolidate": {
          const result = await agent.consolidate();
          return json(res, 200, { status: "done", response: result });
        }
        case "POST /delete": {
          const body = await readJsonBody(req);
          if (!body) return json(res, 400, { error: "invalid JSON" });
          const memoryId = Number(body.memory_id);
          if (!memoryId) return json(res, 400, { error: "missing 'memory_id' field" });
          return json(res, 200, deleteMemory(memoryId));
        }
        case "POST /clear": {
          const memoriesDeleted = clearAllMemories();
          // Clear the inbox so files aren't re-ingested
          let filesDeleted = 0;
          if (fs.existsSync(watchPath)) {
            for (const name of fs.readdirSync(watchPath)) {
              if (name.startsWith(".")) continue; // keep hidden files like .gitkeep
              try {
                fs.rmSync(path.join(watchPath, name), { recursive: true });
                filesDeleted++;
              } catch (err) {
                console.error(`[${time()}] Failed to delete ${name}:`, err);
              }
            }
          }
          console.log(
            `[${time()}] 🗑️  Cleared all ${memoriesDeleted} memories, deleted ${filesDeleted} inbox files`,
          );
          return json(res, 200, {
            status: "cleared",
            memories_deleted: memoriesDeleted,
            files_deleted: filesDeleted,
          });
        }
        default: {
          return json(res, 404, { error: "not found" });
        }
      }
    } catch (err) {
      console.error(`[${time()}] Request error:`, err);
      return json(res, 500, { error: String(err) });
    }
  });
}
