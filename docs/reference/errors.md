---
title: Errors
description: Every AnkipackError code, what raises it and what to do about it. Errors carry a machine-readable code so callers branch on that rather than on message text.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/reference/errors
  type: reference

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: beginner
  time_estimate: 4m

  status: stable

  aliases:
    [
      AnkipackError,
      AnkipackErrorCode,
      deck-not-found,
      notetype-not-found,
      name-conflict,
      id-conflict,
      invalid-input,
      media-name,
      invalid-package,
      unsupported-schema,
      invalid-document,
    ]
---

# Errors

Every error ankipack throws is an `AnkipackError` carrying a `code`. Messages
are free to change between versions; codes are not, so branch on the code.

```ts
import { AnkipackError, Collection } from "ankipack";

declare const col: Collection;

try {
  await col.addNote({ notetype: "Basic", deck: "Missing", fields: ["a", "b"] });
} catch (error) {
  if (error instanceof AnkipackError && error.code === "deck-not-found") {
    // handle it
  }
}
```

`AnkipackError` extends `Error`. The `AnkipackErrorCode` type is exported for
exhaustive switching.

| Code                 | Raised when                                           |
| -------------------- | ----------------------------------------------------- |
| `deck-not-found`     | You named a deck the collection does not contain      |
| `notetype-not-found` | You named a note type the collection does not contain |
| `name-conflict`      | The name is taken, comparing without case             |
| `id-conflict`        | The id is taken                                       |
| `invalid-input`      | A value Anki would not store as given                 |
| `media-name`         | A filename Anki would rewrite                         |
| `invalid-package`    | The bytes are not a readable `.apkg`                  |
| `unsupported-schema` | A collection layout this version does not model       |
| `invalid-document`   | `col.data` is in a state Anki's importer would reject |

## deck-not-found, notetype-not-found

Raised by `col.addNote` and `col.renameDeck` when the named deck or note type
is not in the collection. Names are matched with full Unicode case folding, so
this is a genuine absence rather than a spelling of the wrong case.

Add it first with `col.addDeck` or `col.addNotetype`.

## name-conflict

The name is already used, comparing the way Anki's own indexes do. Raised by
`col.addDeck`, `col.addNotetype` and `col.renameDeck`, and by `Package` at
build time when two decks, or two note types, in the same package have names
that fold to one.

This fires on names that look distinct. Anki folds case across the full Unicode
range, so `Straße` and `Strasse` collide. Left to Anki, the second one's
contents would merge into the first on import.

## id-conflict

The id is already used. Raised by `col.addDeck` and `col.addNotetype`, and also
when a preset or note type you are adding has the id of an existing one under a
different name, because your object would silently take on the existing one's
settings instead of being added.

`Package` raises it too, at build time, when two decks, two presets or two note
types in the same package share an id.

## invalid-input

The largest category: a value ankipack will not pass through because Anki would
rewrite, drop or refuse it. The message names the value and what Anki would do
with it.

Common causes:

- A note's `fields` array whose length does not match its note type
- A tag that is empty, or holds a space, a control character or a lone surrogate
- A field or note type name Anki would strip characters from, trim, or normalise
- Two fields or two templates differing only in case
- A deck preset value outside its range, or a fraction where Anki stores a whole number
- `easyDaysPercentages` that is not 0 or 7 entries, or `fsrsParams` shorter than 21
- A lone surrogate, or a NUL in a name or GUID
- A GUID already used by another note
- An `id` that is not a safe integer, on a `Deck`, `Notetype` or `DeckConfig`
- A media filename passed to `addMedia` that was already added

Why these throw instead of being corrected is
[explained separately](../explanation/validation.md).

## media-name

A media filename Anki would not store as given. Anki refuses an entire package
over one unnormalised name, so this is refused at the call that supplied it.

The message says which rule the name breaks. The rules and what to do about
them are on the [media how-to](../how-to/media.md). The answer is always to
rename the file, because ankipack renaming it would break the template
reference that points at it.

## invalid-package

Raised by `Collection.open` for anything that stops the package being read at
all:

- The bytes are not a zip, which usually means a truncated download
- The archive is missing a file its own metadata says it has
- A member does not decompress
- The `meta` record is damaged
- The collection is not readable SQLite
- The collection has no `col` row
- A schema 11 collection's `col` JSON column does not parse
- A legacy media index is not the JSON object it should be
- A modern media index is not decodable protobuf
- A text column contains a NUL

The last is the one most likely to turn up in a real file.

## unsupported-schema

The package is a valid archive whose collection ankipack does not fully model.
Three cases raise it:

- A collection at a schema other than 11 or 18
- A package declaring an archive layout version ankipack does not know, which
  means it was written by a newer Anki
- A filtered deck inside a schema 11 package

Reading is refused rather than partial. The
[format page](../explanation/apkg-format.md) covers each case.

Re-exporting the deck from a current Anki produces a file ankipack can read.

## invalid-document

The document does not hold together. Two things raise it, and they need
catching in different places.

The whole-document sweep runs at `toUint8Array`, not at the edit that caused
it. `col.data` is the escape hatch, so it is checked when the file is written,
with the offending row named.

Anything that cannot proceed without a consistent document raises it where it
stands. Reading `notetypeName` or `fieldNames`, or calling `setFields`, needs
the note's note type, so each throws when the collection does not contain it.
And a field edit that has to generate a card needs somewhere to put it, so
`setField` and `setFields` throw on a collection holding no deck, though only
when the note has no existing card to inherit a deck from. `col.addNote` names
its deck, so it raises `deck-not-found` instead and never reaches this.

Neither case needs an edit to trigger it: a package can arrive in that state.

What the sweep checks:

- Duplicate ids in `notes`, `cards`, `decks`, `notetypes` or `deck_config`
- Duplicate names among decks, note types or presets, comparing without case
- A note referring to a note type the collection does not contain
- A note whose field count does not match its note type
- A card referring to a note or deck the collection does not contain
- Two cards on the same note and template ordinal
- A deck referring to a preset the package does not carry
- A media filename Anki would rewrite
- More media files than a zip's entry count can hold

Each of these otherwise reaches the recipient as a refused import, a deck that
imports empty, or a bare SQLite constraint message naming nothing.

Duplicate note GUIDs are deliberately **not** checked here, though they are
refused where ankipack creates one. Anki's schema puts no index on `notes.guid`,
so a real collection can arrive holding a duplicate pair and has to be written
back unchanged.
