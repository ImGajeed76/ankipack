import { describe, test, expect } from "bun:test";
import type { SqlValue } from "sql.js";
import { FIXTURES, fixtureByName } from "./fixtures";
import { openPackage, column, scalar, type OpenedPackage } from "./helpers/collection";
import { checkIntegrity } from "./helpers/integrity";

// Invariants a single snapshot cannot express: references resolving, and
// properties that only exist across two runs.

describe("referential integrity", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.name} has no dangling references`, async () => {
      const opened = await openPackage(fixture.build());
      try {
        const problems = checkIntegrity(opened);
        const report = problems.map((p) => `[${p.check}] ${p.detail}`).join("\n");
        expect(report).toBe("");
      } finally {
        opened.db.close();
      }
    });
  }
});

describe("cross-run properties", () => {
  // A snapshot is one run, so it cannot see this: a caller-supplied GUID has to
  // survive verbatim, because that is what makes a re-import update a user's
  // existing note instead of duplicating it.
  test("explicit GUIDs are used verbatim and survive regeneration", async () => {
    const fixture = fixtureByName("explicit-guids");

    const first = await openPackage(fixture.build());
    const second = await openPackage(fixture.build());
    try {
      const guidsOf = (opened: OpenedPackage): SqlValue[] =>
        column(opened.db, "SELECT guid FROM notes ORDER BY guid");

      expect(guidsOf(first)).toEqual(["fixture-guid-first-note", "fixture-guid-second-note"]);
      expect(guidsOf(second)).toEqual(guidsOf(first));
    } finally {
      first.db.close();
      second.db.close();
    }
  });

  // The flip side, and the reason the above matters: without an explicit GUID
  // the default is random, so regenerating the same deck produces different
  // note identities and a re-import adds duplicates rather than updating.
  test("generated GUIDs differ between runs of the same deck", async () => {
    const fixture = FIXTURES[0];
    const first = await openPackage(fixture.build());
    const second = await openPackage(fixture.build());
    try {
      const a = column(first.db, "SELECT guid FROM notes ORDER BY id");
      const b = column(second.db, "SELECT guid FROM notes ORDER BY id");
      expect(a).not.toEqual(b);
    } finally {
      first.db.close();
      second.db.close();
    }
  });
});

describe("collection header", () => {
  test("every fixture declares schema version 18", async () => {
    for (const fixture of FIXTURES) {
      const opened = await openPackage(fixture.build());
      try {
        expect(scalar(opened.db, "SELECT ver FROM col")).toBe(18);
      } finally {
        opened.db.close();
      }
    }
  });

  test("exactly one col row, at id 1", async () => {
    const opened = await openPackage(FIXTURES[0].build());
    try {
      expect(column(opened.db, "SELECT id FROM col")).toEqual([1]);
    } finally {
      opened.db.close();
    }
  });
});
