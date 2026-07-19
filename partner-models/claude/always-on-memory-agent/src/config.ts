/**
 * Configuration via an INI file in the project root.
 *
 * Precedence for every setting: CLI flag > environment variable >
 * config.ini > built-in default. The parser is deliberately minimal
 * (sections, key = value, `;`/`#` comments) to keep the project
 * dependency-free.
 */
import fs from "node:fs";

const CONFIG_PATH = process.env.MEMORY_CONFIG ?? "config.ini";

/** Parse a minimal INI file into a flat map keyed as "section.key". */
export function parseIni(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[section ? `${section}.${key}` : key] = value;
  }
  return result;
}

function loadConfigFile(): Record<string, string> {
  try {
    return parseIni(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {}; // no config file — env vars and defaults apply
  }
}

const fileConfig = loadConfigFile();

/** Resolve a setting: environment variable > config.ini key. */
export function setting(envVar: string, iniKey: string): string | undefined {
  return process.env[envVar] ?? fileConfig[iniKey];
}

/**
 * Resolve a setting that has no built-in default — config.ini is the
 * canonical source. Exits with a clear message when unset everywhere.
 */
export function requireSetting(envVar: string, iniKey: string): string {
  const value = setting(envVar, iniKey);
  if (!value) {
    const [section, key] = iniKey.split(".");
    console.error(
      `Missing required setting: add "${key} = <path>" under [${section}] in ` +
        `${CONFIG_PATH} (or set the ${envVar} environment variable).`,
    );
    process.exit(1);
  }
  return value;
}
