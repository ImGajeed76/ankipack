---
title: Ship an updated deck without duplicating notes
description: A rebuilt deck ships new identities by default, so re-importing it adds duplicates instead of updating. Pin three ids, then stop changing the note type's shape.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/how-to/ship-updates
  type: how-to

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: intermediate
  time_estimate: 10m

  status: stable

  aliases:
    [
      duplicate notes,
      update a deck,
      publish deck updates,
      guid,
      notes skipped,
      Basic+,
      deck versioning,
    ]

  references:
    - https://docs.ankiweb.net/importing/packaged-decks.html
    - https://docs.ankiweb.net/exporting.html

  prev: ../tutorial/first-deck.md
  next: ../explanation/anki-import.md
---

# Ship an updated deck without duplicating notes

You published a deck, fixed some typos, rebuilt it and shipped version two.
Your users import it and end up with every note twice, or with a note type
called `Basic+` and none of your corrections applied.

Nothing went wrong at build time. Anki decides what is an update and what is
new by matching identities, and a rebuild generates fresh ones unless you pin
them.

## What has to stay put

Three ids you set once and never regenerate:

| Identity     | Default           | What happens if it moves                      |
| ------------ | ----------------- | --------------------------------------------- |
| Note GUID    | Random, per build | Every note arrives as a duplicate             |
| Note type id | From the clock    | A second note type, and every note skipped    |
| Preset id    | From the clock    | Another preset in the user's list each import |

And the shape of the note type, which you must then stop changing, because Anki
compares the field count and the derived field and template ids:

| What you must not change   | Effect of changing it                                                   |
| -------------------------- | ----------------------------------------------------------------------- |
| The note type's name       | Every field and template id moves at once                               |
| Any field or template name | That member's id moves                                                  |
| The position of a field    | Its own id moves, and so does every field's after it                    |
| Adding a field             | A different field count is a different shape, before any id is compared |

Each of those has the same effect as losing the note type id.

The deck id is the one identity you do **not** need to pin. Anki matches decks
by name and assigns its own ids on import, so the id changing between builds
means nothing.

## What that looks like in a build

Three lines carry all of it. The rest of this is an ordinary deck built from a
list of rows, and is only here to show where those three sit:

```ts novars
import { Deck, DeckConfig, Note, Notetype, Package } from "ankipack";

interface Row {
  key: string;
  term: string;
  definition: string;
}

const rows: Row[] = [
  { key: "es-0001", term: "hola", definition: "hello" },
  { key: "es-0002", term: "gracias", definition: "thank you" },
];

const my_notetype = new Notetype({
  id: 1700000000001, // (1)!
  name: "Vocab",
  fields: [{ name: "Term" }, { name: "Definition" }],
  templates: [
    {
      name: "Card 1",
      questionFormat: "{{Term}}",
      answerFormat: '{{FrontSide}}<hr id="answer">{{Definition}}',
    },
  ],
});

const my_deck = new Deck({
  name: "Spanish Vocabulary",
  config: new DeckConfig({ id: 1700000000002, name: "Spanish" }), // (2)!
});

for (const row of rows) {
  my_deck.addNote(
    new Note({
      notetype: my_notetype,
      fields: [row.term, row.definition],
      guid: `mydeck-${row.key}`, // (3)!
    }),
  );
}

const pkg = new Package();
pkg.addDeck(my_deck);
```

1. A literal, not a generated id. The number itself is arbitrary; being a
   constant in your source is the whole point, because omitting it takes the
   clock instead.
2. The same for the preset, or every import leaves another preset behind in the
   recipient's list.
3. Built from the source row's own key. Never from `term` or `definition`:
   correcting a typo would move the GUID and the fixed note would arrive as a
   new one.

## Choosing the key

Use whatever stably identifies the row in your source: a database primary key,
a filename, a slug. Prefix it so it cannot collide with GUIDs from another deck
you publish. If your source genuinely has no stable key, add one and store it.

!!! warning "A GUID that moves cannot be moved back"
    Once a release ships with different GUIDs, everyone who imports it already
    has the duplicates. There is no correction you can publish afterwards that
    undoes it, because the new notes match nothing they already have.

## Pinning the id is not enough

A `Notetype` you build does not store field and template ids. ankipack derives
each one by hashing the note type's name, the member's own name and its index
together, which is where the second table's rules come from. Anki's manual
[says the same](https://docs.ankiweb.net/importing/packaged-decks.html) about
adding a field, from the user's side.

If you must change the shape anyway, the options are all bad in different ways:

- Ship the new shape under a new note type id **and new GUIDs**, and accept that
  existing users keep the old notes and receive the new ones alongside as a
  separate set. Keeping the GUIDs does not work: Anki matches the note by GUID
  first, finds it pointing at a different note type, and skips it, so the new
  note type arrives empty.
- Tell users to choose the merge option in Anki's import dialog, which keeps
  fields and templates from both versions. It is off by default and needs a
  full sync, so it is a request you make, not something you can ship.

Plan the fields you need before the first release.

## Which version wins when they have edited yours

When GUIDs match, Anki keeps whichever version was modified more recently, as
[its documentation](https://docs.ankiweb.net/exporting.html) describes.

Every ankipack build stamps every note with the time of that build, not the time
you last changed that note's content. So the comparison is between your build
time and their edit time, and it turns on which of the two came first. An edit
made before you built the release is replaced by it. An edit made after you
built survives, even if they import weeks later.

That is a race, and neither side can see it. Anki's own exports compare real
edit times, so whoever actually changed the note last wins. A rebuilt package
compares when you pressed build against when they typed, which is not the same
question.

If you want it decided rather than raced, set the timestamps yourself. There is
no option on `Note` for this, so it happens as one more step of the same build,
between assembling the package and writing it out:

```ts novars title="deck.ts" hl_lines="41 46-48"
import { writeFile } from "node:fs/promises";
import initSqlJs from "sql.js";
import { Collection, Deck, DeckConfig, Note, Notetype, Package } from "ankipack";

const rows = [
  { key: "es-0001", term: "hola", definition: "hello", changed: 1735689600 },
  { key: "es-0002", term: "gracias", definition: "thank you", changed: 1767225600 },
];

const my_notetype = new Notetype({
  id: 1700000000001,
  name: "Vocab",
  fields: [{ name: "Term" }, { name: "Definition" }],
  templates: [
    {
      name: "Card 1",
      questionFormat: "{{Term}}",
      answerFormat: '{{FrontSide}}<hr id="answer">{{Definition}}',
    },
  ],
});

const my_deck = new Deck({
  name: "Spanish Vocabulary",
  config: new DeckConfig({ id: 1700000000002, name: "Spanish" }),
});

for (const row of rows) {
  my_deck.addNote(
    new Note({
      notetype: my_notetype,
      fields: [row.term, row.definition],
      guid: `mydeck-${row.key}`,
    }),
  );
}

const pkg = new Package();
pkg.addDeck(my_deck);

const col = Collection.fromData(await pkg.toCollection()); // (1)!

const changedAt = new Map<string, number>();
for (const row of rows) changedAt.set(`mydeck-${row.key}`, row.changed);

for (const note of col.data.notes) {
  note.mod = changedAt.get(note.guid) ?? note.mod; // (2)!
}

const SQL = await initSqlJs();
await writeFile("deck.apkg", await col.toUint8Array(SQL)); // (3)!
```

1. The package as rows, without serialising it first. `toCollection` hands the
   builder's own document to the editing API, which is the supported way to
   reach a column the builder has no option for.
2. The GUID is the join back to your source, and the second thing pinning it
   buys you. A row your source no longer knows about keeps the build time it
   already had rather than being reset to nothing.
3. `col` is what gets written now, not `pkg`. Everything else in the package is
   exactly what the builder produced.

Anki then updates only the notes whose source changed after the recipient last
edited them, and leaves the rest alone.

## What you still cannot control

**You cannot retract a note.** Deletions never reach anyone who already
imported it, so ship a correction rather than a removal.

**Renaming a deck gives users both decks.**

## Check it before you publish

Import your new release into a copy of a collection that already holds the old
one. If the note count grew, or a note type gained a `+`, an identity moved.

Two changes slip past that. A moved preset id only adds a row to the preset
list. And a renamed note type arrives under its new name, so nothing collides
and nothing gains a `+`, while every note that referenced it is skipped: you
see an extra note type with nothing in it. Check both lists as well as the
count.

If you release on a schedule, the cheaper check is to diff two consecutive
builds without Anki. Read both with `Collection.open` and compare
`col.data.notetypes[].id` and `.name`, `col.data.deckConfig[].id`, the set of
`col.data.notes[].guid`, and the `name` and `ord` of every row in
`col.data.fields` and `col.data.templates`.

Compare those columns rather than whole rows. Note type and template rows carry
an `mtimeSecs` taken from the build clock, so two builds a second apart differ
there with nothing wrong.

The mechanics behind these rules are on
[what Anki does when it imports your deck](../explanation/anki-import.md).
