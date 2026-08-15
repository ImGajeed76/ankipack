import { describe, test, expect } from "bun:test";
import { FIXTURES } from "./fixtures";
import { openPackage } from "./helpers/collection";
import { dumpCollection, dumpSchema } from "./helpers/dump";
import { readGolden } from "./helpers/golden";

// Each fixture's whole collection is compared against a committed snapshot, so
// a change nobody thought to assert still shows up.

describe("golden sections", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.name}: ${fixture.covers}`, async () => {
      const opened = await openPackage(fixture.build());
      try {
        expect(dumpCollection(opened)).toBe(await readGolden(fixture.name));
      } finally {
        opened.db.close();
      }
    });
  }
});

describe("schema", () => {
  test("DDL matches the committed schema golden", async () => {
    const opened = await openPackage(FIXTURES[0].build());
    try {
      expect(dumpSchema(opened)).toBe(await readGolden("_schema"));
    } finally {
      opened.db.close();
    }
  });

  test("every fixture produces the same DDL", async () => {
    const expected = await readGolden("_schema");
    for (const fixture of FIXTURES) {
      const opened = await openPackage(fixture.build());
      try {
        expect(dumpSchema(opened)).toBe(expected);
      } finally {
        opened.db.close();
      }
    }
  });
});
