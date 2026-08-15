import { describe, test, expect } from "bun:test";
import { Package, Deck, Model, Note } from "../src/index";
import { openPackage, type OpenedPackage } from "./helpers/collection";
import { checkIntegrity } from "./helpers/integrity";

// The integrity checks are what stand in for "would Anki accept this", so a
// silent failure in one of them is worse than not having it: every fixture
// would report clean while shipping the bug it was meant to catch. Each test
// here corrupts a generated collection in one specific way and asserts the
// matching check fires. Without these, "no problems found" proves nothing.

async function corrupt(sql: string[]): Promise<string[]> {
  const model = Model.basic();
  const deck = new Deck({ name: "Subject" });
  deck.addNote(new Note({ model, fields: ["one", "eins"] }));
  deck.addNote(new Note({ model, fields: ["two", "zwei"] }));

  const pkg = new Package();
  pkg.addDeck(deck);
  pkg.addMedia("shipped.png", new Uint8Array([1, 2, 3]));

  const opened = await openPackage(pkg);
  try {
    expect(checkIntegrity(opened)).toEqual([]);
    for (const statement of sql) opened.db.run(statement);
    return checkIntegrity(opened).map((p) => p.check);
  } finally {
    opened.db.close();
  }
}

describe("referential integrity checks fire", () => {
  const DANGLING = 9999999999999;

  test("a card pointing at a missing note is caught", async () => {
    expect(await corrupt([`UPDATE cards SET nid = ${DANGLING}`])).toContain(
      "cards.nid -> notes.id",
    );
  });

  test("a card pointing at a missing deck is caught", async () => {
    expect(await corrupt([`UPDATE cards SET did = ${DANGLING}`])).toContain(
      "cards.did -> decks.id",
    );
  });

  test("a note pointing at a missing notetype is caught", async () => {
    expect(await corrupt([`UPDATE notes SET mid = ${DANGLING}`])).toContain(
      "notes.mid -> notetypes.id",
    );
  });

  test("a field row pointing at a missing notetype is caught", async () => {
    expect(await corrupt([`UPDATE fields SET ntid = ${DANGLING}`])).toContain(
      "fields.ntid -> notetypes.id",
    );
  });

  test("a template row pointing at a missing notetype is caught", async () => {
    expect(await corrupt([`UPDATE templates SET ntid = ${DANGLING}`])).toContain(
      "templates.ntid -> notetypes.id",
    );
  });

  // A deck referencing a deck_config row the package does not contain makes
  // Anki's gather pass reject the whole import.
  test("a deck whose preset is missing from the package is caught", async () => {
    expect(await corrupt(["DELETE FROM deck_config"])).toContain(
      "decks.config_id -> deck_config.id",
    );
  });
});

describe("structural checks fire", () => {
  test("two notes sharing a GUID are caught", async () => {
    expect(await corrupt(["UPDATE notes SET guid = 'duplicated'"])).toContain("notes.guid unique");
  });

  test("a note with the wrong field count is caught", async () => {
    expect(await corrupt(["UPDATE notes SET flds = 'only-one-field'"])).toContain(
      "notes.flds field count",
    );
  });

  test("a card ordinal with no matching template is caught", async () => {
    expect(await corrupt(["UPDATE cards SET ord = 99"])).toContain("cards.ord -> templates.ord");
  });

  test("a gap in the new-card positions is caught", async () => {
    expect(await corrupt(["UPDATE cards SET due = 7 WHERE due = 0"])).toContain(
      "cards.due positions",
    );
  });
});

describe("media checks fire", () => {
  async function withMedia(mutate: (opened: OpenedPackage) => OpenedPackage): Promise<string[]> {
    const deck = new Deck({ name: "Media" });
    deck.addNote(new Note({ model: Model.basic(), fields: ['<img src="shipped.png">', "answer"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    pkg.addMedia("shipped.png", new Uint8Array([1, 2, 3]));

    const opened = await openPackage(pkg);
    try {
      expect(checkIntegrity(opened)).toEqual([]);
      return checkIntegrity(mutate(opened)).map((p) => p.check);
    } finally {
      opened.db.close();
    }
  }

  test("a media index entry with no archive payload is caught", async () => {
    const problems = await withMedia((opened) => ({
      ...opened,
      mediaIndex: { ...opened.mediaIndex, "7": "ghost.png" },
    }));
    expect(problems).toContain("media index -> archive");
  });

  test("a note referencing a file the package does not ship is caught", async () => {
    const problems = await withMedia((opened) => {
      opened.db.run(`UPDATE notes SET flds = '<img src="absent.png">' || flds`);
      return opened;
    });
    expect(problems).toContain("note media references");
  });
});
