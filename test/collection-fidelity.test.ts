import { describe, test, expect } from "bun:test";
import { readPackage } from "../src/collection/read";
import { writePackage } from "../src/collection/write";
import type { CollectionData } from "../src/collection/data";
import { getSql } from "./helpers/collection";
import { FIELD_SEPARATOR as SEP } from "../src/util/constants";

// The fixtures only ever produce new cards and no history, so they cannot
// catch a dropped scheduling column. This builds a collection where every
// table has rows and every column holds a value distinguishable from its
// default, then asserts the round trip returns it unchanged.

function populated(): CollectionData {
  return {
    col: {
      id: 1,
      crt: 1_600_000_000,
      mod: 1_700_000_000_123,
      scm: 1_650_000_000_456,
      ver: 18,
      dty: 0,
      usn: 42,
      ls: 1_690_000_000_789,
      conf: '{"curDeck":3,"userSetting":"keep me"}',
      models: "{}",
      decks: "{}",
      dconf: "{}",
      tags: "{}",
    },
    notes: [
      {
        id: 1_600_000_001_000,
        guid: "guid-one",
        mid: 1_600_000_100_000,
        mod: 1_690_000_001,
        usn: 7,
        tags: " leech marked ",
        flds: `front${SEP}back`,
        sfld: "front",
        csum: 3_079_402_277,
        flags: 3,
        data: '{"pos":1}',
      },
      // sfld is declared integer, so a numeric sort field round trips as one.
      {
        id: 1_600_000_002_000,
        guid: "guid-two",
        mid: 1_600_000_100_000,
        mod: 1_690_000_002,
        usn: -1,
        tags: "",
        flds: `12345${SEP}other`,
        sfld: 12345,
        csum: 1_234_567,
        flags: 0,
        data: "",
      },
    ],
    cards: [
      // A card mid-review: every scheduling column set to something a fresh
      // card would not have.
      {
        id: 1_600_000_003_000,
        nid: 1_600_000_001_000,
        did: 1_600_000_200_000,
        ord: 0,
        mod: 1_690_000_003,
        usn: 9,
        type: 2,
        queue: 2,
        due: 812,
        ivl: 47,
        factor: 2350,
        reps: 19,
        lapses: 4,
        left: 1001,
        odue: 305,
        odid: 1_600_000_201_000,
        flags: 2,
        data: '{"pos":7,"s":12.5}',
      },
      {
        id: 1_600_000_004_000,
        nid: 1_600_000_002_000,
        did: 1_600_000_200_000,
        ord: 1,
        mod: 1_690_000_004,
        usn: -1,
        type: 0,
        queue: 0,
        due: 3,
        ivl: 0,
        factor: 0,
        reps: 0,
        lapses: 0,
        left: 0,
        odue: 0,
        odid: 0,
        flags: 0,
        data: "",
      },
    ],
    revlog: [
      {
        id: 1_690_000_005_000,
        cid: 1_600_000_003_000,
        usn: 11,
        ease: 3,
        ivl: 47,
        lastIvl: 21,
        factor: 2350,
        time: 8400,
        type: 1,
      },
      {
        id: 1_690_000_006_000,
        cid: 1_600_000_003_000,
        usn: -1,
        ease: 1,
        ivl: -60,
        lastIvl: 47,
        factor: 2150,
        time: 21000,
        type: 0,
      },
    ],
    graves: [
      { oid: 1_600_000_009_000, type: 0, usn: 5 },
      { oid: 1_600_000_010_000, type: 1, usn: -1 },
    ],
    deckConfig: [
      {
        id: 1,
        name: "Default",
        mtimeSecs: 1_690_000_007,
        usn: 3,
        config: new Uint8Array([8, 20, 16, 200, 1]),
      },
    ],
    config: [
      { key: "curDeck", usn: 2, mtimeSecs: 1_690_000_008, val: new TextEncoder().encode("3") },
      {
        key: "sortType",
        usn: -1,
        mtimeSecs: 1_690_000_009,
        val: new TextEncoder().encode('"noteFld"'),
      },
    ],
    tags: [
      { tag: "leech", usn: 4, collapsed: true, config: new Uint8Array([10, 3, 97, 98, 99]) },
      { tag: "marked", usn: -1, collapsed: false, config: null },
    ],
    notetypes: [
      {
        id: 1_600_000_100_000,
        name: "Basic",
        mtimeSecs: 1_690_000_010,
        usn: 6,
        config: new Uint8Array([16, 1, 26, 5, 104, 101, 108, 108, 111]),
      },
    ],
    fields: [
      { ntid: 1_600_000_100_000, ord: 0, name: "Front", config: new Uint8Array([16, 20]) },
      { ntid: 1_600_000_100_000, ord: 1, name: "Back", config: new Uint8Array([16, 24]) },
    ],
    templates: [
      {
        ntid: 1_600_000_100_000,
        ord: 0,
        name: "Card 1",
        mtimeSecs: 1_690_000_011,
        usn: 8,
        config: new Uint8Array([10, 2, 113, 102]),
      },
      {
        ntid: 1_600_000_100_000,
        ord: 1,
        name: "Card 2",
        mtimeSecs: 1_690_000_012,
        usn: -1,
        config: new Uint8Array([10, 2, 113, 103]),
      },
    ],
    decks: [
      {
        id: 1_600_000_200_000,
        name: `Parent${SEP}Child`,
        mtimeSecs: 1_690_000_013,
        usn: 10,
        common: new Uint8Array([8, 1]),
        kind: new Uint8Array([10, 2, 8, 1]),
      },
      {
        id: 1_600_000_201_000,
        name: "Filtered",
        mtimeSecs: 1_690_000_014,
        usn: -1,
        common: new Uint8Array([8, 0]),
        kind: new Uint8Array([18, 2, 8, 1]),
      },
    ],
    media: [
      { name: "diagram.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) },
      // NFC, and written as an escape: Anki refuses the whole archive for a
      // media name that is not already normalised.
      { name: "\u00e4.mp3", data: new Uint8Array(300).fill(0x41) },
    ],
  };
}

describe("every column survives a round trip", () => {
  test("the whole collection compares equal", async () => {
    const SQL = await getSql();
    const before = populated();
    const after = readPackage(await writePackage(before, SQL), SQL).data;
    expect(after).toEqual(before);
  });

  // Table by table, so a failure names the table that lost something.
  const TABLES = [
    "col",
    "notes",
    "cards",
    "revlog",
    "graves",
    "deckConfig",
    "config",
    "tags",
    "notetypes",
    "fields",
    "templates",
    "decks",
    "media",
  ] as const;

  for (const table of TABLES) {
    test(`${table} survives a write and read unchanged`, async () => {
      const SQL = await getSql();
      const before = populated();
      const after = readPackage(await writePackage(before, SQL), SQL).data;
      expect(after[table]).toEqual(before[table]);
    });
  }

  // The specific loss this design exists to prevent.
  test("review history and scheduling state are not zeroed", async () => {
    const SQL = await getSql();
    const before = populated();
    const after = readPackage(await writePackage(before, SQL), SQL).data;

    const card = after.cards.find((c) => c.id === 1_600_000_003_000);
    expect(card).toBeDefined();
    expect(card).toMatchObject({
      type: 2,
      queue: 2,
      ivl: 47,
      factor: 2350,
      reps: 19,
      lapses: 4,
      left: 1001,
      odue: 305,
      odid: 1_600_000_201_000,
    });
    expect(after.revlog.length).toBe(2);
    expect(after.col.conf).toContain("keep me");
  });
});
