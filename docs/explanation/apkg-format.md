---
title: The .apkg format
description: An .apkg is a zip holding a metadata record, a zstd-framed SQLite collection at schema 18, and a protobuf media index. ankipack writes that layout and reads the two older ones, converting as it goes.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/explanation/apkg-format
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
      apkg format,
      collection.anki21b,
      schema 18,
      anki zstd,
      apkg internals,
      schema 11,
    ]

  references:
    - https://docs.ankiweb.net/exporting.html

  prev: ./validation.md
---

# The .apkg format

An `.apkg` is a zip archive. Anki has used three different layouts inside it,
and ankipack writes only the newest one while reading all three.

## What is in the archive

A package ankipack writes holds four kinds of entry.

`meta` is a `PackageMetadata` protobuf, and its only interesting field is the
layout version. Anki reads this first and it decides everything else.

`collection.anki21b` is a SQLite database, zstd framed. This is the collection:
notes, cards, decks, note types, review log, configuration, every table.

Numbered entries, `0` upward, are the media files, one per file, each zstd
framed. The names are indices rather than filenames.

`media` is a `MediaEntries` protobuf, also zstd framed, mapping each index to
the real filename, its size and its SHA1. This indirection is why a media file
can be called anything the filename rules allow without the zip needing to
carry that name.

A package with no media still carries a `media` entry holding a framed, empty
`MediaEntries`. Anki decodes it unconditionally, so writing a genuinely
zero-length entry there fails the import with a complaint about an incomplete
frame.

## The three layouts

The `meta` record distinguishes them, and the collection's filename follows.

| Layout   | Collection entry     | Compression |
| -------- | -------------------- | ----------- |
| Legacy 1 | `collection.anki2`   | None        |
| Legacy 2 | `collection.anki21`  | None        |
| Latest   | `collection.anki21b` | zstd        |

Older packages carry no `meta` at all, which is itself the signal: ankipack
falls back to looking for `collection.anki21` and treats its absence as the
oldest layout.

A package declaring a layout version ankipack does not know is refused rather
than probed, and that refusal is more useful than it sounds. Every package
Anki's exporter writes also carries a dummy `collection.anki2` holding a single
note that says a newer Anki is required. A reader that falls back to the legacy
path therefore finds a file which parses perfectly, and reports that placeholder
as though it were the deck.

ankipack does not write that dummy. A package it builds holds `meta`,
`collection.anki21b`, `media`, one numbered entry per media file, and nothing
else.

## zstd without a compressor

ankipack has no zstd compressor and does not need one. The format permits a
block to be stored raw, so a valid frame is a header followed by the payload
split into raw blocks. That is what `zstdRawFrame` writes: correct zstd that
happens to compress nothing.

The zip around it is deflated, so that is where the saving comes from.

Reading is the asymmetric half. A package Anki wrote holds real compressed
frames, so decompression needs a genuine decoder, which is what the `fzstd`
dependency is for.

## Configuration is protobuf, not JSON

Schema 18 stores structured settings as encoded protobuf in `BLOB` columns.
Deck options live in `deck_config.config`, a deck's own settings in
`decks.kind` and `decks.common`, and a note type's in `notetypes.config`, with
each field and template carrying its own.

This is the single biggest difference from the older format, where the same
information was JSON on the `col` row. It is also why reading those values back
out of [`col.data`](../reference/collection-document.md) needs a protobuf
decoder rather than `JSON.parse`.

A note type's config also carries a cached list of which fields each template
requires in order to render. Anki recomputes it on import, so it matters only
to another tool reading the package directly.

## Schema 11 on the way in

Packages produced by older Anki versions, and by most other generators, are at
schema 11. There the note types, decks and presets are JSON blobs on the `col`
row rather than tables of their own.

ankipack converts them on read, so everything downstream sees schema 18. Keys
that ankipack does not model are not discarded during that conversion. They are preserved in the same
`other` byte field Anki uses for the purpose, so a round trip does not quietly
strip a setting written by some other tool.

Two things are refused rather than converted.

A collection at any schema other than 11 or 18 is refused outright, with an
[`unsupported-schema` error](../reference/errors.md). A partial read would
silently drop whatever it did not understand, and for a library whose main
promise is that reading and writing a file leaves it unchanged, that is the
worst possible failure: it succeeds.

A filtered deck in a schema 11 package is also refused. ankipack's converter
does not model one, and a filtered deck is defined by its search terms, so
converting it to a normal deck would silently discard the thing that made it a
deck at all.

## A package holds 65,532 media files

A package can hold 65,532 media files: the zip format's 16 bit entry count of
65,535, minus `meta`, the collection and the media index. It is not an Anki
limit or a deliberate policy, and ankipack does not write a zip64 record that
would lift it. Exceeding it is refused at the save, because the
alternative is worse than an error: the count wraps, and since integer-like
names sort first in the central directory, the entries a reader loses are
`meta`, the collection and the media index.

## What this means for the recipient

ankipack writes the modern layout only. Anki's exporter offers the older one
behind a "support older Anki versions" option, and
[its documentation](https://docs.ankiweb.net/exporting.html) notes that modern
files are not readable by older clients.

So a deck built with ankipack requires Anki 2.1.55 or later, and ankipack
exposes no option to change that. 2.1.50 is where this layout arrived, but only
for collection packages; the desktop's `.apkg` importer reached it in 2.1.52 and
sat behind a preference defaulting to off until 2.1.55. Anything older finds no
collection it recognises and fails without saying why, since ankipack writes no
dummy `collection.anki2` to tell it to update. The only route to a legacy file
runs through Anki itself, by importing the package once and re-exporting it with
that option turned on.
