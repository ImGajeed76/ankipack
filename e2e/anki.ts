import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs `oracle.py` inside the virtualenv `bun run e2e:setup` creates. Kept
 * apart from `test/` so the default suite needs no Python and stays fast.
 */

const ROOT = join(import.meta.dir, "..");
const PYTHON = join(ROOT, "e2e", ".venv", "bin", "python");
const ORACLE = join(ROOT, "e2e", "oracle.py");

/** The Anki this suite is pinned to. Bumping it is a deliberate act. */
export const PINNED_ANKI = "26.08.1";

export function oracleAvailable(): boolean {
  return existsSync(PYTHON);
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  notes_imported: number;
  notes_in_file: number;
  duplicate: number;
  conflicting: number;
  decks: string[];
  notetypes: string[];
  presets: string[];
  cards: number;
  notes: number;
  /** Anki's own verdict from `fix_integrity`: true when it found no problems. */
  check_ok: boolean;
  /** Anki's findings as text. Assert on `check_ok` and pass this as the message. */
  check_database: string;
}

async function run<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn([PYTHON, ORACLE, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  const line = stdout.trim().split("\n").pop() ?? "";
  if (line.length === 0) {
    throw new Error(`oracle produced no output.\n${stderr}`);
  }
  return JSON.parse(line) as T;
}

/** Imports the package into a fresh collection using Anki's real importer. */
export function ankiImport(apkgPath: string): Promise<ImportResult> {
  return run<ImportResult>(["import", apkgPath]);
}

/** Writes a reference package with Anki itself. */
export function ankiExport(outPath: string, legacy = false): Promise<{ ok: boolean }> {
  return run(["export", outPath, ...(legacy ? ["--legacy"] : [])]);
}

/** Anki's own conversion of a legacy package to the current format. */
export function ankiConvert(legacyPath: string, outPath: string): Promise<{ ok: boolean }> {
  return run(["convert", legacyPath, outPath]);
}

export function ankiVersion(): Promise<{ ok: boolean; anki: string }> {
  return run(["version"]);
}

/**
 * A fresh Anki collection already contains stock notetypes and a Default deck,
 * so an import result is only meaningful once those are removed.
 */
const STOCK_NOTETYPES = new Set([
  "Basic",
  "Basic (and reversed card)",
  "Basic (optional reversed card)",
  "Basic (type in the answer)",
  "Cloze",
  "Image Occlusion",
]);

export const imported = {
  notetypes: (r: ImportResult): string[] => r.notetypes.filter((n) => !STOCK_NOTETYPES.has(n)),
  decks: (r: ImportResult): string[] => r.decks.filter((d) => d !== "Default"),
  presets: (r: ImportResult): string[] => r.presets.filter((p) => p !== "Default"),
};
