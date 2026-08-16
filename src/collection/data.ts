import { SCHEMA_VERSION } from "./schema.js";

/**
 * The in-memory form of an Anki collection at schema 18: one type per table,
 * one property per column, nothing summarised or dropped.
 *
 * Protobuf columns stay as bytes. They are decoded on demand and re-encoded
 * only when something changed, which keeps an untouched round trip byte-exact
 * even for fields written by an Anki newer than this one.
 */

/** `notes.sfld` is declared `integer` but holds the sort field's text. */
export type SortField = string | number;

export interface ColRow {
  id: number;
  crt: number;
  mod: number;
  scm: number;
  ver: number;
  dty: number;
  usn: number;
  ls: number;
  /** JSON, and user-owned. Carried verbatim rather than modelled. */
  conf: string;
  models: string;
  decks: string;
  dconf: string;
  tags: string;
}

export interface NoteRow {
  id: number;
  guid: string;
  mid: number;
  mod: number;
  usn: number;
  /** Space-delimited with leading and trailing spaces, or empty for none. */
  tags: string;
  /** Field values joined by U+001F. */
  flds: string;
  sfld: SortField;
  csum: number;
  flags: number;
  data: string;
}

export interface CardRow {
  id: number;
  nid: number;
  did: number;
  ord: number;
  mod: number;
  usn: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  odue: number;
  odid: number;
  flags: number;
  data: string;
}

export interface RevlogRow {
  id: number;
  cid: number;
  usn: number;
  ease: number;
  ivl: number;
  lastIvl: number;
  factor: number;
  time: number;
  type: number;
}

export interface GraveRow {
  oid: number;
  type: number;
  usn: number;
}

export interface DeckConfigRow {
  id: number;
  name: string;
  mtimeSecs: number;
  usn: number;
  /** `DeckConfig.Config` protobuf. */
  config: Uint8Array;
}

export interface ConfigRow {
  key: string;
  usn: number;
  mtimeSecs: number;
  /** Usually JSON, but opaque by contract. */
  val: Uint8Array;
}

export interface TagRow {
  tag: string;
  usn: number;
  collapsed: boolean;
  config: Uint8Array | null;
}

export interface NotetypeRow {
  id: number;
  name: string;
  mtimeSecs: number;
  usn: number;
  /** `Notetype.Config` protobuf. */
  config: Uint8Array;
}

export interface FieldRow {
  ntid: number;
  ord: number;
  name: string;
  /** `Notetype.Field.Config` protobuf. */
  config: Uint8Array;
}

export interface TemplateRow {
  ntid: number;
  ord: number;
  name: string;
  mtimeSecs: number;
  usn: number;
  /** `Notetype.Template.Config` protobuf. */
  config: Uint8Array;
}

export interface DeckRow {
  id: number;
  /** Machine name: components separated by U+001F, not `::`. */
  name: string;
  mtimeSecs: number;
  usn: number;
  /** `Deck.Common` protobuf. */
  common: Uint8Array;
  /** `Deck.Normal` or `Deck.Filtered` protobuf. */
  kind: Uint8Array;
}

export interface MediaFile {
  /** NFC-normalised filename as Anki stores it. */
  name: string;
  data: Uint8Array;
}

export interface CollectionData {
  col: ColRow;
  notes: NoteRow[];
  cards: CardRow[];
  revlog: RevlogRow[];
  graves: GraveRow[];
  deckConfig: DeckConfigRow[];
  config: ConfigRow[];
  tags: TagRow[];
  notetypes: NotetypeRow[];
  fields: FieldRow[];
  templates: TemplateRow[];
  decks: DeckRow[];
  media: MediaFile[];
}

/** A card that has never been studied, as Anki's `Card::new` leaves it. */
export function newCardRow(card: {
  id: number;
  nid: number;
  did: number;
  ord: number;
  due: number;
  mod: number;
}): CardRow {
  return {
    ...card,
    usn: -1,
    type: 0,
    queue: 0,
    ivl: 0,
    factor: 0,
    reps: 0,
    lapses: 0,
    left: 0,
    odue: 0,
    odid: 0,
    flags: 0,
    data: "",
  };
}

/** Anki's stored tag format: space delimited, with a leading and trailing space. */
export function joinTags(tags: readonly string[]): string {
  return tags.length > 0 ? ` ${tags.join(" ")} ` : "";
}

/** Anki's `is_tag_separator`: a space or U+3000, not a space alone. */
const TAG_SEPARATOR = new RegExp(`[ ${String.fromCharCode(0x3000)}]`);

export function splitTags(stored: string): string[] {
  return stored.split(TAG_SEPARATOR).filter((tag) => tag.length > 0);
}

/**
 * One past the highest id anything in the collection already uses.
 *
 * Ids are millisecond timestamps, so a generator seeded from the clock hands
 * out ids a document built moments ago has already taken. Editing then fails on
 * a unique constraint at save time, far from the call that caused it.
 */
export function nextFreeId(data: CollectionData): number {
  let highest = 0;
  for (const note of data.notes) highest = Math.max(highest, note.id);
  for (const card of data.cards) highest = Math.max(highest, card.id);
  return Math.max(highest + 1, Date.now());
}

/**
 * The position a newly added card takes in the new-card queue.
 *
 * Only new cards count: `due` holds a queue position for them, but a day number
 * for review cards and an epoch second for intraday learning cards, so a plain
 * maximum over every card lands the new card billions of positions away.
 * Anki reads this from its `nextPos` config key and falls back to
 * `max(due) + 1 where type = 0` (rslib/src/storage/card/mod.rs).
 */
export function nextNewCardPosition(data: CollectionData): number {
  let highest = -1;
  for (const card of data.cards) {
    if (card.type === 0) highest = Math.max(highest, card.due);
  }
  return highest + 1;
}

/**
 * The `col` row for a fresh collection. `ver` is Anki's SCHEMA_MAX_VERSION, so
 * no upgrade path runs on import, and the JSON columns stay at `'{}'` the way
 * Anki's own initial row does (storage/schema11.sql).
 */
function emptyCol(nowSecs: number, nowMs: number): ColRow {
  return {
    id: 1,
    crt: nowSecs,
    mod: nowMs,
    scm: nowMs,
    ver: SCHEMA_VERSION,
    dty: 0,
    usn: -1,
    ls: 0,
    conf: "{}",
    models: "{}",
    decks: "{}",
    dconf: "{}",
    tags: "{}",
  };
}

export function emptyCollection(nowSecs: number, nowMs: number): CollectionData {
  return {
    col: emptyCol(nowSecs, nowMs),
    notes: [],
    cards: [],
    revlog: [],
    graves: [],
    deckConfig: [],
    config: [],
    tags: [],
    notetypes: [],
    fields: [],
    templates: [],
    decks: [],
    media: [],
  };
}
