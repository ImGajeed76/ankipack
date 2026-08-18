---
title: Your first deck
description: Build a working Anki deck from an empty folder and import it into Anki. Covers project setup, installation under four package managers, and one complete script.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/tutorial/first-deck
  type: tutorial

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: beginner
  time_estimate: 15m

  status: stable

  aliases: [getting started, quickstart, hello world, generate apkg, first deck]

  prev: ../index.md
  next: ../how-to/ship-updates.md
---

# Your first deck

By the end of this you will have a folder containing one script, and an
`.apkg` file that opens in Anki with three cards in it.

You need Anki to see the result, and either Bun or Node 22.18 or later.

!!! inputs "Make it your deck"
    - deck: Deck name { default="Spanish Vocabulary" }
    - about: Description { default="Chapter 1 words" }
    - front1: Card 1 front { default="hola" }
    - back1: Card 1 back { default="hello" }
    - front2: Card 2 front { default="gracias" }
    - back2: Card 2 back { default="thank you" }
    - front3: Card 3 front { default="hasta luego" }
    - back3: Card 3 back { default="see you later" }

Change any of those and every code block below updates as you read, so the deck
you build is yours rather than mine. Leave them alone and you get a small
Spanish deck.

## 1. Create an empty project

Start somewhere new rather than in an existing project:

```bash
mkdir my-deck
cd my-deck
```

Create a `package.json` in it, starting with this:

```json
{
  "name": "my-deck",
  "version": "1.0.0",
  "type": "module"
}
```

`"type": "module"` is the part that matters. ankipack ships as an ES module and
the script below uses top-level `await`, and neither works without it.

Your folder should now look like this:

- **my-deck/**
  - package.json

{ .tree }

## 2. Install ankipack

ankipack uses `sql.js` to build the collection database, so you install both:

=== "bun"
    ```bash
    bun add ankipack@^0.3 sql.js
    bun add -d @types/sql.js
    ```

=== "npm"
    ```bash
    npm install ankipack@^0.3 sql.js
    npm install --save-dev @types/sql.js
    ```

=== "pnpm"
    ```bash
    pnpm add ankipack@^0.3 sql.js
    pnpm add -D @types/sql.js
    ```

=== "yarn"
    ```bash
    yarn add ankipack@^0.3 sql.js
    yarn add -D @types/sql.js
    ```

## 3. Write the script

Create `deck.ts` and build it up a piece at a time. The whole file is at the
bottom if you would rather copy it in one go.

!!! steps
    1. Start with the imports and sql.js. Everything else needs them:

       ```ts title="deck.ts"
       import initSqlJs from "sql.js";
       import { Deck, Note, Notetype, Package } from "ankipack";

       const SQL = await initSqlJs();
       ```

    2. Choose a note type. A note type decides what fields a note has and what
       cards it produces. `Notetype.basic()` is Anki's Front and Back, one card
       per note:

       ```ts
       const my_notetype = Notetype.basic();
       ```

       The variable is yours to name. ankipack does not expect it to be called
       anything in particular.

    3. Create a deck to put the notes in. `description` is optional and shows
       up on the deck's own screen, after you click into it:

       ```ts
       const my_deck = new Deck({
         name: "{{ deck }}",
         description: "{{ about }}",
       });
       ```

    4. Now the cards. `fields` is positional: the first value is Front and the
       second is Back, because that is the order `Notetype.basic()` defines
       them in. Listing them and looping is less to type than three separate
       calls, and it is how you would build a real deck from a spreadsheet or a
       database:

       ```ts
       const cards = [
         ["{{ front1 }}", "{{ back1 }}"], // Front, Back
         ["{{ front2 }}", "{{ back2 }}"],
         ["{{ front3 }}", "{{ back3 }}"],
       ];

       for (const [front, back] of cards) {
         my_deck.addNote(new Note({ notetype: my_notetype, fields: [front, back] }));
       }
       ```

    5. Finally, put the deck in a package and write it out:

       ```ts
       const pkg = new Package();
       pkg.addDeck(my_deck);

       await pkg.writeToFile("deck.apkg", SQL);
       console.log("wrote deck.apkg");
       ```

??? note "The whole file"
    ```ts title="deck.ts"
    import initSqlJs from "sql.js";
    import { Deck, Note, Notetype, Package } from "ankipack";

    const SQL = await initSqlJs();

    const my_notetype = Notetype.basic();

    const my_deck = new Deck({
      name: "{{ deck }}",
      description: "{{ about }}",
    });

    const cards = [
      ["{{ front1 }}", "{{ back1 }}"], // Front, Back
      ["{{ front2 }}", "{{ back2 }}"],
      ["{{ front3 }}", "{{ back3 }}"],
    ];

    for (const [front, back] of cards) {
      my_deck.addNote(new Note({ notetype: my_notetype, fields: [front, back] }));
    }

    const pkg = new Package();
    pkg.addDeck(my_deck);

    await pkg.writeToFile("deck.apkg", SQL);
    console.log("wrote deck.apkg");
    ```

## 4. Run it

Bun and Node both run TypeScript directly, so there is nothing to compile.

=== "bun"
    ```bash
    bun deck.ts
    ```

=== "npm"
    ```bash
    node deck.ts
    ```

=== "pnpm"
    ```bash
    node deck.ts
    ```

=== "yarn"
    ```bash
    node deck.ts
    ```

!!! output
    ```
    wrote deck.apkg
    ```

Node only runs TypeScript unaided from 22.18. On 22.17 or older, either use a
runner such as `tsx`, or rename the script to `deck.js` and change nothing
else: the code above is valid JavaScript as written.

Your folder should now look like this:

- **my-deck/**
  - deck.ts
  - deck.apkg # the deck you just built
  - package.json

{ .tree }

## 5. Import it into Anki

Open Anki, choose File then Import, and pick `deck.apkg`. You get a deck called
{{ deck }} with three cards in it, ready to study.

## Where to go next

You now have the shape of every deck you will build: a note type, a deck, some
notes, a package.

!!! cards { cols=2 }
    - [Ship updates without duplicates](../how-to/ship-updates.md){ icon=refresh-cw }
      Read this before you publish anything. A rebuilt deck duplicates every
      note unless you pin its identities.

    - [Build a custom note type](../reference/notetype.md){ icon=layout-template }
      Your own fields and card templates, instead of Front and Back.

    - [Attach media](../how-to/media.md){ icon=image }
      Images and audio, and the filename rules that will otherwise cost you the
      whole import.

    - [Set the scheduler](../reference/deck-config.md){ icon=sliders }
      FSRS settings and deck options, and whether they reach your users at all.
