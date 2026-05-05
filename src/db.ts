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

    // Decks with a real config get the config row inserted; decks created with
    // `config: null` skip their own config row and reference Anki's built-in
    // id=1 default preset on import (see insertDeck below + the placeholder
    // block after the loop).
    let needPlaceholderConfig = false;
    for (const deck of decks) {
      const config = deck.getEffectiveConfig();
      if (config === NO_PRESET) {
        needPlaceholderConfig = true;
      } else if (!insertedConfigs.has(config.id)) {
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
      insertDeckConfig(db, new DeckConfig({ id: 1, name: "Default" }), now);
      insertedConfigs.add(1);
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

// ── Empty-card detection (mirrors Anki's algorithm) ────────────────────────
//
// Source of truth: ankitects/anki, rslib/src/template.rs (`template_is_empty`)
// and rslib/src/notetype/cardgen.rs (`is_nonempty`, `new_cards_required_normal`).
//
// Anki decides "should this card exist?" by parsing the question template into
// an AST of text / replacement / section / negated-section nodes, then walking
// the AST against the SET of field NAMES that resolve to non-empty values.
// Plain text alone never makes a template non-empty: only a Replacement node
// whose key is in that set counts. Section bodies are recursed into only when
// the section's gate matches (truthy for `#`, falsy for `^`).
//
// `{{type:Field}}` and `{{cloze:Field}}` parse as Replacement nodes whose key
// is "Field" (the filter prefix is dropped when computing the key). They are
// content iff that field is non-empty, same rule as `{{Field}}`.
//
// `{{FrontSide}}` parses as Replacement{ key: "FrontSide" }; "FrontSide" is
// not a real field name, so it is treated as empty for this check.

/**
 * Anki's `field_is_empty`: a field counts as empty when its trimmed value is
 * only whitespace, `<br>`, `</br>`, `<div>`, `</div>`, or `<div />`. Anything
 * else (including `[sound:...]`, `<img ...>`, raw HTML with text inside) is
 * considered non-empty. See `rslib/src/template.rs` `field_is_empty`.
 */
function fieldIsEmpty(text: string): boolean {
  return /^(?:\s|<\/?(?:br|div)\s?\/?>)*$/i.test(text);
}

type ParsedNode =
  | { kind: "text" }
  | { kind: "replacement"; key: string }
  | { kind: "section"; key: string; children: ParsedNode[] }
  | { kind: "negated"; key: string; children: ParsedNode[] };

/** Strip filter prefixes (e.g. `type:Definition` → `Definition`). */
function replacementKey(raw: string): string {
  const colon = raw.lastIndexOf(":");
  return (colon >= 0 ? raw.slice(colon + 1) : raw).trim();
}

/**
 * Parse a mustache template into the minimal AST needed for the empty-card
 * check. Bodies of text nodes are discarded since the caller only cares about
 * structure. Comments (`{{!...}}`) are dropped. Unbalanced or otherwise
 * malformed sections fall through as text, matching Anki's permissive
 * behaviour for templates that contain stray `{{` / `}}`.
 */
function parseTemplate(src: string): ParsedNode[] {
  const tokenRegex = /\{\{\s*([#^/!]?)\s*([^}]*?)\s*\}\}/g;
  const root: ParsedNode[] = [];
  const stack: { key: string; kind: "section" | "negated"; children: ParsedNode[] }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const currentList = (): ParsedNode[] => (stack.length > 0 ? stack[stack.length - 1].children : root);

  while ((match = tokenRegex.exec(src)) !== null) {
    if (match.index > lastIndex) {
      currentList().push({ kind: "text" });
    }
    const sigil = match[1];
    const body = match[2];

    if (sigil === "!") {
      // comment, drop
    } else if (sigil === "#" || sigil === "^") {
      stack.push({ key: body.trim(), kind: sigil === "#" ? "section" : "negated", children: [] });
    } else if (sigil === "/") {
      const closing = body.trim();
      const top = stack[stack.length - 1];
      if (top && top.key === closing) {
        stack.pop();
        currentList().push({ kind: top.kind, key: top.key, children: top.children });
      }
      // Mismatched close: ignore. Anki's parser would raise; we degrade.
    } else {
      currentList().push({ kind: "replacement", key: replacementKey(body) });
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < src.length) {
    currentList().push({ kind: "text" });
  }

  // Any sections still open at end of input: flush their accumulated children
  // back as text so we don't silently lose them.
  while (stack.length > 0) {
    const frame = stack.pop()!;
    currentList().push(...frame.children);
  }

  return root;
}

/**
 * Anki's `template_is_empty` (with `check_negated=true`, which is the value
 * `renders_with_fields` passes). Returns true when no Replacement reachable
 * through satisfied conditionals references a non-empty field.
 */
function templateIsEmpty(nodes: ParsedNode[], nonempty: Set<string>): boolean {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        continue;
      case "replacement":
        if (nonempty.has(node.key)) return false;
        break;
      case "section":
        if (!nonempty.has(node.key)) continue;
        if (!templateIsEmpty(node.children, nonempty)) return false;
        break;
      case "negated":
        if (nonempty.has(node.key)) continue;
        if (!templateIsEmpty(node.children, nonempty)) return false;
        break;
    }
  }
  return true;
}

/**
 * Check if a template should generate a card for the given note.
 *
 * Mirrors Anki's `ParsedTemplate::renders_with_fields`: build the set of
 * non-empty field names on the note, then walk the parsed template AST and
 * return true iff any reachable Replacement references a field in that set.
 */
function templateHasContent(note: Note, templateOrd: number): boolean {
  const tmpl = note.model.templates[templateOrd];
  if (!tmpl) return false;

  const nonempty = new Set<string>();
  for (let i = 0; i < note.model.fields.length; i++) {
    if (!fieldIsEmpty(note.fields[i] ?? "")) {
      nonempty.add(note.model.fields[i].name);
    }
  }
  if (note.tags.length > 0) nonempty.add("Tags");

  const parsed = parseTemplate(tmpl.questionFormat);
  return !templateIsEmpty(parsed, nonempty);
}
