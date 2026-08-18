---
title: What Anki does when it imports your deck
description: Anki merges your package into a collection that already exists, matching notes by GUID, note types by id and decks by name. Where those keys disagree, notes are silently skipped.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/explanation/anki-import
  type: explanation

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: advanced
  time_estimate: 10m

  status: stable

  aliases:
    [
      anki import behaviour,
      note matching,
      duplicate notes on import,
      notes skipped on import,
      deck merge,
      overwrite,
    ]

  references:
    - https://docs.ankiweb.net/importing/packaged-decks.html
    - https://docs.ankiweb.net/exporting.html
    - https://docs.ankiweb.net/deck-options.html

  prev: ../how-to/ship-updates.md
  next: ./validation.md
---

# What Anki does when it imports your deck

Importing an `.apkg` is a merge, not a copy. The recipient already has a
collection, and Anki works out which parts of your package are things they
already have and which are new. Everything surprising about shipping a deck
follows from that one fact.

The catch is that Anki does not use one key for the job. Each kind of object is
matched by a different one.

| You ship      | Anki matches it by | If it finds a match                   | If it does not                    |
| ------------- | ------------------ | ------------------------------------- | --------------------------------- |
| A note        | its GUID           | Updates it, if yours is newer         | Adds it, keeping its id if free   |
| A note type   | its **id**         | Updates it                            | Adds it, renaming on a name clash |
| A deck        | its **name**       | Merges into it                        | Creates it, with a new id         |
| A deck preset | its id             | Keeps the recipient's, discards yours | Adds it                           |

Those keys disagreeing with each other is where deck publishing goes wrong.

## Notes are matched by GUID

Every note carries a GUID, and that is the only thing Anki looks at to decide
whether a note in your package is one the recipient already has. The note id is
not used for matching. An incoming note whose GUID is new keeps the id it
arrived with, unless that id is already taken, in which case Anki bumps it until
it is free. Decks are the ones that always get a fresh id.

When the GUID does match, Anki compares modification times and keeps whichever
version is newer. The manual states this from the user's side in
[Anki's exporting documentation](https://docs.ankiweb.net/exporting.html): on
re-import, the version with the most recent modification time wins.

That is not quite the comparison it sounds like. ankipack stamps every note with
the time of the build rather than the time its content last changed, so what
gets compared is your build time against their edit time. An edit made before
you built is replaced; one made after you built survives. The manual's framing
assumes a deck re-exported from Anki, where an untouched note still carries its
old timestamp and the two sides really are comparing edit times.

Since Anki 23.10 the recipient can override that, choosing to update notes
always or never rather than only when yours are newer. Newer-wins is the
default, not the rule.

Supplying stable GUIDs across builds is what the
[updates how-to](../how-to/ship-updates.md) is about.

## Note types are matched by id, and renamed by name

The id is the identity here, and the name only decides what a duplicate ends up
called. That is the reverse of decks in the table above, and getting it the
wrong way round is expensive.

Anki looks up your note type by its id. If the recipient has a note type with
that id, yours updates it. If they do not, yours is added as a new note type,
and only then does the name matter: before inserting, Anki checks whether the
name is already taken by a _different_ id, and if it is, it appends a `+` and
checks again. That is where a stray `Basic+` in someone's note type list comes
from.

By itself a duplicated note type is untidy rather than harmful. The damage
comes from how it interacts with the note rule above. When Anki finds a note
whose GUID matches one the recipient already has, but whose note type id is not
the same, it does not update the note and it does not add it. It logs the note
as conflicting and moves on. The note is skipped.

So a deck rebuilt with a fresh note type id produces exactly this: a second
note type named with a trailing `+`, and every note that should have been an
update quietly doing nothing. The recipient's existing notes are unharmed. They
simply never receive the correction you shipped.

ankipack generates note type ids from the clock when you do not pass one, so
this is the default behaviour of a naive rebuild.

### A matching id is not enough

Pinning the note type id is necessary and not sufficient. Having found the note
type by id, Anki then asks whether the two versions have the same shape. They
do only if they have the same number of fields, the same number of templates,
and each field and template pairs off with its opposite number. Fields and
templates carry ids of their own. Anki compares those ids when both sides have
them, and falls back to comparing names when one side does not.

Anything that fails that check sends the incoming note type down the same path
as an unrecognised one: it is added under a fresh id, and the notes that
referenced it are skipped.

Renaming a field is the first way in. ankipack derives each field and template
id from the note type's name, the member's own name and its index, so a rename
produces a different id and the pairing fails. Renaming the note type moves
every one of them at once, and reordering fields moves them too.

Adding a field is the second, and pinning every id does not help. The field
count is compared before anything else, so a note type with one extra field is
a different shape regardless of how stable every id is. Anki's
manual says the same thing from the user's side, that updating is generally not
possible if either party has added a field, and it has a
[note to deck authors](https://docs.ankiweb.net/importing/packaged-decks.html)
on why those ids matter.

There is an escape, but it is not yours to take. Since Anki 23.10 the recipient
can choose to merge the two note types instead, which keeps the fields and
templates from both. It is off by default and it requires a full sync, so it is
something you can ask a user to do, not something you can ship.

One thing limits the damage, as far as it goes. Anki records the original id on
the copy it created, and a later import that matches both that id **and** the
same shape updates the copy rather than making another. Change the shape again
and neither condition holds, so a third release does add a third copy.

## Decks are matched by name

Decks match on one key with no shape comparison behind it, so there is far less
to go wrong. Anki looks for a deck with the same name and merges your cards
into it.

Deck ids are not preserved. Anki assigns its own and remaps every card as it
imports, which is why a deck id you choose is only ever meaningful inside your
own package. It is not an address you can hand to the recipient.

Two consequences follow. Renaming a deck between releases does not rename
anything on the recipient's side: the new name matches nothing, so they end up
with both decks. And because the match is on the full name, including the `::`
separated path, moving a deck under a different parent is a rename like any
other.

The only case where Anki declines to merge is a kind mismatch, a normal deck
meeting a filtered one of the same name. There it appends a suffix rather than
merging, and every subdeck follows the renamed parent.

## Presets are added only if absent, and only if asked for

A deck preset is inserted with SQLite's `INSERT OR IGNORE`. If the recipient
already has a preset with that id, yours is discarded without a word and theirs
is left exactly as it was. Your package cannot modify a preset the recipient
already has, which is a deliberate protection rather than a limitation: a
shared deck cannot rewrite someone's scheduling.

Before any of that, the import dialog decides whether presets are read from
your package at all. If the option is off, Anki never gathers them, and a deck
that referenced one simply lands on the recipient's default. This is the single
setting that governs every scheduler value a preset carries, desired retention
included. The one thing it does not gate is a desired retention set on the deck
row itself, which you can only reach through `col.data`. That travels when the
deck is new, and not otherwise: updating a deck matched by name copies the
description, the preset id and the four limits, and leaves the recipient's
retention alone.

FSRS parameters are gated a second time. When learning progress is not being
imported, Anki clears the parameter vector out of every preset before it is
inserted, so a package can carry parameters that are then dropped on the way
in. The remaining preset values survive.

None of this can switch FSRS on. FSRS is a collection-wide setting rather than
a preset one, as
[the deck options documentation](https://docs.ankiweb.net/deck-options.html)
explains, so no `.apkg` can enable it for anybody. Parameters and desired
retention travel in the preset; the decision to use them at all belongs to the
recipient.

## Deletions never arrive

ankipack records a removed note in the `graves` table, which is the mechanism
Anki uses so a deleted note is not resurrected by the next sync. The `.apkg`
import path does not look at that table. Shipping a
new release with a note removed does not remove it from anyone who already
imported the old one. There is no way to retract a note through a deck package.

## Names are compared without regard to case

Anki declares its name columns with a case-insensitive collation, and the
comparison is full Unicode case folding rather than an ASCII lowercase. Deck
names, note type names and tags all go through it.

This decides more than it appears to. Two decks in one package named `Spanish`
and `spanish` are one deck to Anki, and the second one's cards merge into the
first. `Straße` and `Strasse` fold to the same key. ankipack refuses the pair
when it builds the package, rather than shipping one whose contents silently
collapse on arrival. Why it refuses rather than quietly renaming is
[a separate question](./validation.md).

## Where these facts come from

Every claim above about Anki's behaviour was read from Anki's own source at the
version ankipack targets, 26.08.1. Paths are relative to `rslib/src`:

- `import_export/package/apkg/import/notes.rs`, the note rules and the note
  type shape comparison
- `import_export/package/apkg/import/decks.rs`, the deck rules
- `import_export/gather.rs`, the preset and scheduling gating
- `notetype/merge.rs`, the per-field and per-template matching
- `notetype/mod.rs`, the `+` rename loop

Where the manual covers the same ground it is linked above.
