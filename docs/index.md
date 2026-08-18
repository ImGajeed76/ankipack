---
title: ankipack
description: A TypeScript library that generates, reads and edits Anki .apkg deck files, with every FSRS deck option, in Node, Bun and the browser.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/overview
  type: explanation

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: beginner
  time_estimate: 3m

  status: stable

  aliases:
    [
      ankipack,
      anki apkg generator,
      anki deck library,
      generate anki deck javascript,
      apkg typescript,
      genanki alternative,
      esm,
    ]

  next: ./tutorial/first-deck.md
---

# ankipack

ankipack builds Anki `.apkg` deck files from TypeScript, and opens ones that
already exist so you can change them and write them back.

It writes the format current Anki uses, and reads the older packages that older
Anki versions and most other generators produce, converting them on the way in.
Node, Bun, browsers and browser extensions.

```ts
import initSqlJs from "sql.js";
import { Deck, Note, Notetype, Package } from "ankipack";

const SQL = await initSqlJs();

const my_deck = new Deck({ name: "Spanish Vocabulary" });
my_deck.addNote(new Note({ notetype: Notetype.basic(), fields: ["hola", "hello"] }));

const pkg = new Package();
pkg.addDeck(my_deck);
await pkg.writeToFile("spanish.apkg", SQL);
```

## What it does

**Builds decks.** Multiple decks per package, four stock note types and custom
ones, media attachments, tags, and deck options presets covering the scheduler
in full, FSRS included.

**Reads and edits existing packages.** Every row is kept, including tables the
typed API does not expose, so review history and scheduling state survive an
edit untouched. Editing a shared deck does not reset what its users have
studied.

**Refuses input Anki would silently rewrite.** Anki tends to rewrite, drop or
replace a value it will not store rather than reporting it, and the consequence
surfaces on somebody else's machine.
[Why it refuses rather than repairing](./explanation/validation.md).

## Before you install

**It ships only as an ES module.** There is no CommonJS build. That is less of
a constraint than it once was, since Node can now `require()` an ES module, but
the versions matter: it works on Node 20.19 and later, and on 22.12 and later,
and throws `ERR_REQUIRE_ESM` on anything older, including the whole of Node 21.
The examples here use top-level `await`, so you will want `"type": "module"`
regardless.

**sql.js is an optional peer dependency, not a direct one.** ankipack never
creates the sql.js instance. You initialise it and pass it in, which is what
lets you control how its WASM binary loads, and that matters in browsers and
extensions.

Size is the other reason it is not bundled, and the numbers are lopsided enough
to matter. Bundled for a browser, ankipack is about 63 kB gzipped; sql.js adds
roughly 17 kB of loader and a 322 kB gzipped WASM binary on top. Installed,
ankipack and its three dependencies are around 3 MB against sql.js's 24 MB.
Which copy of sql.js you use, and how its binary reaches the browser, is not a
decision ankipack should be making for you.

Those figures are from `bun build --minify --target=browser` and a plain `npm
install`, so treat them as the right order of magnitude rather than exact.

Its three runtime dependencies are
[fflate](https://github.com/101arrowz/fflate),
[fzstd](https://github.com/101arrowz/fzstd) and
[@bufbuild/protobuf](https://github.com/bufbuild/protobuf-es). None of them has
dependencies of its own.

## Where to start

!!! cards { cols=2 }
    - [Your first deck](./tutorial/first-deck.md){ icon=rocket }
      From an empty folder to a deck you can import.

    - [Ship updates without duplicates](./how-to/ship-updates.md){ icon=refresh-cw }
      Read this before publishing. A rebuilt deck duplicates every note unless
      you pin its identities.

    - [What Anki does on import](./explanation/anki-import.md){ icon=git-merge }
      Why notes get skipped, note types get a `+`, and presets sometimes never
      arrive.

    - [Edit an existing .apkg](./how-to/edit-apkg.md){ icon=pencil }
      Bulk changes to a deck you already have, keeping its review history.

    - [Generate a deck in the browser](./how-to/browser.md){ icon=globe }
      Loading the WASM binary, in a page or an extension, and handing the file
      to the user.

    - [Attach media](./how-to/media.md){ icon=image }
      Images and audio, and the filename rules that will otherwise cost you the
      whole import.

Reference pages for [Package, Deck and Note](./reference/package-deck-note.md),
[Notetype](./reference/notetype.md), [DeckConfig](./reference/deck-config.md),
[Collection](./reference/collection.md), the
[collection document](./reference/collection-document.md) and
[errors](./reference/errors.md) cover the API surface option by option.

## Versions

ankipack is MIT licensed and developed
[on GitHub](https://github.com/ImGajeed76/ankipack).

These pages document 0.3 and later. 0.3 renamed `Model` to `Notetype` with no
compatibility alias, and began refusing several kinds of input that 0.2.0
accepted and shipped broken. The
[changelog](https://github.com/ImGajeed76/ankipack/blob/main/CHANGELOG.md)
lists every change with its reasoning, and is the place to look when upgrading.
It also ships inside the package, so `node_modules/ankipack/CHANGELOG.md` is
the copy matching the version you actually installed.
