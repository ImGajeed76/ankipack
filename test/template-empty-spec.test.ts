// Standalone test for the new templateHasContent algorithm in ankipack.
// Run from the project root: bun test tmp/template-empty-spec.test.ts
//
// Mirrors the cases Anki itself documents in rslib/src/template.rs and
// rslib/src/notetype/cardgen.rs. Imports the patched ankipack source
// directly via relative path so we don't depend on a published version.

import { describe, test, expect } from "bun:test";
import { Model, Note } from "../src/index";

// Helper: build a Note with given field values and ask if card 0 would render.
// templateHasContent is not exported, so we exercise it indirectly by reading
// it through Note's model + the same internal heuristic. The cleanest way is
// to expose it for testing — for now we re-implement the entry path.
//
// Since templateHasContent is private, we expose it temporarily via a side
// channel: call buildDatabase and inspect the resulting cards. That requires
// sql.js. Lightweight alternative: vendor the function. We do the vendor
// trick: import db.ts directly and reach into its private function via a
// re-export shim. Patch in `tmp/ankipack/src/db.ts` adds an export marker
// only when this env var is set.
//
// For the smoke test below, we instead build a tiny Package end-to-end and
// count the rows in the cards table.

import initSqlJs from "sql.js";
import { Deck, DeckConfig, Package } from "../src/index";

async function countCards(model: Model, fieldValues: string[][]): Promise<number> {
  const SQL = await initSqlJs();
  const deck = new Deck({
    name: "test-deck",
    config: new DeckConfig({ name: "test-config" }),
  });
  for (const fields of fieldValues) {
    deck.addNote(new Note({ model, fields }));
  }
  const pkg = new Package();
  pkg.addDeck(deck);
  const bytes = await pkg.toUint8Array(SQL);

  // Crack open the apkg, count cards in the SQLite.
  const { unzipSync } = await import("fflate");
  const entries = unzipSync(bytes);
  const dbBytes = entries["collection.anki2"];
  const db = new SQL.Database(dbBytes);
  const result = db.exec("SELECT COUNT(*) FROM cards");
  return result[0]?.values?.[0]?.[0] as number;
}

const FIELDS = [
  { name: "Term" },
  { name: "Definition" },
  { name: "TermImage" },
  { name: "TermAudio" },
  { name: "TermTTS" },
  { name: "DefinitionImage" },
  { name: "DefinitionAudio" },
  { name: "DefinitionTTS" },
  { name: "AddReverse" },
];

describe("templateHasContent (Anki-spec compliant)", () => {
  test("plain text alone is treated as empty (no card)", async () => {
    const model = new Model({
      name: "plain-text-only",
      fields: FIELDS,
      templates: [
        {
          name: "Card 1",
          questionFormat: "<p>Hello world (no field references)</p>",
          answerFormat: "{{FrontSide}}{{Definition}}",
        },
      ],
    });
    const cards = await countCards(model, [
      ["Term-A", "Def-A", "", "", "", "", "", "", ""],
    ]);
    expect(cards).toBe(0);
  });

  test("a single non-empty replacement makes the card non-empty", async () => {
    const model = new Model({
      name: "single-ref",
      fields: FIELDS,
      templates: [
        {
          name: "Card 1",
          questionFormat: "{{Term}}",
          answerFormat: "{{Definition}}",
        },
      ],
    });
    expect(await countCards(model, [["Term-A", "", "", "", "", "", "", "", ""]])).toBe(1);
    expect(await countCards(model, [["", "", "", "", "", "", "", "", ""]])).toBe(0);
  });

  test("section with empty gate suppresses entire body, even if inner refs are non-empty", async () => {
    // The KEY case for our typing card: {{#Definition}}...{{Term}}...{{/Definition}}
    // With Definition="" and Term="Argentina", the card must NOT generate.
    const model = new Model({
      name: "gated-section",
      fields: FIELDS,
      templates: [
        {
          name: "Card 1",
          questionFormat: "{{#Definition}}<div>{{Term}}</div>{{type:Definition}}{{/Definition}}",
          answerFormat: "{{FrontSide}}",
        },
      ],
    });
    // Definition empty → card not generated even though Term is non-empty
    expect(await countCards(model, [["Argentina", "", "", "", "", "", "", "", ""]])).toBe(0);
    // Definition non-empty → card generates
    expect(await countCards(model, [["Argentina", "country", "", "", "", "", "", "", ""]])).toBe(1);
  });

  test("nested sections evaluate inner gate too", async () => {
    const model = new Model({
      name: "nested",
      fields: FIELDS,
      templates: [
        {
          name: "Card 1",
          questionFormat: "{{#AddReverse}}{{#Term}}<div>{{Term}}</div>{{/Term}}{{/AddReverse}}",
          answerFormat: "{{FrontSide}}",
        },
      ],
    });
    // outer gate empty
    expect(await countCards(model, [["x", "", "", "", "", "", "", "", ""]])).toBe(0);
    // outer gate set, inner ref non-empty
    expect(await countCards(model, [["x", "", "", "", "", "", "", "", "1"]])).toBe(1);
    // outer gate set, inner ref empty
    expect(await countCards(model, [["", "", "", "", "", "", "", "", "1"]])).toBe(0);
  });

  test("negated section: shows when field is empty", async () => {
    const model = new Model({
      name: "negated",
      fields: FIELDS,
      templates: [
        {
          name: "Card 1",
          questionFormat: "{{^Definition}}{{Term}}{{/Definition}}",
          answerFormat: "{{FrontSide}}",
        },
      ],
    });
    // Definition empty → negated body active → Term ref counts → renders
    expect(await countCards(model, [["Argentina", "", "", "", "", "", "", "", ""]])).toBe(1);
    // Definition non-empty → negated body skipped → no replacement reachable → empty
    expect(await countCards(model, [["Argentina", "country", "", "", "", "", "", "", ""]])).toBe(0);
  });

  test("{{type:Field}} is treated as a Replacement on the underlying field", async () => {
    const model = new Model({
      name: "type-filter",
      fields: FIELDS,
      templates: [
        {
          name: "Card 1",
          questionFormat: "Type: {{type:Definition}}",
          answerFormat: "{{FrontSide}}",
        },
      ],
    });
    expect(await countCards(model, [["x", "", "", "", "", "", "", "", ""]])).toBe(0);
    expect(await countCards(model, [["x", "answer", "", "", "", "", "", "", ""]])).toBe(1);
  });

  test('field with only "<br>" or "<div></div>" counts as empty', async () => {
    const model = new Model({
      name: "br-only",
      fields: FIELDS,
      templates: [
        {
          name: "Card 1",
          questionFormat: "{{Term}}",
          answerFormat: "{{FrontSide}}",
        },
      ],
    });
    expect(await countCards(model, [["<br>", "", "", "", "", "", "", "", ""]])).toBe(0);
    expect(await countCards(model, [["<div></div>", "", "", "", "", "", "", "", ""]])).toBe(0);
    expect(await countCards(model, [["  ", "", "", "", "", "", "", "", ""]])).toBe(0);
    expect(await countCards(model, [["<div>x</div>", "", "", "", "", "", "", "", ""]])).toBe(1);
  });

  test("{{FrontSide}} alone does not make the question non-empty", async () => {
    // FrontSide is special; it's never in the nonempty_fields set.
    const model = new Model({
      name: "frontside-only",
      fields: FIELDS,
      templates: [
        {
          name: "Card 1",
          questionFormat: "{{FrontSide}}",
          answerFormat: "{{FrontSide}}",
        },
      ],
    });
    expect(await countCards(model, [["x", "y", "", "", "", "", "", "", ""]])).toBe(0);
  });
});
