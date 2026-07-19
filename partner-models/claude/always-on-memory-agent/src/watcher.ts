/**
 * Inbox folder watcher — polls for new files and ingests them.
 */
import fs from "node:fs";
import path from "node:path";

import type { MemoryAgent } from "./agent.js";
import { isFileProcessed, markFileProcessed, time } from "./db.js";
import { ALL_SUPPORTED, TEXT_EXTENSIONS, UNSUPPORTED_MEDIA } from "./filetypes.js";

const MAX_TEXT_CHARS = 10_000;

export function startWatcher(
  agent: MemoryAgent,
  folder: string,
  pollIntervalMs = 5_000,
): { stop: () => void } {
  fs.mkdirSync(folder, { recursive: true });
  console.log(`[${time()}] 👁️  Watching: ${folder}/  (supports: text, images, PDFs)`);

  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const entries = fs.readdirSync(folder).sort();
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        const filePath = path.join(folder, name);
        if (!fs.statSync(filePath).isFile()) continue;

        const ext = path.extname(name).toLowerCase();
        if (!ALL_SUPPORTED.has(ext)) {
          if (UNSUPPORTED_MEDIA.has(ext) && !isFileProcessed(filePath)) {
            console.warn(`[${time()}] ⚠️  Skipping ${name} — Claude does not support this media type`);
            markFileProcessed(filePath);
          }
          continue;
        }
        if (isFileProcessed(filePath)) continue;

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
        } catch (err) {
          console.error(`[${time()}] Error ingesting ${name}:`, err);
        }
        markFileProcessed(filePath);
      }
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
