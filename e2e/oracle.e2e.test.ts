import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fromBinary } from "@bufbuild/protobuf";
import { Notetype_ConfigSchema } from "../src/generated/anki/notetypes_pb";
import { DeckConfig_ConfigSchema } from "../src/generated/anki/deck_config_pb";
import { Deck_KindContainerSchema } from "../src/generated/anki/decks_pb";
import { readPackage } from "../src/collection/read";
import type { CollectionData } from "../src/collection/data";
import { toHumanDeckName } from "../src/util/text";
import { ankiConvert, ankiExport, oracleAvailable } from "./anki";

// ankipack converts schema 11 on the way in, ported by hand from Anki's own
// From<...Schema11> impls. This checks the port against the only authority
// that matters: Anki converting the same file itself.
//
// Anki reassigns ids and timestamps when it imports, and its exporter leaves
// behind the fields and templates of notetypes it filtered out, so the
// comparison is by content rather than by row.

if (!oracleAvailable()) {
  throw new Error("e2e oracle is not installed. Run `bun run e2e:setup` first.");
}

let SQL: SqlJsStatic;
let ours: CollectionData;
let anki: CollectionData;

beforeAll(async () => {
  SQL = await initSqlJs();
  const dir = mkdtempSync(join(tmpdir(), "ankipack-oracle-"));
  const legacy = join(dir, "legacy.apkg");
  const converted = join(dir, "converted.apkg");

  await ankiExport(legacy, true);
  await ankiConvert(legacy, converted);

  ours = readPackage(await Bun.file(legacy).bytes(), SQL).data;
  anki = readPackage(await Bun.file(converted).bytes(), SQL).data;
});

/** Field and template names of the notetypes that actually exist. */
function notetypeShape(
  d: CollectionData,
): Record<string, { fields: string[]; templates: string[] }> {
  const out: Record<string, { fields: string[]; templates: string[] }> = {};
  for (const nt of d.notetypes) {
    out[nt.name] = {
      fields: d.fields
        .filter((f) => f.ntid === nt.id)
        .sort((a, b) => a.ord - b.ord)
        .map((f) => f.name),
      templates: d.templates
        .filter((t) => t.ntid === nt.id)
        .sort((a, b) => a.ord - b.ord)
        .map((t) => t.name),
    };
  }
  return out;
}

describe("ankipack's schema 11 conversion matches Anki's", () => {
  test("the same note types, with the same fields and templates", () => {
    expect(notetypeShape(ours)).toEqual(notetypeShape(anki));
  });

  test("the same note type configuration", () => {
    for (const nt of ours.notetypes) {
      const theirs = anki.notetypes.find((n) => n.name === nt.name);
      expect(theirs).toBeDefined();
      const a = fromBinary(Notetype_ConfigSchema, nt.config);
      const b = fromBinary(Notetype_ConfigSchema, theirs!.config);
      expect({
        kind: a.kind,
        sortFieldIdx: a.sortFieldIdx,
        css: a.css,
        latexPre: a.latexPre,
      }).toEqual({ kind: b.kind, sortFieldIdx: b.sortFieldIdx, css: b.css, latexPre: b.latexPre });
    }
  });

  test("the same decks", () => {
    expect(ours.decks.map((d) => toHumanDeckName(d.name)).sort()).toEqual(
      anki.decks.map((d) => toHumanDeckName(d.name)).sort(),
    );
  });

  test("the same deck descriptions and preset links", () => {
    for (const deck of ours.decks) {
      const theirs = anki.decks.find((d) => d.name === deck.name);
      expect(theirs).toBeDefined();
      const a = fromBinary(Deck_KindContainerSchema, deck.kind);
      const b = fromBinary(Deck_KindContainerSchema, theirs!.kind);
      expect(a.kind.case).toBe(b.kind.case);
      if (a.kind.case === "normal" && b.kind.case === "normal") {
        expect(a.kind.value.description).toBe(b.kind.value.description);
      }
    }
  });

  test("the same presets, with the same scheduling values", () => {
    expect(ours.deckConfig.map((c) => c.name).sort()).toEqual(
      anki.deckConfig.map((c) => c.name).sort(),
    );
    for (const preset of ours.deckConfig) {
      const theirs = anki.deckConfig.find((c) => c.name === preset.name);
      expect(theirs).toBeDefined();
      const a = fromBinary(DeckConfig_ConfigSchema, preset.config);
      const b = fromBinary(DeckConfig_ConfigSchema, theirs!.config);
      const compared = (c: typeof a) => ({
        learnSteps: c.learnSteps,
        relearnSteps: c.relearnSteps,
        newPerDay: c.newPerDay,
        reviewsPerDay: c.reviewsPerDay,
        initialEase: c.initialEase,
        easyMultiplier: c.easyMultiplier,
        hardMultiplier: c.hardMultiplier,
        lapseMultiplier: c.lapseMultiplier,
        intervalMultiplier: c.intervalMultiplier,
        maximumReviewInterval: c.maximumReviewInterval,
        minimumLapseInterval: c.minimumLapseInterval,
        graduatingIntervalGood: c.graduatingIntervalGood,
        graduatingIntervalEasy: c.graduatingIntervalEasy,
        leechThreshold: c.leechThreshold,
        leechAction: c.leechAction,
        capAnswerTimeToSecs: c.capAnswerTimeToSecs,
        newCardInsertOrder: c.newCardInsertOrder,
        buryNew: c.buryNew,
        buryReviews: c.buryReviews,
        disableAutoplay: c.disableAutoplay,
        showTimer: c.showTimer,
        skipQuestionWhenReplayingAnswer: c.skipQuestionWhenReplayingAnswer,
      });
      expect(compared(a)).toEqual(compared(b));
    }
  });

  test("the same notes, by content rather than by id", () => {
    const shape = (d: CollectionData) =>
      d.notes
        .map((n) => ({ guid: n.guid, flds: n.flds, tags: n.tags, sfld: n.sfld }))
        .sort((x, y) => x.guid.localeCompare(y.guid));
    expect(shape(ours)).toEqual(shape(anki));
  });

  test("the same cards, by ordinal per note", () => {
    const shape = (d: CollectionData) => {
      const guidOf = new Map(d.notes.map((n) => [n.id, n.guid]));
      return d.cards.map((c) => `${guidOf.get(c.nid) ?? "?"}#${c.ord}`).sort();
    };
    expect(shape(ours)).toEqual(shape(anki));
  });
});
