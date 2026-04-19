import { describe, test, expect, beforeAll } from "bun:test";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { Package, Deck, DeckConfig, Model, Note } from "../src/index";

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe("Package", () => {
  test("generates a valid .apkg with a basic deck", async () => {
    const model = Model.basic();
    const deck = new Deck({ name: "Test Deck" });

    deck.addNote(
      new Note({
        model,
        fields: ["Hello", "World"],
      }),
    );

    const pkg = new Package();
    pkg.addDeck(deck);

    const bytes = await pkg.toUint8Array(SQL);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);

    // Verify it's a valid ZIP (starts with PK header)
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
  });

  test("generates correct number of cards for basic model", async () => {
    const model = Model.basic();
    const deck = new Deck({ name: "Card Count Test" });

    deck.addNote(new Note({ model, fields: ["Q1", "A1"] }));
    deck.addNote(new Note({ model, fields: ["Q2", "A2"] }));
    deck.addNote(new Note({ model, fields: ["Q3", "A3"] }));

    const pkg = new Package();
    pkg.addDeck(deck);

    const bytes = await pkg.toUint8Array(SQL);

    // Extract and verify the SQLite database from the ZIP
    const { unzipSync } = await import("fflate");
    const files = unzipSync(bytes);
    const dbBytes = files["collection.anki2"];
    expect(dbBytes).toBeDefined();

    const db = new SQL.Database(dbBytes);

    // Check notes count
    const noteCount = db.exec("SELECT COUNT(*) FROM notes")[0].values[0][0];
    expect(noteCount).toBe(3);

    // Check cards count (1 template = 1 card per note)
    const cardCount = db.exec("SELECT COUNT(*) FROM cards")[0].values[0][0];
    expect(cardCount).toBe(3);

    // Check schema version
    const ver = db.exec("SELECT ver FROM col")[0].values[0][0];
    expect(ver).toBe(18);

    db.close();
  });

  test("generates 2 cards per note for basic-and-reversed model", async () => {
    const model = Model.basicAndReversed();
    const deck = new Deck({ name: "Reversed Test" });

    deck.addNote(new Note({ model, fields: ["Front", "Back"] }));

    const pkg = new Package();
    pkg.addDeck(deck);

    const bytes = await pkg.toUint8Array(SQL);
    const { unzipSync } = await import("fflate");
    const files = unzipSync(bytes);
    const db = new SQL.Database(files["collection.anki2"]);

    const cardCount = db.exec("SELECT COUNT(*) FROM cards")[0].values[0][0];
    expect(cardCount).toBe(2);

    db.close();
  });

  test("stores FSRS deck config in protobuf", async () => {
    const config = new DeckConfig({
      name: "FSRS Config",
      desiredRetention: 0.95,
      learnSteps: [1, 10],
      relearnSteps: [10],
      newPerDay: 140,
      reviewsPerDay: 9999,
      maximumReviewInterval: 4,
      buryNew: true,
      buryReviews: true,
    });

    const model = Model.basic();
    const deck = new Deck({ name: "FSRS Deck", config });
    deck.addNote(new Note({ model, fields: ["Q", "A"] }));

    const pkg = new Package();
    pkg.addDeck(deck);

    const bytes = await pkg.toUint8Array(SQL);
    const { unzipSync } = await import("fflate");
    const files = unzipSync(bytes);
    const db = new SQL.Database(files["collection.anki2"]);

    // Verify deck_config table has our custom config (no id=1 default that would overwrite user's)
    const configs = db.exec("SELECT name FROM deck_config WHERE name = 'FSRS Config'");
    expect(configs.length).toBe(1);
    expect(configs[0].values.length).toBe(1);

    // Verify the deck references the config
    const deckRows = db.exec("SELECT id, name FROM decks");
    expect(deckRows.length).toBe(1);
    expect(deckRows[0].values[0][1]).toBe("FSRS Deck");

    db.close();
  });

  test("handles cloze deletions", async () => {
    const model = Model.cloze();
    const deck = new Deck({ name: "Cloze Test" });

    deck.addNote(
      new Note({
        model,
        fields: ["{{c1::Paris}} is the capital of {{c2::France}}", ""],
      }),
    );

    const pkg = new Package();
    pkg.addDeck(deck);

    const bytes = await pkg.toUint8Array(SQL);
    const { unzipSync } = await import("fflate");
    const files = unzipSync(bytes);
    const db = new SQL.Database(files["collection.anki2"]);

    // Should have 2 cards (c1 and c2)
    const cardCount = db.exec("SELECT COUNT(*) FROM cards")[0].values[0][0];
    expect(cardCount).toBe(2);

    // Check card ordinals
    const ords = db.exec("SELECT ord FROM cards ORDER BY ord");
    expect(ords[0].values[0][0]).toBe(0); // c1
    expect(ords[0].values[1][0]).toBe(1); // c2

    db.close();
  });

  test("handles media files", async () => {
    const model = Model.basic();
    const deck = new Deck({ name: "Media Test" });
    deck.addNote(
      new Note({
        model,
        fields: ['<img src="test.png">', "Answer"],
      }),
    );

    const pkg = new Package();
    pkg.addDeck(deck);
    pkg.addMedia("test.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const bytes = await pkg.toUint8Array(SQL);
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(bytes);

    // Check media index
    const mediaJson = JSON.parse(strFromU8(files["media"]));
    expect(mediaJson["0"]).toBe("test.png");

    // Check media file exists
    expect(files["0"]).toBeDefined();
    expect(files["0"][0]).toBe(0x89); // PNG header byte
  });

  test("handles tags", async () => {
    const model = Model.basic();
    const deck = new Deck({ name: "Tags Test" });
    deck.addNote(
      new Note({
        model,
        fields: ["Q", "A"],
        tags: ["vocab", "chapter1"],
      }),
    );

    const pkg = new Package();
    pkg.addDeck(deck);

    const bytes = await pkg.toUint8Array(SQL);
    const { unzipSync } = await import("fflate");
    const files = unzipSync(bytes);
    const db = new SQL.Database(files["collection.anki2"]);

    const tags = db.exec("SELECT tags FROM notes")[0].values[0][0];
    expect(tags).toBe(" vocab chapter1 ");

    db.close();
  });

  test("validates field count matches model", () => {
    const model = Model.basic();
    expect(() => {
      new Note({ model, fields: ["only one"] });
    }).toThrow('model "Basic" expects 2');
  });

  test("rejects empty package", async () => {
    const pkg = new Package();
    expect(pkg.toUint8Array(SQL)).rejects.toThrow("at least one deck");
  });

  test("multiple decks in one package", async () => {
    const model = Model.basic();

    const deck1 = new Deck({ name: "Deck A" });
    deck1.addNote(new Note({ model, fields: ["Q1", "A1"] }));

    const deck2 = new Deck({ name: "Deck B" });
    deck2.addNote(new Note({ model, fields: ["Q2", "A2"] }));

    const pkg = new Package();
    pkg.addDeck(deck1);
    pkg.addDeck(deck2);

    const bytes = await pkg.toUint8Array(SQL);
    const { unzipSync } = await import("fflate");
    const files = unzipSync(bytes);
    const db = new SQL.Database(files["collection.anki2"]);

    const deckCount = db.exec("SELECT COUNT(*) FROM decks")[0].values[0][0];
    expect(deckCount).toBe(2);

    const noteCount = db.exec("SELECT COUNT(*) FROM notes")[0].values[0][0];
    expect(noteCount).toBe(2);

    db.close();
  });

  test("card positions are sequential across notes", async () => {
    const model = Model.basic();
    const deck = new Deck({ name: "Position Test" });

    deck.addNote(new Note({ model, fields: ["Q1", "A1"] }));
    deck.addNote(new Note({ model, fields: ["Q2", "A2"] }));
    deck.addNote(new Note({ model, fields: ["Q3", "A3"] }));

    const pkg = new Package();
    pkg.addDeck(deck);

    const bytes = await pkg.toUint8Array(SQL);
    const { unzipSync } = await import("fflate");
    const files = unzipSync(bytes);
    const db = new SQL.Database(files["collection.anki2"]);

    const dues = db.exec("SELECT due FROM cards ORDER BY due");
    expect(dues[0].values[0][0]).toBe(0);
    expect(dues[0].values[1][0]).toBe(1);
    expect(dues[0].values[2][0]).toBe(2);

    db.close();
  });
});
