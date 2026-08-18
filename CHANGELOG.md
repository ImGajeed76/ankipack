# Changelog

## 0.3.0

ankipack can now read an `.apkg`, change it, and write it back. Building and
reading share one internal representation of a collection, so there is one
serialiser rather than two that can drift apart.

Breaking

- Packages are written in Anki's current layout: a `meta` record, a
  zstd-framed `collection.anki21b`, and a protobuf media index whose files are
  framed individually. Previously ankipack wrote the legacy
  `collection.anki2` with a JSON media index. Anki accepts both; anything else
  reading the file needs to handle the new one.

- `Model` is now `Notetype`, and `NoteOptions.model` is `notetype`. Anki calls
  this a note type everywhere: its interface, its Rust core and its protobuf
  service all say notetype, and `model` survives only as the schema 11 column
  name and a deprecated alias in its Python library. Half the new reading API
  already said notetype, so one of the two words had to go. `Model`,
  `ModelOptions` and `Model.basic()` become `Notetype`, `NotetypeOptions` and
  `Notetype.basic()`. There is no compatibility alias.

- A lone surrogate is refused wherever text enters the library: deck, note type,
  field, template and preset names, and a note's fields, tags and GUID. An
  unpaired surrogate has no UTF-8 form, so Anki reads the column as invalid and
  refuses the entire collection with nothing naming the note. 0.2.0 accepted
  them all, so a build whose source can emit one now throws.

- Deck, note type, field and template names are compared with full Unicode case
  folding, which is what Anki's `COLLATE unicase` indexes use. `toLowerCase`
  agrees for ASCII but not for `Straße` and `Strasse`, which Anki treats as one
  deck: 0.2.0 shipped both and Anki silently merged the second deck's cards into
  the first. Note type names were compared exactly, so `Vocab` and `vocab` got
  through as well. Both now throw.

- Every error is now an `AnkipackError` carrying a `code`, so a caller can tell
  a missing deck from an unreadable file without matching on message text.
  Anything that catches an `Error` still catches these.

- `toUint8Array` refuses a document that would not import. `col.data` is the
  documented escape hatch, so an edit there could produce a package whose notes
  point at note types it does not contain, which Anki rejects outright, or one
  whose field counts do not match, which imports as blank notes. Both now fail
  at the save with the offending row named. A duplicate id used to surface as a
  bare SQLite constraint message with nothing saying which row caused it.

- Two notes in one package sharing a GUID are refused, and so is `addNote` with
  a GUID the collection already holds. Anki matches an imported note to an
  existing one by GUID and remaps the id. Two notes in one package both reach
  the recipient, but Anki's GUID map holds one note per GUID, so a later release
  can only ever update one of them. A GUID already in the collection is treated
  as an edit of that note: its cards and review log stay, its fields are
  replaced. Check Database calls both results healthy. The check sits where
  ankipack creates the GUID rather than at the save, because Anki's own schema
  puts no unique index on `notes.guid`, so a collection can arrive already
  holding a duplicate and has to write back unchanged.

- `addMedia` throws when the filename was already added. It used to replace the
  bytes silently, which loses whichever file was added first.

- Note type, field and template names must be in NFC. Anki normalises them on
  import and leaves the template bodies alone, so an NFD field name parts
  company with its own `{{ref}}` and every one of its cards renders "there is no
  field called ...". Leading and trailing whitespace is judged by Rust's
  `char::is_whitespace`, which JavaScript's `\s` disagrees with in both
  directions: U+0085 was accepted and then trimmed by Anki, U+FEFF was refused
  though Anki keeps it.

- `addMedia` and `setMedia` apply Anki's full media filename rules. Anki refuses
  a package outright unless every name is already normalised, so `diagram
  [1].png`, `CON.png`, a name over 120 bytes, a trailing space, or an NFD name
  of the kind a macOS filesystem returns each cost the user the entire deck.
  0.2.0 rejected only an empty name, a path separator, `.`, `..` and an NFC
  collision, so a build that shipped `photo [1].png` now throws. Anki's answer
  for "unassigned code point" comes from Unicode 10, which is what its own
  character tables are, so a recent emoji in a filename is refused too.

- `sql.js` is now an optional peer dependency rather than a direct one. It was
  always the caller's job to create the instance and pass it in, so installing
  it was never ankipack's to decide, and it is most of the tree. `npm install
  ankipack` drops from 28 MB to 4.5 MB. Install `sql.js` alongside ankipack, as
  the README has always shown.

Reading and editing

- Two cards on the same note and template ordinal are refused. Anki's importer
  inserts both, and only Check Database removes one, so until the recipient runs
  it they study the same template twice.

- Media filenames are checked at the save as well as at `addMedia` and
  `setMedia`, since `col.data.media` reaches the writer directly and Anki
  refuses the whole import over one bad name.

- A damaged `col` JSON column is refused rather than read as empty. Read as
  empty, an unreadable `models`, `decks` or `dconf` drops every note type, deck
  or preset it holds, and an unreadable `conf` drops `schedVer`, which makes
  Anki rerun its v1-to-v2 scheduler upgrade over cards that are already v2.

- New: `Collection.open(bytes, SQL)` reads a package, and `toUint8Array` writes
  it back. Every row is held, including tables ankipack has no API for, so
  review history, scheduling state and collection settings survive an edit
  untouched. That is the whole reason the document holds raw rows rather than
  rebuilding from the builder types, which reset every scheduling column.
- New: notes can be found by deck, tag or note type, and their fields, tags and
  GUIDs read. Editing fields recomputes the sort field and the duplicate
  checksum, marks the note changed since the last sync, and adds any card the
  new content renders. Existing cards are never modified or deleted, matching
  Anki's `new_cards_required`.
- New: `addNote`, `removeNote` (which also removes the cards and review log and
  leaves graves), `renameDeck`, `setMedia` and `removeMedia`.
- New: `addDeck` and `addNotetype` take the same `Deck` and `Notetype` objects
  used to build a package from scratch, so a deck or note type can be added to
  a collection that was opened rather than built. `addDeck` brings the deck's
  preset and any notes it already holds.
- New: packages at schema 11, which is what older Anki versions and most
  third-party generators produce, are converted on the way in. Note type, deck
  and preset JSON becomes the schema 18 tables, and JSON keys ankipack does not
  model are preserved in the protobuf `other` field the way Anki preserves them.
- A schema ankipack does not fully model is refused rather than read partly,
  and so is a filtered deck in a legacy package, since Anki empties those on
  export and converting one would silently lose its search terms.

Internal

- `bun run check`, `lint` and `format:check` cover `test/` and `e2e/` as well as
  `src/`. `prepublishOnly` runs all three, so a release cannot ship with them
  broken.

- Writing a collection runs in one transaction instead of committing every row
  on its own. The per-row commits were most of the time a large package spent
  writing, so a package with tens of thousands of notes writes several times
  faster.

- An unreadable package raises an `AnkipackError` rather than whatever fzstd,
  sql.js or the protobuf decoder threw. A truncated download and a file that is
  not an `.apkg` were the two cases the error contract missed.

- `stripInternal` is on, so `@internal` members no longer appear in the
  published types. `Collection.notetypeFor` was returning a type a consumer
  could not name. `SortField` is exported, since `NoteRow.sfld` has that type.

- Linting is type-aware and uses `strictTypeChecked`, so rules that need type
  information now run: a floating promise, an unsafe `any`, a needless
  assertion. `noImplicitOverride` is on. `no-unnecessary-condition` is the one
  rule left off, because without `noUncheckedIndexedAccess` it reports every
  `entries[name] === undefined` guard as unnecessary when those guards are what
  report a missing zip entry.

- `src/db.ts` is gone. Building a package now produces the document model and
  hands it to the same writer reading uses, so the golden tests cover both.
- zstd frames are written without a compressor. The format allows stored
  blocks, so a conforming frame is a header plus the payload in raw blocks,
  which avoids a WebAssembly dependency for compression. The archive is
  deflated, which is where the size saving actually comes from.
- New runtime dependency `fzstd` for reading zstd.

Testing

- New: an end-to-end suite under `e2e/` that runs Anki's own Rust core over the
  files ankipack writes, via the `anki` package on PyPI pinned to the version
  this library claims parity with. `bun run e2e:setup` then `bun run test:e2e`;
  the default `bun test` does not touch it and needs no Python.
- It asserts Anki accepts what ankipack writes, from the builder and from the
  read-edit-write path, with a clean Check Database. For the schema 11
  conversion it uses Anki as the oracle: Anki imports a legacy package and
  re-exports it in the current format, and that is what ankipack's converter is
  compared against.
- Reading a collection Anki wrote now works. Anki declares six name columns
  `COLLATE unicase`, which sql.js cannot register, and `tags` is WITHOUT ROWID
  keyed on one, so SQLite could not even plan a scan. The collation is rewritten
  out of the in-memory copy before reading. ankipack still writes those columns
  without it: building the index under one collation and declaring another would
  leave a btree whose order contradicts its own declaration.

## 0.2.0

Audited every table ankipack writes against Anki 26.08.1's source. The
generated package was imported into Anki 26.08.1 to confirm the results,
including subdeck nesting, cloze generation, media, deck presets, and the
card an alt-syntax template now produces.

Breaking

- `TemplateDef.targetDeckId` is removed. Cards never honoured it, and Anki
  reassigns every deck id on import without remapping the field, so any value
  written there pointed at a deck the recipient does not have.
- Input Anki would silently rewrite or refuse now throws at construction rather
  than shipping a broken package:

  - a tag that is empty or contains a space
  - a preset value outside Anki's accepted range, or a fraction on an option
    Anki stores as a whole number
  - `easyDaysPercentages` that is not 0 or 7 entries
  - a non-empty `fsrsParams` with fewer than 21 values
  - a field name that is empty, contains `:{}"`, starts with `#/^`, or has
    leading or trailing whitespace
  - two field names, or two template names, differing only in case
  - a note type or template name that is empty or contains a quote, which Anki
    strips on import, renaming the note type into a possible collision
  - a note type with no fields or no templates
  - a `sortFieldIndex` outside the model's fields
  - an `id` that is not a safe integer
  - a media filename that is not a plain filename, or that collides with
    another once Anki normalises it
  - two decks with the same name or the same id, two `DeckConfig`s sharing an
    id, or two note types sharing an id or a name
  - a NUL in a note type, field, template or preset name, or in a note GUID,
    and any control character in a tag
  - a non-finite value in `learnSteps`, `relearnSteps`, `fsrsParams` or
    `easyDaysPercentages`, or a negative learning step

Decks

- Fix: subdeck names now reach Anki as subdecks. `decks.name` holds Anki's
  machine name, whose components are separated by U+001F, so a name like
  `French::Vocab` arrived as one deck with literal colons: three or more levels
  went missing from the deck list until Check Database was run, two levels
  landed nested under Default. Names are now normalised the way Anki normalises
  them (NFC, control characters stripped, components trimmed, an empty
  component becoming `blank`). Anki creates the missing parent decks itself on
  import, so only the leaf is shipped.
- Fix: two decks with the same name now raise a named error instead of a raw
  SQLite unique-constraint failure. Names are compared after normalisation,
  since `A`, `A::` and ` A ` collapse onto the same machine name.

Cards

- Fix: a note whose templates all render empty now gets a card anyway, matching
  Anki's `ensure_not_empty`. Such notes previously shipped with no cards at all,
  leaving them invisible in the collection.
- Fix: cloze deletions follow Anki's tokenizer.
  - Comma lists (`{{c1,2,3::x}}`) generate a card each rather than being ignored.
  - Cloze number 0 is discarded instead of writing `ord = -1`, which aborted the
    entire import because Anki reads `ord` as a `u16`.
  - Ordinals are capped at 499, and numbers beyond `u16` are no longer treated
    as cloze markers.
  - Only the first 10 nested markers count.
- Fix: card generation matches Anki's template rules.
  - Anki's special fields (`Deck`, `Subdeck`, `Type`, `Card`, `CardFlag`,
    `CardID`) count as content; `<!-- ... -->` comments do not.
  - `{{{Field}}}` resolves to `Field`, and a filter key is not trimmed.
  - A template that fails to parse generates no card, rather than one that
    cannot render.
  - Field emptiness uses ASCII whitespace only, so a field holding a
    non-breaking or ideographic space is no longer treated as empty.
  - The legacy `{{=<% %>=}}` directive switches the template to `<% %>`
    delimiters, as Anki does. Such a template previously rendered nothing, so
    its card was never generated.

Notes

- Fix: ASCII control characters are stripped from field values, as Anki does.
  A value containing the field separator previously split into extra fields and
  failed Anki's field-count check, aborting the import; a NUL truncated the rest
  of the note outright, because sql.js binds strings as NUL-terminated.
- Fix: `sfld` and `csum` are computed from the field with HTML stripped, which
  is what Anki stores and what its duplicate detection compares against.
- Fix: HTML entity decoding is Anki's, character for character. It was a pair
  of regex passes, which decoded far more than Anki does: any `&` that does not
  open a valid entity leaves the whole string undecoded, so `Tom & Jerry &amp;
  Co` keeps its `&amp;`. A decoded `&` is no longer rescanned, `&#xD800;` no
  longer produces a lone surrogate, `&#X41;` is no longer accepted, and
  `&constructor;` no longer resolves off the entity table's prototype and
  writes a JavaScript function into the note.
- Fix: stripping a field no longer takes exponential time. The media-tag
  pattern is a transcription of Anki's, which is linear under Rust's regex
  engine but not under a backtracking one: a 136-character field took 29
  seconds, and every note is stripped twice.
- Fix: two places where transcribing that pattern into JavaScript changed what
  it matches. Anki writes it in verbose mode, where the regex crate drops
  insignificant whitespace inside character classes too, so `<img src= foo.jpg>`
  keeps the space as part of the filename; and Rust's word boundary is
  Unicode-aware, so `<imgé src=a.jpg>` is not a media tag. Both were settled by
  running Anki's own pattern under the regex version it pins, over a
  4024-input corpus that the pattern here now reproduces exactly.
- Fix: GUID digits are emitted most significant first, matching Anki's
  `to_base_n`.
- Change: a tag containing a space is rejected. Anki splits the stored tag
  string on spaces, so such a tag silently became several.

Note types

- Fix: field and template ids are now written. Without them Anki matches fields
  by name when deciding whether an incoming note type is the same as one it
  already has, which meant an id collision could overwrite the user's own note
  type in place. The ids are derived from the note type and field names, so a
  rebuilt deck keeps matching the same fields on re-import.
- Fix: the `reqs` cache in the shipped note type now uses Anki's own algorithm.
  Anki recomputes it on import, so this only matters to other tools that read
  an apkg directly.
- Change: note types with no fields, no templates, or an empty name are
  rejected, as are field names Anki rewrites on import (containing `:{}"` or
  starting with `#/^`) and field names differing only in case. Anki renames
  these but does not rewrite the `{{Field}}` references in the templates we
  shipped, so the two would stop matching.
- Fix: the stock note types now match Anki's byte for byte. The default CSS was
  missing `line-height: 1.5` and used a different indent, the LaTeX preamble was
  missing its trailing newline, `<hr id=answer>` was written with the id quoted,
  and `Model.cloze()` shipped a different answer template and cloze styling.
- Fix: the stock note types record which Anki preset they came from. Without it
  Anki refuses "Restore to Default" on an imported note type.
- Fix: `Model.cloze()` marks its `Text` field as protected, as Anki does, so the
  editor no longer offers to delete the field the note type depends on.
- Fix: deck name components are trimmed against Rust's whitespace set rather
  than JavaScript's. The two disagree on U+0085 and U+FEFF, and a deck whose
  name began with U+FEFF lost the character and merged into the user's
  similarly named deck instead of staying separate.

Deck presets

- Change: option values outside Anki's accepted ranges are rejected. Anki
  replaces an out-of-range value with its own default rather than clamping, so
  these were silently discarded. `desiredRetention` was documented as 0 to 1 and
  is actually 0.7 to 0.99.
- Change: `easyDaysPercentages` must have 0 or 7 entries. Any other length makes
  Anki's load balancer fail to build the study queue for every deck in the
  collection, not just the imported one.
- Change: an unnamed `DeckConfig` is named `Preset <id>` rather than `Default`.
  Anki uniquifies imported deck names but not preset names, so the old default
  put a second, indistinguishable "Default" in the user's preset list.
- Fix: `DeckConfig` copies its options. They were read again when the package
  was built, so mutating the object after construction bypassed validation
  entirely.
- Fix: `secondsToShowQuestion` and `secondsToShowAnswer` accept fractions. Anki
  stores both as floats and its own UI offers 0.1 steps, so whole numbers were
  being demanded for no reason.

Media

- Change: `addMedia` rejects names that are not a plain filename, and names that
  collide once Anki normalises them to NFC. Anki rejects the entire package for
  the first, and silently drops one of the files for the second.

API

- Fix: `NO_PRESET` and the `NoPreset` type are exported from the package entry
  point, so the documented `config: null` contract is fully expressible.

## 0.1.3

- Fix: `Deck({ config: null })` apkgs no longer fail import with "No such
  deck config: '1'". Anki's apkg importer runs a gather pass on the apkg's
  temp collection that resolves every deck's `config_id` against the apkg's
  own `deck_config` table, so an empty table (as 0.1.2 produced) failed
  validation. We now ship a single placeholder row at id=1 named "Default";
  Anki's merge step uses `INSERT OR IGNORE`, so the row is silently dropped
  on collision with the user's existing Default preset and nothing in their
  setup is overwritten.

## 0.1.2

- Feature: `Deck({ config: null })` ships no per-deck `deck_config` row and
  points the deck at Anki's built-in default preset (id=1) on import.
  Previously, omitting `config` always inserted an auto-generated minimal
  preset, which meant every imported deck added a new entry to the user's
  deck options list. The new sentinel makes "use the user's default preset"
  expressible.

## 0.1.1

- Fix: `templateHasContent` now honors mustache section gating
  (`{{#Field}}…{{/Field}}`), matching Anki's own algorithm. Templates
  whose body is wrapped in a section with an empty gate no longer
  generate phantom "(empty card)" entries.
- Fix: emit explicit `.js` extensions on relative imports so the
  compiled ESM works under Node's strict resolver without a manual
  patch.

## 0.1.0

Initial release.

- Generate `.apkg` files targeting the latest Anki format (V18 schema with protobuf)
- Full FSRS scheduler support (desired retention, custom weights, all deck options)
- Built-in note types: Basic, Basic (and reversed), Basic (type in the answer), Cloze
- Custom note types with arbitrary fields, templates, and CSS
- Media file attachments (images, audio, etc.)
- Multiple decks per package
- Works in browsers, Node.js, and Bun
