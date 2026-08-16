# End-to-end tests

Everything under `test/` proves ankipack agrees with itself. That is worth a
lot, and it is not the same as being right: a reader and a writer built from the
same misreading of the format will round-trip happily and still produce a file
Anki refuses.

These tests run Anki's real Rust core over the same files.

## Setup

```bash
bun run e2e:setup   # creates e2e/.venv and installs anki==26.8.1
bun run test:e2e
```

The virtualenv is gitignored. `bun run test` does not touch any of this, so the
default suite stays fast and needs no Python.

## Why the version is pinned

ankipack claims parity with a specific Anki, and the tests assert against that
claim. The first e2e test checks the installed Anki against `PINNED_ANKI`, so an
accidental upgrade fails loudly rather than quietly changing what "correct"
means.

The release is spelled two ways and both are needed. PyPI publishes it as
`26.8.1`, which is the pin in `requirements.txt` that `setup.sh` installs.
`anki.buildinfo.version` reports `26.08.1`, which is what `PINNED_ANKI` in
`anki.ts` holds. Bumping is deliberate: change both together.

## What is here

- `oracle.py` runs inside the venv and speaks JSON. It can import a package,
  export a reference package written by Anki itself, and convert a legacy
  package to the current format.
- `anki.ts` wraps it, and filters out the stock notetypes and Default deck that
  every fresh Anki collection starts with.
- `import.e2e.test.ts` asserts Anki accepts what ankipack writes, both from the
  builder and from the read-edit-write path, with a clean Check Database.
- `oracle.e2e.test.ts` uses Anki as the authority on the schema 11 conversion.
  Anki imports a legacy package and re-exports it in the current format; that
  output is what ankipack's own converter is compared against.

## Comparing by content, not by row

Anki reassigns ids and timestamps when it imports, and its exporter leaves
behind the `fields` and `templates` rows of notetypes it filtered out. So the
oracle compares note types by name, notes by GUID, and cards by ordinal per
note, rather than expecting rows to match.
