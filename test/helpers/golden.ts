import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const GOLDEN_DIR = join(import.meta.dir, "..", "golden");

export function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}.txt`);
}

/** A missing golden fails rather than being written on the fly; creating one is deliberate. */
export async function readGolden(name: string): Promise<string> {
  try {
    return await readFile(goldenPath(name), "utf8");
  } catch {
    throw new Error(
      `No golden for "${name}". Generate it with \`bun run test/update-golden.ts\`, ` +
        `then verify the package imports into Anki before committing the file.`,
    );
  }
}
