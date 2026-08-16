import type { Deck } from "../deck.js";
import { NO_PRESET } from "../deck.js";
import { DeckConfig } from "../deck-config.js";
import type { Notetype } from "../notetype.js";
import type { Note } from "../note.js";
import { create, toBinary } from "@bufbuild/protobuf";
import { DeckConfig_ConfigSchema } from "../generated/anki/deck_config_pb.js";
import {
  Deck_CommonSchema,
  Deck_KindContainerSchema,
  Deck_NormalSchema,
} from "../generated/anki/decks_pb.js";
import {
  Notetype_ConfigSchema,
  Notetype_Field_ConfigSchema,
  Notetype_Template_ConfigSchema,
} from "../generated/anki/notetypes_pb.js";
import { IdGenerator } from "../util/id.js";
import { generateGuid } from "../util/guid.js";
import { fieldChecksum } from "../util/checksum.js";
import { FIELD_SEPARATOR } from "../util/constants.js";
import {
  stripHtmlPreservingMediaFilenames,
  stripInvalidFieldChars,
  toNativeDeckName,
} from "../util/text.js";
import { unicaseKey } from "../util/casefold.js";
import { fail } from "../error.js";
import { SPECIAL_FIELD_NAMES, templateRenders } from "../util/template.js";
import {
  emptyCollection,
  joinTags,
  newCardRow,
  type CollectionData,
  type MediaFile,
} from "./data.js";

interface InternalNote {
  note: Note;
  deckId: number;
}

/** Turns decks into the document model. No database until it is serialised. */
export async function buildCollection(decks: Deck[], media: MediaFile[]): Promise<CollectionData> {
  const idGen = new IdGenerator();
  const now = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const data = emptyCollection(now, nowMs);
  data.media = media;

  // Tracked by id and by name: the schema is unique on both, and either
  // collision otherwise surfaces as a raw SQLite error or, for a repeated id,
  // as a silently dropped notetype.
  const addedNotetypes = new Map<number, Notetype>();
  const notetypeNames = new Map<string, Notetype>();
  const addedConfigs = new Map<number, DeckConfig>();
  const allNotes: InternalNote[] = [];
  let cardPosition = 0;

  let needPlaceholderConfig = false;
  // Compared after normalisation: " A " and "A" are the same native name.
  const deckNames = new Map<string, string>();
  const deckIds = new Map<number, string>();

  for (const deck of decks) {
    // Anki's decks.name index is COLLATE unicase, so two names differing only
    // in case are one deck to it and the second deck's cards are merged into
    // the first. Compared folded here so that never reaches a user.
    const nativeName = unicaseKey(toNativeDeckName(deck.name));
    const clash = deckNames.get(nativeName);
    if (clash !== undefined) {
      fail(
        "name-conflict",
        `Decks ${JSON.stringify(clash)} and ${JSON.stringify(deck.name)} ` +
          `resolve to the same Anki deck name, which Anki compares case-insensitively`,
      );
    }
    deckNames.set(nativeName, deck.name);

    const idClash = deckIds.get(deck.id);
    if (idClash !== undefined) {
      fail(
        "id-conflict",
        `Decks ${JSON.stringify(idClash)} and ${JSON.stringify(deck.name)} ` +
          `share id ${deck.id}`,
      );
    }
    deckIds.set(deck.id, deck.name);

    const config = deck.getEffectiveConfig();
    if (config === NO_PRESET) {
      needPlaceholderConfig = true;
    } else if (addedConfigs.has(config.id)) {
      // Only one row per id can ship, so a second preset reusing an id would
      // silently give its deck the first preset's settings.
      const existing = addedConfigs.get(config.id);
      if (existing !== config) {
        fail(
          "id-conflict",
          `Two different presets share id ${config.id}: ` +
            `${JSON.stringify(existing?.name)} and ${JSON.stringify(config.name)}`,
        );
      }
    } else {
      addDeckConfig(data, config, now);
      addedConfigs.set(config.id, config);
    }

    addDeck(data, deck, now);

    for (const note of deck.notes) {
      allNotes.push({ note, deckId: deck.id });

      const notetype = note.notetype;
      const sameId = addedNotetypes.get(notetype.id);
      if (sameId !== undefined) {
        if (sameId !== notetype) {
          fail(
            "id-conflict",
            `Two different note types share id ${notetype.id}: ` +
              `${JSON.stringify(sameId.name)} and ${JSON.stringify(notetype.name)}`,
          );
        }
      } else {
        // Anki's notetypes.name index is COLLATE unicase, so a name differing
        // only in case is not free: it imports as `name+` and the templates
        // shipped alongside still point at the original.
        const sameName = notetypeNames.get(unicaseKey(notetype.name));
        if (sameName !== undefined) {
          fail(
            "name-conflict",
            sameName.name === notetype.name
              ? `Two different note types are both named ${JSON.stringify(notetype.name)}, ` +
                  `which Anki requires to be unique`
              : `Note types ${JSON.stringify(sameName.name)} and ` +
                  `${JSON.stringify(notetype.name)} resolve to the same Anki note type ` +
                  `name, which Anki compares case-insensitively and requires to be unique`,
          );
        }
        addNotetype(data, notetype, now);
        addedNotetypes.set(notetype.id, notetype);
        notetypeNames.set(unicaseKey(notetype.name), notetype);
      }
    }
  }

  // Anki's import resolves every deck's `config_id` against the apkg's own
  // `deck_config`, so a NO_PRESET deck needs a row at id=1 or the gather phase
  // fails. Its importer uses INSERT OR IGNORE, so this cannot overwrite the
  // user's own Default.
  if (needPlaceholderConfig && !addedConfigs.has(1)) {
    const placeholder = new DeckConfig({ id: 1, name: "Default" });
    addDeckConfig(data, placeholder, now);
    addedConfigs.set(1, placeholder);
  }

  for (const { note, deckId } of allNotes) {
    cardPosition = await addNote(data, idGen, note, deckId, now, cardPosition);
  }

  return data;
}

export function addDeckConfig(data: CollectionData, config: DeckConfig, now: number): void {
  data.deckConfig.push({
    id: config.id,
    name: config.name,
    mtimeSecs: now,
    usn: -1,
    config: toBinary(DeckConfig_ConfigSchema, config.toProtobuf()),
  });
}

export function addDeck(data: CollectionData, deck: Deck, now: number): void {
  // Every collection has a preset at id 1 (storage/deckconfig add_default_deck_config),
  // so a NO_PRESET deck points there and inherits the user's own default.
  const config = deck.getEffectiveConfig();
  const configId = config === NO_PRESET ? 1n : BigInt(config.id);

  const kindContainer = create(Deck_KindContainerSchema, {
    kind: {
      case: "normal",
      value: create(Deck_NormalSchema, { configId, description: deck.description ?? "" }),
    },
  });

  // Anki resolves parents from the native name, and creates any that are
  // missing on import (`match_or_create_parents`), so only the leaf is shipped.
  data.decks.push({
    id: deck.id,
    name: toNativeDeckName(deck.name),
    mtimeSecs: now,
    usn: -1,
    common: toBinary(Deck_CommonSchema, create(Deck_CommonSchema, {})),
    kind: toBinary(Deck_KindContainerSchema, kindContainer),
  });
}

export function addNotetype(data: CollectionData, notetype: Notetype, now: number): void {
  data.notetypes.push({
    id: notetype.id,
    name: notetype.name,
    mtimeSecs: now,
    usn: -1,
    config: toBinary(Notetype_ConfigSchema, notetype.toNotetypeConfigProtobuf()),
  });

  notetype.fields.forEach((field, ord) => {
    data.fields.push({
      ntid: notetype.id,
      ord,
      name: field.name,
      config: toBinary(Notetype_Field_ConfigSchema, notetype.toFieldConfigProtobuf(ord)),
    });
  });

  notetype.templates.forEach((tmpl, ord) => {
    data.templates.push({
      ntid: notetype.id,
      ord,
      name: tmpl.name,
      mtimeSecs: now,
      usn: -1,
      config: toBinary(Notetype_Template_ConfigSchema, notetype.toTemplateConfigProtobuf(ord)),
    });
  });
}

async function addNote(
  data: CollectionData,
  idGen: IdGenerator,
  note: Note,
  deckId: number,
  now: number,
  cardPosition: number,
): Promise<number> {
  const noteId = idGen.next();
  // Card generation reads the same values that get stored, so a stripped
  // character cannot make the cards disagree with the row.
  const storedFields = note.fields.map(stripInvalidFieldChars);

  const guid = note.guid ?? generateGuid();
  // Anki's guid map holds one note per guid, so only one of the two can ever be
  // the target of a later release.
  if (data.notes.some((row) => row.guid === guid)) {
    fail(
      "invalid-input",
      `Two notes in this package share the guid ${JSON.stringify(guid)}. Both would be ` +
        `imported, and a later release could only ever update one of them.`,
    );
  }

  data.notes.push({
    id: noteId,
    guid,
    mid: note.notetype.id,
    mod: now,
    usn: -1,
    tags: joinTags(note.tags),
    flds: storedFields.join(FIELD_SEPARATOR),
    sfld: stripHtmlPreservingMediaFilenames(storedFields[note.notetype.sortFieldIndex ?? 0] ?? ""),
    csum: await fieldChecksum(stripHtmlPreservingMediaFilenames(storedFields[0] ?? "")),
    flags: 0,
    data: "",
  });

  return addCards(data, idGen, note, storedFields, noteId, deckId, now, cardPosition);
}

/** Returns the next free card position. */
function addCards(
  data: CollectionData,
  idGen: IdGenerator,
  note: Note,
  fields: string[],
  noteId: number,
  deckId: number,
  now: number,
  startPosition: number,
): number {
  const ords = wantedCardOrds(
    {
      isCloze: note.notetype.type === "cloze",
      fieldNames: note.notetype.fields.map((field) => field.name),
      questionFormats: note.notetype.templates.map((tmpl) => tmpl.questionFormat),
    },
    fields,
    note.tags.length > 0,
    // A note being built has no cards yet, so the fallback always applies.
    true,
  );

  // Anki fills `CardGenCache::next_position` once per note and reuses it for
  // every card of that note, so siblings stay together in the new queue and one
  // note consumes one position.
  for (const ord of ords) {
    data.cards.push(
      newCardRow({ id: idGen.next(), nid: noteId, did: deckId, ord, due: startPosition, mod: now }),
    );
  }

  return ords.length > 0 ? startPosition + 1 : startPosition;
}

interface ClozeMarker {
  values: number[];
  children: ClozeMarker[];
}

/**
 * Anki's cloze rules (`rslib/src/cloze.rs`, `new_cards_required_cloze`): the ordinal is n-1
 * capped at 499, c0 is dropped, and nesting is tracked only 10 deep.
 */
function extractClozeOrds(fields: string[], forceFirst = true): number[] {
  const ords = new Set<number>();

  for (const field of fields) {
    for (const marker of parseClozeMarkers(field)) {
      collectClozeOrds(marker, ords);
    }
  }

  if (ords.size > 0) return [...ords].sort((a, b) => a - b);
  return forceFirst ? [0] : [];
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
  return /^(?:[\t\n\v\f\r ]|<\/?(?:br|div) ?\/?>)*$/i.test(text);
}

/** What a notetype contributes to deciding which cards a note has. */
export interface CardGenNotetype {
  isCloze: boolean;
  fieldNames: string[];
  questionFormats: string[];
}

/**
 * The ordinals a note should have cards for. Both halves of the library call
 * this, so building a package and editing one cannot disagree about which
 * cards a note gets.
 *
 * `forceFirst` is Anki's `ensure_not_empty`, which applies only when the note
 * would otherwise end up with no cards at all.
 */
export function wantedCardOrds(
  notetype: CardGenNotetype,
  values: string[],
  hasTags: boolean,
  forceFirst: boolean,
): number[] {
  if (notetype.isCloze) return extractClozeOrds(values, forceFirst);

  const nonempty = nonemptyFieldNames(notetype.fieldNames, values, hasTags);
  const ords = notetype.questionFormats
    .map((qfmt, ord) => (templateRenders(qfmt, nonempty) ? ord : -1))
    .filter((ord) => ord >= 0);
  return ords.length === 0 && forceFirst ? [0] : ords;
}

/**
 * The field names a template may treat as content, per Anki's card generator.
 * Takes names and values rather than a Note, so editing an existing collection
 * decides card generation exactly the way building one does.
 */
function nonemptyFieldNames(fieldNames: string[], values: string[], hasTags: boolean): Set<string> {
  const declared = new Set(fieldNames);
  const nonempty = new Set<string>();

  fieldNames.forEach((name, index) => {
    if (!fieldIsEmpty(values[index] ?? "")) nonempty.add(name);
  });

  for (const special of SPECIAL_FIELD_NAMES) {
    if (special === "FrontSide" || declared.has(special)) continue;
    if (special === "Tags" && !hasTags) continue;
    nonempty.add(special);
  }

  return nonempty;
}
