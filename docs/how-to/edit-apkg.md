---
title: Edit an existing .apkg
description: Open a package, find and change notes, and write it back with review history and scheduling intact, instead of rebuilding the deck and resetting everyone's progress.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/how-to/edit-apkg
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
      edit apkg,
      modify a deck,
      bulk edit notes,
      read apkg,
      Collection.open,
      find and replace,
      rename deck,
    ]

  references:
    - https://docs.ankiweb.net/templates/generation.html
---

# Edit an existing `.apkg`

You have a deck file and want to change something in it: fix a typo across
every note, retag a batch, rename a deck, swap an image. Rebuilding it from
source would work only if you have the source, and would reset every scheduling
column even then.

`Collection` opens the file you already have and writes it back with everything
you did not touch left alone.

```ts
import { readFile, writeFile } from "node:fs/promises";
import initSqlJs from "sql.js";
import { Collection } from "ankipack";

const SQL = await initSqlJs();
const col = Collection.open(await readFile("deck.apkg"), SQL);

for (const note of col.notes({ notetype: "Basic" })) {
  const back = note.field("Back");
  if (back.includes("recieve")) {
    await note.setField("Back", back.replaceAll("recieve", "receive")); // (1)!
  }
}

await writeFile("deck.apkg", await col.toUint8Array(SQL));
```

1. The one I keep misspelling.

Every row read is kept, including tables ankipack has no API for. Review
history, card intervals, ease factors, due dates and collection settings all
survive untouched, which is the entire reason to edit rather than rebuild.

Older packages are handled too: schema 11 files, which is what older Anki
versions and most other generators produce, are converted on the way in. The
output is always Anki's current layout.

## Finding the notes you want

The example above took every Basic note in the file. Most edits want a smaller
set than that.

`col.notes()` gives you all of them. Narrow it by deck, tag or note type, and
pass two if both have to hold. `col.note(id)` fetches a single note when you
already know its id.

```ts
import { Collection } from "ankipack";

declare const col: Collection;

const everything = col.notes();
const chapter = col.notes({ deck: "Spanish::Vocabulary", tag: "chapter1" });
const single = col.note(1700000000001);
```

Two of the three filters fail quietly rather than loudly.

**`deck` means that one deck, not its subdecks.** Filtering on `Spanish` finds
nothing at all when the notes live in `Spanish::Vocabulary`.

**`tag` is case-sensitive**, where `deck` and `notetype` are not. `Chapter1` and
`chapter1` are two different tags.

### When you need a whole subtree

There is no recursive filter, so collect the deck names yourself. Expect the
same note back more than once while you do: a reversed note type has two cards,
they can sit in different subdecks, and editing that note twice applies your
change twice.

```ts
import { Collection } from "ankipack";

declare const col: Collection;

const subtree = col
  .deckNames()
  .filter((name) => name === "Spanish" || name.startsWith("Spanish::")); // (1)!

const found = subtree.flatMap((deck) => col.notes({ deck }));
const notes = [...new Map(found.map((note) => [note.id, note])).values()]; // (2)!
```

1. `Spanish` itself, plus everything under it. `deckNames()` gives the display
   form, with `::` between components.
2. Keyed by id, so a note reached through two subdecks survives once.

## Editing notes

You have seen `setField` already. Reading and retagging work the same way, on
the note object the filter handed you:

```ts
import { Collection } from "ankipack";

declare const col: Collection;

for (const note of col.notes({ tag: "chapter1" })) {
  await note.setField("Back", note.field("Back").trim());
  note.removeTag("chapter1");
  note.addTag("chapter1-clean");
}
```

`setFields(values)` replaces every field at once, positionally, and `setTags`
replaces the whole tag list. The signatures are on the
[Collection reference](../reference/collection.md).

The part that is not obvious is what a field edit does besides storing the
value. It recomputes the sort field and the duplicate checksum, marks the note
changed since the last sync, and adds any card the new content now renders. It
never removes one, following
[Anki's own rule](https://docs.ankiweb.net/templates/generation.html) that cards
which stop rendering are left for the Empty Cards tool.

So a bulk edit can grow a deck's card count. Nothing you do here will shrink it.

## Adding and removing

`addNote` names its note type and deck rather than taking objects, and throws if
the collection does not already hold them. So anything new goes in first:

```ts novars
import { Collection, Deck, Notetype } from "ankipack";

declare const col: Collection;

col.addNotetype(Notetype.cloze()); // (1)!
await col.addDeck(new Deck({ name: "Spanish::Grammar" }));

await col.addNote({
  notetype: "Cloze", // (2)!
  deck: "Spanish::Grammar",
  fields: ["Ir is irregular: yo {{c1::voy}}, tú {{c2::vas}}", ""], // (3)!
  tags: ["chapter2"],
});

col.removeNote(1700000000001); // (4)!
```

1. `Notetype.cloze()` is named `Cloze`, which is the name the note below asks
   for. Adding one that is already there throws `name-conflict` rather than
   quietly merging into it.
2. By name, not by object, and `notetype-not-found` or `deck-not-found` if
   either is missing. That is the whole reason for the order above.
3. Positional, in the note type's field order. Cloze has two, `Text` and
   `Back Extra`, and this note generates two cards, one per cloze number.
4. Takes the note's cards and its review log with it.

`addDeck` is transactional. If a note partway through is refused, the collection
is restored rather than left holding half a deck.

## Renaming a deck

`renameDeck` renames a deck and everything under it, but the name you give has
to be a deck row in its own right. A package whose only deck is
`Spanish::Vocabulary` has no `Spanish` row to rename, so add one with `addDeck`
first.

## Reaching past the API

`col.data` is the whole collection as plain rows, one property per column, under
Anki's own names: review log entries, card scheduling state, deck descriptions,
collection settings. Anything without a typed method is in there.

The trade is that you are on your own. Nothing is checked as you assign it.
`toUint8Array` validates the document when you write and names the offending
row, which is [deliberate](../explanation/validation.md), but until then a wrong
value is just a value. Every column is described on the
[collection document](../reference/collection-document.md) page, and that is the
thing to read before you start rather than after.

Unsuspending makes a good example, because it is not the mirror of suspending:

```ts
import { Collection } from "ankipack";

declare const col: Collection;

for (const card of col.data.cards) {
  if (card.queue !== -1) continue; // (1)!

  if (card.type === 1 || card.type === 3) {
    card.queue = card.due > 1_000_000_000 ? 1 : 3; // (2)!
  } else {
    card.queue = card.type; // (3)!
  }
}
```

1. `-1` is Anki's suspended queue, so this skips every card that is not
   suspended. Suspending is the easy direction: set it to `-1` and you are done.
2. Learning and relearning cards, `type` 1 and 3. Where they go back to depends
   on what `due` holds: a Unix timestamp means the intraday queue, 1, and a day
   number means the day-learning queue, 3. Anki decides it the same way, in
   `restore_queue_from_type`.
3. New and review cards restore straight across, because `type` and `queue`
   number those two the same.

## Before you ship the result

If you are redistributing the edited file, the identity rules still apply. The
notes keep their original GUIDs, which is what you want, but check that you
have not changed the note type's fields or names in passing. See
[shipping updates](./ship-updates.md).

Two of the edits above do not survive the trip. A note you removed is not
removed from anyone who already imported the deck, and a deck you renamed
arrives as a second deck alongside the old one. Both are
[how importing works](../explanation/anki-import.md) rather than limits of the
editing API, and neither shows up until somebody else opens the file.
