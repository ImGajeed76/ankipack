<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <img src="assets/banner-light.png" alt="Ankipack" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ankipack"><img src="https://img.shields.io/npm/v/ankipack.svg" alt="npm"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://docolin.com/imgajeed/ankipack/index"><img src="https://img.shields.io/badge/docs-docolin-6d4aff.svg" alt="Documentation"></a>
</p>

Generate, read and edit Anki `.apkg` decks programmatically, with full FSRS support.
Works in browsers (including extensions), Node.js, and Bun.

ankipack targets Anki's modern schema (V18, with protobuf-encoded deck configs) and is verified against Anki 26.08.1. As far as I know, it is the only JavaScript or TypeScript package made for creating decks in that format, FSRS deck options included.

**[Your first deck](https://docolin.com/imgajeed/ankipack/tutorial/first-deck)**
goes from an empty folder to a deck in Anki in about 15 minutes. Everything else
is in the [documentation](https://docolin.com/imgajeed/ankipack/index).

## What it does

- **Builds decks.** Multiple decks per package, four stock note types and custom ones, media, and tags
- **39 deck options**, FSRS included: desired retention, historical retention, custom parameters and easy days
- **Reads and edits existing packages.** Review history and scheduling state survive, so editing a shared deck does not reset what its users have studied
- **Three runtime dependencies**, none of which has any of its own: [fflate](https://github.com/101arrowz/fflate), [fzstd](https://github.com/101arrowz/fzstd), [@bufbuild/protobuf](https://github.com/bufbuild/protobuf-es). About 63 kB gzipped in a browser bundle, with sql.js left external

## Installation

```bash
bun add ankipack sql.js     # or: npm install ankipack sql.js
bun add -d @types/sql.js    # TypeScript, sql.js ships no types
```

ankipack is ESM only, which needs Node 20.19 or 22.12 and later. sql.js is an
optional peer dependency: you create the instance and pass it in, which is what
lets you control how its WASM binary loads.
[The overview](https://docolin.com/imgajeed/ankipack/index) has the size
breakdown and the rest of the detail.

## Quick start

```typescript
import initSqlJs from "sql.js";
import { Package, Deck, DeckConfig, Notetype, Note } from "ankipack";

const SQL = await initSqlJs();

const notetype = Notetype.basic();

const deck = new Deck({
  name: "Spanish::Vocabulary", // use :: for subdecks
  config: new DeckConfig({
    name: "Spanish Preset",
    desiredRetention: 0.85,
    newPerDay: 15,
  }),
});

deck.addNote(new Note({ notetype, fields: ["hola", "hello"] }));
deck.addNote(new Note({ notetype, fields: ["gracias", "thank you"] }));

const pkg = new Package();
pkg.addDeck(deck);

// Node.js / Bun: write to file
await pkg.writeToFile("spanish.apkg", SQL);

// Browser: get bytes for download
const bytes = await pkg.toUint8Array(SQL);
```

Read
[ship an updated deck](https://docolin.com/imgajeed/ankipack/how-to/ship-updates)
before you publish: a rebuilt deck duplicates every note unless you pin its
identities, and there is no way to retract a note in a later release. The
[documentation](https://docolin.com/imgajeed/ankipack/index) covers the rest,
including [the browser](https://docolin.com/imgajeed/ankipack/how-to/browser),
[editing an existing file](https://docolin.com/imgajeed/ankipack/how-to/edit-apkg)
and every option on every class.

## Contributing

Issues and pull requests are welcome. The library targets Bun for development:

```bash
bun install
bun run test        # unit tests
bun run check       # typecheck
bun run lint
bun run format
```

`src/generated/` is produced by `bun run generate` from the `.proto` files in
`proto/`, so it is regenerated rather than edited. The
[changelog](CHANGELOG.md) records every change with its reasoning, and ships
inside the package, so `node_modules/ankipack/CHANGELOG.md` matches the version
you actually installed.

## License

MIT License. See [LICENSE](LICENSE) for details.

<p align="center">Built with ❤️ by <a href="https://oseifert.ch">Oliver</a>.</p>
