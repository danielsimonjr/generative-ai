/**
 * Inbox folder watcher — polls for new files and ingests them.
 */
import fs from "node:fs";
import path from "node:path";

import type { MemoryAgent } from "./agent.js";
import { isFileProcessed, markFileProcessed, time } from "./db.js";
import { ALL_SUPPORTED, TEXT_EXTENSIONS, UNSUPPORTED_MEDIA } from "./filetypes.js";

const MAX_TEXT_CHARS = 10_000;
// A transient failure (e.g. API outage) leaves the file unmarked so it's
// retried on later polls; give up after this many attempts per file version.
const MAX_ATTEMPTS = 3;

export function startWatcher(
  agent: MemoryAgent,
  folder: string,
  pollIntervalMs = 5_000,
): { stop: () => void } {
  fs.mkdirSync(folder, { recursive: true });
  console.log(`[${time()}] 👁️  Watching: ${folder}/  (supports: text, images, PDFs)`);

  let stopped = false;
  let running = false;
  const attempts = new Map<string, number>(); // "path:mtime" -> failed tries

  const processFile = async (name: string, filePath: string, mtimeMs: number) => {
    const ext = path.extname(name).toLowerCase();
    const attemptKey = `${filePath}:${mtimeMs}`;
    try {
      if (TEXT_EXTENSIONS.has(ext)) {
        console.log(`[${time()}] 📄 New text file: ${name}`);
        const text = fs.readFileSync(filePath, "utf-8").slice(0, MAX_TEXT_CHARS);
        if (text.trim()) {
          await agent.ingest(text, name);
        }
      } else {
        console.log(`[${time()}] 🖼️  New media file: ${name}`);
        await agent.ingestFile(filePath);
      }
      markFileProcessed(filePath, mtimeMs);
      attempts.delete(attemptKey);
    } catch (err) {
      const tries = (attempts.get(attemptKey) ?? 0) + 1;
      attempts.set(attemptKey, tries);
      if (tries >= MAX_ATTEMPTS) {
        // Persistent failure — stop retrying this file version
        console.error(`[${time()}] ❌ Giving up on ${name} after ${tries} attempts:`, err);
        markFileProcessed(filePath, mtimeMs);
        attempts.delete(attemptKey);
      } else {
        console.error(
          `[${time()}] Error ingesting ${name} (attempt ${tries}/${MAX_ATTEMPTS}, will retry):`,
          err,
        );
      }
    }
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // Collect everything eligible, then ingest in parallel — the agent's
      // operation gate bounds actual LLM concurrency
      const pending: { name: string; filePath: string; mtimeMs: number }[] = [];
      for (const name of fs.readdirSync(folder).sort()) {
        if (name.startsWith(".")) continue;
        const filePath = path.join(folder, name);
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const mtimeMs = stat.mtimeMs;

        const ext = path.extname(name).toLowerCase();
        if (!ALL_SUPPORTED.has(ext)) {
          if (UNSUPPORTED_MEDIA.has(ext) && !isFileProcessed(filePath, mtimeMs)) {
            console.warn(`[${time()}] ⚠️  Skipping ${name} — Claude does not support this media type`);
            markFileProcessed(filePath, mtimeMs);
          }
          continue;
        }
        if (isFileProcessed(filePath, mtimeMs)) continue;
        pending.push({ name, filePath, mtimeMs });
      }
      await Promise.all(pending.map((f) => processFile(f.name, f.filePath, f.mtimeMs)));
    } catch (err) {
      console.error(`[${time()}] Watch error:`, err);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(tick, pollIntervalMs);
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}
