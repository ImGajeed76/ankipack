import { describe, test, expect } from "bun:test";
import { Package, Deck, DeckConfig, Model, Note } from "../src/index";
import { openPackage, column, scalar, query, getSql } from "./helpers/collection";

// Named behavioural rules. The golden dumps already cover the full shape of a
// generated collection, so this file only states the rules a reader should be
// able to find by name, most of them about what lands in someone's collection.

describe("API contract", () => {
  test("a note whose field count differs from its model is rejected", () => {
    const model = Model.basic();
    expect(() => new Note({ model, fields: ["only one"] })).toThrow('model "Basic" expects 2');
  });

  test("a package with no decks is rejected", async () => {
    const pkg = new Package();
    await expect(pkg.toUint8Array(await getSql())).rejects.toThrow("at least one deck");
  });
});

describe("card generation", () => {
  async function cardOrdinals(deck: Deck): Promise<number[]> {
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      return column(opened.db, "SELECT ord FROM cards ORDER BY ord").map(Number);
    } finally {
      opened.db.close();
    }
  }

  test("a basic note generates one card", async () => {
    const deck = new Deck({ name: "Basic" });
    deck.addNote(new Note({ model: Model.basic(), fields: ["Q", "A"] }));
    expect(await cardOrdinals(deck)).toEqual([0]);
  });

  test("a reversed note generates one card per template", async () => {
    const deck = new Deck({ name: "Reversed" });
    deck.addNote(new Note({ model: Model.basicAndReversed(), fields: ["Q", "A"] }));
    expect(await cardOrdinals(deck)).toEqual([0, 1]);
  });

  test("a template whose fields are all empty generates no card", async () => {
    const deck = new Deck({ name: "Empty Back" });
    deck.addNote(new Note({ model: Model.basicAndReversed(), fields: ["front only", ""] }));
    expect(await cardOrdinals(deck)).toEqual([0]);
  });

  test("cloze generates one card per distinct deletion, ordinals 0-based", async () => {
    const deck = new Deck({ name: "Cloze" });
    deck.addNote(
      new Note({ model: Model.cloze(), fields: ["{{c1::a}} and {{c2::b}} and {{c1::c}}", ""] }),
    );
    expect(await cardOrdinals(deck)).toEqual([0, 1]);
  });

  test("cloze with no deletions still generates one card", async () => {
    const deck = new Deck({ name: "Cloze Plain" });
    deck.addNote(new Note({ model: Model.cloze(), fields: ["no deletions here", ""] }));
    expect(await cardOrdinals(deck)).toEqual([0]);
  });
});

describe("deck presets", () => {
  async function deckConfigRows(...decks: Deck[]): Promise<Array<[number, string]>> {
    const pkg = new Package();
    for (const deck of decks) pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      return query(opened.db, "SELECT id, name FROM deck_config ORDER BY id").values.map(
        (row) => [Number(row[0]), String(row[1])] as [number, string],
      );
    } finally {
      opened.db.close();
    }
  }

  // One shared model: two Model instances with the same name in one package
  // collide on the notetypes name unique index.
  const model = Model.basic();

  function deckWithNote(options: ConstructorParameters<typeof Deck>[0]): Deck {
    const deck = new Deck(options);
    deck.addNote(new Note({ model, fields: ["a", "b"] }));
    return deck;
  }

  // id=1 is Anki's built-in Default preset. Shipping a real preset there would
  // overwrite whatever the user has configured on it.
  test("an omitted config ships a generated preset named after the deck, never at id 1", async () => {
    const rows = await deckConfigRows(deckWithNote({ name: "Auto Cfg" }));
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe("Auto Cfg Config");
    expect(rows[0][0]).not.toBe(1);
  });

  test("config: null ships only the id=1 placeholder Anki's gather pass needs", async () => {
    const rows = await deckConfigRows(deckWithNote({ name: "No Cfg", config: null }));
    expect(rows).toEqual([[1, "Default"]]);
  });

  test("several config: null decks still ship exactly one placeholder", async () => {
    const rows = await deckConfigRows(
      deckWithNote({ name: "A", config: null }),
      deckWithNote({ name: "B", config: null }),
    );
    expect(rows).toEqual([[1, "Default"]]);
  });

  test("an explicit config is shipped under its own name, never at id 1", async () => {
    const config = new DeckConfig({ name: "Exam Preset", desiredRetention: 0.95 });
    const rows = await deckConfigRows(deckWithNote({ name: "Exam", config }));
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe("Exam Preset");
    expect(rows[0][0]).not.toBe(1);
  });

  test("decks sharing one config object ship a single preset row", async () => {
    const config = new DeckConfig({ name: "Shared" });
    const rows = await deckConfigRows(
      deckWithNote({ name: "One", config }),
      deckWithNote({ name: "Two", config }),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("note contents", () => {
  test("tags are stored space-delimited and space-padded", async () => {
    const deck = new Deck({ name: "Tags" });
    deck.addNote(
      new Note({ model: Model.basic(), fields: ["Q", "A"], tags: ["vocab", "chapter1"] }),
    );
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      expect(scalar(opened.db, "SELECT tags FROM notes")).toBe(" vocab chapter1 ");
    } finally {
      opened.db.close();
    }
  });

  test("an untagged note stores an empty tag string", async () => {
    const deck = new Deck({ name: "Untagged" });
    deck.addNote(new Note({ model: Model.basic(), fields: ["Q", "A"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      expect(scalar(opened.db, "SELECT tags FROM notes")).toBe("");
    } finally {
      opened.db.close();
    }
  });

  test("sortFieldIndex chooses which field is written to sfld", async () => {
    const model = new Model({
      name: "Sorted",
      sortFieldIndex: 1,
      fields: [{ name: "First" }, { name: "Second" }],
      templates: [{ name: "Card 1", questionFormat: "{{First}}", answerFormat: "{{Second}}" }],
    });
    const deck = new Deck({ name: "Sorting" });
    deck.addNote(new Note({ model, fields: ["ignored", "sort on me"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      expect(scalar(opened.db, "SELECT sfld FROM notes")).toBe("sort on me");
    } finally {
      opened.db.close();
    }
  });

  // Anki dedupes on the first field's checksum, so it must depend on that field
  // alone. If it drifted to cover every field, duplicate detection would break.
  test("csum is derived from the first field only", async () => {
    const model = Model.basic();
    const deck = new Deck({ name: "Checksums" });
    deck.addNote(new Note({ model, fields: ["same front", "one back"] }));
    deck.addNote(new Note({ model, fields: ["same front", "other back"] }));
    deck.addNote(new Note({ model, fields: ["different front", "one back"] }));

    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      const [first, second, third] = column(opened.db, "SELECT csum FROM notes ORDER BY id");
      expect(first).toBe(second);
      expect(first).not.toBe(third);
    } finally {
      opened.db.close();
    }
  });
});

describe("packaging", () => {
  test("cards are filed under the deck their note was added to", async () => {
    const model = Model.basic();
    const first = new Deck({ name: "First" });
    const second = new Deck({ name: "Second" });
    first.addNote(new Note({ model, fields: ["one", "eins"] }));
    second.addNote(new Note({ model, fields: ["two", "zwei"] }));

    const pkg = new Package();
    pkg.addDeck(first);
    pkg.addDeck(second);
    const opened = await openPackage(pkg);
    try {
      const rows = query(
        opened.db,
        "SELECT d.name, n.sfld FROM cards c JOIN decks d ON d.id = c.did JOIN notes n ON n.id = c.nid ORDER BY d.name",
      ).values;
      expect(rows).toEqual([
        ["First", "one"],
        ["Second", "two"],
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("a model used by several decks is inserted once", async () => {
    const model = Model.basic();
    const first = new Deck({ name: "First" });
    const second = new Deck({ name: "Second" });
    first.addNote(new Note({ model, fields: ["a", "b"] }));
    second.addNote(new Note({ model, fields: ["c", "d"] }));

    const pkg = new Package();
    pkg.addDeck(first);
    pkg.addDeck(second);
    const opened = await openPackage(pkg);
    try {
      expect(column(opened.db, "SELECT COUNT(*) FROM notetypes")).toEqual([1]);
    } finally {
      opened.db.close();
    }
  });

  test("media files are indexed by position and stored under that name", async () => {
    const deck = new Deck({ name: "Media" });
    deck.addNote(new Note({ model: Model.basic(), fields: ['<img src="diagram.png">', "answer"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    pkg.addMedia("diagram.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const opened = await openPackage(pkg);
    try {
      expect(opened.mediaIndex).toEqual({ "0": "diagram.png" });
      expect(Array.from(opened.entries["0"])).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      opened.db.close();
    }
  });
});
