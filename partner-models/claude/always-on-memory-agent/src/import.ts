/**
 * CLI entry for bulk import via the Message Batches API.
 *
 * Usage:
 *     npm run import -- ./corpus            # a directory of text files
 *     npm run import -- notes.md report.txt # or individual files
 */
import { runImport } from "./importer.js";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: npm run import -- <dir-or-file> [more paths...]");
  process.exit(1);
}

const summary = await runImport(paths);
process.exit(summary.errored > 0 ? 1 : 0);
