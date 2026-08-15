import { mkdir, writeFile } from "node:fs/promises";
import { FIXTURES } from "./fixtures";
import { openPackage } from "./helpers/collection";
import { dumpCollection, dumpSchema } from "./helpers/dump";
import { GOLDEN_DIR, goldenPath } from "./helpers/golden";

// A separate command, not an env flag on `bun test`: regenerating must be deliberate.

await mkdir(GOLDEN_DIR, { recursive: true });

let schemaWritten = false;

for (const fixture of FIXTURES) {
  const opened = await openPackage(fixture.build());
  try {
    await writeFile(goldenPath(fixture.name), dumpCollection(opened), "utf8");
    if (!schemaWritten) {
      await writeFile(goldenPath("_schema"), dumpSchema(opened), "utf8");
      schemaWritten = true;
    }
    console.log(`wrote ${fixture.name}`);
  } finally {
    opened.db.close();
  }
}

console.log(
  `\n${FIXTURES.length} goldens written to ${GOLDEN_DIR}.\n` +
    `These are unverified until a generated .apkg has been imported into a real\n` +
    `Anki. Record which Anki version was used, and what you checked, before\n` +
    `committing them.`,
);
