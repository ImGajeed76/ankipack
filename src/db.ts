import type { SqlJsStatic, Database } from "sql.js";
import type { Deck } from "./deck.js";
import { NO_PRESET } from "./deck.js";
import { DeckConfig } from "./deck-config.js";
import type { Model } from "./model.js";
import type { Note } from "./note.js";
import { create, toBinary } from "@bufbuild/protobuf";
import { DeckConfig_ConfigSchema } from "./generated/anki/deck_config_pb.js";
import {
  Deck_CommonSchema,
  Deck_KindContainerSchema,
  Deck_NormalSchema,
} from "./generated/anki/decks_pb.js";
import {
  Notetype_ConfigSchema,
  Notetype_Field_ConfigSchema,
  Notetype_Template_ConfigSchema,
} from "./generated/anki/notetypes_pb.js";
import { IdGenerator } from "./util/id.js";
import { generateGuid } from "./util/guid.js";
import { fieldChecksum } from "./util/checksum.js";
import { FIELD_SEPARATOR } from "./util/constants.js";
import {
  stripHtmlPreservingMediaFilenames,
  stripInvalidFieldChars,
  toNativeDeckName,
} from "./util/text.js";
import { templateRenders } from "./util/template.js";

/** All SQL to create the V18 schema */
const SCHEMA_SQL = `
-- Legacy V11 tables
CREATE TABLE col (
  id integer PRIMARY KEY,
  crt integer NOT NULL,
  mod integer NOT NULL,
  scm integer NOT NULL,
  ver integer NOT NULL,
  dty integer NOT NULL,
  usn integer NOT NULL,
  ls integer NOT NULL,
  conf text NOT NULL,
  models text NOT NULL,
  decks text NOT NULL,
  dconf text NOT NULL,
  tags text NOT NULL
);

CREATE TABLE notes (
  id integer PRIMARY KEY,
  guid text NOT NULL,
  mid integer NOT NULL,
  mod integer NOT NULL,
  usn integer NOT NULL,
  tags text NOT NULL,
  flds text NOT NULL,
  sfld integer NOT NULL,
  csum integer NOT NULL,
  flags integer NOT NULL,
  data text NOT NULL
);

CREATE TABLE cards (
  id integer PRIMARY KEY,
  nid integer NOT NULL,
  did integer NOT NULL,
  ord integer NOT NULL,
  mod integer NOT NULL,
  usn integer NOT NULL,
  type integer NOT NULL,
  queue integer NOT NULL,
  due integer NOT NULL,
  ivl integer NOT NULL,
  factor integer NOT NULL,
  reps integer NOT NULL,
  lapses integer NOT NULL,
  left integer NOT NULL,
  odue integer NOT NULL,
  odid integer NOT NULL,
  flags integer NOT NULL,
  data text NOT NULL
);

CREATE TABLE revlog (
  id integer PRIMARY KEY,
  cid integer NOT NULL,
  usn integer NOT NULL,
  ease integer NOT NULL,
  ivl integer NOT NULL,
  lastIvl integer NOT NULL,
  factor integer NOT NULL,
  time integer NOT NULL,
  type integer NOT NULL
);

CREATE TABLE graves (
  oid integer NOT NULL,
  type integer NOT NULL,
  usn integer NOT NULL,
  PRIMARY KEY (oid, type)
) WITHOUT ROWID;

-- V11 indexes
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
CREATE INDEX idx_notes_mid ON notes (mid);
CREATE INDEX idx_cards_odid ON cards (odid) WHERE odid != 0;
CREATE INDEX idx_graves_pending ON graves (usn);

-- V14 tables
CREATE TABLE deck_config (
  id integer PRIMARY KEY NOT NULL,
  name text NOT NULL,
  mtime_secs integer NOT NULL,
  usn integer NOT NULL,
  config blob NOT NULL
);

CREATE TABLE config (
  KEY text NOT NULL PRIMARY KEY,
  usn integer NOT NULL,
  mtime_secs integer NOT NULL,
  val blob NOT NULL
) WITHOUT ROWID;

CREATE TABLE tags (
  tag text NOT NULL PRIMARY KEY,
  usn integer NOT NULL,
  collapsed boolean NOT NULL,
  config blob NULL
) WITHOUT ROWID;

-- V15 tables
CREATE TABLE notetypes (
  id integer NOT NULL PRIMARY KEY,
  name text NOT NULL,
  mtime_secs integer NOT NULL,
  usn integer NOT NULL,
  config blob NOT NULL
);
CREATE UNIQUE INDEX idx_notetypes_name ON notetypes (name);
CREATE INDEX idx_notetypes_usn ON notetypes (usn);

CREATE TABLE fields (
  ntid integer NOT NULL,
  ord integer NOT NULL,
  name text NOT NULL,
  config blob NOT NULL,
  PRIMARY KEY (ntid, ord)
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_fields_name_ntid ON fields (name, ntid);

CREATE TABLE templates (
  ntid integer NOT NULL,
  ord integer NOT NULL,
  name text NOT NULL,
  mtime_secs integer NOT NULL,
  usn integer NOT NULL,
  config blob NOT NULL,
  PRIMARY KEY (ntid, ord)
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_templates_name_ntid ON templates (name, ntid);
CREATE INDEX idx_templates_usn ON templates (usn);

CREATE TABLE decks (
  id integer PRIMARY KEY NOT NULL,
  name text NOT NULL,
  mtime_secs integer NOT NULL,
  usn integer NOT NULL,
  common blob NOT NULL,
  kind blob NOT NULL
);
CREATE UNIQUE INDEX idx_decks_name ON decks (name);
`;

interface InternalNote {
  note: Note;
  deckId: number;
}

export async function buildDatabase(SQL: SqlJsStatic, decks: Deck[]): Promise<Uint8Array> {
  const db = new SQL.Database();
  const idGen = new IdGenerator();
  const now = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  try {
    // Create schema
    db.run(SCHEMA_SQL);

    // Insert col row
    db.run(`INSERT INTO col VALUES(1, ?, ?, ?, 18, 0, -1, 0, '{}', '{}', '{}', '{}', '{}')`, [
      now,
      nowMs,
      nowMs,
    ]);

    // Track models we've already inserted, by id and by name: the schema is
    // unique on both, and either collision otherwise surfaces as a raw
    // SQLite error or, for a repeated id, as a silently dropped notetype.
    const insertedModels = new Map<number, Model>();
    const modelNames = new Map<string, Model>();
    // Track configs we've already inserted
    const insertedConfigs = new Map<number, DeckConfig>();
    // Collect all notes with their deck IDs
    const allNotes: InternalNote[] = [];
    // Card position counter (controls new card order)
    let cardPosition = 0;

    // Decks with a real config get the config row inserted; decks created with
    // `config: null` skip their own config row and reference Anki's built-in
    // id=1 default preset on import (see insertDeck below + the placeholder
    // block after the loop).
    let needPlaceholderConfig = false;
    // Compared after normalisation: " A " and "A" are the same native name.
    const deckNames = new Map<string, string>();
    const deckIds = new Map<number, string>();
    for (const deck of decks) {
      const nativeName = toNativeDeckName(deck.name);
      const clash = deckNames.get(nativeName);
      if (clash !== undefined) {
        throw new Error(
          `Decks ${JSON.stringify(clash)} and ${JSON.stringify(deck.name)} ` +
            `resolve to the same Anki deck name`,
        );
      }
      deckNames.set(nativeName, deck.name);

      const idClash = deckIds.get(deck.id);
      if (idClash !== undefined) {
        throw new Error(
          `Decks ${JSON.stringify(idClash)} and ${JSON.stringify(deck.name)} ` +
            `share id ${deck.id}`,
        );
      }
      deckIds.set(deck.id, deck.name);

      const config = deck.getEffectiveConfig();
      if (config === NO_PRESET) {
        needPlaceholderConfig = true;
      } else if (insertedConfigs.has(config.id)) {
        // Only one row per id can ship, so a second preset reusing an id would
        // silently give its deck the first preset's settings.
        const existing = insertedConfigs.get(config.id);
        if (existing !== config) {
          throw new Error(
            `Two different DeckConfigs share id ${config.id}: ` +
              `${JSON.stringify(existing?.name)} and ${JSON.stringify(config.name)}`,
          );
        }
      } else {
        insertDeckConfig(db, config, now);
        insertedConfigs.set(config.id, config);
      }

      // Insert deck
      insertDeck(db, deck, now);

      // Collect notes
      for (const note of deck.notes) {
        allNotes.push({ note, deckId: deck.id });

        // Insert model if not yet inserted
        const model = note.model;
        const sameId = insertedModels.get(model.id);
        if (sameId !== undefined) {
          if (sameId !== model) {
            throw new Error(
              `Two different Models share id ${model.id}: ` +
                `${JSON.stringify(sameId.name)} and ${JSON.stringify(model.name)}`,
            );
          }
        } else {
          const sameName = modelNames.get(model.name);
          if (sameName !== undefined) {
            throw new Error(
              `Two different Models are both named ${JSON.stringify(model.name)}, ` +
                `which Anki requires to be unique`,
            );
          }
          insertModel(db, model, now);
          insertedModels.set(model.id, model);
          modelNames.set(model.name, model);
        }
      }
    }

    // Anki's import path runs a `gather_data` pass on the apkg's temp
    // collection that resolves every deck's `config_id` against the apkg's
    // own `deck_config` table. A NO_PRESET deck points at id=1 (Anki's
    // built-in Default preset), so the apkg must contain a placeholder row
    // at id=1 or the gather phase fails with "No such deck config: '1'".
    //
    // The placeholder is harmless on the user's side: Anki's importer uses
    // `INSERT OR IGNORE INTO deck_config` (rslib/.../add_if_unique.sql), so
    // the row is silently dropped on collision with the user's existing
    // Default preset, leaving any customisations they've made intact.
    if (needPlaceholderConfig && !insertedConfigs.has(1)) {
      const placeholder = new DeckConfig({ id: 1, name: "Default" });
      insertDeckConfig(db, placeholder, now);
      insertedConfigs.set(1, placeholder);
    }

    // Insert all notes and their cards
    for (const { note, deckId } of allNotes) {
      cardPosition = await insertNote(db, idGen, note, deckId, now, cardPosition);
    }

    const data = db.export();
    return data;
  } finally {
    db.close();
  }
}

function insertDeckConfig(db: Database, config: DeckConfig, now: number): void {
  const configProto = config.toProtobuf();
  const configBytes = toBinary(DeckConfig_ConfigSchema, configProto);

  db.run(`INSERT INTO deck_config (id, name, mtime_secs, usn, config) VALUES (?, ?, ?, -1, ?)`, [
    config.id,
    config.name,
    now,
    configBytes,
  ]);
}

function insertDeck(db: Database, deck: Deck, now: number): void {
  const common = create(Deck_CommonSchema, {});
  const commonBytes = toBinary(Deck_CommonSchema, common);

  // Anki guarantees a built-in default preset at id=1 in every collection
  // (rslib hardcodes DeckConfigId(1).unwrap()). Decks marked NO_PRESET
  // reference it directly so the imported deck inherits the user's existing
  // default scheduling and no new preset appears in their preset list.
  const config = deck.getEffectiveConfig();
  const configId = config === NO_PRESET ? 1n : BigInt(config.id);

  const normal = create(Deck_NormalSchema, {
    configId,
    description: deck.description ?? "",
  });
  const kindContainer = create(Deck_KindContainerSchema, {
    kind: { case: "normal", value: normal },
  });
  const kindBytes = toBinary(Deck_KindContainerSchema, kindContainer);

  // Anki resolves parents from the native name, and creates any that are
  // missing on import (`match_or_create_parents`), so only the leaf is shipped.
  db.run(`INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, ?, -1, ?, ?)`, [
    deck.id,
    toNativeDeckName(deck.name),
    now,
    commonBytes,
    kindBytes,
  ]);
}

function insertModel(db: Database, model: Model, now: number): void {
  const configProto = model.toNotetypeConfigProtobuf();
  const configBytes = toBinary(Notetype_ConfigSchema, configProto);

  db.run(`INSERT INTO notetypes (id, name, mtime_secs, usn, config) VALUES (?, ?, ?, -1, ?)`, [
    model.id,
    model.name,
    now,
    configBytes,
  ]);

  // Insert fields
  for (let i = 0; i < model.fields.length; i++) {
    const field = model.fields[i];
    const fieldConfig = model.toFieldConfigProtobuf(i);
    const fieldConfigBytes = toBinary(Notetype_Field_ConfigSchema, fieldConfig);

    db.run(`INSERT INTO fields (ntid, ord, name, config) VALUES (?, ?, ?, ?)`, [
      model.id,
      i,
      field.name,
      fieldConfigBytes,
    ]);
  }

  // Insert templates
  for (let i = 0; i < model.templates.length; i++) {
    const tmpl = model.templates[i];
    const tmplConfig = model.toTemplateConfigProtobuf(i);
    const tmplConfigBytes = toBinary(Notetype_Template_ConfigSchema, tmplConfig);

    db.run(
      `INSERT INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?, ?, ?, ?, -1, ?)`,
      [model.id, i, tmpl.name, now, tmplConfigBytes],
    );
  }
}

async function insertNote(
  db: Database,
  idGen: IdGenerator,
  note: Note,
  deckId: number,
  now: number,
  cardPosition: number,
): Promise<number> {
  const noteId = idGen.next();
  const guid = note.guid ?? generateGuid();
  // Card generation reads the same values that get stored, so a stripped
  // character cannot make the cards disagree with the row.
  const storedFields = note.fields.map(stripInvalidFieldChars);
  const flds = storedFields.join(FIELD_SEPARATOR);
  const sortField = stripHtmlPreservingMediaFilenames(
    storedFields[note.model.sortFieldIndex ?? 0] ?? "",
  );
  const csum = await fieldChecksum(stripHtmlPreservingMediaFilenames(storedFields[0] ?? ""));
  const tags = note.tags.length > 0 ? ` ${note.tags.join(" ")} ` : "";

  db.run(
    `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
     VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')`,
    [noteId, guid, note.model.id, now, tags, flds, sortField, csum],
  );

  return insertCards(db, idGen, note, storedFields, noteId, deckId, now, cardPosition);
}

/** Returns the next free card position. */
function insertCards(
  db: Database,
  idGen: IdGenerator,
  note: Note,
  fields: string[],
  noteId: number,
  deckId: number,
  now: number,
  startPosition: number,
): number {
  let position = startPosition;
  const emit = (ord: number): void => {
    insertCard(db, { id: idGen.next(), noteId, deckId, ord, now, position });
    position++;
  };

  if (note.model.type === "cloze") {
    for (const ord of extractClozeOrds(fields)) emit(ord);
    return position;
  }

  const nonempty = nonemptyFieldNames(note, fields);
  let generated = 0;
  note.model.templates.forEach((tmpl, ord) => {
    if (templateRenders(tmpl.questionFormat, nonempty)) {
      emit(ord);
      generated++;
    }
  });

  // Anki's `ensure_not_empty`: card 0 is forced when no template renders.
  if (generated === 0) emit(0);

  return position;
}

interface CardRow {
  id: number;
  noteId: number;
  deckId: number;
  ord: number;
  now: number;
  position: number;
}

function insertCard(db: Database, card: CardRow): void {
  db.run(
    `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
     VALUES (?, ?, ?, ?, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
    [card.id, card.noteId, card.deckId, card.ord, card.now, card.position],
  );
}

interface ClozeMarker {
  values: number[];
  children: ClozeMarker[];
}

/**
 * Anki's cloze rules (rslib/src/cloze.rs, cardgen.rs:169): the ordinal is n-1
 * capped at 499, c0 is dropped, and nesting is tracked only 10 deep. Never
 * returns empty, so a cloze note is never card-less.
 */
function extractClozeOrds(fields: string[]): number[] {
  const ords = new Set<number>();

  for (const field of fields) {
    for (const marker of parseClozeMarkers(field)) {
      collectClozeOrds(marker, ords);
    }
  }

  return ords.size > 0 ? [...ords].sort((a, b) => a - b) : [0];
}

/**
 * A closed marker is pushed into its parent rather than harvested on the spot,
 * so an unclosed outer marker discards everything nested inside it, the way
 * Anki's `parse_text_with_clozes` does.
 */
function parseClozeMarkers(field: string): ClozeMarker[] {
  const closed: ClozeMarker[] = [];
  const open: ClozeMarker[] = [];
  let index = 0;

  while (index < field.length) {
    if (field.startsWith("{{c", index)) {
      const numbers = parseClozeNumbers(field, index + 3);
      if (numbers) {
        if (open.length < 10) open.push({ values: numbers.values, children: [] });
        index = numbers.end;
        continue;
      }
    }
    if (field.startsWith("}}", index)) {
      const marker = open.pop();
      if (marker) {
        (open[open.length - 1]?.children ?? closed).push(marker);
        index += 2;
        continue;
      }
    }
    index++;
  }

  // Markers still open at the end of the field never closed, so Anki drops them
  // along with anything nested inside.
  return closed;
}

function collectClozeOrds(marker: ClozeMarker, ords: Set<number>): void {
  for (const value of marker.values) {
    if (value !== 0) ords.add(Math.min(value - 1, 499));
  }
  for (const child of marker.children) {
    collectClozeOrds(child, ords);
  }
}

/** Read the comma-separated number list of a cloze marker, up to its `::`. */
function parseClozeNumbers(
  field: string,
  start: number,
): { values: number[]; end: number } | undefined {
  let cursor = start;
  let digits = "";
  while (cursor < field.length && (isAsciiDigit(field[cursor]) || field[cursor] === ",")) {
    digits += field[cursor];
    cursor++;
  }
  if (digits.length === 0 || !field.startsWith("::", cursor)) return undefined;

  const values = digits
    .split(",")
    .filter((part) => part.length > 0)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 65535);

  return values.length > 0 ? { values, end: cursor + 2 } : undefined;
}

function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/**
 * Anki's `field_is_empty` (rslib/src/template.rs). `[[:space:]]` there is ASCII
 * only, so a field of non-breaking spaces is NON-empty to Anki.
 */
function fieldIsEmpty(text: string): boolean {
  // `[[:space:]]` in Rust's regex crate is ASCII only, so a field holding a
  // non-breaking or ideographic space is NOT empty to Anki.
  return /^(?:[\t\n\v\f\r ]|<\/?(?:br|div) ?\/?>)*$/i.test(text);
}

/**
 * Anki's `SPECIAL_FIELDS` (rslib/src/notetype/mod.rs). All except `FrontSide`
 * count as non-empty during card generation, unless a real field shadows the
 * name; `Tags` counts only when the note is tagged.
 */
const SPECIAL_FIELDS = [
  "FrontSide",
  "Card",
  "CardFlag",
  "Deck",
  "Subdeck",
  "Tags",
  "Type",
  "CardID",
];

/** The field names a template may treat as content, per Anki's card generator. */
function nonemptyFieldNames(note: Note, fields: string[]): Set<string> {
  const declared = new Set(note.model.fields.map((field) => field.name));
  const nonempty = new Set<string>();

  note.model.fields.forEach((field, index) => {
    if (!fieldIsEmpty(fields[index] ?? "")) nonempty.add(field.name);
  });

  for (const special of SPECIAL_FIELDS) {
    if (special === "FrontSide" || declared.has(special)) continue;
    if (special === "Tags" && note.tags.length === 0) continue;
    nonempty.add(special);
  }

  return nonempty;
}
