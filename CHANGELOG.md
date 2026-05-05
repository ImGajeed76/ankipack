# Changelog

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
