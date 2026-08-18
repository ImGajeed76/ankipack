---
title: The collection document (col.data)
description: Every table and column ankipack models, which columns hold raw protobuf and how to decode them, for anything the typed API does not cover.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/reference/collection-document
  type: reference

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: advanced
  time_estimate: 8m

  status: stable

  aliases:
    [
      col.data,
      CollectionData,
      NoteRow,
      CardRow,
      DeckRow,
      revlog,
      graves,
      protobuf columns,
      escape hatch,
    ]
---

# The collection document (`col.data`)

`col.data` is the whole collection as rows, one type per table and one property
per column. It is the escape hatch for anything the typed API does not cover:
review history, card scheduling state, collection configuration, deck
descriptions, and any column ankipack has no method for.

For example, here is how you would suspend every card of one note:

```ts
import { readFile, writeFile } from "node:fs/promises";
import initSqlJs from "sql.js";
import { Collection } from "ankipack";

const SQL = await initSqlJs();
const col = Collection.open(await readFile("deck.apkg"), SQL);

for (const card of col.data.cards.filter((c) => c.nid === 1700000000001)) { // (1)!
  card.queue = -1;
}

await writeFile("deck.apkg", await col.toUint8Array(SQL));
```

1. Cards reach their note through `nid`. Nothing gives you a note's cards
   directly, which is the shape of most work down here.

Nothing read is summarised or dropped, so an untouched round trip returns every
row and every column value unchanged, protobuf blobs included, even where they
were written by a newer Anki than ankipack models.

That holds for a schema 18 package. Opening a schema 11 one converts it first,
so the round trip is equivalent rather than identical. See
[the format page](../explanation/apkg-format.md).

Editing here is checked when the file is written rather than when the
assignment happens, and `toUint8Array` throws `invalid-document` naming the
offending row. The reasoning for that split is on the
[validation page](../explanation/validation.md).

## CollectionData

| Property     | Type              | Table                       |
| ------------ | ----------------- | --------------------------- |
| `col`        | `ColRow`          | `col`, a single row         |
| `notes`      | `NoteRow[]`       | `notes`                     |
| `cards`      | `CardRow[]`       | `cards`                     |
| `revlog`     | `RevlogRow[]`     | `revlog`                    |
| `graves`     | `GraveRow[]`      | `graves`                    |
| `deckConfig` | `DeckConfigRow[]` | `deck_config`               |
| `config`     | `ConfigRow[]`     | `config`                    |
| `tags`       | `TagRow[]`        | `tags`                      |
| `notetypes`  | `NotetypeRow[]`   | `notetypes`                 |
| `fields`     | `FieldRow[]`      | `fields`                    |
| `templates`  | `TemplateRow[]`   | `templates`                 |
| `decks`      | `DeckRow[]`       | `decks`                     |
| `media`      | `MediaFile[]`     | The archive's media entries |

Column names are Anki's own, not renamed, so
[Anki's own schema](https://github.com/ankitects/anki/tree/main/rslib/src/storage)
is readable against this directly. It is `schema11.sql` plus the numbered
upgrade files rather than one schema 18 file. Two exceptions to the naming:
snake\_case column names become camelCase properties, as in `mtime_secs` to
`mtimeSecs`, and the `config` table's `KEY` column is the `key` property.

Rows join on ids. `NoteRow.mid` names a `NotetypeRow`; `FieldRow.ntid` and
`TemplateRow.ntid` name the note type they belong to; `CardRow.nid` names its
note and `CardRow.did` its deck.

## Columns that are not what they look like

A handful of columns carry encodings rather than plain values, and reaching for
them naively produces wrong results rather than errors.

| Column                                            | Looks like           | Actually holds                                                        |
| ------------------------------------------------- | -------------------- | --------------------------------------------------------------------- |
| `NoteRow.flds`                                    | A string             | Every field value, joined by `U+001F`                                 |
| `NoteRow.tags`                                    | A string             | Space-delimited, with a leading and trailing space, or empty          |
| `NoteRow.sfld`                                    | Declared `integer`   | The sort field's text. Typed `SortField`, which is `string \| number` |
| `DeckRow.name`                                    | `Foo::Bar`           | Components separated by `U+001F`, not `::`                            |
| `ColRow.conf`, `models`, `decks`, `dconf`, `tags` | Columns of their own | Vestigial at schema 18. Anki moved their contents into tables         |
| `ConfigRow.val`                                   | A value              | Bytes, usually JSON, opaque by contract                               |

`deckNames()` converts `DeckRow.name` to the display form, and the typed API
accepts `::` names everywhere.

## Protobuf columns

Schema 18 stores structured settings as encoded protobuf. ankipack keeps them
as bytes and decodes on demand, so an untouched value is re-encoded exactly as
it arrived.

| Column                 | Message                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `DeckConfigRow.config` | `DeckConfig.Config`                                                     |
| `NotetypeRow.config`   | `Notetype.Config`                                                       |
| `FieldRow.config`      | `Notetype.Field.Config`                                                 |
| `TemplateRow.config`   | `Notetype.Template.Config`                                              |
| `DeckRow.common`       | `Deck.Common`                                                           |
| `DeckRow.kind`         | `Deck.KindContainer`, a oneof wrapping `Deck.Normal` or `Deck.Filtered` |
| `TagRow.config`        | Always `null`. Anki declares the column but defines no message for it   |

Reading one needs a protobuf decoder. ankipack does not re-export the generated
message types, so decoding them yourself means depending on
`@bufbuild/protobuf` and on Anki's `.proto` definitions directly. For anything
that has a typed method, use the method: it re-encodes correctly and updates
the surrounding rows.

## Cards, review log and graves

### CardRow

The scheduling state.

| Column                   | Holds                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `id`, `nid`, `did`       | Card id, its note, its deck                                                                     |
| `ord`                    | Which template of the note type this card is                                                    |
| `type`, `queue`          | Anki's card state. Negative `queue` is out of circulation: `-1` suspended, `-2` and `-3` buried |
| `due`                    | A position for new cards, a day number for review cards, a unix timestamp while learning        |
| `ivl`                    | Interval in days                                                                                |
| `factor`                 | Ease in permille                                                                                |
| `reps`, `lapses`, `left` | Review counters and remaining learning steps                                                    |
| `odue`, `odid`           | Original due and deck, for a card currently in a filtered deck                                  |
| `mod`, `usn`             | Modified time in seconds, and sync state. `-1` means unsynced                                   |
| `flags`, `data`          | Flag colour, and a JSON string Anki uses for scheduler extras                                   |

A card ankipack creates is unstudied: `type` and `queue` zero, `ivl`, `factor`,
`reps`, `lapses`, `left`, `odue` and `odid` all zero, `usn` at `-1` so a
syncing client picks it up, and `due` set to its position in the new queue.

### RevlogRow

One row per answered card.

| Column           | Holds                                                              |
| ---------------- | ------------------------------------------------------------------ |
| `id`             | The review's timestamp in milliseconds, and its primary key        |
| `cid`            | The card reviewed                                                  |
| `ease`           | Which button was pressed, 1 to 4. `0` means a manual reschedule    |
| `ivl`, `lastIvl` | Interval after and before, in days. Negative means seconds         |
| `factor`         | Ease factor after the review, in permille                          |
| `time`           | Milliseconds the answer took                                       |
| `type`           | Review kind: learn, review, relearn, filtered, manual, rescheduled |
| `usn`            | Sync state                                                         |

### GraveRow

Deletions, so a syncing client does not resurrect them.

| Column | Holds                                          |
| ------ | ---------------------------------------------- |
| `oid`  | The deleted object's id                        |
| `type` | `0` for a card, `1` for a note, `2` for a deck |
| `usn`  | Sync state                                     |

Anki's `.apkg` importer never reads this table, so graves affect syncing and
`.colpkg` restores rather than anyone importing your deck.

## What is not modelled

`ColRow`'s JSON columns are carried verbatim rather than parsed. A collection
Anki made carries an empty string in each, because it creates every collection
at schema 11 and immediately upgrades, which blanks them. A package
ankipack builds carries `"{}"`. Nothing at schema 18 reads either, so if you are
looking for a collection setting, it is a `ConfigRow`, not `ColRow.conf`.

The media archive is modelled as name and bytes only. Its sizes and SHA1s are
computed at write time rather than stored.
