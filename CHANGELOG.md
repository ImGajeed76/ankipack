# Changelog

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
