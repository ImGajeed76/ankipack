import type { SqlJsStatic } from "sql.js";
import { fromBinary } from "@bufbuild/protobuf";
import {
  Notetype_ConfigSchema,
  Notetype_Config_Kind,
  Notetype_Template_ConfigSchema,
} from "../generated/anki/notetypes_pb.js";
import { fieldChecksum } from "../util/checksum.js";
import { FIELD_SEPARATOR } from "../util/constants.js";
import { IdGenerator } from "../util/id.js";
import { generateGuid } from "../util/guid.js";
import {
  rejectLoneSurrogates,
  rejectNul,
  stripHtmlPreservingMediaFilenames,
  stripInvalidFieldChars,
  toHumanDeckName,
  toNativeDeckName,
  toNormalizedDeckName,
} from "../util/text.js";
import { unicaseKey } from "../util/casefold.js";
import { assertMediaFilename } from "../util/media-name.js";
import { assertTag } from "../util/tags.js";
import type { Deck } from "../deck.js";
import { NO_PRESET } from "../deck.js";
import { DeckConfig } from "../deck-config.js";
import type { Notetype } from "../notetype.js";
import { fail } from "../error.js";
import { addDeck, addDeckConfig, addNotetype, wantedCardOrds } from "./build.js";
import { joinTags, newCardRow, nextFreeId, nextNewCardPosition, splitTags } from "./data.js";
import type { CollectionData, DeckRow, NoteRow, NotetypeRow } from "./data.js";
import { readPackage } from "./read.js";
import { writePackage } from "./write.js";

/** What a note's notetype says about generating its cards. */
interface NotetypeInfo {
  id: number;
  name: string;
  isCloze: boolean;
  sortFieldIndex: number;
  fieldNames: string[];
  questionFormats: string[];
  /** Per template, the deck its cards go to, or 0 to follow the note. */
  targetDeckIds: number[];
}

/**
 * An existing collection, opened for editing.
 *
 * Every row read stays in the document, so anything not edited here is written
 * back exactly as it arrived, review history and scheduling included.
 *
 * @example
 * ```ts
 * const col = Collection.open(bytes, SQL);
 * for (const note of col.notes({ tag: "chapter1" })) {
 *   await note.setField("Back", "der Hund");
 * }
 * const out = await col.toUint8Array(SQL);
 * ```
 */
export class Collection {
  readonly data: CollectionData;
  private readonly idGen: IdGenerator;
  private notetypeCache = new Map<number, NotetypeInfo>();

  private constructor(data: CollectionData) {
    this.data = data;
    // Seeded past what the document already uses, not from the clock: a package
    // built moments ago holds ids in the future.
    this.idGen = new IdGenerator(nextFreeId(data));
  }

  /** Reads an `.apkg`. Throws if it is not a schema ankipack fully models. */
  static open(bytes: Uint8Array, SQL: SqlJsStatic): Collection {
    return new Collection(readPackage(bytes, SQL).data);
  }

  /** Wraps a document produced elsewhere, such as `Package.toCollection()`. */
  static fromData(data: CollectionData): Collection {
    return new Collection(data);
  }

  /** Serialises to an `.apkg` in Anki's latest layout. */
  toUint8Array(SQL: SqlJsStatic): Promise<Uint8Array> {
    return writePackage(this.data, SQL);
  }

  /** Deck names as Anki displays them, `::` separated. */
  deckNames(): string[] {
    return this.data.decks.map((deck) => toHumanDeckName(deck.name));
  }

  /**
   * Notes, optionally filtered. `deck` and `notetype` are matched the way
   * Anki's own indexes match them, without regard to case; `tag` is exact.
   */
  notes(filter?: { deck?: string; tag?: string; notetype?: string }): CollectionNote[] {
    let rows = this.data.notes;

    if (filter?.deck !== undefined) {
      const deck = this.deckNamed(filter.deck);
      const deckIds = new Set(deck === undefined ? [] : [deck.id]);
      const noteIds = new Set(this.data.cards.filter((c) => deckIds.has(c.did)).map((c) => c.nid));
      rows = rows.filter((note) => noteIds.has(note.id));
    }

    if (filter?.tag !== undefined) {
      const wanted = filter.tag;
      rows = rows.filter((note) => splitTags(note.tags).includes(wanted));
    }

    if (filter?.notetype !== undefined) {
      const notetype = this.notetypeNamed(filter.notetype);
      rows = rows.filter((note) => note.mid === notetype?.id);
    }

    return rows.map((row) => new CollectionNote(this, row));
  }

  /** The single note with this id, or undefined. */
  note(id: number): CollectionNote | undefined {
    const row = this.data.notes.find((note) => note.id === id);
    return row ? new CollectionNote(this, row) : undefined;
  }

  /**
   * Adds a note to an existing deck, generating its cards the same way building
   * a package does.
   *
   * @throws If the notetype or deck is not already in the collection, or the
   * field count does not match the notetype.
   */
  async addNote(options: {
    notetype: string;
    deck: string;
    fields: string[];
    tags?: string[];
    guid?: string;
  }): Promise<CollectionNote> {
    const notetype = this.notetypeNamed(options.notetype);
    if (notetype === undefined) {
      fail(
        "notetype-not-found",
        `No note type named ${JSON.stringify(options.notetype)} in this collection`,
      );
    }
    const deck = this.deckNamed(options.deck);
    if (deck === undefined) {
      fail("deck-not-found", `No deck named ${JSON.stringify(options.deck)} in this collection`);
    }

    if (options.guid !== undefined) {
      rejectNul(options.guid, "Note guid");
      rejectLoneSurrogates(options.guid, "Note guid");
      // The edit keeps that note's cards and review log and replaces its fields.
      if (this.data.notes.some((row) => row.guid === options.guid)) {
        fail(
          "invalid-input",
          `Note guid ${JSON.stringify(options.guid)} is already used by a note in this ` +
            `collection. Anki would treat this as an edit of that note, not a new one.`,
        );
      }
    }
    const tags = options.tags ?? [];
    for (const tag of tags) assertTag(tag);

    const row: NoteRow = {
      id: this.idGen.next(),
      guid: options.guid ?? generateGuid(),
      mid: notetype.id,
      mod: nowSecs(),
      usn: -1,
      tags: joinTags(tags),
      flds: "",
      sfld: "",
      csum: 0,
      flags: 0,
      data: "",
    };

    // Everything that can be refused is refused before the row joins the
    // document, so a rejected call leaves no half-built note behind.
    const note = new CollectionNote(this, row);
    await note.setFields(options.fields, { generateCards: false });
    this.data.notes.push(row);
    this.addMissingCards(row, deck.id);
    return note;
  }

  /**
   * Adds a deck, its preset, and any notes it already holds along with the note
   * types those notes use.
   *
   * @throws If the name or id is one the collection already uses. Anki compares
   * deck names without regard to case, so a name differing only in case would
   * merge the two decks on import rather than adding one.
   */
  async addDeck(deck: Deck): Promise<void> {
    const clash = this.deckNamed(deck.name);
    if (clash !== undefined) {
      fail(
        "name-conflict",
        `A deck named ${JSON.stringify(toHumanDeckName(clash.name))} already exists, and ` +
          `Anki compares deck names case-insensitively`,
      );
    }
    if (this.data.decks.some((row) => row.id === deck.id)) {
      fail("id-conflict", `A deck with id ${deck.id} already exists in this collection`);
    }

    // A note partway through the deck can still be refused, and half a deck is
    // worse than none: the caller sees an error and the document has changed
    // anyway. Every row this adds is new, so restoring the arrays undoes it.
    const undo = {
      decks: [...this.data.decks],
      deckConfig: [...this.data.deckConfig],
      notetypes: [...this.data.notetypes],
      fields: [...this.data.fields],
      templates: [...this.data.templates],
      notes: [...this.data.notes],
      cards: [...this.data.cards],
    };

    try {
      const config = deck.getEffectiveConfig();
      if (config === NO_PRESET) {
        // A NO_PRESET deck points at preset 1, and Anki's gather pass resolves
        // that against the package's own deck_config, so the row has to exist.
        // Its importer uses INSERT OR IGNORE, so it cannot overwrite the user's.
        if (!this.data.deckConfig.some((row) => row.id === 1)) {
          addDeckConfig(this.data, new DeckConfig({ id: 1, name: "Default" }), nowSecs());
        }
      } else {
        const existing = this.data.deckConfig.find((row) => row.id === config.id);
        if (existing === undefined) {
          addDeckConfig(this.data, config, nowSecs());
        } else if (existing.name !== config.name) {
          fail(
            "id-conflict",
            `A deck preset with id ${config.id} already exists, named ` +
              `${JSON.stringify(existing.name)}, so ${JSON.stringify(config.name)} would ` +
              `silently inherit its settings`,
          );
        }
      }
      addDeck(this.data, deck, nowSecs());

      for (const note of deck.notes) {
        const known = this.data.notetypes.find((nt) => nt.id === note.notetype.id);
        if (known === undefined) {
          this.addNotetype(note.notetype);
        } else if (known.name !== note.notetype.name) {
          fail(
            "id-conflict",
            `A note type with id ${note.notetype.id} already exists, named ` +
              `${JSON.stringify(known.name)}, so ${JSON.stringify(note.notetype.name)} would ` +
              `silently inherit its fields and templates`,
          );
        }
        await this.addNote({
          notetype: note.notetype.name,
          deck: deck.name,
          fields: note.fields,
          tags: note.tags,
          guid: note.guid,
        });
      }
    } catch (error) {
      Object.assign(this.data, undo);
      this.notetypeCache.clear();
      throw error;
    }
  }

  /**
   * Adds a note type, so `addNote` can use it.
   *
   * @throws If the name or id is one the collection already uses. Anki's
   * notetypes.name index is case-insensitive, so a name differing only in case
   * arrives renamed and the templates shipped with it stop resolving.
   */
  addNotetype(notetype: Notetype): void {
    const clash = this.notetypeNamed(notetype.name);
    if (clash !== undefined) {
      fail(
        "name-conflict",
        `A note type named ${JSON.stringify(clash.name)} already exists, and Anki ` +
          `compares note type names case-insensitively`,
      );
    }
    if (this.data.notetypes.some((row) => row.id === notetype.id)) {
      fail("id-conflict", `A note type with id ${notetype.id} already exists in this collection`);
    }
    addNotetype(this.data, notetype, nowSecs());
    this.notetypeCache.delete(notetype.id);
  }

  /**
   * Removes a note, its cards, and its review log, and records the deletions so
   * a syncing client removes them too rather than resurrecting them.
   */
  removeNote(id: number): void {
    if (!this.data.notes.some((note) => note.id === id)) return;

    const cardIds = new Set(
      this.data.cards.filter((card) => card.nid === id).map((card) => card.id),
    );
    this.data.cards = this.data.cards.filter((card) => card.nid !== id);
    this.data.revlog = this.data.revlog.filter((entry) => !cardIds.has(entry.cid));
    this.data.notes = this.data.notes.filter((note) => note.id !== id);
    // Anki's grave types: 0 card, 1 note, 2 deck (rslib/src/storage/graves).
    // `graves` is keyed on (oid, type), so a repeated row fails the write.
    for (const cardId of cardIds) this.grave(cardId, 0);
    this.grave(id, 1);
  }

  private grave(oid: number, type: number): void {
    if (this.data.graves.some((g) => g.oid === oid && g.type === type)) return;
    this.data.graves.push({ oid, type, usn: -1 });
  }

  /**
   * Renames a deck and its subdecks, the way Anki's `rename_child_decks` does.
   * Renaming only the parent would leave the children under a deck Anki then
   * recreates on import, splitting the tree in two.
   */
  renameDeck(from: string, to: string): void {
    const deck = this.deckNamed(from);
    if (deck === undefined) fail("deck-not-found", `No deck named ${JSON.stringify(from)}`);
    rejectLoneSurrogates(to, `Deck name ${JSON.stringify(to)}`);

    const native = deck.name;
    const target = toNativeDeckName(to);
    const prefix = unicaseKey(`${native}${FIELD_SEPARATOR}`);
    const moving = this.data.decks.filter(
      (d) => d === deck || unicaseKey(d.name).startsWith(prefix),
    );
    const staying = this.data.decks.filter((d) => !moving.includes(d));

    // Rebuilt from components, as `NativeDeckName::reparent` does. Children are
    // selected on the folded name, which can differ in length from the stored
    // one, so a prefix of the parent's length cuts in the wrong place.
    const depth = native.split(FIELD_SEPARATOR).length;
    const reparented = (name: string): string =>
      [target, ...name.split(FIELD_SEPARATOR).slice(depth)].join(FIELD_SEPARATOR);

    // Anki's deck name index is case-insensitive, so a name differing only in
    // case is not a free slot: its cards would merge into the other deck. Every
    // subdeck moves too, and `rename_child_decks` does not uniquify them, so a
    // child landing on a taken name breaks the unique index rather than the
    // rename.
    for (const row of moving) {
      const renamed = reparented(row.name);
      const clash = staying.find((other) => unicaseKey(other.name) === unicaseKey(renamed));
      if (clash !== undefined) {
        fail(
          "name-conflict",
          `Renaming ${JSON.stringify(from)} to ${JSON.stringify(toNormalizedDeckName(to))} ` +
            `would name a deck ${JSON.stringify(toHumanDeckName(renamed))}, and ` +
            `${JSON.stringify(toHumanDeckName(clash.name))} already exists. Anki compares ` +
            `deck names case-insensitively.`,
        );
      }
    }

    const now = nowSecs();
    for (const row of moving) {
      row.name = reparented(row.name);
      row.usn = -1;
      row.mtimeSecs = now;
    }
  }

  /** Adds or replaces a media file. */
  setMedia(name: string, data: Uint8Array): void {
    assertMediaFilename(name);
    const existing = this.data.media.findIndex((file) => file.name === name);
    if (existing >= 0) this.data.media[existing] = { name, data };
    else this.data.media.push({ name, data });
  }

  removeMedia(name: string): void {
    this.data.media = this.data.media.filter((file) => file.name !== name);
  }

  /** @internal */
  notetypeFor(row: NoteRow): NotetypeInfo {
    const cached = this.notetypeCache.get(row.mid);
    if (cached) return cached;

    const notetype = this.data.notetypes.find((nt) => nt.id === row.mid);
    if (notetype === undefined) {
      fail(
        "invalid-document",
        `Note ${row.id} refers to notetype ${row.mid}, which is not in the package`,
      );
    }
    const config = fromBinary(Notetype_ConfigSchema, notetype.config);
    const templateConfigs = this.data.templates
      .filter((template) => template.ntid === notetype.id)
      .sort((a, b) => a.ord - b.ord)
      .map((template) => fromBinary(Notetype_Template_ConfigSchema, template.config));
    const info: NotetypeInfo = {
      id: notetype.id,
      name: notetype.name,
      isCloze: config.kind === Notetype_Config_Kind.CLOZE,
      sortFieldIndex: config.sortFieldIdx,
      fieldNames: this.data.fields
        .filter((field) => field.ntid === notetype.id)
        .sort((a, b) => a.ord - b.ord)
        .map((field) => field.name),
      questionFormats: templateConfigs.map((c) => c.qFormat),
      // Anki's cardgen: `did: card.target_deck_id.or(extracted.deck_id)`.
      // ankipack never writes one, but a package it opens can carry one.
      targetDeckIds: templateConfigs.map((c) => Number(c.targetDeckId)),
    };
    this.notetypeCache.set(row.mid, info);
    return info;
  }

  /**
   * Adds cards for ordinals that should exist and do not, leaving every
   * existing card untouched, which is what Anki's `new_cards_required` returns.
   * Cards that stop rendering stay put, as Anki leaves them for Empty Cards.
   *
   * @internal
   */
  addMissingCards(row: NoteRow, targetDeckId?: number): void {
    const info = this.notetypeFor(row);
    const values = row.flds.split(FIELD_SEPARATOR);
    const existing = this.data.cards.filter((card) => card.nid === row.id);

    const wanted = wantedCardOrds(
      { isCloze: info.isCloze, fieldNames: info.fieldNames, questionFormats: info.questionFormats },
      values,
      row.tags.trim().length > 0,
      // Anki forces card 0 only when the note would otherwise have none at all,
      // so a note that still has a card does not gain a blank one.
      existing.length === 0,
    );

    const have = new Set(existing.map((card) => card.ord));
    const missing = wanted.filter((ord) => !have.has(ord));
    if (missing.length === 0) return;

    // `extract_data_from_existing_cards`: a new card joins its siblings, in
    // their home deck rather than a filtered one. Siblings spread across
    // several decks name no deck at all, and the note falls back the way a
    // brand new one does.
    const homeDecks = new Set(existing.map((card) => (card.odid !== 0 ? card.odid : card.did)));
    const deckId =
      (homeDecks.size === 1 ? [...homeDecks][0] : undefined) ??
      targetDeckId ??
      this.defaultDeckId();
    if (deckId === undefined) fail("invalid-document", "Collection has no deck to add cards to");

    // The position comes from the first sibling still waiting to be studied, so
    // the note stays together in the new queue. A studied card reports none.
    const inherited = existing.find((card) => card.type === 0);
    const due =
      inherited === undefined
        ? nextNewCardPosition(this.data)
        : Math.max(0, inherited.odue !== 0 ? inherited.odue : inherited.due);

    const now = nowSecs();
    for (const ord of missing) {
      // A template may name its own deck, which wins over the note's. Anki's
      // cloze generator never reads the override, so neither does this.
      const override = info.isCloze ? 0 : (info.targetDeckIds[ord] ?? 0);
      this.data.cards.push(
        newCardRow({
          id: this.idGen.next(),
          nid: row.id,
          did: override !== 0 ? override : deckId,
          ord,
          due,
          mod: now,
        }),
      );
    }
  }

  /**
   * The deck a caller means by this name. Matched the way Anki's `get_deck_id`
   * does, against the `COLLATE unicase` index, so the case a caller happens to
   * type does not decide whether their deck exists.
   */
  private deckNamed(name: string): DeckRow | undefined {
    const wanted = unicaseKey(toNativeDeckName(name));
    return this.data.decks.find((deck) => unicaseKey(deck.name) === wanted);
  }

  /** The same, for `notetypes.name`, which carries the same unique index. */
  private notetypeNamed(name: string): NotetypeRow | undefined {
    const wanted = unicaseKey(name);
    return this.data.notetypes.find((notetype) => unicaseKey(notetype.name) === wanted);
  }

  /**
   * Anki's `default_deck_conf` is hard-coded to deck 1. A package without one
   * gets its first deck instead.
   */
  private defaultDeckId(): number | undefined {
    return this.data.decks.find((deck) => deck.id === 1)?.id ?? this.data.decks[0]?.id;
  }
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** A note in an opened collection. Edits write through to the document. */
export class CollectionNote {
  constructor(
    private readonly collection: Collection,
    readonly row: NoteRow,
  ) {}

  get id(): number {
    return this.row.id;
  }

  get guid(): string {
    return this.row.guid;
  }

  get notetypeName(): string {
    return this.collection.notetypeFor(this.row).name;
  }

  get fieldNames(): string[] {
    return this.collection.notetypeFor(this.row).fieldNames;
  }

  get fields(): string[] {
    return this.row.flds.split(FIELD_SEPARATOR);
  }

  get tags(): string[] {
    return splitTags(this.row.tags);
  }

  field(name: string): string {
    const index = this.fieldNames.indexOf(name);
    if (index < 0) {
      fail(
        "invalid-input",
        `Note type ${JSON.stringify(this.notetypeName)} has no field ${JSON.stringify(name)}`,
      );
    }
    return this.fields[index] ?? "";
  }

  /** Replaces one field by name. */
  async setField(name: string, value: string): Promise<void> {
    const index = this.fieldNames.indexOf(name);
    if (index < 0) {
      fail(
        "invalid-input",
        `Note type ${JSON.stringify(this.notetypeName)} has no field ${JSON.stringify(name)}`,
      );
    }
    const values = this.fields;
    values[index] = value;
    await this.setFields(values);
  }

  /**
   * Replaces every field. Recomputes the sort field and duplicate checksum,
   * marks the note modified and unsynced, and adds any card the new content
   * now renders.
   */
  async setFields(values: string[], options?: { generateCards?: boolean }): Promise<void> {
    const info = this.collection.notetypeFor(this.row);
    if (values.length !== info.fieldNames.length) {
      fail(
        "invalid-input",
        `Note type ${JSON.stringify(info.name)} has ${info.fieldNames.length} fields, got ${values.length}`,
      );
    }
    values.forEach((value, index) => {
      rejectLoneSurrogates(value, `Field ${JSON.stringify(info.fieldNames[index])}`);
    });
    const stored = values.map(stripInvalidFieldChars);
    this.row.flds = stored.join(FIELD_SEPARATOR);
    this.row.sfld = stripHtmlPreservingMediaFilenames(stored[info.sortFieldIndex] ?? "");
    this.row.csum = await fieldChecksum(stripHtmlPreservingMediaFilenames(stored[0] ?? ""));
    this.touch();
    if (options?.generateCards !== false) this.collection.addMissingCards(this.row);
  }

  setTags(tags: string[]): void {
    for (const tag of tags) assertTag(tag);
    this.row.tags = joinTags(tags);
    this.touch();
  }

  addTag(tag: string): void {
    const tags = this.tags;
    if (!tags.includes(tag)) this.setTags([...tags, tag]);
  }

  removeTag(tag: string): void {
    this.setTags(this.tags.filter((existing) => existing !== tag));
  }

  /** Anki treats usn -1 as "changed since the last sync". */
  private touch(): void {
    this.row.mod = nowSecs();
    this.row.usn = -1;
  }
}
