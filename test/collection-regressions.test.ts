import { describe, test, expect } from "bun:test";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { decompress } from "fzstd";
import { MediaEntriesSchema } from "../src/generated/anki/import_export_pb";
import { zstdRawFrame } from "../src/util/zstd";
import { DeckConfig_ConfigSchema } from "../src/generated/anki/deck_config_pb";
import { Deck_CommonSchema, Deck_KindContainerSchema } from "../src/generated/anki/decks_pb";
import {
  Notetype_Field_ConfigSchema,
  Notetype_Template_ConfigSchema,
} from "../src/generated/anki/notetypes_pb";
import { readPackage } from "../src/collection/read";
import { writePackage } from "../src/collection/write";
import { AnkipackError, Collection, Deck, DeckConfig, Notetype, Note, Package } from "../src/index";
import { stripHtmlPreservingMediaFilenames } from "../src/util/text";
import { mediaFilenameProblem, normalizeMediaFilename } from "../src/util/media-name";
import { isUnassignedForAnki } from "../src/util/unassigned";
import { getSql } from "./helpers/collection";
import { legacyPackage } from "./helpers/legacy";

// Each case pins a defect this code had once, and the invariant that holds
// instead. Bytes that would be invisible in the file are written as escapes.

const NUL = String.fromCharCode(0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

async function twoDecks(): Promise<Collection> {
  const SQL = await getSql();
  const notetype = Notetype.basic({ name: "Probe" });
  const a = new Deck({ name: "A" });
  const b = new Deck({ name: "B" });
  a.addNote(new Note({ notetype, fields: ["a1", "a2"] }));
  b.addNote(new Note({ notetype, fields: ["b1", "b2"] }));
  const pkg = new Package();
  pkg.addDeck(a);
  pkg.addDeck(b);
  return Collection.open(await pkg.toUint8Array(SQL), SQL);
}

/**
 * One note on a two-template notetype with the second card not yet generated,
 * so filling the empty field produces exactly one sibling.
 */
async function pendingSibling(): Promise<Collection> {
  const SQL = await getSql();
  const deck = new Deck({ name: "A" });
  deck.addNote(
    new Note({ notetype: Notetype.basicAndReversed({ name: "Rev" }), fields: ["front", ""] }),
  );
  const pkg = new Package();
  pkg.addDeck(deck);
  return Collection.open(await pkg.toUint8Array(SQL), SQL);
}

describe("editing an existing collection", () => {
  // The target deck is a parameter, not instance state, so the await inside
  // addNote cannot let a concurrent call redirect it.
  test("concurrent addNote puts each note in the deck it asked for", async () => {
    const col = await twoDecks();
    const deckA = col.data.decks.find((d) => d.name === "A")!.id;
    const deckB = col.data.decks.find((d) => d.name === "B")!.id;

    const [na, nb] = await Promise.all([
      col.addNote({ notetype: "Probe", deck: "A", fields: ["new-a", "x"] }),
      col.addNote({ notetype: "Probe", deck: "B", fields: ["new-b", "y"] }),
    ]);

    const deckOf = (id: number): number | undefined =>
      col.data.cards.find((c) => c.nid === id)?.did;
    expect(deckOf(na.id)).toBe(deckA);
    expect(deckOf(nb.id)).toBe(deckB);
  });

  // `due` is a queue position for new cards, a day number for review cards and
  // an epoch second for intraday learning ones, so only new cards may count.
  test("a new card's position ignores review and learning cards", async () => {
    const col = await twoDecks();
    const cards = col.data.cards;
    Object.assign(cards[0], { type: 2, queue: 2, due: 812 });
    Object.assign(cards[1], { type: 1, queue: 1, due: 1_755_300_000 });

    const note = await col.addNote({ notetype: "Probe", deck: "A", fields: ["fresh", "z"] });
    const fresh = col.data.cards.find((c) => c.nid === note.id)!;
    expect(fresh.due).toBe(0);
  });

  test("cards generated in one pass share a position, as Anki gives them", async () => {
    const SQL = await getSql();
    const deck = new Deck({ name: "Pair" });
    deck.addNote(
      new Note({ notetype: Notetype.basicAndReversed({ name: "Rev" }), fields: ["front", "back"] }),
    );
    const pkg = new Package();
    pkg.addDeck(deck);
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);

    const note = await col.addNote({ notetype: "Rev", deck: "Pair", fields: ["x", "y"] });
    const dues = col.data.cards.filter((c) => c.nid === note.id).map((c) => c.due);
    expect(dues.length).toBe(2);
    expect(new Set(dues).size).toBe(1);
  });

  test("the id generator starts past what the document already uses", async () => {
    let collisions = 0;
    for (let i = 0; i < 30; i++) {
      const notetype = Notetype.basic({ name: "Probe" });
      const deck = new Deck({ name: "D" });
      deck.addNote(new Note({ notetype, fields: ["a", "b"] }));
      const pkg = new Package();
      pkg.addDeck(deck);

      const col = Collection.fromData(await pkg.toCollection());
      await col.addNote({ notetype: "Probe", deck: "D", fields: ["c", "d"] });
      const ids = [...col.data.notes.map((n) => n.id), ...col.data.cards.map((c) => c.id)];
      if (new Set(ids).size !== ids.length) collisions++;
    }
    expect(collisions).toBe(0);
  });

  test("renameDeck renames subdecks too", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Probe" });
    const pkg = new Package();
    for (const name of ["Old", "Old::Child", "Old::Child::Deep", "Older"]) {
      const deck = new Deck({ name });
      deck.addNote(new Note({ notetype, fields: [name, "x"] }));
      pkg.addDeck(deck);
    }
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);
    col.renameDeck("Old", "New");

    // "Older" starts with "Old" as text but is not a subdeck of it.
    expect(col.deckNames().sort()).toEqual(["New", "New::Child", "New::Child::Deep", "Older"]);
  });

  test("renameDeck refuses a name that differs only in case", async () => {
    const col = await twoDecks();
    expect(() => col.renameDeck("A", "b")).toThrow(/already exists/);
  });

  test("removing the same note twice still writes", async () => {
    const SQL = await getSql();
    const col = await twoDecks();
    const id = col.notes()[0].id;
    col.removeNote(id);
    col.removeNote(id);
    await col.toUint8Array(SQL);
    expect(col.data.graves.filter((g) => g.oid === id && g.type === 1).length).toBe(1);
  });

  // `graves` is keyed on (oid, type). A package can arrive already holding a
  // grave for a note it also still contains, and removing that note then
  // writes the same key twice, which fails the whole save.
  test("removing a note the package already graved still writes", async () => {
    const SQL = await getSql();
    const col = await twoDecks();
    const note = col.notes()[0];
    const cardId = col.data.cards.find((c) => c.nid === note.id)!.id;
    col.data.graves.push({ oid: note.id, type: 1, usn: 5 });
    col.data.graves.push({ oid: cardId, type: 0, usn: 5 });

    col.removeNote(note.id);
    await col.toUint8Array(SQL);
    expect(col.data.graves.filter((g) => g.oid === note.id && g.type === 1).length).toBe(1);
  });

  test("a rejected addNote leaves nothing behind", async () => {
    const col = await twoDecks();
    const before = col.data.notes.length;
    await expect(
      col.addNote({ notetype: "Probe", deck: "A", fields: ["only one"] }),
    ).rejects.toThrow(/has 2 fields/);
    expect(col.data.notes.length).toBe(before);
  });

  test("the edit path applies the same tag rules as the build path", async () => {
    const col = await twoDecks();
    const note = col.notes()[0];
    expect(() => note.setTags([`bad${NUL}tag`])).toThrow(/control character/);
    expect(() => note.setTags([`two${IDEOGRAPHIC_SPACE}words`])).toThrow(/space/);
    await expect(
      col.addNote({ notetype: "Probe", deck: "A", fields: ["a", "b"], tags: [`x${NUL}y`] }),
    ).rejects.toThrow(/control character/);
    await expect(
      col.addNote({ notetype: "Probe", deck: "A", fields: ["a", "b"], guid: `g${NUL}h` }),
    ).rejects.toThrow(/NUL/);
  });

  test("a note that still has a card does not gain a blank one", async () => {
    const SQL = await getSql();
    const deck = new Deck({ name: "Pair" });
    deck.addNote(
      new Note({ notetype: Notetype.basicAndReversed({ name: "Rev" }), fields: ["front", "back"] }),
    );
    const pkg = new Package();
    pkg.addDeck(deck);
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);

    // Drop card 0 the way Anki's Empty Cards tool would, then empty the fields
    // so nothing renders. Anki's ensure_not_empty only fires for a note with no
    // cards at all, so ord 0 must not come back.
    const note = col.notes()[0];
    col.data.cards = col.data.cards.filter((c) => !(c.nid === note.id && c.ord === 0));
    await note.setFields(["", ""]);

    expect(col.data.cards.filter((c) => c.nid === note.id).map((c) => c.ord)).toEqual([1]);
  });

  test("a sibling card goes to the home deck, not a filtered one", async () => {
    const col = await pendingSibling();
    const deckA = col.data.decks.find((d) => d.name === "A")!.id;
    const note = col.notes()[0];
    // A card pulled into a filtered deck keeps its home deck in odid.
    const card = col.data.cards.find((c) => c.nid === note.id)!;
    card.did = 999_999;
    card.odid = deckA;

    await note.setFields(["front", "back"]);
    const generated = col.data.cards.filter((c) => c.nid === note.id && c.id !== card.id);
    expect(generated.length).toBe(1);
    for (const extra of generated) expect(extra.did).toBe(deckA);
  });
});

describe("media filenames Anki would rewrite are refused", () => {
  // Anki's SafeMediaEntry::from_entry rejects the whole archive unless the name
  // is already normalised, so a bad name loses every note in the package.
  const BAD: Array<[string, string]> = [
    ["diagram [1].png", "square brackets"],
    ["a:b.png", "colon"],
    ["what?.png", "question mark"],
    ["a*.png", "star"],
    ["a|b.png", "pipe"],
    ["a^b.png", "caret"],
    ['a"b.png', "quote"],
    ["a<b>.png", "angle brackets"],
    ["CON.png", "Windows device name"],
    ["trailing.png ", "trailing space"],
    ["trailing.png.", "trailing period"],
    [`a${String.fromCharCode(0x00a0)}b.png`, "non-breaking space"],
    [`${"a".repeat(130)}.png`, "over the 120-byte cap"],
    [`cafe${String.fromCharCode(0x0301)}.png`, "NFD, which macOS filesystems return"],
  ];

  for (const [name, why] of BAD) {
    test(`Package.addMedia refuses ${why}`, () => {
      const pkg = new Package();
      expect(() => pkg.addMedia(name, new Uint8Array([1]))).toThrow(/Media filename/);
    });

    test(`Collection.setMedia refuses ${why}`, async () => {
      const col = await twoDecks();
      expect(() => col.setMedia(name, new Uint8Array([1]))).toThrow(/Media filename/);
    });
  }

  test("an ordinary filename is still accepted on both paths", async () => {
    const pkg = new Package();
    expect(() => pkg.addMedia("diagram-1.png", new Uint8Array([1]))).not.toThrow();
    const col = await twoDecks();
    expect(() => col.setMedia("diagram-1.png", new Uint8Array([1]))).not.toThrow();
  });
});

// A hand-built schema 11 collection, since nothing here can produce one.
function legacyWith(overrides: {
  models?: unknown;
  decks?: unknown;
  dconf?: unknown;
  conf?: unknown;
  /** Raw JSON, for values JSON.stringify would round before they are read. */
  rawNotetypes?: string;
}): (SQL: Awaited<ReturnType<typeof getSql>>) => Uint8Array {
  return (SQL) =>
    legacyPackage(SQL, (db) => {
      db.run(`INSERT INTO col VALUES (1, 1, 1, 1, 11, 0, -1, 0, ?, ?, ?, ?, '{}')`, [
        JSON.stringify(overrides.conf ?? {}),
        overrides.rawNotetypes ?? JSON.stringify(overrides.models ?? {}),
        JSON.stringify(overrides.decks ?? {}),
        JSON.stringify(overrides.dconf ?? {}),
      ]);
    });
}

const NT = 1_600_000_100_000;

describe("schema 11 conversion", () => {
  test("field and template ordinals come from position, not the JSON", async () => {
    const SQL = await getSql();
    // Every field claims ord 0, which is what buggy writers produce. Anki
    // assigns by enumerate(), and a duplicate here fails the (ntid, ord) key.
    const bytes = legacyWith({
      models: {
        [NT]: {
          id: NT,
          name: "Legacy",
          type: 0,
          flds: [
            { name: "Front", ord: 0 },
            { name: "Back", ord: 0 },
            { name: "Extra", ord: 0 },
          ],
          tmpls: [
            { name: "C1", ord: 0, qfmt: "{{Front}}" },
            { name: "C2", ord: 0, qfmt: "{{Back}}" },
          ],
        },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    expect(data.fields.map((f) => [f.ord, f.name])).toEqual([
      [0, "Front"],
      [1, "Back"],
      [2, "Extra"],
    ]);
    expect(data.templates.map((t) => t.ord)).toEqual([0, 1]);
  });

  test("desiredRetention is a percentage in schema 11 and a fraction in 18", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      decks: { 5: { id: 5, name: "D", dyn: 0, conf: 1, desiredRetention: 90 } },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    const kind = fromBinary(Deck_KindContainerSchema, data.decks[0].kind);
    if (kind.kind.case !== "normal") throw new Error("expected a normal deck");
    expect(kind.kind.value.desiredRetention).toBeCloseTo(0.9, 5);
  });

  test("a filtered deck is refused whether dyn is a number or a bool", async () => {
    const SQL = await getSql();
    for (const dyn of [1, true]) {
      const bytes = legacyWith({ decks: { 5: { id: 5, name: "Cram", dyn, terms: [] } } })(SQL);
      expect(() => readPackage(bytes, SQL)).toThrow(/filtered deck/);
    }
  });

  test("per-deck study counters survive", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      decks: {
        5: {
          id: 5,
          name: "D",
          dyn: 0,
          conf: 1,
          newToday: [42, 7],
          revToday: [42, 3],
          lrnToday: [42, 2],
          timeToday: [42, 123456],
          extendNew: -3,
        },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    const common = fromBinary(Deck_CommonSchema, data.decks[0].common);
    expect(common).toMatchObject({
      lastDayStudied: 42,
      newStudied: 7,
      reviewStudied: 3,
      learningStudied: 2,
      millisecondsStudied: 123456,
    });
    const kind = fromBinary(Deck_KindContainerSchema, data.decks[0].kind);
    if (kind.kind.case !== "normal") throw new Error("expected a normal deck");
    expect(kind.kind.value.extendNew).toBe(0);
  });

  test("an explicit null id stays unset rather than becoming zero", async () => {
    const SQL = await getSql();
    // This is what Anki's own schema 11 downgrade writes.
    const bytes = legacyWith({
      models: {
        [NT]: {
          id: NT,
          name: "Legacy",
          type: 0,
          flds: [{ name: "Front", id: null }],
          tmpls: [{ name: "C1", qfmt: "{{Front}}", id: null }],
        },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    expect(fromBinary(Notetype_Field_ConfigSchema, data.fields[0].config).id).toBeUndefined();
  });

  test("unknown keys inside new, rev and lapse are kept", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      dconf: {
        1: {
          id: 1,
          name: "P",
          new: {
            delays: [1],
            initialFactor: 2500,
            ints: [1, 4],
            order: 1,
            perDay: 20,
            addonKey: 42,
          },
          rev: { ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, revExtra: "x" },
          lapse: {
            delays: [10],
            leechAction: 1,
            leechFails: 8,
            minInt: 1,
            mult: 0,
            lapseExtra: true,
          },
          topLevelExtra: "kept",
        },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    const other = fromBinary(DeckConfig_ConfigSchema, data.deckConfig[0].config).other;
    expect(JSON.parse(new TextDecoder().decode(other))).toEqual({
      topLevelExtra: "kept",
      new: { addonKey: 42 },
      rev: { revExtra: "x" },
      lapse: { lapseExtra: true },
    });
  });

  test("a short or invalid ints array falls back to Anki's 1 and 4", async () => {
    const SQL = await getSql();
    for (const ints of [[7], [-5, 4], [], [70000, 4]]) {
      const bytes = legacyWith({
        dconf: {
          1: {
            id: 1,
            name: "P",
            new: { delays: [1], initialFactor: 2500, ints, order: 1, perDay: 20 },
          },
        },
      })(SQL);
      const { data } = readPackage(bytes, SQL);
      const config = fromBinary(DeckConfig_ConfigSchema, data.deckConfig[0].config);
      expect([config.graduatingIntervalGood, config.graduatingIntervalEasy]).toEqual([1, 4]);
    }
  });

  test("an absent replayq means Anki skips the question on replay", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({ dconf: { 1: { id: 1, name: "P" } } })(SQL);
    const { data } = readPackage(bytes, SQL);
    const config = fromBinary(DeckConfig_ConfigSchema, data.deckConfig[0].config);
    expect(config.skipQuestionWhenReplayingAnswer).toBe(true);
  });
});

describe("collisions Anki resolves differently from ankipack", () => {
  // Anki's decks.name index is COLLATE unicase, so two names differing only in
  // case are one deck to it. ankipack's is binary, so both write fine and Anki then
  // merges them, moving one deck's cards into the other.
  test("two decks differing only in case are refused at build time", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Probe" });
    const pkg = new Package();
    for (const name of ["Spanish", "SPANISH"]) {
      const deck = new Deck({ name });
      deck.addNote(new Note({ notetype, fields: [name, "x"] }));
      pkg.addDeck(deck);
    }
    await expect(pkg.toUint8Array(SQL)).rejects.toThrow(/case-insensitively/);
  });

  test("subdecks differing only in case are refused too", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Probe" });
    const pkg = new Package();
    for (const name of ["A::Sub", "A::SUB"]) {
      const deck = new Deck({ name });
      deck.addNote(new Note({ notetype, fields: [name, "x"] }));
      pkg.addDeck(deck);
    }
    await expect(pkg.toUint8Array(SQL)).rejects.toThrow(/case-insensitively/);
  });

  test("names that merely share a prefix are still fine", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Probe" });
    const pkg = new Package();
    for (const name of ["Spanish", "Spanish Advanced", "Spanish::Sub"]) {
      const deck = new Deck({ name });
      deck.addNote(new Note({ notetype, fields: [name, "x"] }));
      pkg.addDeck(deck);
    }
    await expect(pkg.toUint8Array(SQL)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("packages ankipack cannot read are refused, not misread", () => {
  // Every Anki-written package carries a dummy collection.anki2 holding one
  // note that says a newer Anki is needed. Treating an unknown version as
  // "no meta" reads that dummy as if it were the real collection.
  test("a meta version from a newer Anki is refused", async () => {
    const SQL = await getSql();
    const dummy = new SQL.Database();
    let bytes: Uint8Array;
    try {
      dummy.run("CREATE TABLE col (id integer PRIMARY KEY, ver integer NOT NULL)");
      bytes = zipSync({
        // version 99: a layout this code has never seen.
        meta: new Uint8Array([0x08, 0x63]),
        "collection.anki2": dummy.export(),
        media: strToU8("{}"),
      });
    } finally {
      dummy.close();
    }
    expect(() => readPackage(bytes, SQL)).toThrow(/newer|unsupported|version/i);
  });

  test("a media entry with no file in the archive is refused", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Probe" });
    const deck = new Deck({ name: "D" });
    deck.addNote(new Note({ notetype, fields: ["a", "b"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    pkg.addMedia("present.png", new Uint8Array([1]));

    // Name a second file in the index without shipping it, which is what a
    // truncated or hand-edited package looks like.
    const entries = unzipSync(await pkg.toUint8Array(SQL));
    const index = fromBinary(MediaEntriesSchema, decompress(entries["media"]));
    index.entries.push({ ...index.entries[0], name: "missing.png" });
    entries["media"] = zstdRawFrame(toBinary(MediaEntriesSchema, index));

    expect(() => readPackage(zipSync(entries), SQL)).toThrow(/missing\.png/);
  });
});

describe("schema 11 quirks Anki repairs on the way in", () => {
  test("a notetype's identity is the map key, not its inner id", async () => {
    const SQL = await getSql();
    // Anki writes the row under the inner id but its fields under the map key,
    // so the two dangle when they differ. One id everywhere, taken from the
    // key, is what `notes.mid` resolves against.
    const bytes = legacyWith({
      models: {
        1000: { id: 0, name: "Legacy", type: 0, flds: [{ name: "Front" }], tmpls: [{ name: "C" }] },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    expect(data.notetypes[0].id).toBe(1000);
    expect(data.fields[0].ntid).toBe(1000);
    expect(data.templates[0].ntid).toBe(1000);
  });

  test("a deck preset's identity is the map key too", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({ dconf: { 7: { id: 3, name: "P" } } })(SQL);
    const { data } = readPackage(bytes, SQL);
    expect(data.deckConfig[0].id).toBe(7);
  });

  test("notetypes sharing a name are uniquified rather than colliding", async () => {
    const SQL = await getSql();
    const model = (id: number) => ({
      id,
      name: "Dup",
      type: 0,
      flds: [{ name: "Front" }],
      tmpls: [{ name: "C" }],
    });
    const bytes = legacyWith({ models: { 1000: model(1000), 2000: model(2000) } })(SQL);

    const { data } = readPackage(bytes, SQL);
    // Anki appends underscores until the name is unique under UniCase.
    expect(data.notetypes.map((n) => n.name).sort()).toEqual(["Dup", "Dup_"]);
    // And the package must still be writable, which a raw collision is not.
    await expect(writePackage(data, SQL)).resolves.toBeInstanceOf(Uint8Array);
  });

  test("decks sharing a name after normalisation are uniquified", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      decks: {
        1: { id: 1, name: "Spanish", dyn: 0, conf: 1 },
        2: { id: 2, name: "SPANISH", dyn: 0, conf: 1 },
      },
      // Every real schema 11 collection carries preset 1, and a deck pointing
      // at one the file lacks is refused by Anki as well as by ankipack.
      dconf: { 1: { id: 1, name: "Default" } },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    expect(new Set(data.decks.map((d) => d.name.toLowerCase())).size).toBe(2);
    await expect(writePackage(data, SQL)).resolves.toBeInstanceOf(Uint8Array);
  });

  test("duplicate field names within a notetype are uniquified", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      models: {
        1000: {
          id: 1000,
          name: "Legacy",
          type: 0,
          flds: [{ name: "Front" }, { name: "Front" }],
          tmpls: [{ name: "C" }, { name: "C" }],
        },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    expect(new Set(data.fields.map((f) => f.name)).size).toBe(2);
    expect(new Set(data.templates.map((t) => t.name)).size).toBe(2);
    await expect(writePackage(data, SQL)).resolves.toBeInstanceOf(Uint8Array);
  });

  // Schema 15 stored 2.5 as 250 and created presets at the minimum ease by
  // mistake; the 15-to-16 upgrade resets anything at or below 1.3 to 2.5.
  test("a preset stuck at the minimum ease is reset to the default", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      dconf: {
        1: {
          id: 1,
          name: "P",
          new: { delays: [1], initialFactor: 1300, ints: [1, 4], order: 1, perDay: 20 },
        },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    const config = fromBinary(DeckConfig_ConfigSchema, data.deckConfig[0].config);
    expect(config.initialEase).toBeCloseTo(2.5, 5);
  });

  test("a healthy initial ease is left alone", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      dconf: {
        1: {
          id: 1,
          name: "P",
          new: { delays: [1], initialFactor: 2300, ints: [1, 4], order: 1, perDay: 20 },
        },
      },
    })(SQL);
    const { data } = readPackage(bytes, SQL);
    const config = fromBinary(DeckConfig_ConfigSchema, data.deckConfig[0].config);
    expect(config.initialEase).toBeCloseTo(2.3, 5);
  });
});

describe("sub-objects Anki replaces wholesale when a key is missing", () => {
  // serde marks new/rev/lapse with default_on_invalid, so one absent required
  // key discards the entire struct rather than that one field. Defaulting per
  // field instead gives a preset that looks configured but is not.
  const CASES: Array<[string, Record<string, unknown>, Record<string, number>]> = [
    // `rev` without perDay: the whole struct defaults, so 200 not 0.
    [
      "rev missing perDay",
      { rev: { ease4: 1.4, ivlFct: 1.1, maxIvl: 1000 } },
      { reviewsPerDay: 200 },
    ],
    // `new` without initialFactor: perDay falls back to 20, not the 33 given.
    [
      "new missing initialFactor",
      { new: { delays: [1], ints: [1, 4], order: 1, perDay: 33 } },
      { newPerDay: 20 },
    ],
    // `lapse` without minInt: leechThreshold is 8, not the 9 given.
    [
      "lapse missing minInt",
      { lapse: { delays: [10], leechAction: 0, leechFails: 9, mult: 0 } },
      { leechThreshold: 8 },
    ],
  ];

  for (const [name, partial, expected] of CASES) {
    test(`${name} discards the whole sub-object`, async () => {
      const SQL = await getSql();
      const bytes = legacyWith({ dconf: { 1: { id: 1, name: "P", ...partial } } })(SQL);
      const { data } = readPackage(bytes, SQL);
      const config = fromBinary(DeckConfig_ConfigSchema, data.deckConfig[0].config);
      expect(config).toMatchObject(expected);
    });
  }

  test("a complete sub-object is used as given", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      dconf: {
        1: {
          id: 1,
          name: "P",
          rev: { bury: false, ease4: 1.4, ivlFct: 1.1, maxIvl: 1000, perDay: 88, hardFactor: 1.2 },
        },
      },
    })(SQL);
    const { data } = readPackage(bytes, SQL);
    const config = fromBinary(DeckConfig_ConfigSchema, data.deckConfig[0].config);
    expect(config.reviewsPerDay).toBe(88);
  });
});

describe("a template's own deck override is honoured", () => {
  // Anki's cardgen does `did: card.target_deck_id.or(extracted.deck_id)`. A
  // package can arrive with one set even though ankipack never writes one.
  test("a card generated for such a template goes to that deck", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basicAndReversed({ name: "Rev" });
    const home = new Deck({ name: "Home" });
    const target = new Deck({ name: "Target" });
    home.addNote(new Note({ notetype, fields: ["front", ""] }));
    target.addNote(new Note({ notetype, fields: ["other", "side"] }));
    const pkg = new Package();
    pkg.addDeck(home);
    pkg.addDeck(target);

    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);
    const targetId = col.data.decks.find((d) => d.name === "Target")!.id;

    // Point template ord 1 at the other deck, as Anki would store it.
    const tmpl = col.data.templates.find((t) => t.ord === 1)!;
    const config = fromBinary(Notetype_Template_ConfigSchema, tmpl.config);
    config.targetDeckId = BigInt(targetId);
    tmpl.config = toBinary(Notetype_Template_ConfigSchema, config);

    // Filling Back makes ord 1 render, so a card is generated for it.
    const note = col.notes({ deck: "Home" })[0];
    await note.setField("Back", "now filled");

    const generated = col.data.cards.find((c) => c.nid === note.id && c.ord === 1);
    expect(generated).toBeDefined();
    expect(generated!.did).toBe(targetId);
  });
});

describe("stripping stays linear", () => {
  // Anki's engine is linear on these shapes, so quadratic here is a divergence
  // even where it is fast enough on a small field.
  const SHAPES: Array<[string, (bytes: number) => string]> = [
    ["unpaired <", (n) => "<".repeat(n)],
    ["repeated <!--", (n) => "<!--".repeat(Math.floor(n / 4))],
    ["a < b repeated", (n) => "a < b ".repeat(Math.floor(n / 6))],
  ];

  for (const [name, make] of SHAPES) {
    test(name, () => {
      const time = (bytes: number): number => {
        const input = make(bytes);
        const started = performance.now();
        stripHtmlPreservingMediaFilenames(input);
        return performance.now() - started;
      };
      time(32 * 1024); // warm up, so the first run does not carry JIT cost
      const small = Math.max(time(64 * 1024), 1);
      const large = time(256 * 1024);
      // Quadratic would be about 16x for 4x the input; linear about 4x.
      expect(large / small).toBeLessThan(8);
    });
  }
});

describe("values Anki writes that must be read as Anki reads them", () => {
  // Anki's schema 11 downgrade writes these as JSON null for every normal
  // deck, because they are Option<u32> with no skip_serializing_if. Reading
  // null as 0 sets a per-deck override of zero new and zero review cards, so
  // the deck becomes unstudiable and nothing reports an error.
  test("null day limits stay unset rather than becoming zero", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      decks: {
        1: {
          id: 1,
          name: "D",
          dyn: 0,
          conf: 1,
          reviewLimit: null,
          newLimit: null,
          desiredRetention: null,
          reviewLimitToday: null,
          newLimitToday: null,
        },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    const kind = fromBinary(Deck_KindContainerSchema, data.decks[0].kind);
    if (kind.kind.case !== "normal") throw new Error("expected a normal deck");
    expect(kind.kind.value.newLimit).toBeUndefined();
    expect(kind.kind.value.reviewLimit).toBeUndefined();
    expect(kind.kind.value.desiredRetention).toBeUndefined();
    expect(kind.kind.value.newLimitToday).toBeUndefined();
  });

  // U+0130 is the only code point whose toLowerCase() changes UTF-16 length,
  // so an index taken from a lowercased copy no longer lines up.
  test("a dotted capital I does not shift the scanner's index", () => {
    const I = String.fromCodePoint(0x0130);
    expect(stripHtmlPreservingMediaFilenames(`${I}stanbul<style>p{}</style>Turkey`)).toBe(
      `${I}stanbulTurkey`,
    );
    expect(stripHtmlPreservingMediaFilenames(`<style>${I}</style>X`)).toBe("X");
    expect(stripHtmlPreservingMediaFilenames(`a${I}b<script>q</script>tail`)).toBe(`a${I}btail`);
  });

  // Rust's (?i) folds through case-folding orbits; toLowerCase does not.
  test("the long s opens a style block, as it does for Anki", () => {
    const LONG_S = String.fromCodePoint(0x017f);
    expect(stripHtmlPreservingMediaFilenames(`<${LONG_S}tyle>a</style>b`)).toBe("b");
  });

  test("stripping style blocks is linear, not just the bare-angle path", () => {
    const make = (bytes: number): string => "<style>x</style>".repeat(Math.floor(bytes / 16));
    const time = (bytes: number): number => {
      const input = make(bytes);
      const started = performance.now();
      stripHtmlPreservingMediaFilenames(input);
      return performance.now() - started;
    };
    time(64 * 1024);
    const small = time(128 * 1024);
    const large = time(512 * 1024);
    expect(large / Math.max(small, 0.5)).toBeLessThan(8);
  });

  // sql.js writes a lone surrogate as invalid UTF-8, and Anki's Rust core
  // refuses the whole database with a Utf8 error.
  test("a lone surrogate in a field is refused", () => {
    const notetype = Notetype.basic({ name: "Surrogate" });
    const lone = String.fromCharCode(0xd800);
    expect(() => new Note({ notetype, fields: [`before ${lone} after`, "b"] })).toThrow(
      /surrogate/i,
    );
  });

  test("a matched surrogate pair is fine", () => {
    const notetype = Notetype.basic({ name: "Surrogate" });
    expect(() => new Note({ notetype, fields: ["emoji \u{1F600}", "b"] })).not.toThrow();
  });

  // A name Anki strips a character from no longer matches the media index.
  test("code points newer than Anki's Unicode tables are refused in filenames", () => {
    const pkg = new Package();
    for (const name of ["hearts\u{1F970}.png", "yawn\u{1F971}.png", "mtavruli\u{1C90}.png"]) {
      expect(() => pkg.addMedia(name, new Uint8Array([1]))).toThrow(/Media filename/);
    }
  });

  test("a filename with an older emoji is still accepted", () => {
    const pkg = new Package();
    expect(() => pkg.addMedia("ok\u{1F600}.png", new Uint8Array([1]))).not.toThrow();
  });

  // Anki sets these to `rand::random::<i64>()`, so most real ones are past 2^53
  // and JSON.parse rounds them. Its notetype merge matches fields on this id.
  test("64-bit field and template ids keep their exact value", async () => {
    const SQL = await getSql();
    const fieldId = -5125466732644499068n;
    const templateId = 8573920184756301993n;
    // Written as raw JSON text: routing through JSON.stringify would round the
    // ids before the fixture ever reached the reader.
    const models = `{"1000":{"id":1000,"name":"Legacy","type":0,
      "flds":[{"name":"Front","ord":0,"id":${fieldId}}],
      "tmpls":[{"name":"C","ord":0,"qfmt":"{{Front}}","id":${templateId}}]}}`;
    const bytes = legacyWith({ rawNotetypes: models })(SQL);

    const { data } = readPackage(bytes, SQL);
    expect(fromBinary(Notetype_Field_ConfigSchema, data.fields[0].config).id).toBe(fieldId);
    expect(fromBinary(Notetype_Template_ConfigSchema, data.templates[0].config).id).toBe(
      templateId,
    );
  });

  test("a preset with a negative number opens rather than throwing", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      dconf: {
        1: {
          id: 1,
          name: "P",
          new: { delays: [1], initialFactor: 2500, ints: [1, 4], order: 1, perDay: -5 },
        },
      },
    })(SQL);
    expect(() => readPackage(bytes, SQL)).not.toThrow();
  });

  // `From<&DeckCommonSchema11>` takes the newest of the time, new and review
  // days only, and zeroes any counter whose own day is older than that. Keeping
  // a stale count tells Anki today's quota is already spent.
  test("study counters from an earlier day are reset, and lrn does not set the day", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      decks: {
        1: {
          id: 1,
          name: "D",
          dyn: 0,
          conf: 1,
          newToday: [5, 10],
          revToday: [3, 20],
          lrnToday: [7, 30],
          timeToday: [5, 999],
        },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    const common = fromBinary(Deck_CommonSchema, data.decks[0].common);
    expect(common.lastDayStudied).toBe(5);
    expect(common.newStudied).toBe(10);
    expect(common.reviewStudied).toBe(0);
    expect(common.learningStudied).toBe(0);
    expect(common.millisecondsStudied).toBe(999);
  });

  test("a deck takes its id from the deck, not from the map key", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      decks: { 9999: { id: 4242, name: "D", dyn: 0, conf: 1 } },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    expect(data.decks.map((d) => d.id)).toEqual([4242]);
  });

  // Anki uniquifies a notetype name with `_` but a template or field name
  // inside one with `+`, and NFC-normalises all three first.
  test("duplicate template and field names take a + suffix", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      models: {
        1000: {
          id: 1000,
          name: "M",
          type: 0,
          flds: [
            { name: "F", ord: 0 },
            { name: "F", ord: 1 },
          ],
          tmpls: [
            { name: "C", ord: 0, qfmt: "{{F}}" },
            { name: "C", ord: 1, qfmt: "{{F}}" },
          ],
        },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    expect(data.fields.map((f) => f.name)).toEqual(["F", "F+"]);
    expect(data.templates.map((t) => t.name)).toEqual(["C", "C+"]);
  });

  test("notetype names are NFC-normalised the way Anki stores them", async () => {
    const SQL = await getSql();
    const decomposed = `Cafe${String.fromCodePoint(0x0301)}`;
    const bytes = legacyWith({
      models: {
        1000: {
          id: 1000,
          name: decomposed,
          type: 0,
          flds: [{ name: decomposed, ord: 0 }],
          tmpls: [{ name: decomposed, ord: 0, qfmt: "{{Front}}" }],
        },
      },
    })(SQL);

    const { data } = readPackage(bytes, SQL);
    const composed = decomposed.normalize("NFC");
    expect(data.notetypes[0].name).toBe(composed);
    expect(data.fields[0].name).toBe(composed);
    expect(data.templates[0].name).toBe(composed);
  });

  // `set_all_config(conf, Usn(0), TimestampSecs(0))`: the split out of `col.conf`
  // is not a user edit, so it is not marked as one.
  test("config rows split out of col.conf carry usn 0 and mtime 0", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({ conf: { schedVer: 2, curDeck: 1 } })(SQL);

    const { data } = readPackage(bytes, SQL);
    expect(data.config.length).toBeGreaterThan(0);
    for (const row of data.config) {
      expect(row.usn).toBe(0);
      expect(row.mtimeSecs).toBe(0);
    }
  });

  // `CardGenCache::next_position` is filled once per note and reused for every
  // card of it, so a two-card note occupies one position, not two. Building
  // handed out a position per card, which spreads siblings through the new
  // queue instead of keeping them together.
  test("every card of one note gets the same due position", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basicAndReversed({ name: "Rev" });
    const deck = new Deck({ name: "D" });
    deck.addNote(new Note({ notetype, fields: ["a", "b"] }));
    deck.addNote(new Note({ notetype, fields: ["c", "d"] }));
    const pkg = new Package();
    pkg.addDeck(deck);

    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);
    const notes = col.data.notes.map((n) => n.id).sort((x, y) => x - y);
    const duesOf = (nid: number): number[] =>
      col.data.cards.filter((c) => c.nid === nid).map((c) => c.due);

    expect(duesOf(notes[0])).toEqual([0, 0]);
    expect(duesOf(notes[1])).toEqual([1, 1]);
  });

  // `extracted.due` is the first existing new card's position, so a sibling
  // joins its note in the queue rather than landing at the very end of it.
  test("a generated sibling takes the existing card's due position", async () => {
    const col = await pendingSibling();
    const note = col.notes()[0];
    const card = col.data.cards.find((c) => c.nid === note.id)!;
    card.due = 42;

    await note.setFields(["front", "back"]);
    const sibling = col.data.cards.find((c) => c.nid === note.id && c.id !== card.id)!;
    expect(sibling.due).toBe(42);
  });

  // `existing_cards.sql` reads the position only for type 0, so a card that has
  // been studied says nothing about where a new sibling belongs.
  test("a reviewed card does not lend its due to a sibling", async () => {
    const col = await pendingSibling();
    const note = col.notes()[0];
    const card = col.data.cards.find((c) => c.nid === note.id)!;
    card.type = 2;
    card.queue = 2;
    card.due = 900;

    await note.setFields(["front", "back"]);
    const sibling = col.data.cards.find((c) => c.nid === note.id && c.id !== card.id)!;
    expect(sibling.due).not.toBe(900);
  });

  // `new_cards_required_cloze` sets `did` from the note's own cards and never
  // reads `target_deck_id`: the override is a normal-notetype feature.
  test("a cloze template's deck override does not move its cards", async () => {
    const SQL = await getSql();
    const main = new Deck({ name: "Main" });
    const other = new Deck({ name: "Other" });
    main.addNote(new Note({ notetype: Notetype.cloze({ name: "Cz" }), fields: ["{{c1::p}}", ""] }));
    other.addNote(new Note({ notetype: Notetype.basic({ name: "Filler" }), fields: ["x", "y"] }));
    const pkg = new Package();
    pkg.addDeck(main);
    pkg.addDeck(other);

    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);
    const mainId = col.data.decks.find((d) => d.name === "Main")!.id;
    const otherId = col.data.decks.find((d) => d.name === "Other")!.id;

    const clozeNt = col.data.notetypes.find((n) => n.name === "Cz")!;
    const tmpl = col.data.templates.find((t) => t.ntid === clozeNt.id)!;
    const config = fromBinary(Notetype_Template_ConfigSchema, tmpl.config);
    config.targetDeckId = BigInt(otherId);
    tmpl.config = toBinary(Notetype_Template_ConfigSchema, config);

    // A brand new note generates ord 0, which is the only ordinal the single
    // cloze template's override could ever be read for.
    const note = await col.addNote({ notetype: "Cz", deck: "Main", fields: ["{{c1::q}}", ""] });

    const placed = col.data.cards.filter((c) => c.nid === note.id);
    expect(placed.length).toBe(1);
    for (const card of placed) expect(card.did).toBe(mainId);
  });

  // Anki's `is_tag_separator` is a space or U+3000, so a stored tag string
  // holding one is two tags to Anki and one to a naive split on spaces.
  test("tags are split on the ideographic space too", async () => {
    const col = await twoDecks();
    const note = col.notes()[0];
    // Written the way a collection from another client can hold it. The public
    // API refuses U+3000 in a tag, so this has to go in through the row.
    note.row.tags = ` alpha${String.fromCharCode(0x3000)}beta `;
    expect(note.tags).toEqual(["alpha", "beta"]);
  });

  // `decks.name` is indexed COLLATE unicase, so Anki finds a deck whatever case
  // the caller asks in. Refusing a rename onto "b" while being unable to find
  // "b" is the same rule applied in only one direction.
  test("a deck is found regardless of the case asked for", async () => {
    const col = await twoDecks();
    expect(col.notes({ deck: "a" }).length).toBe(1);
    await expect(
      col.addNote({ notetype: "Probe", deck: "a", fields: ["x", "y"] }),
    ).resolves.toBeDefined();
    expect(() => col.renameDeck("a", "C")).not.toThrow();
    expect(col.deckNames()).toContain("C");
  });

  // Keeping 64-bit ids exact must not reach the keys ankipack does not model:
  // those are handed straight back to JSON.stringify for the `other` blob,
  // which refuses a BigInt and would fail the whole read.
  test("an unmodelled key holding a huge number still reads", async () => {
    const SQL = await getSql();
    const models = `{"1000":{"id":1000,"name":"M","type":0,"vendorBig":9007199254740999,
      "flds":[{"name":"F","ord":0}],"tmpls":[{"name":"C","ord":0,"qfmt":"{{F}}"}]}}`;
    const bytes = legacyWith({ rawNotetypes: models })(SQL);

    expect(() => readPackage(bytes, SQL)).not.toThrow();
  });

  test("renameDeck refuses a collision a subdeck would cause", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Probe" });
    const pkg = new Package();
    for (const name of ["A", "A::x", "B::X"]) {
      const deck = new Deck({ name });
      deck.addNote(new Note({ notetype, fields: [name, "v"] }));
      pkg.addDeck(deck);
    }
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);
    // Renaming A to B would put A::x next to B::X, which Anki merges.
    expect(() => col.renameDeck("A", "B")).toThrow(/already exists/);
  });
});

/** A schema 11 collection with one preset, one deck and one card on it. */
function legacyWithCard(options: {
  initialFactor?: number;
  cardFactor?: number;
  graves?: Array<[number, number, number]>;
  media?: Record<string, string>;
  noteFields?: string;
  guid?: string;
}): (SQL: Awaited<ReturnType<typeof getSql>>) => Uint8Array {
  const NT = 1000;
  const DECK = 2000;
  return (SQL) =>
    legacyPackage(
      SQL,
      (db) => {
        const models = {
          [NT]: {
            id: NT,
            name: "M",
            type: 0,
            flds: [{ name: "F", ord: 0 }],
            tmpls: [{ name: "C", ord: 0, qfmt: "{{F}}" }],
          },
        };
        const decks = { [DECK]: { id: DECK, name: "D", dyn: 0, conf: 1 } };
        const dconf = {
          1: {
            id: 1,
            name: "P",
            maxTaken: 60,
            new: {
              delays: [1, 10],
              initialFactor: options.initialFactor ?? 2500,
              ints: [1, 4],
              order: 1,
              perDay: 20,
            },
            rev: { ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200 },
            lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
          },
        };
        db.run(`INSERT INTO col VALUES (1,1,1,1,11,0,-1,0,'{}',?,?,?,'{}')`, [
          JSON.stringify(models),
          JSON.stringify(decks),
          JSON.stringify(dconf),
        ]);
        db.run(`INSERT INTO notes VALUES (1,?,?,1,-1,'',?,'x',1,0,'')`, [
          options.guid ?? "guid123456",
          NT,
          options.noteFields ?? "x",
        ]);
        db.run(`INSERT INTO cards VALUES (1,1,?,0,1,-1,2,2,500,40,?,12,2,0,0,0,0,'')`, [
          DECK,
          options.cardFactor ?? 2500,
        ]);
        for (const [oid, type, usn] of options.graves ?? []) {
          db.run(`INSERT INTO graves VALUES (?,?,?)`, [oid, type, usn]);
        }
      },
      options.media === undefined
        ? {}
        : {
            ...Object.fromEntries(
              Object.keys(options.media).map((k) => [k, new Uint8Array([1, 2, 3])]),
            ),
            media: strToU8(JSON.stringify(options.media)),
          },
    );
}

describe("legacy files Anki accepts must convert, not break", () => {
  // `SafeMediaEntry::from_legacy` normalises the name; `from_entry`, used for
  // the current layout, refuses the whole archive unless it is already
  // normalised. Converting one into the other without normalising turns an
  // importable package into an unimportable one.
  test("a legacy media name Anki would normalise is normalised on read", async () => {
    const SQL = await getSql();
    const nfd = `cafe${String.fromCodePoint(0x0301)}.png`;
    const { data } = readPackage(legacyWithCard({ media: { "0": nfd } })(SQL), SQL);
    expect(data.media[0].name).toBe(nfd.normalize("NFC"));
  });

  // `truncate_filename` caps the extension at 10 bytes, then the stem, leaving
  // room for the dot and the underscore it may append. A name it repairs must
  // come out the far side clean, or the package is refused anyway.
  test("an over-long legacy media name is truncated the way Anki truncates it", () => {
    const utf8 = new TextEncoder();
    const cases: Array<[string, string]> = [
      [`${"a".repeat(200)}.png`, "a long stem"],
      ["b".repeat(200), "no extension at all"],
      [`${"c".repeat(110)}.${"e".repeat(40)}`, "a long stem and a long extension"],
      [`${"é".repeat(80)}.png`, "a multibyte stem at the boundary"],
    ];
    for (const [name, why] of cases) {
      const out = normalizeMediaFilename(name);
      expect(utf8.encode(out).length, why).toBeLessThanOrEqual(120);
      // Normalising twice must not keep changing it, and the result must be a
      // name the current format accepts.
      expect(normalizeMediaFilename(out), why).toBe(out);
      expect(mediaFilenameProblem(out), why).toBeUndefined();
    }
  });

  test("a legacy media name with a disallowed character is repaired on read", async () => {
    const SQL = await getSql();
    const { data } = readPackage(legacyWithCard({ media: { "0": "a:b.png" } })(SQL), SQL);
    expect(data.media[0].name).toBe("ab.png");
  });

  test("a legacy Windows device name gains the underscore Anki adds", async () => {
    const SQL = await getSql();
    const { data } = readPackage(legacyWithCard({ media: { "0": "con.png" } })(SQL), SQL);
    expect(data.media[0].name).toBe("con_.png");
  });

  // SQLite stores text as a C string, so a NUL truncates the value on read.
  // Writing the truncated value back destroys the note: Anki reads the original
  // as three fields and the rewritten one as one.
  test("a NUL in a text column is refused rather than silently truncating", async () => {
    const SQL = await getSql();
    // Bound as a blob literal, since a NUL cannot travel through sql.js as text.
    const bytes = legacyPackage(SQL, (db) => {
      db.run(`INSERT INTO col VALUES (1,1,1,1,11,0,-1,0,'{}','{}','{}','{}','{}')`);
      db.run(`INSERT INTO notes VALUES (1,'g',1,1,-1,'',CAST(x'6100620063' AS TEXT),'x',1,0,'')`);
    });
    expect(() => readPackage(bytes, SQL)).toThrow(/NUL/i);
  });

  // Schema 11's graves has no primary key, schema 18's is (oid, type), and
  // Anki bridges the two with INSERT OR IGNORE.
  test("duplicate graves rows in a legacy file do not break the write", async () => {
    const SQL = await getSql();
    const bytes = legacyWithCard({
      graves: [
        [5, 0, -1],
        [5, 0, -1],
        [5, 0, 0],
      ],
    })(SQL);
    const { data } = readPackage(bytes, SQL);
    expect(data.graves.length).toBe(1);
    await expect(writePackage(data, SQL)).resolves.toBeDefined();
  });

  // `TodayAmountSchema11` is `#[serde(from = "Vec<Value>")]` and pops the
  // amount first, then the day, so a short array means day 0.
  test("today counters are popped from the end, not read positionally", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      decks: { 1: { id: 1, name: "D", dyn: 0, conf: 1, newToday: [7] } },
    })(SQL);
    const { data } = readPackage(bytes, SQL);
    const common = fromBinary(Deck_CommonSchema, data.decks[0].common);
    expect(common.lastDayStudied).toBe(0);
    expect(common.newStudied).toBe(7);
  });

  // `desiredRetention` is `Option<u32>` with default_on_invalid, so a float
  // fails the deserialize and leaves the override unset.
  test("a non-integer desiredRetention is unset, not divided by 100", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      decks: { 1: { id: 1, name: "D", dyn: 0, conf: 1, desiredRetention: 0.9 } },
    })(SQL);
    const { data } = readPackage(bytes, SQL);
    const kind = fromBinary(Deck_KindContainerSchema, data.decks[0].kind);
    if (kind.kind.case !== "normal") throw new Error("expected a normal deck");
    expect(kind.kind.value.desiredRetention).toBeUndefined();
  });

  test("an integer desiredRetention is still read as a percentage", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      decks: { 1: { id: 1, name: "D", dyn: 0, conf: 1, desiredRetention: 90 } },
    })(SQL);
    const { data } = readPackage(bytes, SQL);
    const kind = fromBinary(Deck_KindContainerSchema, data.decks[0].kind);
    if (kind.kind.case !== "normal") throw new Error("expected a normal deck");
    expect(kind.kind.value.desiredRetention).toBeCloseTo(0.9, 5);
  });

  // Resetting the preset is only half of Anki's schema 15 to 16 step: it then
  // runs fix_low_ease.sql over the cards of every deck using that preset.
  test("a preset repaired to the default ease also repairs its low-ease cards", async () => {
    const SQL = await getSql();
    const bytes = legacyWithCard({ initialFactor: 1300, cardFactor: 1300 })(SQL);
    const { data } = readPackage(bytes, SQL);
    expect(data.cards[0].factor).toBe(2500);
  });

  test("a card above the low-ease cap keeps its factor", async () => {
    const SQL = await getSql();
    const bytes = legacyWithCard({ initialFactor: 1300, cardFactor: 2100 })(SQL);
    const { data } = readPackage(bytes, SQL);
    expect(data.cards[0].factor).toBe(2100);
  });

  test("a healthy preset leaves its low-ease cards alone", async () => {
    const SQL = await getSql();
    const bytes = legacyWithCard({ initialFactor: 2500, cardFactor: 1300 })(SQL);
    const { data } = readPackage(bytes, SQL);
    expect(data.cards[0].factor).toBe(1300);
  });

  // `Tag::new` sets expanded false and `register_tag` binds `!expanded`.
  test("tags upgraded from schema 11 are collapsed", async () => {
    const SQL = await getSql();
    const bytes = legacyPackage(SQL, (db) => {
      db.run(`INSERT INTO col VALUES (1,1,1,1,11,0,-1,0,'{}','{}','{}','{}',?)`, [
        JSON.stringify({ foo: -1 }),
      ]);
    });
    const { data } = readPackage(bytes, SQL);
    expect(data.tags).toEqual([{ tag: "foo", usn: -1, collapsed: true, config: null }]);
  });

  // The bigint conversion must not reach a key that goes back out through
  // JSON.stringify, which refuses one.
  test("an add-on id nested under an unmodelled key does not abort the open", async () => {
    const SQL = await getSql();
    const models = `{"1000":{"id":1000,"name":"M","type":0,
      "myAddon":{"id":9007199254740993},
      "flds":[{"name":"F","ord":0}],"tmpls":[{"name":"C","ord":0,"qfmt":"{{F}}"}]}}`;
    expect(() => readPackage(legacyWith({ rawNotetypes: models })(SQL), SQL)).not.toThrow();
  });

  // Anki's default_on_invalid drops each of these rather than refusing.
  test("values Anki drops do not abort the open", async () => {
    const SQL = await getSql();
    const cases: Array<[string, (sql: typeof SQL) => Uint8Array]> = [
      [
        "negative reviewLimit",
        legacyWith({ decks: { 1: { id: 1, name: "D", dyn: 0, conf: 1, reviewLimit: -5 } } }),
      ],
      [
        "huge extendNew",
        legacyWith({ decks: { 1: { id: 1, name: "D", dyn: 0, conf: 1, extendNew: 9e12 } } }),
      ],
      [
        "fractional notetype did",
        legacyWith({
          models: {
            1000: {
              id: 1000,
              name: "M",
              type: 0,
              did: 1.5,
              flds: [{ name: "F", ord: 0 }],
              tmpls: [{ name: "C", ord: 0, qfmt: "{{F}}" }],
            },
          },
        }),
      ],
      [
        "negative field tag",
        legacyWith({
          models: {
            1000: {
              id: 1000,
              name: "M",
              type: 0,
              flds: [{ name: "F", ord: 0, tag: -1 }],
              tmpls: [{ name: "C", ord: 0, qfmt: "{{F}}" }],
            },
          },
        }),
      ],
    ];
    for (const [why, build] of cases) {
      expect(() => readPackage(build(SQL), SQL), why).not.toThrow();
    }
  });
});

describe("names must fold the way Anki indexes them", () => {
  // Anki's COLLATE unicase is the unicase crate, which does FULL case folding.
  // toLowerCase agrees for ASCII but not for these, so the guard that exists to
  // stop Anki silently merging two decks never fired.
  const FOLD_PAIRS: Array<[string, string, string]> = [
    ["Straße", "Strasse", "sharp s folds to ss"],
    [`${String.fromCodePoint(0x017f)}un`, "sun", "long s folds to s"],
    [`${String.fromCodePoint(0xfb01)}n`, "fin", "the fi ligature folds to fi"],
    ["ςigma", "σigma", "final sigma folds to sigma"],
  ];

  for (const [a, b, why] of FOLD_PAIRS) {
    test(`two decks are refused when ${why}`, async () => {
      const SQL = await getSql();
      const notetype = Notetype.basic({ name: "Probe" });
      const pkg = new Package();
      for (const name of [a, b]) {
        const deck = new Deck({ name });
        deck.addNote(new Note({ notetype, fields: [name, "v"] }));
        pkg.addDeck(deck);
      }
      await expect(pkg.toUint8Array(SQL)).rejects.toThrow(/same Anki deck name/);
    });

    test(`two field names are refused when ${why}`, () => {
      expect(
        () =>
          new Notetype({
            name: "M",
            fields: [{ name: a }, { name: b }],
            templates: [{ name: "C", questionFormat: `{{${a}}}`, answerFormat: "x" }],
          }),
      ).toThrow(/case-insensitively/);
    });
  }

  test("two note types differing only in case are refused", async () => {
    const SQL = await getSql();
    const pkg = new Package();
    for (const [name, deckName] of [
      ["Vocab", "A"],
      ["vocab", "B"],
    ]) {
      const deck = new Deck({ name: deckName });
      deck.addNote(new Note({ notetype: Notetype.basic({ name }), fields: ["a", "b"] }));
      pkg.addDeck(deck);
    }
    await expect(pkg.toUint8Array(SQL)).rejects.toThrow(/unique/);
  });

  test("a deck is found through a full case fold, as Anki's index finds it", async () => {
    const SQL = await getSql();
    const deck = new Deck({ name: "Straße" });
    deck.addNote(new Note({ notetype: Notetype.basic({ name: "Probe" }), fields: ["a", "b"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);
    expect(col.notes({ deck: "STRASSE" }).length).toBe(1);
  });

  // Anki's notetypes.name index is COLLATE unicase too.
  test("a notetype is found regardless of the case asked for", async () => {
    const col = await twoDecks();
    await expect(
      col.addNote({ notetype: "probe", deck: "A", fields: ["x", "y"] }),
    ).resolves.toBeDefined();
    expect(col.notes({ notetype: "PROBE" }).length).toBeGreaterThan(0);
  });
});

describe("every path that writes text guards it", () => {
  // Every other string this class writes into a TEXT column is guarded; a
  // lone surrogate here fails Anki's import with DbError { kind: Utf8 }.
  test("renameDeck refuses a lone surrogate", async () => {
    const col = await twoDecks();
    const lone = String.fromCharCode(0xd800);
    expect(() => col.renameDeck("A", `Bad${lone}Name`)).toThrow(/surrogate/i);
  });

  // fflate writes no zip64 record and truncates the entry count to 16 bits, so
  // past this many files the archive silently loses its own collection.
  test("a package with more entries than a plain zip can hold is refused", async () => {
    const SQL = await getSql();
    const col = await twoDecks();
    for (let i = 0; i < 65_540; i++) {
      col.data.media.push({ name: `f${i}.bin`, data: new Uint8Array([1]) });
    }
    await expect(col.toUint8Array(SQL)).rejects.toThrow(/media files/i);
  });
});

describe("text handling stays linear and lossless", () => {
  // The give-up latches only trigger on an UNTERMINATED block, which the
  // existing linearity test never produces.
  test("stripping unterminated style and script blocks is linear", () => {
    const time = (input: string): number => {
      const started = performance.now();
      stripHtmlPreservingMediaFilenames(input);
      return performance.now() - started;
    };
    for (const open of ["<style>", "<script>"]) {
      time(open.repeat(4096));
      const small = time(open.repeat(16_384));
      const large = time(open.repeat(65_536));
      expect(large / Math.max(small, 0.5)).toBeLessThan(20);
    }
  });

  test("a lone surrogate in a media filename is refused", () => {
    const pkg = new Package();
    const lone = String.fromCharCode(0xd800);
    expect(() => pkg.addMedia(`a${lone}b.png`, new Uint8Array([1]))).toThrow(/Media filename/);
  });

  // Anki's invalid_char_for_field keeps \n and \t; stripping them would flatten
  // every multi-line field in the collection.
  test("a field keeps its newlines and tabs", async () => {
    const SQL = await getSql();
    const deck = new Deck({ name: "D" });
    deck.addNote(
      new Note({ notetype: Notetype.basic({ name: "Probe" }), fields: ["line1\nline2\tend", "b"] }),
    );
    const pkg = new Package();
    pkg.addDeck(deck);
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);
    expect(col.notes()[0].fields[0]).toBe("line1\nline2\tend");
  });
});

describe("packages Anki must be able to import", () => {
  // Anki's gather pass resolves every deck's config_id against the package's
  // own deck_config, so a NO_PRESET deck needs a placeholder row at id 1 or
  // Anki refuses the whole package.
  test("addDeck with config null still ships the preset Anki resolves against", async () => {
    const SQL = await getSql();
    const built = new Deck({ name: "Vocab" });
    built.addNote(new Note({ notetype: Notetype.basic({ name: "B" }), fields: ["a", "b"] }));
    const pkg = new Package();
    pkg.addDeck(built);
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);

    const added = new Deck({ name: "Grammar", config: null });
    added.addNote(new Note({ notetype: Notetype.basic({ name: "B2" }), fields: ["c", "d"] }));
    await col.addDeck(added);

    expect(col.data.deckConfig.map((c) => c.id)).toContain(1);
    await expect(col.toUint8Array(SQL)).resolves.toBeInstanceOf(Uint8Array);
  });

  // Anki's COLLATE unicase is the `unicase` crate at the version its Cargo.lock
  // pins. Its tables predate Cherokee's lowercase block, so it folds those, and
  // postdate nothing else here: code points assigned after it are left alone
  // where `toLowerCase` maps them.
  test("names fold exactly as Anki's collation folds them", async () => {
    const SQL = await getSql();
    const CHEROKEE_A = String.fromCodePoint(0x13a0);
    const CHEROKEE_SMALL_A = String.fromCodePoint(0xab70);
    const GLAGOLITIC = String.fromCodePoint(0x2c2f);
    const GLAGOLITIC_SMALL = String.fromCodePoint(0x2c5f);

    // Anki merges these two decks, so shipping both loses one.
    const merged = new Package();
    for (const name of [CHEROKEE_A, CHEROKEE_SMALL_A]) {
      const deck = new Deck({ name });
      deck.addNote(new Note({ notetype: Notetype.basic({ name: "P" }), fields: [name, "v"] }));
      merged.addDeck(deck);
    }
    await expect(merged.toUint8Array(SQL)).rejects.toThrow(/same Anki deck name/);

    // Anki keeps these apart, so refusing them refuses a package it accepts.
    const distinct = new Package();
    for (const [name, model] of [
      [GLAGOLITIC, "P1"],
      [GLAGOLITIC_SMALL, "P2"],
    ]) {
      const deck = new Deck({ name });
      deck.addNote(new Note({ notetype: Notetype.basic({ name: model }), fields: [name, "v"] }));
      distinct.addDeck(deck);
    }
    await expect(distinct.toUint8Array(SQL)).resolves.toBeInstanceOf(Uint8Array);
  });

  // Rust's serde refuses a float where it wants an integer, and
  // `default_on_invalid` then substitutes the whole `new` block, so the preset
  // never looks low-ease and no card is touched.
  test("a float-formatted initialFactor does not trigger the ease repair", async () => {
    const SQL = await getSql();
    const bytes = legacyWithFloatEase(SQL, "1300.0");
    const { data } = readPackage(bytes, SQL);
    expect(data.cards.map((c) => c.factor)).toEqual([1300, 2000]);
  });

  test("an integer initialFactor still triggers it", async () => {
    const SQL = await getSql();
    const bytes = legacyWithFloatEase(SQL, "1300");
    const { data } = readPackage(bytes, SQL);
    expect(data.cards.map((c) => c.factor)).toEqual([2500, 2500]);
  });

  // `split_and_truncate_filename` uses rsplitn(2, '.'), so a name whose only
  // dot is at index 0 has an empty stem and everything after it as extension.
  test("a leading-dot filename truncates on that dot, as Anki truncates it", () => {
    const name = `.${"y".repeat(131)}`;
    expect(normalizeMediaFilename(name)).toBe(`.${"y".repeat(10)}`);
  });

  // `review_limit_today` is `Option<DayLimit>` with default_on_invalid, so
  // anything unreadable leaves the override off. A limit of 0 means no cards.
  test("an unreadable day limit leaves the override unset", async () => {
    const SQL = await getSql();
    for (const value of [{ limit: "x", today: 3 }, {}, 5]) {
      const bytes = legacyWith({
        decks: { 1: { id: 1, name: "D", dyn: 0, conf: 1, reviewLimitToday: value } },
      })(SQL);
      const { data } = readPackage(bytes, SQL);
      const kind = fromBinary(Deck_KindContainerSchema, data.decks[0].kind);
      if (kind.kind.case !== "normal") throw new Error("expected a normal deck");
      expect(kind.kind.value.reviewLimitToday, JSON.stringify(value)).toBeUndefined();
    }
  });

  test("a readable day limit still comes through", async () => {
    const SQL = await getSql();
    const bytes = legacyWith({
      decks: { 1: { id: 1, name: "D", dyn: 0, conf: 1, reviewLimitToday: { limit: 5, today: 3 } } },
    })(SQL);
    const { data } = readPackage(bytes, SQL);
    const kind = fromBinary(Deck_KindContainerSchema, data.decks[0].kind);
    if (kind.kind.case !== "normal") throw new Error("expected a normal deck");
    expect(kind.kind.value.reviewLimitToday?.limit).toBe(5);
  });

  // Each of these reaches a protobuf field whose type cannot hold the value, so
  // the encoder threw a bare Error and the whole open aborted.
  test("legacy values Anki reads do not abort the open with an encoder error", async () => {
    const SQL = await getSql();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["negative day limit today", { reviewLimitToday: { limit: 5, today: -3 } }],
      ["day limit past uint32", { reviewLimitToday: { limit: 4_294_967_296 } }],
      ["today counter past int32", { newToday: [0, 2_147_483_648] }],
    ];
    for (const [why, extra] of cases) {
      const bytes = legacyWith({
        decks: { 1: { id: 1, name: "D", dyn: 0, conf: 1, ...extra } },
      })(SQL);
      expect(() => readPackage(bytes, SQL), why).not.toThrow();
    }
  });

  // `buildCollection` treats a reused preset or notetype id as fatal, because
  // the second one silently inherits the first one's settings and templates.
  test("addDeck refuses a preset or note type id that means something else", async () => {
    const col = await twoDecks();

    const preset = new DeckConfig({ id: 5000, name: "Mine", desiredRetention: 0.95 });
    const first = new Deck({ name: "One", config: preset });
    first.addNote(new Note({ notetype: Notetype.basic({ name: "N1" }), fields: ["a", "b"] }));
    await col.addDeck(first);

    const clashing = new DeckConfig({ id: 5000, name: "Other", desiredRetention: 0.7 });
    const second = new Deck({ name: "Two", config: clashing });
    second.addNote(new Note({ notetype: Notetype.basic({ name: "N2" }), fields: ["c", "d"] }));
    await expect(col.addDeck(second)).rejects.toThrow(/id/i);
  });

  // A deck pointing at a preset the package does not carry is the shape Anki
  // refuses with "No such deck config".
  test("a deck referring to a missing preset is refused at write time", async () => {
    const SQL = await getSql();
    const col = await twoDecks();
    const deck = col.data.decks[0];
    const kind = fromBinary(Deck_KindContainerSchema, deck.kind);
    if (kind.kind.case !== "normal") throw new Error("expected a normal deck");
    kind.kind.value.configId = 987_654n;
    deck.kind = toBinary(Deck_KindContainerSchema, kind);

    await expect(col.toUint8Array(SQL)).rejects.toThrow(/deck_config|preset/i);
  });

  // Anki's index folds case, so an exact duplicate would pass even if the check
  // stopped folding. The names differ only in case for that reason.
  test("two decks whose names differ only in case are refused when the collection is saved", async () => {
    const SQL = await getSql();
    const col = await twoDecks();
    col.data.decks[1].name = col.data.decks[0].name.toUpperCase();
    await expect(col.toUint8Array(SQL)).rejects.toThrow(/name/i);
  });

  // Both notes reach the recipient and Check Database calls that healthy, so
  // the e2e oracle cannot catch this one.
  test("two notes in one package sharing a guid are refused when the package is built", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Probe" });
    const deck = new Deck({ name: "D" });
    deck.addNote(new Note({ notetype, fields: ["a", "b"], guid: "shared" }));
    deck.addNote(new Note({ notetype, fields: ["c", "d"], guid: "shared" }));
    const pkg = new Package();
    pkg.addDeck(deck);
    await expect(pkg.toUint8Array(SQL)).rejects.toThrow(/guid/i);
  });

  // Anki's own schema puts no unique index on notes.guid, so a collection can
  // arrive already holding a duplicate. Refusing to save it would break the
  // round trip over a state ankipack did not create and Anki tolerates.
  test("a duplicate guid already in the collection still writes back", async () => {
    const SQL = await getSql();
    const col = await twoDecks();
    col.data.notes[1].guid = col.data.notes[0].guid;
    await expect(col.toUint8Array(SQL)).resolves.toBeInstanceOf(Uint8Array);
  });

  test("addNote refuses a guid the collection already holds", async () => {
    const col = await twoDecks();
    const taken = col.data.notes[0].guid;
    await expect(
      col.addNote({ notetype: "Probe", deck: "A", fields: ["x", "y"], guid: taken }),
    ).rejects.toThrow(/guid/i);
  });

  // Anki imports both and Check Database removes one, in text a caller never
  // sees.
  test("two cards sharing a note and template ordinal are refused when the collection is saved", async () => {
    const SQL = await getSql();
    const col = await twoDecks();
    const card = col.data.cards[0];
    col.data.cards.push({ ...card, id: card.id + 1 });
    await expect(col.toUint8Array(SQL)).rejects.toThrow(/ord|template/i);
  });

  // `col.data.media` is the documented escape hatch, so a name can reach the
  // writer without passing `addMedia` or `setMedia`.
  test("a media filename Anki would refuse is caught when the collection is saved", async () => {
    const SQL = await getSql();
    const col = await twoDecks();
    col.data.media.push({ name: "bad<name>.png", data: new Uint8Array([1]) });
    await expect(col.toUint8Array(SQL)).rejects.toThrow(/media|filename/i);
  });
});

/** A schema 11 package whose preset ease is written with the given literal. */
function legacyWithFloatEase(
  SQL: Awaited<ReturnType<typeof getSql>>,
  initialFactor: string,
): Uint8Array {
  const models = {
    1000: {
      id: 1000,
      name: "M",
      type: 0,
      flds: [{ name: "F", ord: 0 }],
      tmpls: [{ name: "C", ord: 0, qfmt: "{{F}}" }],
    },
  };
  const decks = { 2000: { id: 2000, name: "D", dyn: 0, conf: 1 } };
  const dconf =
    `{"1":{"id":1,"mod":0,"name":"P","usn":0,"maxTaken":60,` +
    `"new":{"delays":[1,10],"initialFactor":${initialFactor},"ints":[1,4],"order":1,"perDay":20},` +
    `"rev":{"ease4":1.3,"ivlFct":1,"maxIvl":36500,"perDay":200},` +
    `"lapse":{"delays":[10],"leechAction":1,"leechFails":8,"minInt":1,"mult":0}}}`;

  return legacyPackage(SQL, (db) => {
    db.run(`INSERT INTO col VALUES (1,1,1,1,11,0,-1,0,'{}',?,?,?,'{}')`, [
      JSON.stringify(models),
      JSON.stringify(decks),
      dconf,
    ]);
    db.run(`INSERT INTO notes VALUES (1,'g',1000,1,-1,'','x','x',1,0,'')`);
    db.run(`INSERT INTO cards VALUES (1,1,2000,0,1,0,2,2,500,40,1300,12,2,0,0,0,0,'')`);
    db.run(`INSERT INTO cards VALUES (2,1,2000,1,1,0,2,2,500,40,2000,12,2,0,0,0,0,'')`);
  });
}

// Each of these asserts the exact boundary rather than the presence of a guard,
// so a guard rewritten to a nearby value still fails.
describe("guards that must stay exact, not merely present", () => {
  // The cap has to be the real boundary, not a round number well past it: a
  // package one entry over wraps the 16-bit count and names none of its files.
  // Only the refusal is exercised, because it happens before the zip.
  test("the media cap is the exact entry count a zip can index", async () => {
    const SQL = await getSql();
    const col = await twoDecks();
    // `meta`, the collection, the media index, and the slot the count needs.
    const cap = 0xffff - 2 - 1;
    for (let i = 0; i <= cap; i++) {
      col.data.media.push({ name: `f${i}.bin`, data: new Uint8Array([1]) });
    }
    await expect(col.toUint8Array(SQL)).rejects.toThrow(new RegExp(`at most ${cap} media files`));
  });

  // `BigInt("1e30")` throws, `safeParse` swallows it, and the whole models blob
  // becomes {}: every notetype in the collection, silently gone.
  test("a JSON number in exponent form does not discard the notetypes", async () => {
    const SQL = await getSql();
    const models = `{"1000":{"id":1e30,"name":"M","type":0,
      "flds":[{"name":"F","ord":0}],"tmpls":[{"name":"C","ord":0,"qfmt":"{{F}}"}]}}`;
    const { data } = readPackage(legacyWith({ rawNotetypes: models })(SQL), SQL);
    expect(data.notetypes.length).toBe(1);
  });

  test("truncation produces the name Anki produces, not merely a short one", () => {
    const cases: Array<[string, string]> = [
      [`${"a".repeat(200)}.png`, `${"a".repeat(115)}.png`],
      ["b".repeat(200), "b".repeat(118)],
      [`${"c".repeat(110)}.${"e".repeat(40)}`, `${"c".repeat(108)}.${"e".repeat(10)}`],
      [`hello ${"z".repeat(200)}`, `hello ${"z".repeat(112)}`],
    ];
    for (const [input, want] of cases) {
      expect(normalizeMediaFilename(input), input.slice(0, 12)).toBe(want);
    }
  });

  test("a NUL is caught in every table that carries text, not only notes", async () => {
    const SQL = await getSql();
    // cards.data and col.conf, neither of which the notes fixture touches.
    const inCards = legacyPackage(SQL, (db) => {
      db.run(`INSERT INTO col VALUES (1,1,1,1,11,0,-1,0,'{}','{}','{}','{}','{}')`);
      db.run(
        `INSERT INTO cards VALUES (1,1,1,0,1,0,0,0,0,0,0,0,0,0,0,0,0,CAST(x'6100620063' AS TEXT))`,
      );
    });
    expect(() => readPackage(inCards, SQL)).toThrow(/cards\.data.*NUL/is);

    const inCol = legacyPackage(SQL, (db) => {
      db.run(
        `INSERT INTO col VALUES (1,1,1,1,11,0,-1,0,CAST(x'6100620063' AS TEXT),'{}','{}','{}','{}')`,
      );
    });
    expect(() => readPackage(inCol, SQL)).toThrow(/col\.conf.*NUL/is);
  });

  test("the ease repair follows odid, skips new cards, and marks the change", async () => {
    const SQL = await getSql();
    const bytes = legacyPackage(SQL, (db) => {
      const models = {
        1000: {
          id: 1000,
          name: "M",
          type: 0,
          flds: [{ name: "F", ord: 0 }],
          tmpls: [{ name: "C", ord: 0, qfmt: "{{F}}" }],
        },
      };
      // Deck 2000 uses the broken preset; deck 3000 uses a healthy one.
      const decks = {
        2000: { id: 2000, name: "Broken", dyn: 0, conf: 1 },
        3000: { id: 3000, name: "Healthy", dyn: 0, conf: 2 },
      };
      const preset = (id: number, factor: number): string =>
        `"${id}":{"id":${id},"mod":0,"name":"P${id}","usn":0,"maxTaken":60,` +
        `"new":{"delays":[1,10],"initialFactor":${factor},"ints":[1,4],"order":1,"perDay":20},` +
        `"rev":{"ease4":1.3,"ivlFct":1,"maxIvl":36500,"perDay":200},` +
        `"lapse":{"delays":[10],"leechAction":1,"leechFails":8,"minInt":1,"mult":0}}`;
      db.run(`INSERT INTO col VALUES (1,1,1,1,11,0,-1,0,'{}',?,?,?,'{}')`, [
        JSON.stringify(models),
        JSON.stringify(decks),
        `{${preset(1, 1300)},${preset(2, 2500)}}`,
      ]);
      db.run(`INSERT INTO notes VALUES (1,'g',1000,1,-1,'','x','x',1,0,'')`);
      // In the healthy deck now, but its home deck is the broken one.
      db.run(`INSERT INTO cards VALUES (1,1,3000,0,1,7,2,2,500,40,1300,12,2,0,0,2000,0,'')`);
      // A brand new card in the broken deck: factor 0 must stay 0.
      db.run(`INSERT INTO cards VALUES (2,1,2000,1,1,7,0,0,0,0,0,0,0,0,0,0,0,'')`);
      // Already above the cap, so untouched.
      db.run(`INSERT INTO cards VALUES (3,1,2000,2,1,7,2,2,500,40,2100,12,2,0,0,0,0,'')`);
    });

    const { data } = readPackage(bytes, SQL);
    const byId = new Map(data.cards.map((c) => [c.id, c]));
    expect(byId.get(1)?.factor, "reached through odid").toBe(2500);
    expect(byId.get(1)?.usn, "repair is marked unsynced").toBe(-1);
    expect(byId.get(2)?.factor, "a new card keeps factor 0").toBe(0);
    expect(byId.get(2)?.usn, "and is left alone").toBe(7);
    expect(byId.get(3)?.factor, "above the cap").toBe(2100);
  });

  test("the unassigned table is inclusive at both ends of a range", () => {
    // U+0378 and U+0379 open a range; U+037A is the assigned code point after it.
    expect(isUnassignedForAnki(0x0378)).toBe(true);
    expect(isUnassignedForAnki(0x0379)).toBe(true);
    expect(isUnassignedForAnki(0x037a)).toBe(false);
    expect(isUnassignedForAnki(0x0377)).toBe(false);
    // The last range runs to the end of the code space.
    expect(isUnassignedForAnki(0x10ffff)).toBe(true);
  });
});

describe("reading a schema 11 col row", () => {
  for (const [column, index] of [
    ["conf", 0],
    ["models", 1],
    ["decks", 2],
    ["dconf", 3],
  ] as const) {
    test(`a damaged col.${column} is refused rather than read as empty`, async () => {
      const SQL = await getSql();
      const columns = ["{}", "{}", "{}", "{}"];
      columns[index] = "{not json";
      const bytes = legacyPackage(SQL, (db) => {
        db.run(`INSERT INTO col VALUES (1, 1, 1, 1, 11, 0, -1, 0, ?, ?, ?, ?, '{}')`, columns);
      });
      expect(() => readPackage(bytes, SQL)).toThrow(new RegExp(column));
    });
  }
});

describe("a damaged file fails with a code, not a dependency's message", () => {
  const codeOfRead = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      if (error instanceof AnkipackError) return error.code;
      return `not an AnkipackError: ${String(error)}`;
    }
    return "did not throw";
  };

  test("a truncated collection payload is reported as invalid-package", async () => {
    const SQL = await getSql();
    const pkg = new Package();
    const deck = new Deck({ name: "D" });
    deck.addNote(new Note({ notetype: Notetype.basic(), fields: ["a", "b"] }));
    pkg.addDeck(deck);
    const entries = unzipSync(await pkg.toUint8Array(SQL));
    entries["collection.anki21b"] = new Uint8Array([1, 2, 3, 4, 5]);
    expect(codeOfRead(() => readPackage(zipSync(entries), SQL))).toBe("invalid-package");
  });

  test("a collection payload that is not a database is reported as invalid-package", async () => {
    const SQL = await getSql();
    const bytes = zipSync({
      meta: new Uint8Array([0x08, 0x03]),
      "collection.anki21b": zstdRawFrame(strToU8("not a database at all")),
    });
    expect(codeOfRead(() => readPackage(bytes, SQL))).toBe("invalid-package");
  });

  test("a damaged meta record is reported as invalid-package", async () => {
    const SQL = await getSql();
    const bytes = zipSync({
      meta: new Uint8Array([0xff, 0xff, 0xff]),
      "collection.anki21b": new Uint8Array([0]),
    });
    expect(codeOfRead(() => readPackage(bytes, SQL))).toBe("invalid-package");
  });

  test("a legacy media index that is not JSON is reported as invalid-package", async () => {
    const SQL = await getSql();
    const bytes = legacyPackage(SQL, (db) => {
      db.run(`INSERT INTO col VALUES (1, 1, 1, 1, 11, 0, -1, 0, '{}', '{}', '{}', '{}', '{}')`);
    });
    const entries = unzipSync(bytes);
    entries["media"] = strToU8("{not json");
    expect(codeOfRead(() => readPackage(zipSync(entries), SQL))).toBe("invalid-package");
  });

  test("a legacy media index whose name is not a string is reported as invalid-package", async () => {
    const SQL = await getSql();
    const bytes = legacyPackage(SQL, (db) => {
      db.run(`INSERT INTO col VALUES (1, 1, 1, 1, 11, 0, -1, 0, '{}', '{}', '{}', '{}', '{}')`);
    });
    const entries = unzipSync(bytes);
    entries["media"] = strToU8('{"0": 12345}');
    entries["0"] = new Uint8Array([1]);
    expect(codeOfRead(() => readPackage(zipSync(entries), SQL))).toBe("invalid-package");
  });
});

describe("a package declaring the unicase collation in any casing still opens", () => {
  /**
   * Declares `tags.tag` with the given collation spelling, the way a real
   * collection carries it. sql.js refuses an unknown collation in a CREATE, so
   * it goes in through `sqlite_master`, which is where Anki's own file has it.
   */
  async function packageDeclaring(spelling: string): Promise<Uint8Array> {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Probe" });
    const deck = new Deck({ name: "D" });
    deck.addNote(new Note({ notetype, fields: ["a", "b"] }));
    const pkg = new Package();
    pkg.addDeck(deck);

    const entries = unzipSync(await pkg.toUint8Array(SQL));
    const db = new SQL.Database(decompress(entries["collection.anki21b"]));
    db.run("PRAGMA writable_schema = ON");
    db.run(
      "UPDATE sqlite_master SET sql = replace(sql, 'tag text NOT NULL', ?) WHERE name = 'tags'",
      [`tag text NOT NULL ${spelling}`],
    );
    db.run("PRAGMA writable_schema = OFF");
    const bytes = db.export();
    db.close();

    entries["collection.anki21b"] = zstdRawFrame(bytes);
    return zipSync(entries);
  }

  for (const spelling of ["COLLATE unicase", "collate unicase", "COLLATE UNICASE"]) {
    test(`\`${spelling}\` is stripped`, async () => {
      const SQL = await getSql();
      expect(readPackage(await packageDeclaring(spelling), SQL).data.notes).toHaveLength(1);
    });
  }
});

describe("names Anki rewrites on import must be refused, not shipped", () => {
  // `prepare_for_update` runs `normalize_names` on every imported note type
  // (rslib/src/notetype/mod.rs), NFC-normalising the note type, field and
  // template names. Template bodies are never normalised, so an NFD field name
  // and its NFD reference come apart and every card renders
  // "Found '{{Cafe}}', but there is no field called 'Cafe'".
  const NFD = "Cafe\u0301";
  const NFC = "Caf\u00e9";

  test("an NFD field name is refused", () => {
    expect(
      () =>
        new Notetype({
          name: "NFD Field",
          fields: [{ name: NFD }, { name: "Back" }],
          templates: [{ name: "Card 1", questionFormat: `{{${NFD}}}`, answerFormat: "{{Back}}" }],
        }),
    ).toThrow(/normalis|nfc/i);
  });

  test("an NFD note type name is refused", () => {
    expect(
      () =>
        new Notetype({
          name: NFD,
          fields: [{ name: "Front" }, { name: "Back" }],
          templates: [{ name: "Card 1", questionFormat: "{{Front}}", answerFormat: "{{Back}}" }],
        }),
    ).toThrow(/normalis|nfc/i);
  });

  test("an NFD template name is refused", () => {
    expect(
      () =>
        new Notetype({
          name: "NFD Template",
          fields: [{ name: "Front" }, { name: "Back" }],
          templates: [{ name: NFD, questionFormat: "{{Front}}", answerFormat: "{{Back}}" }],
        }),
    ).toThrow(/normalis|nfc/i);
  });

  test("the same name already in NFC is accepted", () => {
    expect(
      () =>
        new Notetype({
          name: NFC,
          fields: [{ name: NFC }, { name: "Back" }],
          templates: [{ name: "Card 1", questionFormat: `{{${NFC}}}`, answerFormat: "{{Back}}" }],
        }),
    ).not.toThrow();
  });

  // Anki trims with `char::is_whitespace`, which JavaScript's /\s/ does not
  // agree with: U+0085 is whitespace to Rust and not to JS, U+FEFF the reverse.
  test("a field name padded with U+0085 is refused, because Anki trims it", () => {
    expect(
      () =>
        new Notetype({
          name: "NEL Pad",
          fields: [{ name: "\u0085Front" }, { name: "Back" }],
          templates: [
            { name: "Card 1", questionFormat: `{{\u0085Front}}`, answerFormat: "{{Back}}" },
          ],
        }),
    ).toThrow(/whitespace|space/i);
  });

  test("a field name padded with U+FEFF is accepted, because Anki keeps it", () => {
    expect(
      () =>
        new Notetype({
          name: "BOM Pad",
          fields: [{ name: "\ufeffFront" }, { name: "Back" }],
          templates: [
            { name: "Card 1", questionFormat: `{{\ufeffFront}}`, answerFormat: "{{Back}}" },
          ],
        }),
    ).not.toThrow();
  });
});

describe("a builder type must not share the caller's arrays", () => {
  test("mutating the fields array after construction does not reach the note type", () => {
    const fields = [{ name: "Front" }, { name: "Back" }];
    const notetype = new Notetype({
      name: "Shared Fields",
      fields,
      templates: [{ name: "Card 1", questionFormat: "{{Front}}", answerFormat: "{{Back}}" }],
    });
    fields.push({ name: "Bad:Name" });
    expect(notetype.fields).toHaveLength(2);
  });

  test("mutating the templates array after construction does not reach the note type", () => {
    const templates = [{ name: "Card 1", questionFormat: "{{Front}}", answerFormat: "{{Back}}" }];
    const notetype = new Notetype({
      name: "Shared Templates",
      fields: [{ name: "Front" }, { name: "Back" }],
      templates,
    });
    templates.push({ name: "Card 2", questionFormat: "{{Back}}", answerFormat: "{{Front}}" });
    expect(notetype.templates).toHaveLength(1);
  });
});

describe("renameDeck keeps subdecks under their renamed parent", () => {
  // A fold that changes length (ss for the sharp s) leaves the child's stored
  // name and the folded parent different lengths, so the child has to be
  // rebuilt from components. Anki does the same in rslib/src/decks/name.rs
  // `reparent`.
  test("a parent whose fold changes length keeps its children intact", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Probe" });
    const parent = new Deck({ name: "Straße" });
    parent.addNote(new Note({ notetype, fields: ["a", "b"] }));
    const pkg = new Package();
    pkg.addDeck(parent);
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);

    // Stored under the folded spelling, which Anki's unicase index reads as
    // the same parent.
    const template = col.data.decks[col.data.decks.length - 1];
    col.data.decks.push({
      ...template,
      id: 9_999_001,
      name: `Strasse${String.fromCharCode(0x1f)}kid`,
    });

    col.renameDeck("Straße", "X");
    expect(col.deckNames().sort()).toEqual(["X", "X::kid"]);
  });
});
