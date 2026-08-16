import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { DeckConfig_ConfigSchema } from "../generated/anki/deck_config_pb.js";
import {
  Deck_CommonSchema,
  Deck_KindContainerSchema,
  Deck_NormalSchema,
  Deck_Normal_DayLimitSchema,
  type Deck_Normal_DayLimit,
} from "../generated/anki/decks_pb.js";
import {
  Notetype_ConfigSchema,
  Notetype_Config_CardRequirementSchema,
  Notetype_Field_ConfigSchema,
  Notetype_Template_ConfigSchema,
} from "../generated/anki/notetypes_pb.js";
import { toNativeDeckName } from "../util/text.js";
import { unicaseKey } from "../util/casefold.js";
import { fail } from "../error.js";
import { stableId } from "../util/id.js";
import { SCHEMA_VERSION } from "./schema.js";
import type {
  CollectionData,
  ConfigRow,
  DeckConfigRow,
  DeckRow,
  FieldRow,
  NotetypeRow,
  TagRow,
  TemplateRow,
} from "./data.js";

/**
 * Converts a schema 11 collection into the document model.
 *
 * Schema 11 keeps notetypes, decks and presets as JSON blobs in the `col` row
 * rather than in tables, so this is a translation rather than a read. It is the
 * only place that knows the older shape.
 *
 * Ported from Anki's own `From<...Schema11>` implementations in
 * rslib/src/{notetype,decks,deckconfig}/schema11.rs.
 */

type Json = Record<string, unknown>;

/** Anki stores JSON keys it does not model in a `bytes other` protobuf field. */
function leftoverKeys(source: Json, reserved: readonly string[]): Json {
  const rest: Json = {};
  for (const [key, value] of Object.entries(source)) {
    if (!reserved.includes(key)) rest[key] = value;
  }
  return rest;
}

/**
 * `safeParse` hands back a bigint for a large `id`, and an add-on can put one
 * under a key ankipack does not model, where it goes straight back out as JSON.
 * Nothing downstream reads those, so they go back to a number rather than
 * aborting the read on a value `JSON.stringify` refuses.
 */
const numberForJson = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? Number(value) : value;

function otherBytes(source: Json, reserved: readonly string[], extra: Json = {}): Uint8Array {
  const rest = { ...leftoverKeys(source, reserved), ...extra };
  return Object.keys(rest).length === 0
    ? new Uint8Array()
    : new TextEncoder().encode(JSON.stringify(rest, numberForJson));
}

/**
 * Anki's uniquing rule: append a suffix until the name is free, comparing
 * without regard to case because its indexes are `COLLATE unicase`. Notetype
 * and deck names take `_`; a template or field name inside a notetype takes
 * `+`, from `Notetype::ensure_names_unique`.
 */
function uniqueName(name: string, used: Set<string>, suffix: "_" | "+"): string {
  let candidate = name;
  while (used.has(unicaseKey(candidate))) candidate += suffix;
  used.add(unicaseKey(candidate));
  return candidate;
}

/** Anki's `normalize_names` runs before uniquing, so a name in NFD collides
 * with the same name in NFC. */
function normalizedName(value: unknown): string {
  return str(value).normalize("NFC");
}

function repairInitialEase(ease: number): number {
  return ease <= 1.3 ? 2.5 : ease;
}

/**
 * The Rust type a key deserializes into, so a value serde could not read takes
 * the same path here that it does there. `lenient` is `default_on_invalid` on
 * the key itself: it survives anything, so only its absence matters.
 */
type FieldKind = "lenient" | "u16" | "u32" | "f32";

const FITS: Record<Exclude<FieldKind, "lenient">, (value: unknown) => boolean> = {
  u16: (value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff,
  u32: (value) =>
    Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff,
  f32: (value) => typeof value === "number" && Number.isFinite(value),
};

/**
 * `new`, `rev` and `lapse` are `default_on_invalid`, so serde replaces the whole
 * struct when any required key is absent or out of range, not just that field:
 * a `rev` missing `perDay` gives Anki's 200, not 0.
 */
function subObject(value: unknown, required: Record<string, FieldKind>, fallback: Json): Json {
  const parsed = obj(value);
  for (const [key, kind] of Object.entries(required)) {
    if (parsed[key] === undefined) return fallback;
    if (kind !== "lenient" && !FITS[kind](parsed[key])) return fallback;
  }
  return parsed;
}

/** `default_on_invalid` on an integer key: unreadable becomes the type's zero. */
const lenientInt = (value: unknown, fallback = 0): number =>
  FITS.u32(value) ? (value as number) : fallback;

/** `default_on_invalid` on an `Option<u32>`: unreadable leaves it unset. */
const lenientOptionalInt = (value: unknown): number | undefined =>
  FITS.u32(value) ? (value as number) : undefined;

/** `Option<DeckId>` with `default_on_invalid`: anything unreadable means none. */
const lenientDeckId = (value: unknown): bigint =>
  typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : 0n;

/** For the handful of values Anki clamps rather than refusing. */
const clampU32 = (value: number): number => Math.min(0xffff_ffff, Math.max(0, Math.trunc(value)));

/**
 * `Value::as_i64()` then `as i32`: a string or a fractional number yields
 * nothing, and anything past the i32 range wraps rather than being refused.
 */
const asI64 = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) ? value | 0 : 0;

/** The same, for a `Deserialize_repr` enum, which only reads its own variants. */
const lenientEnum = (value: unknown, variants: readonly number[], fallback: number): number =>
  typeof value === "number" && variants.includes(value) ? value : fallback;

const NEW_REQUIRED: Record<string, FieldKind> = {
  delays: "lenient",
  initialFactor: "u16",
  ints: "lenient",
  order: "lenient",
  perDay: "lenient",
};
const NEW_DEFAULT: Json = {
  bury: false,
  delays: [1, 10],
  initialFactor: 2500,
  ints: [1, 4],
  order: 1,
  perDay: 20,
};

const REV_REQUIRED: Record<string, FieldKind> = {
  ease4: "f32",
  ivlFct: "f32",
  maxIvl: "u32",
  perDay: "lenient",
};
const REV_DEFAULT: Json = {
  bury: false,
  ease4: 1.3,
  ivlFct: 1.0,
  maxIvl: 36500,
  perDay: 200,
  hardFactor: 1.2,
};

const LAPSE_REQUIRED: Record<string, FieldKind> = {
  delays: "lenient",
  leechAction: "lenient",
  leechFails: "u32",
  minInt: "u32",
  mult: "f32",
};
const LAPSE_DEFAULT: Json = {
  delays: [10],
  leechAction: 1,
  leechFails: 8,
  minInt: 1,
  mult: 0,
};

/**
 * Absent and explicitly null are both "unset". Anki writes `null` rather than
 * omitting these keys, because they are `Option<T>` with no
 * `skip_serializing_if`, so a `=== undefined` check misses every one of them.
 * Reading a null as 0 sets a real override: `newLimit: 0` means no new cards.
 */
const isUnset = (value: unknown): boolean => value === undefined || value === null;

/** `safeParse` hands back a bigint for an id too large for a double. */
const optionalId = (value: unknown): bigint | undefined => {
  if (isUnset(value)) return undefined;
  return typeof value === "bigint" ? value : BigInt(Math.trunc(num(value)));
};

const num = (value: unknown, fallback = 0): number => {
  if (typeof value === "bigint") return Number(value);
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback;
};
const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const bool = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : fallback;
const floats = (value: unknown): number[] =>
  Array.isArray(value) ? value.map((item) => num(item)) : [];
/** `Array.isArray` narrows to `any[]`, which loses every type below it. */
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);
const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

const NOTETYPE_KEYS = [
  "id",
  "name",
  "type",
  "mod",
  "usn",
  "sortf",
  "did",
  "tmpls",
  "flds",
  "css",
  "latexPre",
  "latexPost",
  "latexsvg",
  "req",
  "originalStockKind",
  "originalId",
];
const FIELD_KEYS = [
  "name",
  "ord",
  "sticky",
  "rtl",
  "font",
  "size",
  "description",
  "plainText",
  "collapsed",
  "excludeFromSearch",
  "id",
  "tag",
  "preventDeletion",
];
const TEMPLATE_KEYS = [
  "name",
  "ord",
  "qfmt",
  "afmt",
  "bqfmt",
  "bafmt",
  "did",
  "bfont",
  "bsize",
  "id",
];
const DECK_KEYS = [
  "id",
  "mod",
  "name",
  "usn",
  "collapsed",
  "browserCollapsed",
  "desc",
  "md",
  "dyn",
  "conf",
  "extendNew",
  "extendRev",
  "reviewLimit",
  "newLimit",
  "reviewLimitToday",
  "newLimitToday",
  "desiredRetention",
  "newToday",
  "revToday",
  "lrnToday",
  "timeToday",
];
const DECKCONF_KEYS = [
  "id",
  "mod",
  "name",
  "usn",
  "maxTaken",
  "autoplay",
  "timer",
  "replayq",
  "new",
  "rev",
  "lapse",
  "dyn",
  "newMix",
  "newPerDayMinimum",
  "interdayLearningMix",
  "reviewOrder",
  "newSortOrder",
  "newGatherPriority",
  "buryInterdayLearning",
  "fsrsWeights",
  "fsrsParams5",
  "fsrsParams6",
  "desiredRetention",
  "ignoreRevlogsBeforeDate",
  "easyDaysPercentages",
  "stopTimerOnAnswer",
  "secondsToShowQuestion",
  "secondsToShowAnswer",
  "questionAction",
  "answerAction",
  "waitForAudio",
  "sm2Retention",
  "weightSearch",
];

const REQUIREMENT_KINDS: Record<string, number> = { none: 0, any: 1, all: 2 };

function convertNotetypes(json: string): {
  notetypes: NotetypeRow[];
  fields: FieldRow[];
  templates: TemplateRow[];
} {
  const notetypes: NotetypeRow[] = [];
  const fields: FieldRow[] = [];
  const templates: TemplateRow[] = [];

  const usedNames = new Set<string>();

  for (const [key, value] of Object.entries(obj(safeParse(json, "models")))) {
    const nt = obj(value);
    // The map key, which is what `notes.mid` resolves against. Anki takes the
    // row from the inner id and its fields from the key, dangling if they differ.
    const id =
      num(key) || num(nt.id) || Number(stableId("notetype", str(nt.name)) % 1_000_000_007n);

    const reqs = (Array.isArray(nt.req) ? nt.req : []).map((entry) => {
      // Serialised as a tuple: [card_ord, kind, [field_ords]].
      const [cardOrd, kind, fieldOrds] = arr(entry);
      return create(Notetype_Config_CardRequirementSchema, {
        cardOrd: num(cardOrd),
        kind: REQUIREMENT_KINDS[str(kind)] ?? 0,
        fieldOrds: Array.isArray(fieldOrds) ? fieldOrds.map((o) => num(o)) : [],
      });
    });

    notetypes.push({
      id,
      name: uniqueName(normalizedName(nt.name), usedNames, "_"),
      mtimeSecs: num(nt.mod),
      usn: num(nt.usn),
      config: toBinary(
        Notetype_ConfigSchema,
        create(Notetype_ConfigSchema, {
          kind: num(nt.type),
          sortFieldIdx: num(nt.sortf),
          css: str(nt.css),
          targetDeckIdUnused: lenientDeckId(nt.did),
          latexPre: str(nt.latexPre),
          latexPost: str(nt.latexPost),
          latexSvg: bool(nt.latexsvg),
          reqs,
          originalStockKind: num(nt.originalStockKind),
          originalId: optionalId(nt.originalId),
          other: otherBytes(nt, NOTETYPE_KEYS),
        }),
      ),
    });

    // Ordinals come from the array position, not the JSON. Anki assigns them by
    // `enumerate()` when it loads a notetype, and legacy files in the wild
    // carry stale or duplicated `ord` values that would otherwise collide on
    // the (ntid, ord) key or silently misalign fields against `flds`.
    const fieldNames = new Set<string>();
    (Array.isArray(nt.flds) ? nt.flds : []).forEach((raw, index) => {
      const field = obj(raw);
      fields.push({
        ntid: id,
        ord: index,
        name: uniqueName(normalizedName(field.name), fieldNames, "+"),
        config: toBinary(
          Notetype_Field_ConfigSchema,
          create(Notetype_Field_ConfigSchema, {
            sticky: bool(field.sticky),
            rtl: bool(field.rtl),
            fontName: str(field.font, "Arial"),
            fontSize: FITS.u32(field.size) ? num(field.size) : 20,
            description: str(field.description),
            plainText: bool(field.plainText),
            collapsed: bool(field.collapsed),
            excludeFromSearch: bool(field.excludeFromSearch),
            id: optionalId(field.id),
            tag: lenientOptionalInt(field.tag),
            preventDeletion: bool(field.preventDeletion),
            other: otherBytes(field, FIELD_KEYS),
          }),
        ),
      });
    });

    const templateNames = new Set<string>();
    (Array.isArray(nt.tmpls) ? nt.tmpls : []).forEach((raw, index) => {
      const tmpl = obj(raw);
      templates.push({
        ntid: id,
        ord: index,
        name: uniqueName(normalizedName(tmpl.name), templateNames, "+"),
        // Anki sets both to zero when upgrading a template.
        mtimeSecs: 0,
        usn: 0,
        config: toBinary(
          Notetype_Template_ConfigSchema,
          create(Notetype_Template_ConfigSchema, {
            qFormat: str(tmpl.qfmt),
            aFormat: str(tmpl.afmt),
            qFormatBrowser: str(tmpl.bqfmt),
            aFormatBrowser: str(tmpl.bafmt),
            targetDeckId: lenientDeckId(tmpl.did),
            browserFontName: str(tmpl.bfont),
            browserFontSize: lenientInt(tmpl.bsize),
            id: optionalId(tmpl.id),
            other: otherBytes(tmpl, TEMPLATE_KEYS),
          }),
        ),
      });
    });
  }

  return { notetypes, fields, templates };
}

/**
 * A per-day override, `{limit, today}` in both schemas.
 *
 * `Option<DayLimit>` with `default_on_invalid`, so anything unreadable leaves
 * the override off rather than setting one. A `limit` of 0 is not the same as
 * no limit: it means no cards today.
 */
function dayLimit(value: unknown): Deck_Normal_DayLimit | undefined {
  if (isUnset(value)) return undefined;
  const parsed = obj(value);
  if (!FITS.u32(parsed.limit) || !FITS.u32(parsed.today)) return undefined;
  return create(Deck_Normal_DayLimitSchema, {
    limit: num(parsed.limit),
    today: num(parsed.today),
  });
}

function convertDecks(json: string): DeckRow[] {
  const decks: DeckRow[] = [];
  const usedNames = new Set<string>();

  for (const value of Object.values(obj(safeParse(json, "decks")))) {
    const deck = obj(value);
    // Anki resets filtered decks when exporting, so one here means the file was
    // not produced by an export. Converting it partly would drop its search
    // terms silently. `dyn` is a bool in some writers and a number in others.
    if (bool(deck.dyn) || num(deck.dyn) !== 0) {
      fail(
        "unsupported-schema",
        `Deck ${JSON.stringify(str(deck.name))} is a filtered deck, which ankipack cannot convert ` +
          `from the legacy format. Re-export it from Anki.`,
      );
    }

    // `TodayAmountSchema11` is `#[serde(from = "Vec<Value>")]`: it pops the
    // amount off the end first and the day second, so `[7]` is day 0 amount 7,
    // and only a whole number counts (`Value::as_i64`).
    const dayCount = (value: unknown): { day: number; count: number } => {
      const pair = arr(value);
      const count = asI64(pair.pop());
      const day = asI64(pair.pop());
      return { day, count };
    };
    const newToday = dayCount(deck.newToday);
    const revToday = dayCount(deck.revToday);
    const lrnToday = dayCount(deck.lrnToday);
    const timeToday = dayCount(deck.timeToday);
    const maxDay = Math.max(timeToday.day, newToday.day, revToday.day);

    const normal = create(Deck_NormalSchema, {
      configId: BigInt(num(deck.conf, 1)),
      // Anki clamps these before they reach a uint32 field.
      extendNew: lenientInt(deck.extendNew),
      extendReview: lenientInt(deck.extendRev),
      description: str(deck.desc),
      markdownDescription: bool(deck.md),
      reviewLimit: lenientOptionalInt(deck.reviewLimit),
      newLimit: lenientOptionalInt(deck.newLimit),
      // Schema 11 stores this as an `Option<u32>` percentage and 18 as a
      // fraction. A non-integer fails the deserialize, and `default_on_invalid`
      // leaves the override unset rather than dividing it by 100.
      desiredRetention: FITS.u32(deck.desiredRetention)
        ? num(deck.desiredRetention) / 100
        : undefined,
      reviewLimitToday: dayLimit(deck.reviewLimitToday),
      newLimitToday: dayLimit(deck.newLimitToday),
    });

    decks.push({
      // Anki reads `d.common.id` and discards the map key, unlike dconf below.
      id: num(deck.id),
      // Schema 11 stores the human name; schema 18 stores the machine name.
      name: uniqueName(toNativeDeckName(str(deck.name)), usedNames, "_"),
      mtimeSecs: num(deck.mod),
      usn: num(deck.usn),
      common: toBinary(
        Deck_CommonSchema,
        create(Deck_CommonSchema, {
          studyCollapsed: bool(deck.collapsed),
          browserCollapsed: bool(deck.browserCollapsed),
          // `max_day as u32` in Rust, which wraps rather than refusing a
          // negative day. The comparisons below are on the signed value.
          lastDayStudied: maxDay >>> 0,
          // A count from an earlier day would tell Anki today's quota is
          // already spent. `lrn` does not get a vote on which day is current,
          // because studying always touches `time` while custom study may
          // touch only `new` or `rev`.
          newStudied: newToday.day === maxDay ? newToday.count : 0,
          reviewStudied: revToday.day === maxDay ? revToday.count : 0,
          learningStudied: lrnToday.day === maxDay ? lrnToday.count : 0,
          millisecondsStudied: timeToday.count,
          other: otherBytes(deck, DECK_KEYS),
        }),
      ),
      kind: toBinary(
        Deck_KindContainerSchema,
        create(Deck_KindContainerSchema, { kind: { case: "normal", value: normal } }),
      ),
    });
  }

  return decks;
}

function convertDeckConfigs(json: string): {
  configs: DeckConfigRow[];
  /** Presets the schema 15 to 16 step reset, whose cards Anki repairs too. */
  repaired: Set<number>;
} {
  const configs: DeckConfigRow[] = [];
  const repaired = new Set<number>();

  for (const [key, value] of Object.entries(obj(safeParse(json, "dconf")))) {
    const conf = obj(value);
    const newConf = subObject(conf.new, NEW_REQUIRED, NEW_DEFAULT);
    const revConf = subObject(conf.rev, REV_REQUIRED, REV_DEFAULT);
    const lapseConf = subObject(conf.lapse, LAPSE_REQUIRED, LAPSE_DEFAULT);
    // Anki's `deserialize_new_intervals` falls back to (1, 4) unless there are
    // at least two entries that both fit in a u16. AnkiDroid wrote 2-element
    // arrays, which is why the check is on length rather than shape.
    const rawInts = Array.isArray(newConf.ints) ? newConf.ints.map((v) => num(v, -1)) : [];
    const intsValid =
      rawInts.length >= 2 &&
      rawInts.slice(0, 2).every((v) => Number.isInteger(v) && v >= 0 && v <= 65535);
    const ints = intsValid ? rawInts : [1, 4];

    // Anki folds leftover keys from the nested objects up into the top-level
    // `other` under their own names, so they have to be added after the
    // reserved-key filter rather than before it, which would strip them again.
    const extras: Json = {};
    for (const [key, source, reserved] of [
      ["new", newConf, NEW_KEYS],
      ["rev", revConf, REV_KEYS],
      ["lapse", lapseConf, LAPSE_KEYS],
    ] as const) {
      const rest = leftoverKeys(source, reserved);
      if (Object.keys(rest).length > 0) extras[key] = rest;
    }

    const rawEase = num(newConf.initialFactor, 2500) / 1000;
    const configId = num(key) || num(conf.id);
    if (rawEase <= 1.3) repaired.add(configId);

    configs.push({
      // Anki forces the id from the map key: "buggy clients may have failed to
      // set inner id to match hash key".
      id: configId,
      name: str(conf.name),
      mtimeSecs: num(conf.mod),
      usn: num(conf.usn),
      config: toBinary(
        DeckConfig_ConfigSchema,
        create(DeckConfig_ConfigSchema, {
          learnSteps: floats(newConf.delays),
          relearnSteps: floats(lapseConf.delays),
          newPerDay: lenientInt(newConf.perDay),
          reviewsPerDay: lenientInt(revConf.perDay),
          newPerDayMinimum: num(conf.newPerDayMinimum),
          // Schema 15 created presets at the minimum ease by mistake, so the
          // 15-to-16 upgrade resets anything at or below 1.3 to the default.
          initialEase: repairInitialEase(rawEase),
          easyMultiplier: num(revConf.ease4, 1.3),
          hardMultiplier: num(revConf.hardFactor, 1.2),
          lapseMultiplier: num(lapseConf.mult),
          intervalMultiplier: num(revConf.ivlFct, 1),
          maximumReviewInterval: num(revConf.maxIvl, 36500),
          minimumLapseInterval: num(lapseConf.minInt),
          graduatingIntervalGood: num(ints[0], 1),
          graduatingIntervalEasy: num(ints[1], 4),
          // The two enums are inverted: schema 11 is Random=0, Due=1, while
          // NewCardInsertOrder is Due=0, Random=1.
          newCardInsertOrder: lenientEnum(newConf.order, [0, 1], 1) === 0 ? 1 : 0,
          newCardGatherPriority: num(conf.newGatherPriority),
          newCardSortOrder: num(conf.newSortOrder),
          reviewOrder: num(conf.reviewOrder),
          newMix: num(conf.newMix),
          interdayLearningMix: num(conf.interdayLearningMix),
          leechAction: lenientEnum(lapseConf.leechAction, [0, 1], 1),
          leechThreshold: num(lapseConf.leechFails),
          disableAutoplay: !bool(conf.autoplay, true),
          capAnswerTimeToSecs: clampU32(num(conf.maxTaken)),
          showTimer: lenientInt(conf.timer) !== 0,
          stopTimerOnAnswer: bool(conf.stopTimerOnAnswer),
          secondsToShowQuestion: num(conf.secondsToShowQuestion),
          secondsToShowAnswer: num(conf.secondsToShowAnswer),
          questionAction: num(conf.questionAction),
          answerAction: num(conf.answerAction),
          waitForAudio: bool(conf.waitForAudio, true),
          // serde gives an absent `replayq` bool::default(), which is false.
          skipQuestionWhenReplayingAnswer: !bool(conf.replayq, false),
          buryNew: bool(newConf.bury),
          buryReviews: bool(revConf.bury),
          buryInterdayLearning: bool(conf.buryInterdayLearning),
          fsrsParams4: floats(conf.fsrsWeights),
          fsrsParams5: floats(conf.fsrsParams5),
          fsrsParams6: floats(conf.fsrsParams6),
          ignoreRevlogsBeforeDate: str(conf.ignoreRevlogsBeforeDate),
          easyDaysPercentages: floats(conf.easyDaysPercentages),
          desiredRetention: num(conf.desiredRetention),
          historicalRetention: num(conf.sm2Retention),
          paramSearch: str(conf.weightSearch),
          other: otherBytes(conf, DECKCONF_KEYS, extras),
        }),
      ),
    });
  }

  return { configs, repaired };
}

const NEW_KEYS = ["bury", "delays", "initialFactor", "ints", "order", "perDay"];
const REV_KEYS = ["bury", "ease4", "ivlFct", "maxIvl", "perDay", "hardFactor"];
const LAPSE_KEYS = ["delays", "leechAction", "leechFails", "minInt", "mult"];

/**
 * Schema 11 keeps collection settings as JSON on `col.conf`; schema 18 keeps
 * them as one row per key, each holding that key's JSON value. Anki's
 * `upgrade_config_to_schema14` does this split and then blanks `conf`.
 *
 * Leaving them in `conf` is not harmless. Nothing reads that column at schema
 * 18, and `schedVer` is one of the keys: absent, Anki reads the collection as
 * v1 and reruns its v1-to-v2 scheduler upgrade over cards that are already v2.
 */
function convertConfig(json: string): ConfigRow[] {
  const encoder = new TextEncoder();
  return Object.entries(obj(safeParse(json, "conf"))).map(([key, value]) => ({
    key,
    // `set_all_config(conf, Usn(0), TimestampSecs(0))`: splitting the blob is
    // not a user edit, so it is not marked as one.
    usn: 0,
    mtimeSecs: 0,
    val: encoder.encode(JSON.stringify(value, numberForJson)),
  }));
}

/** Schema 11 keeps the tag list as a `{tag: usn}` object on the `col` row. */
function convertTags(json: string): TagRow[] {
  return Object.entries(obj(safeParse(json, "tags"))).map(([tag, usn]) => ({
    tag,
    usn: num(usn),
    // `Tag::new` leaves `expanded` false and `register_tag` binds `!expanded`.
    collapsed: true,
    config: null,
  }));
}

/**
 * Anki's `fix_low_card_eases_for_configs`, the other half of the schema 15 to
 * 16 step. Resetting the preset alone leaves every card that was answered under
 * the broken 130% ease still sitting at it.
 */
function repairLowCardEases(data: CollectionData, repaired: Set<number>): void {
  if (repaired.size === 0) return;

  const affected = new Set<number>();
  for (const deck of data.decks) {
    const kind = fromBinary(Deck_KindContainerSchema, deck.kind);
    if (kind.kind.case === "normal" && repaired.has(Number(kind.kind.value.configId))) {
      affected.add(deck.id);
    }
  }

  for (const card of data.cards) {
    if (card.factor === 0 || card.factor > 2000) continue;
    if (affected.has(card.did) || affected.has(card.odid)) {
      card.factor = 2500;
      card.usn = -1;
    }
  }
}

/** Rewrites a schema 11 document in place as schema 18. */
export function upgradeFromSchema11(data: CollectionData): void {
  const { notetypes, fields, templates } = convertNotetypes(data.col.models);
  data.notetypes = notetypes;
  data.fields = fields;
  data.templates = templates;
  data.decks = convertDecks(data.col.decks);
  const { configs, repaired } = convertDeckConfigs(data.col.dconf);
  data.deckConfig = configs;
  repairLowCardEases(data, repaired);
  data.tags = convertTags(data.col.tags);
  data.config = convertConfig(data.col.conf);

  // The JSON columns are what schema 18 replaced, so they are emptied the way
  // Anki's own upgrade leaves them, `conf` included now that it has been split
  // into `config` rows.
  data.col.models = "";
  data.col.decks = "";
  data.col.dconf = "";
  data.col.tags = "";
  data.col.conf = "";
  data.col.ver = SCHEMA_VERSION;
}

/** The keys read as a protobuf int64, and so worth keeping past 2^53. */
const EXACT_ID_KEYS = new Set(["id", "originalId"]);

/**
 * Keys Rust declares as an integer. `1300.0` is a valid JSON number and an
 * invalid `u16`, and the two are the same double once parsed, so the decision
 * has to be made here where the source text is still available.
 *
 * Keyed by name, so a name Anki types differently in two structs cannot be
 * listed: `desiredRetention` is `f32` on a preset and `Option<u32>` on a deck.
 */
const INTEGER_KEYS = new Set([
  "initialFactor",
  "perDay",
  "maxIvl",
  "leechFails",
  "minInt",
  "leechAction",
  "order",
  "timer",
  "maxTaken",
  "newPerDayMinimum",
  "extendNew",
  "extendRev",
  "reviewLimit",
  "newLimit",
  "limit",
  "today",
  "size",
  "bsize",
  "tag",
  "sortf",
  "did",
  "type",
  "ord",
]);

const INTEGER_SOURCE = /^-?\d+$/;

/**
 * `JSON.parse`, reading numbers the way Rust's serde reads them. Both decisions
 * need the source text, which the parsed double no longer carries.
 *
 * An id past 2^53 rounds, and Anki's notetype merge matches fields on that id,
 * so a rounded one duplicates the column on the next import. A float where Rust
 * wants an integer is a deserialize failure, and `NaN` is how that reaches the
 * converters, which already reject it.
 *
 * The reviver's third argument is ES2025. Without it, numbers parse plainly.
 */
function safeParse(json: string, column: string): unknown {
  if (json.trim().length === 0) return {};
  try {
    return JSON.parse(json, function (key, value: unknown, context?: { source?: string }) {
      const source = context?.source;
      if (typeof value !== "number" || source === undefined) return value;

      if (INTEGER_KEYS.has(key) && !INTEGER_SOURCE.test(source)) return Number.NaN;

      if (!EXACT_ID_KEYS.has(key)) return value;
      if (!Number.isInteger(value) || Number.isSafeInteger(value)) return value;
      return INTEGER_SOURCE.test(source) ? BigInt(source) : value;
    });
  } catch (error) {
    // An absent column and a damaged one are not the same thing. Reading a
    // damaged `conf` as {} drops schedVer, and Anki then reruns its v1-to-v2
    // upgrade over cards that are already v2.
    fail("invalid-package", `Collection column ${column} is not valid JSON (${String(error)})`);
  }
}
