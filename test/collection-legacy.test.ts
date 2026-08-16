import { describe, test, expect } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { fromBinary } from "@bufbuild/protobuf";
import { DeckConfig_ConfigSchema } from "../src/generated/anki/deck_config_pb";
import { Deck_KindContainerSchema, Deck_CommonSchema } from "../src/generated/anki/decks_pb";
import {
  Notetype_ConfigSchema,
  Notetype_Field_ConfigSchema,
  Notetype_Template_ConfigSchema,
} from "../src/generated/anki/notetypes_pb";
import { readPackage } from "../src/collection/read";
import { Collection } from "../src/index";
import { FIELD_SEPARATOR } from "../src/util/constants";
import { getSql } from "./helpers/collection";
import { legacyPackage as buildLegacy, SCHEMA_11_SQL } from "./helpers/legacy";

const NOTETYPE_ID = 1600000100000;
const DECK_ID = 1600000200000;
const NOTE_ID = 1600000001000;
const CARD_ID = 1600000003000;

const MODELS = {
  [NOTETYPE_ID]: {
    id: NOTETYPE_ID,
    name: "Legacy Basic",
    type: 0,
    mod: 1690000010,
    usn: -1,
    sortf: 1,
    did: DECK_ID,
    css: ".card { color: red; }",
    latexPre: "\\documentclass{article}",
    latexPost: "\\end{document}",
    latexsvg: true,
    req: [[0, "any", [0]]],
    // A key ankipack does not model, which must survive into `other`.
    vendorExtension: { keep: "me" },
    flds: [
      {
        name: "Front",
        ord: 0,
        sticky: true,
        rtl: false,
        font: "Courier",
        size: 24,
        unknownFieldKey: 7,
      },
      { name: "Back", ord: 1, sticky: false, rtl: true, font: "Arial", size: 20 },
    ],
    tmpls: [
      {
        name: "Card 1",
        ord: 0,
        qfmt: "{{Front}}",
        afmt: "{{FrontSide}}<hr id=answer>{{Back}}",
        bqfmt: "",
        bafmt: "",
        bfont: "Georgia",
        bsize: 14,
        unknownTemplateKey: true,
      },
    ],
  },
};

const DECKS = {
  [DECK_ID]: {
    id: DECK_ID,
    name: "Languages::French",
    mod: 1690000013,
    usn: -1,
    collapsed: true,
    browserCollapsed: false,
    desc: "Chapter one",
    dyn: 0,
    conf: 1700000000042,
    extendNew: 5,
    extendRev: 7,
    newToday: [0, 0],
    revToday: [0, 0],
    lrnToday: [0, 0],
    timeToday: [0, 0],
  },
};

const DCONF = {
  1: {
    id: 1,
    name: "Legacy Preset",
    mod: 1690000007,
    usn: -1,
    maxTaken: 45,
    autoplay: false,
    timer: 1,
    replayq: false,
    dyn: false,
    new: {
      bury: true,
      delays: [1, 10],
      initialFactor: 2300,
      ints: [2, 5, 0],
      order: 0,
      perDay: 33,
    },
    rev: { bury: true, ease4: 1.4, ivlFct: 1.1, maxIvl: 1000, perDay: 88, hardFactor: 1.25 },
    lapse: { delays: [12], leechAction: 0, leechFails: 9, minInt: 3, mult: 0.5 },
    desiredRetention: 0.93,
    stopTimerOnAnswer: true,
    unknownPresetKey: "kept",
  },
  // A preset other than Default, so a deck bound to it proves `conf` is read
  // rather than defaulted.
  1700000000042: {
    id: 1700000000042,
    name: "Chapter Preset",
    mod: 1690000007,
    usn: -1,
  },
};

function legacyPackage(SQL: Awaited<ReturnType<typeof getSql>>): Uint8Array {
  return buildLegacy(
    SQL,
    (db) => {
      db.run(
        `INSERT INTO col VALUES (1, 1600000000, 1700000000123, 1650000000456, 11, 0, -1, 0,
          ?, ?, ?, ?, ?)`,
        [
          '{"curDeck":1,"userSetting":"keep me","schedVer":2,"sortType":"noteFld"}',
          JSON.stringify(MODELS),
          JSON.stringify(DECKS),
          JSON.stringify(DCONF),
          '{"leech":-1,"verb":5}',
        ],
      );
      db.run(
        `INSERT INTO notes VALUES (?, 'legacy-guid', ?, 1690000001, -1, ' verb ', ?, 'chien', 12345, 0, '')`,
        [NOTE_ID, NOTETYPE_ID, `chien${FIELD_SEPARATOR}dog`],
      );
      db.run(
        `INSERT INTO cards VALUES (?, ?, ?, 0, 1690000003, 5, 2, 2, 500, 40, 2300, 12, 2, 0, 0, 0, 0, '')`,
        [CARD_ID, NOTE_ID, DECK_ID],
      );
      db.run(`INSERT INTO revlog VALUES (1690000005000, ?, 5, 3, 40, 20, 2300, 7000, 1)`, [
        CARD_ID,
      ]);
      db.run(`INSERT INTO graves VALUES (999, 1, 5)`);
    },
    {
      "0": new Uint8Array([1, 2, 3]),
      media: strToU8(JSON.stringify({ "0": "legacy.png" })),
    },
  );
}

describe("reading a schema 11 package", () => {
  test("the tables that exist in both schemas come across untouched", async () => {
    const SQL = await getSql();
    const { data } = readPackage(legacyPackage(SQL), SQL);

    expect(data.col.ver).toBe(18);
    expect(data.notes.length).toBe(1);
    expect(data.notes[0].flds).toBe(`chien${FIELD_SEPARATOR}dog`);
    expect(data.cards.length).toBe(1);
    // The scheduling state a legacy file carries must not be reset by the upgrade.
    expect(data.cards[0]).toMatchObject({ type: 2, queue: 2, ivl: 40, factor: 2300, reps: 12 });
    expect(data.revlog.length).toBe(1);
    expect(data.graves).toEqual([{ oid: 999, type: 1, usn: 5 }]);
    expect(data.media).toEqual([{ name: "legacy.png", data: new Uint8Array([1, 2, 3]) }]);
  });

  test("notetype JSON becomes notetype, field and template rows", async () => {
    const SQL = await getSql();
    const { data } = readPackage(legacyPackage(SQL), SQL);

    expect(data.notetypes.length).toBe(1);
    expect(data.notetypes[0]).toMatchObject({ id: NOTETYPE_ID, name: "Legacy Basic" });

    const config = fromBinary(Notetype_ConfigSchema, data.notetypes[0].config);
    expect(config.sortFieldIdx).toBe(1);
    expect(config.css).toBe(".card { color: red; }");
    expect(config.latexSvg).toBe(true);
    expect(config.reqs.map((r) => ({ ord: r.cardOrd, kind: r.kind, ords: r.fieldOrds }))).toEqual([
      { ord: 0, kind: 1, ords: [0] },
    ]);

    expect(data.fields.map((f) => f.name)).toEqual(["Front", "Back"]);
    const front = fromBinary(Notetype_Field_ConfigSchema, data.fields[0].config);
    expect(front).toMatchObject({ sticky: true, rtl: false, fontName: "Courier", fontSize: 24 });
    const back = fromBinary(Notetype_Field_ConfigSchema, data.fields[1].config);
    expect(back.rtl).toBe(true);

    expect(data.templates.map((t) => t.name)).toEqual(["Card 1"]);
    const tmpl = fromBinary(Notetype_Template_ConfigSchema, data.templates[0].config);
    expect(tmpl.qFormat).toBe("{{Front}}");
    expect(tmpl.browserFontName).toBe("Georgia");
    expect(tmpl.browserFontSize).toBe(14);
  });

  test("keys ankipack does not model are kept in the protobuf `other` field", async () => {
    const SQL = await getSql();
    const { data } = readPackage(legacyPackage(SQL), SQL);
    const decode = (bytes: Uint8Array): unknown =>
      JSON.parse(new TextDecoder().decode(bytes)) as unknown;

    expect(decode(fromBinary(Notetype_ConfigSchema, data.notetypes[0].config).other)).toEqual({
      vendorExtension: { keep: "me" },
    });
    expect(decode(fromBinary(Notetype_Field_ConfigSchema, data.fields[0].config).other)).toEqual({
      unknownFieldKey: 7,
    });
    expect(
      decode(fromBinary(Notetype_Template_ConfigSchema, data.templates[0].config).other),
    ).toEqual({ unknownTemplateKey: true });
    expect(decode(fromBinary(DeckConfig_ConfigSchema, data.deckConfig[0].config).other)).toEqual({
      unknownPresetKey: "kept",
    });
  });

  test("deck JSON becomes a deck row with the machine name", async () => {
    const SQL = await getSql();
    const { data } = readPackage(legacyPackage(SQL), SQL);

    expect(data.decks.length).toBe(1);
    // Schema 11 stores the human name; schema 18 stores U+001F components.
    expect(data.decks[0].name).toBe(`Languages${FIELD_SEPARATOR}French`);

    const common = fromBinary(Deck_CommonSchema, data.decks[0].common);
    expect(common.studyCollapsed).toBe(true);

    const kind = fromBinary(Deck_KindContainerSchema, data.decks[0].kind);
    expect(kind.kind.case).toBe("normal");
    if (kind.kind.case !== "normal") throw new Error("expected a normal deck");
    expect(kind.kind.value.description).toBe("Chapter one");
    expect(kind.kind.value.extendNew).toBe(5);
    expect(kind.kind.value.extendReview).toBe(7);
    expect(Number(kind.kind.value.configId)).toBe(1700000000042);
  });

  test("preset JSON becomes a deck_config row with the nested values flattened", async () => {
    const SQL = await getSql();
    const { data } = readPackage(legacyPackage(SQL), SQL);

    expect(data.deckConfig.map((c) => c.name)).toEqual(["Legacy Preset", "Chapter Preset"]);

    const config = fromBinary(DeckConfig_ConfigSchema, data.deckConfig[0].config);
    expect(config.learnSteps).toEqual([1, 10]);
    expect(config.relearnSteps).toEqual([12]);
    expect(config.newPerDay).toBe(33);
    expect(config.reviewsPerDay).toBe(88);
    expect(config.buryNew).toBe(true);
    expect(config.buryReviews).toBe(true);
    // initial_factor is per-mille in schema 11.
    expect(config.initialEase).toBeCloseTo(2.3, 5);
    expect(config.easyMultiplier).toBeCloseTo(1.4, 5);
    expect(config.hardMultiplier).toBeCloseTo(1.25, 5);
    expect(config.lapseMultiplier).toBeCloseTo(0.5, 5);
    expect(config.intervalMultiplier).toBeCloseTo(1.1, 5);
    expect(config.maximumReviewInterval).toBe(1000);
    expect(config.minimumLapseInterval).toBe(3);
    expect(config.graduatingIntervalGood).toBe(2);
    expect(config.graduatingIntervalEasy).toBe(5);
    expect(config.leechThreshold).toBe(9);
    expect(config.leechAction).toBe(0);
    expect(config.capAnswerTimeToSecs).toBe(45);
    expect(config.showTimer).toBe(true);
    expect(config.stopTimerOnAnswer).toBe(true);
    expect(config.desiredRetention).toBeCloseTo(0.93, 5);
    // The enums are inverted: schema 11 is Random=0, Due=1; the proto is
    // Due=0, Random=1. The fixture says 0, so the result must be 1.
    expect(config.newCardInsertOrder).toBe(1);
    // Anki stores the inverse of these two.
    expect(config.disableAutoplay).toBe(true);
    expect(config.skipQuestionWhenReplayingAnswer).toBe(true);
  });

  test("the col JSON columns are emptied, as Anki's own upgrade leaves them", async () => {
    const SQL = await getSql();
    const { data } = readPackage(legacyPackage(SQL), SQL);
    expect(data.col.models).toBe("");
    expect(data.col.decks).toBe("");
    expect(data.col.dconf).toBe("");
    expect(data.col.tags).toBe("");
    expect(data.col.conf).toBe("");
  });

  // Nothing reads col.conf at schema 18. Anki's upgrade_config_to_schema14
  // splits it into one row per key and then blanks the column. Leaving the
  // JSON there loses every setting in it, and `schedVer` is one of them:
  // absent, Anki treats the collection as v1 and reruns its v1-to-v2 upgrade
  // over cards that are already v2.
  test("col.conf becomes config rows rather than staying as JSON", async () => {
    const SQL = await getSql();
    const { data } = readPackage(legacyPackage(SQL), SQL);

    const asJson = (key: string): unknown => {
      const row = data.config.find((c) => c.key === key);
      expect(row).toBeDefined();
      return JSON.parse(new TextDecoder().decode(row!.val)) as unknown;
    };

    expect(data.config.map((c) => c.key).sort()).toEqual([
      "curDeck",
      "schedVer",
      "sortType",
      "userSetting",
    ]);
    expect(asJson("schedVer")).toBe(2);
    expect(asJson("curDeck")).toBe(1);
    expect(asJson("userSetting")).toBe("keep me");
    expect(asJson("sortType")).toBe("noteFld");
  });

  test("col.tags becomes tag rows", async () => {
    const SQL = await getSql();
    const { data } = readPackage(legacyPackage(SQL), SQL);
    // Verified against Anki 26.08.1: its own 11 to 18 upgrade writes collapsed 1,
    // because `Tag::new` leaves `expanded` false and `register_tag` binds `!expanded`.
    expect(data.tags).toEqual([
      { tag: "leech", usn: -1, collapsed: true, config: null },
      { tag: "verb", usn: 5, collapsed: true, config: null },
    ]);
  });

  test("a filtered deck is refused rather than half-converted", async () => {
    const SQL = await getSql();
    const db = new SQL.Database();
    let bytes: Uint8Array;
    try {
      db.run(SCHEMA_11_SQL);
      db.run(`INSERT INTO col VALUES (1, 1, 1, 1, 11, 0, -1, 0, '{}', '{}', ?, '{}', '{}')`, [
        JSON.stringify({ 5: { id: 5, name: "Cram", mod: 1, usn: -1, collapsed: false, dyn: 1 } }),
      ]);
      bytes = zipSync({ "collection.anki2": db.export(), media: strToU8("{}") });
    } finally {
      db.close();
    }
    expect(() => readPackage(bytes, SQL)).toThrow(/filtered deck/);
  });
});

describe("a legacy package can be edited and written back as the latest format", () => {
  test("read, edit, save, reopen", async () => {
    const SQL = await getSql();
    const col = Collection.open(legacyPackage(SQL), SQL);

    expect(col.deckNames()).toEqual(["Languages::French"]);
    const note = col.notes()[0];
    expect(note.fields).toEqual(["chien", "dog"]);

    await note.setField("Back", "hound");

    const reopened = Collection.open(await col.toUint8Array(SQL), SQL);
    const reread = reopened.notes()[0];
    expect(reread.fields).toEqual(["chien", "hound"]);
    // The upgrade and the edit must both leave the review history alone.
    expect(reopened.data.revlog.length).toBe(1);
    expect(reopened.data.cards[0]).toMatchObject({ ivl: 40, factor: 2300, reps: 12 });
    expect(reopened.data.media).toEqual([{ name: "legacy.png", data: new Uint8Array([1, 2, 3]) }]);
  });
});
