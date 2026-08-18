---
title: Package, Deck and Note
description: The build API. Every option and default on Package, Deck and Note, and every value ankipack refuses to pass through to Anki.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/reference/package-deck-note
  type: reference

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: beginner
  time_estimate: 6m

  status: stable

  aliases:
    [
      Package,
      Deck,
      Note,
      addDeck,
      addMedia,
      addNote,
      writeToFile,
      toUint8Array,
      DeckOptions,
      NoteOptions,
      NO_PRESET,
      collection.apkg,
    ]

  references:
    - https://docs.ankiweb.net/exporting.html
---

# Package, Deck and Note

Building an `.apkg` from scratch takes these three classes and a
[`Notetype`](./notetype.md): notes go into a deck, decks go into a package, and
the package writes the file.

```ts
import initSqlJs from "sql.js";
import { Package, Deck, Note, Notetype } from "ankipack";

const SQL = await initSqlJs();

const my_notetype = Notetype.basic();
const my_deck = new Deck({ name: "Spanish::Vocabulary" });
my_deck.addNote(new Note({ notetype: my_notetype, fields: ["hola", "hello"] }));

const pkg = new Package();
pkg.addDeck(my_deck);
await pkg.writeToFile("spanish.apkg", SQL);
```

The note type has its own page, [`Notetype`](./notetype.md), and so does the
scheduler preset a deck can carry, [`DeckConfig`](./deck-config.md). To open and
change an `.apkg` that already exists rather than build one, use
[`Collection`](./collection.md).

## Package

A container for decks and media that produces the final file. It has no
constructor options.

| Method                     | Returns                   | Description                                                                                                        |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `addDeck(deck)`            | `void`                    | Adds a deck. A package may hold several                                                                            |
| `addMedia(filename, data)` | `void`                    | Attaches a media file. Throws `invalid-input` if the name was already added, `media-name` if Anki would rewrite it |
| `toUint8Array(SQL)`        | `Promise<Uint8Array>`     | Builds the `.apkg` in memory                                                                                       |
| `writeToFile(path, SQL)`   | `Promise<void>`           | Builds it and writes it to disk. Node and Bun only                                                                 |
| `toCollection()`           | `Promise<CollectionData>` | The document the package describes, before serialisation                                                           |

`SQL` is an initialised sql.js instance, which you create and pass in. In Node
and Bun `initSqlJs()` needs no arguments; in a browser or an extension see
[generating a deck in the browser](../how-to/browser.md).

Both build methods throw `invalid-input` if the package contains no decks, and
validate the whole document before writing. `toCollection` is the bridge to the
editing API: pass its result to `Collection.fromData` to adjust something the
builder has no option for before writing.

`addMedia` applies Anki's filename rules in full, because a package carrying a
single unnormalised name is refused whole. The rules are on the
[media how-to](../how-to/media.md).

### Naming the output file

!!! danger "Two filenames Anki does not treat as a deck"
    Anki's desktop importer decides what a file is from its name before it
    opens it. A file called `collection.apkg`, or any name matching
    `backup-*.apkg`, is handled as a **collection package**: importing it
    replaces the user's entire collection rather than adding your deck to it.

    Anki asks first, with a dialog defaulting to No, but your deck cannot be
    installed. `writeToFile` does not inspect the path, so name the file after
    the deck.

The rule lives in Anki's desktop interface rather than its core, so a tool
importing through the library is unaffected.

## Deck

A named group of notes. Its options are `DeckOptions`.

| Option        | Type                 | Default        | Description                                                                      |
| ------------- | -------------------- | -------------- | -------------------------------------------------------------------------------- |
| `name`        | `string`             | required       | Deck name. `::` separates subdecks, as in `Spanish::Vocabulary`                  |
| `description` | `string`             | `undefined`    | Shown on the deck's overview screen, not the deck list. Accepts HTML             |
| `config`      | `DeckConfig \| null` | auto-generated | Deck options preset. `null` ships none, so the deck uses the recipient's Default |
| `id`          | `number`             | auto           | Custom deck id. Must be a safe integer                                           |

| Method                 | Returns                  | Description                                                                           |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `addNote(note)`        | `void`                   | Adds a note. It generates one card per template that renders, or one per cloze number |
| `getEffectiveConfig()` | `DeckConfig \| NoPreset` | The preset this deck will ship, resolving the default                                 |

Deck ids are reassigned by Anki on import, so a custom `id` only identifies the
deck inside your own package.

Two decks in one package whose names differ only in case are refused. Anki
compares deck names with full Unicode case folding, so it would
[merge them](../explanation/anki-import.md) rather than keep both.

### The three values of `config`

| You pass       | What ships                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------ |
| A `DeckConfig` | That preset, and the deck references it                                                          |
| Nothing        | A generated preset named `"<deck name> Config"`, from the normalised name, with library defaults |
| `null`         | No preset of your own. The deck points at preset id 1, the recipient's own Default               |

With `null` the package still carries a placeholder preset row at id 1, because
a recipient who does import presets would otherwise get a file Anki refuses.
That row cannot overwrite their own Default, since presets are inserted only if
absent.

`getEffectiveConfig()` returns the exported `NO_PRESET` sentinel for a deck
built with `config: null`.

## Note

A single note. Its options are `NoteOptions`.

| Option     | Type       | Default  | Description                                                      |
| ---------- | ---------- | -------- | ---------------------------------------------------------------- |
| `notetype` | `Notetype` | required | Defines the fields, and how many cards the note produces         |
| `fields`   | `string[]` | required | Field values, positionally, in the note type's field order       |
| `tags`     | `string[]` | `[]`     | Tags for this note                                               |
| `guid`     | `string`   | auto     | Note identity across builds. Unset means a fresh one every build |

`fields` must hold exactly as many values as the note type has fields, or the
constructor throws `invalid-input`.

### Tags

A tag is refused if it is empty, contains a space or an ideographic space, or
contains an ASCII control character. Anki splits its stored tag string on both
kinds of space, so a tag with one in it silently becomes several tags in the
recipient's tag tree, and it strips control characters outright.

### GUIDs

Each note carries a GUID, and it is the only thing Anki uses to decide whether
an imported note is one the recipient already has. Left unset, ankipack
generates a random one per note, per build.

Set it yourself if you publish updates, and read the
[updates how-to](../how-to/ship-updates.md) first, because the GUID alone is
not sufficient.

Two notes in one package sharing a GUID are refused. Anki keeps one note per
GUID, so both would arrive but only one could ever be updated again.

## Text that is refused

**Lone surrogates** are rejected in deck, note type, field, template and preset
names, and in a note's fields, tags and GUID. An unpaired surrogate has no
UTF-8 encoding, so Anki reads the column as invalid and refuses the entire
collection with nothing naming the note responsible.

**NUL** is rejected in note type, field, template and preset names, and in a
note's GUID. The reason is not Anki: SQLite binds strings NUL-terminated, so a
name containing one would be silently truncated on write. Deck names are the
exception, and take a different route: a NUL there is stripped during deck name
normalisation rather than refused.

Both rules cover names and note content. `description` is the exception on this
page: it lands in a protobuf column nothing validates, so it takes any length
and a lone surrogate in it is replaced with U+FFFD rather than refused.
Sanitise it yourself if it comes from data you do not control.

Why ankipack throws rather than quietly repairing any of this is
[a separate question](../explanation/validation.md).
