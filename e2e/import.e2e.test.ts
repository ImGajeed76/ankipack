import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { Collection, Deck, DeckConfig, Notetype, Note, Package } from "../src/index";
import { ankiImport, ankiVersion, imported, oracleAvailable, PINNED_ANKI } from "./anki";

if (!oracleAvailable()) {
  throw new Error("e2e oracle is not installed. Run `bun run e2e:setup` first.");
}

let SQL: SqlJsStatic;
let workdir: string;

beforeAll(async () => {
  SQL = await initSqlJs();
  workdir = mkdtempSync(join(tmpdir(), "ankipack-e2e-"));
});

async function writeApkg(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(workdir, name);
  await Bun.write(path, bytes);
  return path;
}

function samplePackage(): Package {
  const basic = Notetype.basic({ name: "E2E Basic" });
  const deck = new Deck({
    name: "E2E::Vocabulary",
    config: new DeckConfig({ name: "E2E Preset", desiredRetention: 0.95, newPerDay: 40 }),
  });
  deck.addNote(new Note({ notetype: basic, fields: ["laufen", "to run"], tags: ["verb"] }));
  deck.addNote(new Note({ notetype: basic, fields: ["gehen", "to go"], tags: ["verb"] }));

  const cloze = new Deck({ name: "E2E::Cloze" });
  cloze.addNote(
    new Note({
      notetype: Notetype.cloze({ name: "E2E Cloze" }),
      fields: ["The {{c1::kestrel}} is a {{c2::falcon}}.", "extra"],
    }),
  );

  const pkg = new Package();
  pkg.addDeck(deck);
  pkg.addDeck(cloze);
  pkg.addMedia("diagram.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  return pkg;
}

describe(`Anki ${PINNED_ANKI} accepts what ankipack writes`, () => {
  test("the oracle is the version this suite is pinned to", async () => {
    expect((await ankiVersion()).anki).toBe(PINNED_ANKI);
  });

  test("a built package imports with everything intact", async () => {
    const path = await writeApkg("built.apkg", await samplePackage().toUint8Array(SQL));
    const result = await ankiImport(path);

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.notes_imported).toBe(3);
    expect(result.duplicate).toBe(0);
    expect(result.conflicting).toBe(0);
    // Basic gives one card per note, the cloze note two.
    expect(result.cards).toBe(4);
    expect(imported.decks(result)).toEqual(["E2E", "E2E::Cloze", "E2E::Vocabulary"]);
    expect(imported.notetypes(result).sort()).toEqual(["E2E Basic", "E2E Cloze"]);
    expect(imported.presets(result)).toContain("E2E Preset");
  });

  test("Check Database finds nothing wrong with the imported collection", async () => {
    const path = await writeApkg("integrity.apkg", await samplePackage().toUint8Array(SQL));
    const result = await ankiImport(path);
    expect(result.check_ok, result.check_database).toBe(true);
  });

  test("a package that was read, edited and written back still imports", async () => {
    const original = await samplePackage().toUint8Array(SQL);
    const col = Collection.open(original, SQL);
    for (const note of col.notes({ tag: "verb" })) {
      await note.setField("Back", `${note.field("Back")} [edited]`);
      note.addTag("edited");
    }
    await col.addNote({
      notetype: "E2E Basic",
      deck: "E2E::Vocabulary",
      fields: ["schwimmen", "to swim"],
      tags: ["verb", "added"],
    });

    const path = await writeApkg("edited.apkg", await col.toUint8Array(SQL));
    const result = await ankiImport(path);

    expect(result.error).toBeUndefined();
    expect(result.notes_imported).toBe(4);
    expect(result.cards).toBe(5);
    expect(result.check_ok, result.check_database).toBe(true);
  });

  test("a package carrying no media still imports, because its empty index is framed", async () => {
    const deck = new Deck({ name: "E2E::NoMedia" });
    deck.addNote(new Note({ notetype: Notetype.basic({ name: "E2E Bare" }), fields: ["a", "b"] }));
    const pkg = new Package();
    pkg.addDeck(deck);

    const path = await writeApkg("nomedia.apkg", await pkg.toUint8Array(SQL));
    const result = await ankiImport(path);
    expect(result.error).toBeUndefined();
    expect(result.notes_imported).toBe(1);
  });
});
