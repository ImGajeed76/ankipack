# ankipack

[![npm](https://img.shields.io/npm/v/ankipack.svg)](https://www.npmjs.com/package/ankipack)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Generate Anki `.apkg` decks programmatically with full FSRS support.
Works in browsers (including extensions), Node.js, and Bun.

ankipack targets the latest Anki version (24.x+) and its modern schema (V18 with protobuf-encoded deck configs). As far as we know, this is the only JavaScript/TypeScript package that supports the latest Anki format, including FSRS scheduler settings baked directly into the generated deck.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Platform Support](#platform-support)
- [API](#api)
  - [Package](#package)
  - [Deck](#deck)
  - [DeckConfig](#deckconfig)
  - [Model](#model)
  - [Note](#note)
- [License](#license)

## Features

- **Latest Anki format** with V18 schema and protobuf-encoded configuration
- **Full FSRS support** with desired retention, custom weights, and all scheduler options
- **4 built-in note types**: Basic, Basic (and reversed), Basic (type in the answer), Cloze
- **Custom note types** with arbitrary fields, templates, and CSS
- **Media attachments** for images, audio, and other files
- **Multiple decks** in a single `.apkg` package
- **Preset isolation**: generated presets never overwrite the user's existing Anki defaults
- **Tiny footprint**: only 3 runtime dependencies ([sql.js](https://github.com/sql-js/sql.js), [fflate](https://github.com/101arrowz/fflate), [@bufbuild/protobuf](https://github.com/bufbuild/protobuf-es))
- **Cross-platform**: runs anywhere JavaScript runs

## Installation

```bash
# bun
bun add ankipack sql.js

# npm
npm install ankipack sql.js
```

`sql.js` is a peer-like dependency that you initialize and pass to ankipack. This lets you control how the WASM binary is loaded, which is important in browsers and extensions.

## Quick Start

```typescript
import initSqlJs from "sql.js";
import { Package, Deck, DeckConfig, Model, Note } from "ankipack";

const SQL = await initSqlJs();

// Create a model (note type)
const model = Model.basic();

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
deck.addNote(new Note({ model, fields: ["bonjour", "hello"] }));
deck.addNote(new Note({ model, fields: ["merci", "thank you"] }));

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
| `name` | `string` | required | Deck name. Use `::` for subdecks |
| `description` | `string` | `undefined` | Description shown in Anki's deck list (supports HTML) |
| `config` | `DeckConfig` | auto-generated | Scheduler preset for this deck |
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

Generated configs never use `id=1`, so they will not overwrite the user's existing default preset on import.

#### Learning

| Option | Type | Default | Description |
|---|---|---|---|
| `learnSteps` | `number[]` | `[1, 10]` | Learning steps in minutes |
| `relearnSteps` | `number[]` | `[10]` | Relearning steps for lapsed cards |
| `graduatingIntervalGood` | `number` | `1` | Days after graduating with Good |
| `graduatingIntervalEasy` | `number` | `4` | Days after graduating with Easy |

#### Daily Limits

| Option | Type | Default | Description |
|---|---|---|---|
| `newPerDay` | `number` | `20` | Maximum new cards per day |
| `reviewsPerDay` | `number` | `200` | Maximum reviews per day |

#### Intervals

| Option | Type | Default | Description |
|---|---|---|---|
| `maximumReviewInterval` | `number` | `36500` | Upper bound for intervals (days) |
| `minimumLapseInterval` | `number` | `1` | Minimum interval for lapsed cards (days) |

#### FSRS

| Option | Type | Default | Description |
|---|---|---|---|
| `desiredRetention` | `number` | `0.9` | Target recall probability (0 to 1) |
| `fsrsParams` | `number[]` | `[]` | Custom FSRS model weights |
| `historicalRetention` | `number` | `0.9` | Historical retention for FSRS optimization |
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
| `leechThreshold` | `number` | `8` | Lapses before flagging as leech |

#### Timer / Audio

| Option | Type | Default | Description |
|---|---|---|---|
| `disableAutoplay` | `boolean` | `false` | Disable automatic audio playback |
| `capAnswerTimeToSecs` | `number` | `60` | Cap answer time recording |
| `showTimer` | `boolean` | `false` | Show timer on review screen |
| `stopTimerOnAnswer` | `boolean` | `false` | Stop timer when answer is shown |
| `secondsToShowQuestion` | `number` | `0` | Auto-advance: seconds on question (0 = off) |
| `secondsToShowAnswer` | `number` | `0` | Auto-advance: seconds on answer (0 = off) |
| `waitForAudio` | `boolean` | `true` | Wait for audio before showing answer button |
| `skipQuestionWhenReplayingAnswer` | `boolean` | `false` | Skip question audio on answer replay |

#### SM-2 Fallback

These are only used when FSRS is not enabled.

| Option | Type | Default |
|---|---|---|
| `initialEase` | `number` | `2.5` |
| `easyMultiplier` | `number` | `1.3` |
| `hardMultiplier` | `number` | `1.2` |
| `lapseMultiplier` | `number` | `0.0` |
| `intervalMultiplier` | `number` | `1.0` |

#### Easy Days

| Option | Type | Default | Description |
|---|---|---|---|
| `easyDaysPercentages` | `number[]` | `[]` | Per-weekday review load percentages |

### Model

A note type defining fields and card templates. Use the built-in presets or create custom ones.

#### Built-in Presets

```typescript
Model.basic()               // Front/Back, 1 card per note
Model.basicAndReversed()     // Front/Back + reversed, 2 cards per note
Model.basicTyping()          // Front/Back with type-in answer
Model.cloze()                // Cloze deletions ({{c1::text}})
```

All presets accept optional `{ name?: string, css?: string }`.

#### Custom Model

```typescript
const model = new Model({
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

#### ModelOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | required | Note type name |
| `fields` | `FieldDef[]` | required | Field definitions |
| `templates` | `TemplateDef[]` | required | Card templates |
| `type` | `string` | `"normal"` | `"normal"` or `"cloze"` |
| `css` | `string` | Anki default | CSS applied to all cards of this type |
| `sortFieldIndex` | `number` | `0` | Field index used for browser sorting |
| `latexPre` | `string` | Anki default | LaTeX preamble |
| `latexPost` | `string` | `\end{document}` | LaTeX postamble |
| `latexSvg` | `boolean` | `false` | Render LaTeX as SVG |
| `id` | `number` | auto | Custom model ID |

#### FieldDef

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | required | Field name (unique within the model) |
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
| `targetDeckId` | `number` | `0` | Override deck for this template's cards |

### Note

A single note containing field values. Generates one or more cards based on its model.

```typescript
const note = new Note({
  model: Model.basic(),
  fields: ["What is 2+2?", "4"],
  tags: ["math", "easy"],
});

deck.addNote(note);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | `Model` | required | Note type for this note |
| `fields` | `string[]` | required | Field values (must match model's field count) |
| `tags` | `string[]` | `[]` | Tags for this note |
| `guid` | `string` | auto | Custom GUID (auto-generated base91 if omitted) |

## License

MIT License. See [LICENSE](LICENSE) for details.

<p align="center">Built with ❤️ by <a href="https://oseifert.ch">Oliver</a>.</p>
