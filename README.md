# ankipack

[![npm](https://img.shields.io/npm/v/ankipack.svg)](https://www.npmjs.com/package/ankipack)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Generate, read and edit Anki `.apkg` decks programmatically, with full FSRS support.
Works in browsers (including extensions), Node.js, and Bun.

ankipack targets Anki's modern schema (V18, with protobuf-encoded deck configs) and is verified against Anki 26.08.1. As far as I know, it is the only JavaScript or TypeScript package that supports the latest Anki format, including FSRS scheduler settings.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Platform Support](#platform-support)
- [API](#api)
  - [Package](#package)
  - [Deck](#deck)
  - [DeckConfig](#deckconfig)
  - [Notetype](#notetype)
  - [Note](#note)
  - [Collection](#collection)
- [Errors](#errors)
- [License](#license)

## Features

- **Read, edit and write** existing `.apkg` files
- **Latest Anki format** with V18 schema and protobuf-encoded configuration
- **Reads older packages too**, converting schema 11 on the way in
- **All FSRS deck options**: desired retention, custom weights, and every scheduler setting Anki stores in a preset
- **4 built-in note types**: Basic, Basic (and reversed), Basic (type in the answer), Cloze
- **Custom note types** with arbitrary fields, templates, and CSS
- **Media attachments** for images, audio, and other files
- **Multiple decks** in a single `.apkg` package
- **Preset isolation**: a generated preset is added alongside the recipient's, never applied over one
- **Tiny footprint**: 3 runtime dependencies, none of which has any of its own ([fflate](https://github.com/101arrowz/fflate), [fzstd](https://github.com/101arrowz/fzstd), [@bufbuild/protobuf](https://github.com/bufbuild/protobuf-es)). The library and those three bundle to about 57 kB gzipped, with sql.js left external
- **Cross-platform**: runs anywhere JavaScript runs

## Installation

```bash
# bun
bun add ankipack sql.js

# npm
npm install ankipack sql.js
```

On TypeScript, add `@types/sql.js` as well. sql.js ships no types of its own,
and ankipack's public types name it:

```bash
npm install --save-dev @types/sql.js
```

ankipack does not create the sql.js instance. You initialize it and pass it in, which lets you control how the WASM binary is loaded. That matters in browsers and extensions.

For the same reason `sql.js` is an optional peer dependency rather than a
direct one: installing ankipack does not drag in a copy you may already have,
or pin you to a version. Install it yourself, as above. It is by far the
largest thing in the tree, so `npm install ankipack` on its own is about 4.5 MB
against 28 MB with sql.js.

## Quick Start

```typescript
import initSqlJs from "sql.js";
import { Package, Deck, DeckConfig, Notetype, Note } from "ankipack";

const SQL = await initSqlJs();

// Create a note type
const notetype = Notetype.basic();

// Create a deck with FSRS settings
const deck = new Deck({
  name: "My Vocabulary",
  config: new DeckConfig({
    name: "My Preset",
    desiredRetention: 0.9,
    newPerDay: 20,
  }),
});

// Add notes
deck.addNote(new Note({ notetype, fields: ["bonjour", "hello"] }));
deck.addNote(new Note({ notetype, fields: ["merci", "thank you"] }));

// Export
const pkg = new Package();
pkg.addDeck(deck);

// Node.js / Bun: write to file
await pkg.writeToFile("vocab.apkg", SQL);

// Browser: get bytes for download
const bytes = await pkg.toUint8Array(SQL);
```

## Platform Support

ankipack works in any JavaScript environment. The only platform-specific part is how you initialize `sql.js`.

### Node.js / Bun

```typescript
import initSqlJs from "sql.js";
const SQL = await initSqlJs();
```

sql.js will automatically locate its WASM binary from `node_modules`.

### Browser / Browser Extensions

```typescript
import initSqlJs from "sql.js";

const SQL = await initSqlJs({
  locateFile: (file) => `https://sql.js.org/dist/${file}`,
});
```

You can also bundle the WASM file locally and point `locateFile` to it. In browser extensions, you will typically include `sql-wasm.wasm` in your extension assets and reference it with `chrome.runtime.getURL` or a similar API.

### Download helper (browser)

```typescript
const bytes = await pkg.toUint8Array(SQL);
const blob = new Blob([bytes], { type: "application/octet-stream" });
const url = URL.createObjectURL(blob);

const a = document.createElement("a");
a.href = url;
a.download = "deck.apkg";
a.click();
URL.revokeObjectURL(url);
```

## API

### Package

A container for decks and media files that produces the final `.apkg`.

```typescript
const pkg = new Package();

pkg.addDeck(deck);
pkg.addMedia("photo.jpg", imageBytes);

await pkg.writeToFile("output.apkg", SQL);  // Node.js / Bun
const bytes = await pkg.toUint8Array(SQL);   // Browser
```

| Method | Description |
|---|---|
| `addDeck(deck)` | Add a deck to the package |
| `addMedia(filename, data)` | Attach a media file. Reference it in templates via its filename (e.g. `<img src="photo.jpg">`) |
| `toUint8Array(SQL)` | Build the `.apkg` as a `Uint8Array` |
| `writeToFile(path, SQL)` | Write the `.apkg` to disk (Node.js / Bun only) |

### Deck

A named collection of notes with an associated scheduler preset.

```typescript
const deck = new Deck({
  name: "French::Vocabulary",  // use :: for subdecks
  description: "Chapter 1 words",
  config: myConfig,
});

deck.addNote(note);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | required | Deck name. Use `::` for subdecks. Two decks in one package must not share a name |
| `description` | `string` | `undefined` | Description shown in Anki's deck list (supports HTML) |
| `config` | `DeckConfig \| null` | auto-generated | Scheduler preset. `null` ships no preset of your own: the deck points at id 1, the user's existing Default. The package carries a placeholder row there, which Anki's import drops |
| `id` | `number` | auto | Custom deck ID |

### DeckConfig

Scheduler preset controlling how Anki schedules cards. Supports all FSRS settings.

```typescript
const config = new DeckConfig({
  name: "Cramming Preset",
  desiredRetention: 0.85,
  learnSteps: [1, 10],
  newPerDay: 100,
  maximumReviewInterval: 7,
  buryNew: false,
});
```

An auto-generated preset gets its own id and a name derived from the deck, so it appears alongside the recipient's presets rather than changing one of them.

How the preset reaches the recipient:

- The preset is only applied if they enable "Import any deck presets" in the import dialog, which is off by default. That one setting brings every option below, `desiredRetention` included. The single exception is `fsrsParams`: Anki drops the parameter vector unless "Import any learning progress" is enabled too.
- FSRS itself is a collection-wide setting, not part of a deck preset, so no `.apkg` can switch it on. `fsrsParams` is stored and shown in the deck options, but the recipient has to enable FSRS themselves before it affects scheduling.

Out-of-range values throw, because Anki replaces one with its own default rather than clamping it, and the setting would be silently lost. Options Anki stores as whole numbers reject a fraction. The list options reject a value that is not finite, and the two step lists also reject a negative delay. Anki's importer never revalidates a preset, so a bad value first surfaces on the recipient's next answered card.

A `DeckConfig` copies its options, so changing the object afterwards does not change the preset.

#### Learning

| Option | Type | Default | Description |
|---|---|---|---|
| `learnSteps` | `number[]` | `[1, 10]` | Learning steps in minutes |
| `relearnSteps` | `number[]` | `[10]` | Relearning steps for lapsed cards |
| `graduatingIntervalGood` | `number` | `1` | Days after graduating with Good (1 to 36500) |
| `graduatingIntervalEasy` | `number` | `4` | Days after graduating with Easy (1 to 36500) |

#### Daily Limits

| Option | Type | Default | Description |
|---|---|---|---|
| `newPerDay` | `number` | `20` | Maximum new cards per day (0 to 9999) |
| `reviewsPerDay` | `number` | `200` | Maximum reviews per day (0 to 9999) |

#### Intervals

| Option | Type | Default | Description |
|---|---|---|---|
| `maximumReviewInterval` | `number` | `36500` | Upper bound for intervals in days (1 to 36500) |
| `minimumLapseInterval` | `number` | `1` | Minimum interval for lapsed cards in days (1 to 36500) |

#### FSRS

| Option | Type | Default | Description |
|---|---|---|---|
| `desiredRetention` | `number` | `0.9` | Target recall probability (0.7 to 0.99) |
| `fsrsParams` | `number[]` | `[]` | Custom FSRS model weights. Empty, or 21 or more values (FSRS-6) |
| `historicalRetention` | `number` | `0.9` | Historical retention for FSRS optimization (0.7 to 0.97) |
| `ignoreRevlogsBeforeDate` | `string` | `""` | Ignore review logs before this date (YYYY-MM-DD) |

#### Card Ordering

| Option | Type | Default | Description |
|---|---|---|---|
| `newCardInsertOrder` | `string` | `"due"` | `"due"` or `"random"` |
| `newCardGatherPriority` | `string` | `"deck"` | `"deck"`, `"deckThenRandom"`, `"lowestPosition"`, `"highestPosition"`, `"randomNotes"`, `"randomCards"` |
| `newCardSortOrder` | `string` | `"template"` | `"template"`, `"noSort"`, `"templateThenRandom"`, `"randomNoteThenTemplate"`, `"randomCard"` |
| `reviewOrder` | `string` | `"day"` | `"day"`, `"dayThenDeck"`, `"deckThenDay"`, `"intervalsAscending"`, `"intervalsDescending"`, `"easeAscending"`, `"easeDescending"`, `"retrievabilityAscending"`, `"retrievabilityDescending"`, `"relativeOverdueness"`, `"random"`, `"added"`, `"reverseAdded"` |
| `newMix` | `string` | `"mixWithReviews"` | `"mixWithReviews"`, `"afterReviews"`, `"beforeReviews"` |
| `interdayLearningMix` | `string` | `"mixWithReviews"` | Same as `newMix` |

#### Burying

| Option | Type | Default | Description |
|---|---|---|---|
| `buryNew` | `boolean` | `false` | Bury new sibling cards until next day |
| `buryReviews` | `boolean` | `false` | Bury review sibling cards until next day |
| `buryInterdayLearning` | `boolean` | `false` | Bury interday learning siblings |

#### Leech

| Option | Type | Default | Description |
|---|---|---|---|
| `leechAction` | `string` | `"tagOnly"` | `"suspend"` or `"tagOnly"` |
| `leechThreshold` | `number` | `8` | Lapses before flagging as leech (1 to 9999) |

#### Timer / Audio

| Option | Type | Default | Description |
|---|---|---|---|
| `disableAutoplay` | `boolean` | `false` | Disable automatic audio playback |
| `capAnswerTimeToSecs` | `number` | `60` | Cap answer time recording (1 to 9999) |
| `showTimer` | `boolean` | `false` | Show timer on review screen |
| `stopTimerOnAnswer` | `boolean` | `false` | Stop timer when answer is shown |
| `secondsToShowQuestion` | `number` | `0` | Auto-advance: seconds on question (0 = off) |
| `secondsToShowAnswer` | `number` | `0` | Auto-advance: seconds on answer (0 = off) |
| `waitForAudio` | `boolean` | `true` | Wait for audio before showing answer button |
| `skipQuestionWhenReplayingAnswer` | `boolean` | `false` | Skip question audio on answer replay |

#### SM-2 Fallback

These are only used when FSRS is not enabled.

| Option | Type | Default | Range |
|---|---|---|---|
| `initialEase` | `number` | `2.5` | 1.31 to 5.0 |
| `easyMultiplier` | `number` | `1.3` | 1.0 to 5.0 |
| `hardMultiplier` | `number` | `1.2` | 0.5 to 1.3 |
| `lapseMultiplier` | `number` | `0.0` | 0.0 to 1.0 |
| `intervalMultiplier` | `number` | `1.0` | 0.5 to 2.0 |

#### Easy Days

| Option | Type | Default | Description |
|---|---|---|---|
| `easyDaysPercentages` | `number[]` | `[]` | Per-weekday review load percentages. Empty, or exactly 7 values |

### Notetype

A note type defining fields and card templates. Use the built-in presets or create custom ones.

#### Built-in Presets

```typescript
Notetype.basic()               // Front/Back, 1 card per note
Notetype.basicAndReversed()     // Front/Back + reversed, 2 cards per note
Notetype.basicTyping()          // Front/Back with type-in answer
Notetype.cloze()                // Cloze deletions ({{c1::text}})
```

All presets accept optional `{ name?: string, css?: string }`.

#### Custom Notetype

```typescript
const notetype = new Notetype({
  name: "Vocab (type answer)",
  css: `.card { font-size: 24px; text-align: center; }`,
  fields: [
    { name: "Question" },
    { name: "Answer" },
    { name: "Notes", description: "Optional extra context" },
  ],
  templates: [
    {
      name: "Card 1",
      questionFormat: "{{Question}}\n\n{{type:Answer}}",
      answerFormat: '{{Question}}<hr id="answer">{{type:Answer}}<br>{{Notes}}',
    },
  ],
});
```

#### NotetypeOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | required | Note type name |
| `fields` | `FieldDef[]` | required | Field definitions |
| `templates` | `TemplateDef[]` | required | Card templates |
| `type` | `string` | `"normal"` | `"normal"` or `"cloze"` |
| `css` | `string` | Anki default | CSS applied to all cards of this type |
| `sortFieldIndex` | `number` | `0` | Field index used for browser sorting (0 to one less than the field count) |
| `latexPre` | `string` | Anki default | LaTeX preamble |
| `latexPost` | `string` | `\end{document}` | LaTeX postamble |
| `latexSvg` | `boolean` | `false` | Render LaTeX as SVG |
| `id` | `number` | auto | Custom note type ID |

#### FieldDef

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | required | Field name. Unique within the note type, compared case-insensitively. Must not contain `:{}"`, start with `#/^`, or have leading or trailing space |
| `sticky` | `boolean` | `false` | Keep value when adding new notes |
| `rtl` | `boolean` | `false` | Right-to-left text |
| `fontName` | `string` | `"Arial"` | Editor font |
| `fontSize` | `number` | `20` | Editor font size |
| `description` | `string` | `""` | Placeholder text |
| `plainText` | `boolean` | `false` | Treat as plain text (no HTML) |

#### TemplateDef

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | required | Template name |
| `questionFormat` | `string` | required | Question side HTML (use `{{FieldName}}` for substitutions) |
| `answerFormat` | `string` | required | Answer side HTML (use `{{FrontSide}}` to include the question) |
| `questionFormatBrowser` | `string` | `""` | Alternative question template for browser view |
| `answerFormatBrowser` | `string` | `""` | Alternative answer template for browser view |
| `browserFontName` | `string` | `""` | Browser column font |
| `browserFontSize` | `number` | `0` | Browser column font size |

### Note

A single note containing field values. Generates one card per template its note
type renders.

```typescript
const note = new Note({
  notetype: Notetype.basic(),
  fields: ["What is 2+2?", "4"],
  tags: ["math", "easy"],
});

deck.addNote(note);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `notetype` | `Notetype` | required | Note type for this note |
| `fields` | `string[]` | required | Field values (must match the note type's field count) |
| `tags` | `string[]` | `[]` | Tags for this note. A tag must not be empty, contain a space, which Anki would split into several tags, or contain a control character, which Anki strips |
| `guid` | `string` | auto | Custom GUID. Set this yourself if you publish updates, see [Shipping an updated deck](#shipping-an-updated-deck) |

#### Shipping an updated deck

Anki decides whether an imported note is new or an update by its GUID. The
auto-generated one is random per build, so regenerating a deck and shipping it
again **adds duplicates** rather than updating the notes your users already
have. Re-importing the exact same file is fine, since its GUIDs are fixed.

If you publish updates, set `guid` yourself from whatever stably identifies the
note in your source, and keep it stable across builds:

```typescript
new Note({
  notetype,
  fields: [row.term, row.definition],
  guid: `myapp-${row.id}`,
});
```

Do not derive it from the field values: correcting a typo would change the GUID
and duplicate the note.

Pin the note type's `id` as well. It is generated from the clock, so a rebuilt
deck ships a note type Anki has never seen. Anki adds a second one named
`Basic+` and then skips every note that would have updated, because the note's
GUID matches but its note type no longer does. Pass a constant instead:

```typescript
new Notetype({ id: 1700000000001, name: "Vocab", fields, templates });
```

Pin `DeckConfig`'s `id` too if you ship a preset, or every import leaves
another preset behind in the recipient's list.

Do not rename fields, templates or the note type between releases. The field
and template ids are derived from those names, so a rename makes Anki treat the
note type as a different one, with the same result: a second note type, and the
notes skipped. Their existing notes are safe, but they will not get the update.
Add fields rather than renaming them.

### Collection

`Package` builds a new `.apkg`. `Collection` opens one that already exists so
you can change it and write it back.

```typescript
import initSqlJs from "sql.js";
import { Collection } from "ankipack";

const SQL = await initSqlJs();
const col = Collection.open(await Bun.file("deck.apkg").bytes(), SQL);

for (const note of col.notes({ tag: "chapter1" })) {
  await note.setField("Back", note.field("Back").trim());
  note.addTag("cleaned");
}

await Bun.write("deck.apkg", await col.toUint8Array(SQL));
```

Everything the package contains is kept, including tables ankipack has no API
for. Review history, scheduling state, and any collection setting are written
back exactly as they arrived, so editing a shared deck does not reset what its
users have already studied.

| Method | Description |
|---|---|
| `Collection.open(bytes, SQL)` | Read an `.apkg`. Accepts Anki's current format and the older schema 11 one |
| `Collection.fromData(data)` | Wrap a document built elsewhere, such as `await pkg.toCollection()` |
| `col.notes(filter?)` | Notes, optionally filtered by `deck`, `tag` or `notetype`. `deck` names one deck, not its subdecks; `deck` and `notetype` ignore case, as Anki's own indexes do |
| `col.note(id)` | A single note by id |
| `await col.addNote({ notetype, deck, fields, tags?, guid? })` | Add a note, using a note type and deck the collection already has. A `guid` the collection already holds is refused, because Anki would treat the note as an edit of that one |
| `col.removeNote(id)` | Delete a note with its cards and review log, leaving graves. Anki's `.apkg` importer never reads graves, so this does not delete anything on the recipient's side; it takes effect on a sync or a `.colpkg` restore |
| `await col.addDeck(deck)` | Add a `Deck`, its preset, and any notes it already holds |
| `col.addNotetype(notetype)` | Add a `Notetype`, so `addNote` can use it |
| `col.deckNames()` | Deck names as Anki displays them |
| `col.renameDeck(from, to)` | Rename a deck and its subdecks. Anki's `.apkg` importer matches decks by name, so the recipient gets the renamed deck alongside the old one rather than in place of it |
| `col.setMedia(name, data)` / `col.removeMedia(name)` | Media files |
| `col.data` | The whole collection as rows, if you need something the API above does not cover. Protobuf columns are raw bytes there, so a deck's settings need `@bufbuild/protobuf` to decode |
| `col.toUint8Array(SQL)` | Serialise back to an `.apkg` |

A `CollectionNote` exposes `fields`, `fieldNames`, `tags`, `guid`, `id` and
`notetypeName`, plus `field(name)`, `setField(name, value)`, `setFields(values)`,
`setTags`, `addTag` and `removeTag`. `setField`, `setFields`, `col.addNote` and
`col.addDeck` are async, because they compute the duplicate-detection checksum
and that is a SHA1. Everything else is synchronous.

`addNote` needs the note type and deck to exist already; `addDeck` and
`addNotetype` put them there, taking the same `Deck` and `Notetype` objects used
to build a package from scratch.

`toUint8Array` checks the document before writing. A `col.data` edit that would
produce a package Anki refuses fails at the save, with the offending row named,
rather than as a bare SQLite error or a deck that imports empty. It checks
references between notes, cards, decks and note types, duplicate ids, field
counts, one card per note and template, and media filenames. A duplicate GUID is
refused where ankipack creates one, not here: a collection can arrive already
holding a pair, and it has to write back unchanged. Anything Anki merely
normalises on import is left alone.

Editing fields recomputes the sort field and the duplicate-detection checksum,
marks the note changed since the last sync, and adds any card the new content
now renders. Existing cards are never touched, which is Anki's own rule: filling
in a field that was empty gives you the extra card, and emptying one leaves the
card in place for Anki's Empty Cards tool rather than deleting it.

Writing always produces Anki's current format. Older layouts are converted when
read, so there is one output and one code path rather than a choice to get
wrong. A schema ankipack does not fully model is refused rather than read
partially, because a partial read would silently drop whatever it missed.

Filtered decks in a schema 11 package are also refused. Anki empties them when
exporting, so one in a file means it was not produced by an export, and
converting it would lose its search terms.

## Errors

Every error is an `AnkipackError` with a `code`, so a caller can branch on the
kind of failure rather than on message text:

```typescript
import { AnkipackError } from "ankipack";

try {
  await col.addNote({ notetype: "Basic", deck: "Missing", fields: ["a", "b"] });
} catch (error) {
  if (error instanceof AnkipackError && error.code === "deck-not-found") {
    // ...
  }
}
```

| Code | Raised when |
|---|---|
| `deck-not-found`, `notetype-not-found` | You named something the collection does not contain |
| `name-conflict`, `id-conflict` | The name or id is taken. Names collide the way Anki's indexes do, without regard to case |
| `invalid-input` | A value Anki would not store as given: a wrong field count, a tag holding a space, a lone surrogate |
| `media-name` | A filename Anki would rewrite, which makes it refuse the whole package |
| `invalid-package` | The bytes are not an `.apkg`, or one is missing a file it declares |
| `unsupported-schema` | A collection schema this version does not model |
| `invalid-document` | `col.data` was edited into a state Anki's importer would reject |

## License

MIT License. See [LICENSE](LICENSE) for details.

<p align="center">Built with ❤️ by <a href="https://oseifert.ch">Oliver</a>.</p>
