import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Config { enabled: boolean; experimentalMinimap: boolean }
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({ enabled: true, experimentalMinimap: false });
export function configPath(): string { return join(getAgentDir(), "visible-scrollbar.json"); }

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("visible-scrollbar.json must contain a JSON object.");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`Unknown scrollbar setting: ${key}`);
    if (typeof record[key] !== "boolean") throw new Error(`Scrollbar setting ${key} must be true or false.`);
  }
  return { ...DEFAULT_CONFIG, ...record } as Config;
}

export function loadConfig(path = configPath()): Config {
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG }; throw error; }
  try { return parseConfig(JSON.parse(source)); }
  catch (error) { throw new Error(`Invalid scrollbar configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

export function saveConfig(config: Config, path = configPath()): void {
  const value = parseConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
