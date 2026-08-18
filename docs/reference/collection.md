---
title: Collection and CollectionNote
description: Every method for opening an existing .apkg, finding notes, editing them and writing the file back, including the filter asymmetry that makes a subdeck search silently match nothing.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/reference/collection
  type: reference

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: intermediate
  time_estimate: 8m

  status: stable

  aliases:
    [
      Collection,
      CollectionNote,
      Collection.open,
      addNote,
      removeNote,
      renameDeck,
      setField,
      setFields,
      addTag,
      subdecks,
    ]

  references:
    - https://docs.ankiweb.net/templates/generation.html
---

# Collection and CollectionNote

`Package` builds a new `.apkg`. `Collection` opens one that already exists so
it can be changed and written back.

```ts
import { readFile, writeFile } from "node:fs/promises";
import initSqlJs from "sql.js";
import { Collection } from "ankipack";

const SQL = await initSqlJs();
const col = Collection.open(await readFile("deck.apkg"), SQL);

for (const note of col.notes({ tag: "chapter1" })) {
  await note.setField("Back", note.field("Back").trim());
  note.addTag("cleaned");
}

await writeFile("deck.apkg", await col.toUint8Array(SQL));
```

Every row read is kept, including tables ankipack has no API for. Review
history, scheduling state and collection settings are written back as they
arrived, so editing a shared deck does not reset what its users have already
studied.

A schema 11 package is the exception: reading one converts it, which is what
Anki's own upgrade does, so the result is equivalent rather than identical. See
[the format page](../explanation/apkg-format.md).

## Opening and saving

| Method                        | Returns               | Description                                                                        |
| ----------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `Collection.open(bytes, SQL)` | `Collection`          | Reads an `.apkg`. Accepts all three archive layouts, at collection schema 11 or 18 |
| `Collection.fromData(data)`   | `Collection`          | Wraps a document built elsewhere, such as `await pkg.toCollection()`               |
| `col.toUint8Array(SQL)`       | `Promise<Uint8Array>` | Serialises back to an `.apkg` in Anki's current layout                             |

`open` throws `invalid-package` if the bytes are not an `.apkg` or a declared
file is missing, and `unsupported-schema` for a collection layout ankipack does
not fully model. Reading is refused rather than partial.

`toUint8Array` validates the document first and throws `invalid-document` with
the offending row named. It always writes the current layout, whatever was read.

## Finding notes

| Method               | Returns                       | Description                                      |
| -------------------- | ----------------------------- | ------------------------------------------------ |
| `col.notes(filter?)` | `CollectionNote[]`            | Notes, optionally filtered                       |
| `col.note(id)`       | `CollectionNote \| undefined` | A single note by id                              |
| `col.deckNames()`    | `string[]`                    | Deck names as Anki displays them, `::` separated |

`filter` accepts `deck`, `tag` and `notetype`, and combines them with AND.
`deck` and `notetype` are matched the way Anki's own indexes match them, with
full Unicode case folding, so the case you type does not decide whether your
deck exists.

!!! warning "Two filters return nothing without reporting it"
    `tag` is matched **exactly**, unlike the other two. A tag differing in case
    is a different tag here.

    `deck` names **one deck, not its subdecks**. Filtering on `Spanish` when the
    notes live in `Spanish::Vocabulary` matches nothing at all. Name the
    subdeck, or filter the results of `deckNames()` yourself.

## Changing the collection

| Method                                                        | Returns          | Description                                            |
| ------------------------------------------------------------- | ---------------- | ------------------------------------------------------ |
| `await col.addNote({ notetype, deck, fields, tags?, guid? })` | `CollectionNote` | Adds a note using a note type and deck already present |
| `col.removeNote(id)`                                          | `void`           | Removes a note, its cards and its review log           |
| `await col.addDeck(deck)`                                     | `void`           | Adds a `Deck`, its preset, and any notes it holds      |
| `col.addNotetype(notetype)`                                   | `void`           | Adds a `Notetype`, so `addNote` can use it             |
| `col.renameDeck(from, to)`                                    | `void`           | Renames a deck and every subdeck under it              |
| `col.setMedia(name, data)`                                    | `void`           | Adds or replaces a media file                          |
| `col.removeMedia(name)`                                       | `void`           | Removes one                                            |

`addNote` throws `notetype-not-found` or `deck-not-found` if either is absent,
`invalid-input` on a field count mismatch, and refuses a `guid` the collection
already holds, because Anki would treat that as an edit of the existing note
rather than a new one.

`addDeck` and `addNotetype` take the same objects used to build a package from
scratch. They throw `name-conflict` or `id-conflict` when the name or id is
taken, comparing names without case. `addDeck` is transactional: if a note
partway through is refused, the collection is restored rather than left holding
half a deck.

`renameDeck` renames the deck and every subdeck under it. It throws
`name-conflict` if any resulting name is taken, and `deck-not-found` if the
name you give is not a deck row in its own right: a package whose only deck is
`Spanish::Vocabulary` has no `Spanish` row to rename, so add one with `addDeck`
first. Renaming affects your file only, since Anki matches decks by name on
import and a recipient gets the renamed deck alongside the old one.

`removeNote` also records graves, which stop a syncing client resurrecting the
note. They do not delete anything on a recipient's side, because
[the `.apkg` importer never reads them](../explanation/anki-import.md).

## CollectionNote

| Member                              | Type       | Description                                                                                   |
| ----------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `id`                                | `number`   | Note id                                                                                       |
| `guid`                              | `string`   | Note GUID                                                                                     |
| `notetypeName`                      | `string`   | Name of its note type                                                                         |
| `fieldNames`                        | `string[]` | Field names, in order                                                                         |
| `fields`                            | `string[]` | Field values, in order                                                                        |
| `tags`                              | `string[]` | Tags                                                                                          |
| `field(name)`                       | `string`   | One field by name. Throws `invalid-input` if the note type has no such field                  |
| `await setField(name, value)`       | `void`     | Replaces one field                                                                            |
| `await setFields(values, options?)` | `void`     | Replaces all of them. Length must match. Pass `{ generateCards: false }` to skip adding cards |
| `setTags(tags)`                     | `void`     | Replaces the tag list                                                                         |
| `addTag(tag)`                       | `void`     | Adds one if absent                                                                            |
| `removeTag(tag)`                    | `void`     | Removes one                                                                                   |
| `row`                               | `NoteRow`  | The underlying row                                                                            |

Tags go through the same rules as they do when
[building a package](./package-deck-note.md).

### What editing a field does

Replacing a field recomputes the sort field and the duplicate-detection
checksum, marks the note changed since the last sync, and adds any card the new
content now renders. That checksum is a SHA1 through the Web Crypto API, which
is the only reason `setField` is async: nothing here touches the disk.

Existing cards are never modified or deleted, following
[Anki's own rule](https://docs.ankiweb.net/templates/generation.html): a card
that stops rendering is left for the Empty Cards tool.

## Reaching past the API

`col.data` is a `CollectionData`, every row of every table, and the documented
escape hatch for the ones with no API of their own. Its shape is on the
[collection document](./collection-document.md) page. Edits there are checked
when the file is written rather than when they are made, which is
[deliberate](../explanation/validation.md).
