import type { SqlJsStatic, Database } from "sql.js";
import type { Deck } from "./deck";
import type { Model } from "./model";
import type { Note } from "./note";
import type { DeckConfig } from "./deck-config";
import { create, toBinary } from "@bufbuild/protobuf";
import { DeckConfig_ConfigSchema } from "./generated/anki/deck_config_pb";
import {
  Deck_CommonSchema,
  Deck_KindContainerSchema,
  Deck_NormalSchema,
} from "./generated/anki/decks_pb";
import {
  Notetype_ConfigSchema,
  Notetype_Field_ConfigSchema,
  Notetype_Template_ConfigSchema,
} from "./generated/anki/notetypes_pb";
import { IdGenerator } from "./util/id";
import { generateGuid } from "./util/guid";
import { fieldChecksum } from "./util/checksum";
import { FIELD_SEPARATOR } from "./util/constants";

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

    // Track models we've already inserted
    const insertedModels = new Set<number>();
    // Track configs we've already inserted
    const insertedConfigs = new Set<number>();
    // Collect all notes with their deck IDs
    const allNotes: InternalNote[] = [];
    // Card position counter (controls new card order)
    let cardPosition = 0;

    // Ensure every deck has an explicit config — never rely on id=1 default
    // which would overwrite the user's existing default preset on import
    for (const deck of decks) {
      const config = deck.getEffectiveConfig();
      if (!insertedConfigs.has(config.id)) {
        insertDeckConfig(db, config, now);
        insertedConfigs.add(config.id);
      }

      // Insert deck
      insertDeck(db, deck, now);

      // Collect notes
      for (const note of deck.notes) {
        allNotes.push({ note, deckId: deck.id });

        // Insert model if not yet inserted
        if (!insertedModels.has(note.model.id)) {
          insertModel(db, note.model, now);
          insertedModels.add(note.model.id);
        }
      }
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

  const normal = create(Deck_NormalSchema, {
    configId: BigInt(deck.getEffectiveConfig().id),
    description: deck.description ?? "",
  });
  const kindContainer = create(Deck_KindContainerSchema, {
    kind: { case: "normal", value: normal },
  });
  const kindBytes = toBinary(Deck_KindContainerSchema, kindContainer);

  db.run(`INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, ?, -1, ?, ?)`, [
    deck.id,
    deck.name,
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
  const flds = note.fields.join(FIELD_SEPARATOR);
  const sortField = note.fields[note.model.sortFieldIndex ?? 0] ?? "";
  const csum = await fieldChecksum(note.fields[0] ?? "");
  const tags = note.tags.length > 0 ? ` ${note.tags.join(" ")} ` : "";

  db.run(
    `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
     VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')`,
    [noteId, guid, note.model.id, now, tags, flds, sortField, csum],
  );

  // Generate cards based on model templates
  const templateCount = note.model.templates.length;
  if (note.model.type === "cloze") {
    // For cloze: find all {{cN::...}} patterns and create a card for each
    const clozeOrds = extractClozeOrds(note.fields);
    for (const ord of clozeOrds) {
      const cardId = idGen.next();
      db.run(
        `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
         VALUES (?, ?, ?, ?, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
        [cardId, noteId, deckId, ord, now, cardPosition],
      );
      cardPosition++;
    }
  } else {
    // For standard models: one card per template
    for (let ord = 0; ord < templateCount; ord++) {
      // Check if this template's required fields are filled
      if (templateHasContent(note, ord)) {
        const cardId = idGen.next();
        db.run(
          `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
           VALUES (?, ?, ?, ?, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
          [cardId, noteId, deckId, ord, now, cardPosition],
        );
        cardPosition++;
      }
    }
  }

  return cardPosition;
}

/** Extract cloze deletion ordinals from note fields */
function extractClozeOrds(fields: string[]): number[] {
  const ords = new Set<number>();
  const pattern = /\{\{c(\d+)::/g;
  for (const field of fields) {
    let match;
    while ((match = pattern.exec(field)) !== null) {
      ords.add(Number(match[1]) - 1); // 0-based
    }
  }
  return ords.size > 0 ? [...ords].sort((a, b) => a - b) : [0];
}

/**
 * Check if a template should generate a card for the given note.
 * A card is generated if the question side would render non-empty content.
 * Simple heuristic: check if any field referenced in the question template is non-empty.
 */
function templateHasContent(note: Note, templateOrd: number): boolean {
  const tmpl = note.model.templates[templateOrd];
  if (!tmpl) return false;

  const qfmt = tmpl.questionFormat;
  const fieldPattern = /\{\{([^#/}]+?)\}\}/g;
  let match;
  let hasAnyField = false;

  while ((match = fieldPattern.exec(qfmt)) !== null) {
    const fieldRef = match[1].trim();
    // Skip special references
    if (fieldRef === "FrontSide" || fieldRef.startsWith("type:")) {
      // For type: references, extract the field name after "type:"
      const actualField = fieldRef.startsWith("type:") ? fieldRef.slice(5) : fieldRef;
      if (actualField === "FrontSide") continue;
      const fieldIdx = note.model.fields.findIndex((f) => f.name === actualField);
      if (fieldIdx >= 0 && (note.fields[fieldIdx] ?? "").trim() !== "") {
        return true;
      }
      hasAnyField = true;
      continue;
    }
    const fieldIdx = note.model.fields.findIndex((f) => f.name === fieldRef);
    if (fieldIdx >= 0) {
      hasAnyField = true;
      if ((note.fields[fieldIdx] ?? "").trim() !== "") {
        return true;
      }
    }
  }

  // If no fields found in template, generate card anyway
  return !hasAnyField;
}
