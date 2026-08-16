import { fromBinary } from "@bufbuild/protobuf";
import { Deck_KindContainerSchema } from "../generated/anki/decks_pb.js";
import { FIELD_SEPARATOR } from "../util/constants.js";
import { toHumanDeckName } from "../util/text.js";
import { unicaseKey } from "../util/casefold.js";
import { mediaFilenameProblem } from "../util/media-name.js";
import { fail } from "../error.js";
import type { CollectionData } from "./data.js";

/**
 * Checks the document is one Anki's importer would accept.
 *
 * `collection.data` is the public escape hatch, so a caller can reach a state
 * the writer would happily serialise and Anki would then refuse. Checked here,
 * where the offending row can be named.
 *
 * Only what makes a package unusable; anything Anki normalises on import is
 * left alone.
 */
export function assertWritable(data: CollectionData): void {
  uniqueIds("notes", data.notes);
  uniqueIds("cards", data.cards);
  uniqueIds("decks", data.decks);
  uniqueIds("notetypes", data.notetypes);
  uniqueIds("deck_config", data.deckConfig);

  uniqueNames("decks", data.decks, (row) => toHumanDeckName(row.name));
  uniqueNames("notetypes", data.notetypes, (row) => row.name);
  uniqueNames("deck_config", data.deckConfig, (row) => row.name);

  uniqueCardOrdinals(data.cards);
  mediaFilenames(data.media);

  const notetypeIds = new Set(data.notetypes.map((row) => row.id));
  const noteIds = new Set(data.notes.map((row) => row.id));
  const deckIds = new Set(data.decks.map((row) => row.id));

  // Anki's import resolves every deck's preset against the package's own
  // deck_config, and refuses the whole file with "No such deck config".
  const presetIds = new Set(data.deckConfig.map((row) => row.id));
  for (const deck of data.decks) {
    const kind = fromBinary(Deck_KindContainerSchema, deck.kind);
    if (kind.kind.case !== "normal") continue;
    const configId = Number(kind.kind.value.configId);
    if (!presetIds.has(configId)) {
      fail(
        "invalid-document",
        `decks.kind: deck ${JSON.stringify(toHumanDeckName(deck.name))} refers to deck ` +
          `preset ${configId}, which this package does not carry. Anki refuses the whole ` +
          `import for it.`,
      );
    }
  }

  const fieldCounts = new Map<number, number>();
  for (const field of data.fields) {
    fieldCounts.set(field.ntid, (fieldCounts.get(field.ntid) ?? 0) + 1);
  }

  for (const note of data.notes) {
    if (!notetypeIds.has(note.mid)) {
      fail(
        "invalid-document",
        `notes.mid: note ${note.id} refers to note type ${note.mid}, which this ` +
          `collection does not contain. Anki refuses the whole package for it.`,
      );
    }
    const expected = fieldCounts.get(note.mid) ?? 0;
    const actual = note.flds.split(FIELD_SEPARATOR).length;
    if (actual !== expected) {
      fail(
        "invalid-document",
        `notes.flds: note ${note.id} has ${actual} fields but its note type ` +
          `${note.mid} defines ${expected}, which Anki's importer refuses.`,
      );
    }
  }

  for (const card of data.cards) {
    if (!noteIds.has(card.nid)) {
      fail(
        "invalid-document",
        `cards.nid: card ${card.id} refers to note ${card.nid}, which this ` +
          `collection does not contain.`,
      );
    }
    if (!deckIds.has(card.did)) {
      fail(
        "invalid-document",
        `cards.did: card ${card.id} refers to deck ${card.did}, which this ` +
          `collection does not contain.`,
      );
    }
  }
}

/**
 * `(nid, ord)` is one card. Anki's importer inserts both, and only Check
 * Database removes one, so until the recipient runs it they study the same
 * template twice.
 */
function uniqueCardOrdinals(cards: CollectionData["cards"]): void {
  const seen = new Set<string>();
  for (const card of cards) {
    const key = `${card.nid}:${card.ord}`;
    if (seen.has(key)) {
      fail(
        "invalid-document",
        `cards: note ${card.nid} has more than one card at template ordinal ${card.ord}. ` +
          `Anki imports both and only Check Database removes one.`,
      );
    }
    seen.add(key);
  }
}

/**
 * Anki refuses the whole import over a single bad media name
 * (rslib/src/import_export/package/media.rs `from_entry`).
 */
function mediaFilenames(media: CollectionData["media"]): void {
  for (const file of media) {
    const problem = mediaFilenameProblem(file.name);
    if (problem !== undefined) {
      fail(
        "invalid-document",
        `media: filename ${JSON.stringify(file.name)} ${problem}. Anki refuses the whole ` +
          `import over one bad name.`,
      );
    }
  }
}

/**
 * `decks.name` and `notetypes.name` carry a UNIQUE index. `deck_config.name`
 * does not, but two presets a user cannot tell apart are worth refusing too.
 * All three fold through Anki's case-insensitive collation.
 */
function uniqueNames<T>(table: string, rows: readonly T[], name: (row: T) => string): void {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const value = name(row);
    const key = unicaseKey(value);
    const clash = seen.get(key);
    if (clash !== undefined) {
      fail(
        "invalid-document",
        `${table}.name: ${JSON.stringify(clash)} and ${JSON.stringify(value)} are one name ` +
          `to Anki, which compares them case-insensitively.`,
      );
    }
    seen.set(key, value);
  }
}

function uniqueIds(table: string, rows: ReadonlyArray<{ id: number }>): void {
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      fail(
        "invalid-document",
        `${table}: duplicate id ${row.id}, which the schema does not allow.`,
      );
    }
    seen.add(row.id);
  }
}
