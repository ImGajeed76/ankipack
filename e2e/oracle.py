"""Drives a real Anki as an oracle for ankipack.

The TypeScript suite can only check that ankipack agrees with itself. This runs
Anki's actual Rust core over the same files, so "Anki accepts this" and "this is
what Anki would have produced" become things a test can assert rather than
things a human has to check by importing by hand.

Commands, each taking and returning JSON on stdout:

  import  <apkg>            import into a fresh collection, report what landed
  export  <out> [--legacy]  build a small reference deck and export it
  convert <legacy> <out>    import a legacy package, re-export it as current
  version                   report the installed Anki version
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from anki.collection import Collection
from anki.decks import DeckId
from anki.import_export_pb2 import (
    ExportAnkiPackageOptions,
    ImportAnkiPackageOptions,
    ImportAnkiPackageRequest,
)

FULL_IMPORT = ImportAnkiPackageOptions(with_scheduling=True, with_deck_configs=True)
FULL_EXPORT = dict(with_scheduling=True, with_deck_configs=True, with_media=True)


def _fresh(tmp: str) -> Collection:
    return Collection(str(Path(tmp) / "collection.anki2"))


def cmd_import(apkg: str) -> dict:
    """Import into an empty collection and describe the result."""
    with tempfile.TemporaryDirectory() as tmp:
        col = _fresh(tmp)
        try:
            out = col.import_anki_package(
                ImportAnkiPackageRequest(package_path=apkg, options=FULL_IMPORT)
            )
            log = out.log
            # `ok` is Anki's own verdict. The text cannot stand in for it:
            # `fix_integrity` always appends "Database rebuilt and optimized",
            # and it wraps every count in U+2068/U+2069 isolates, which defeats
            # a pattern like `fixed \d`.
            problems, check_ok = col.fix_integrity()
            return {
                "ok": True,
                "notes_imported": len(log.new),
                "notes_in_file": log.found_notes,
                "duplicate": len(log.duplicate),
                "conflicting": len(log.conflicting),
                # Anki seeds a new collection with its own stock notetypes and a
                # Default deck, so callers filter those out themselves.
                "decks": sorted(d.name for d in col.decks.all_names_and_ids()),
                "notetypes": sorted(n.name for n in col.models.all_names_and_ids()),
                "presets": sorted(c["name"] for c in col.decks.all_config()),
                "cards": col.card_count(),
                "notes": col.note_count(),
                "check_ok": check_ok,
                "check_database": problems,
            }
        except Exception as err:  # noqa: BLE001 - the message is the result
            return {"ok": False, "error": f"{type(err).__name__}: {err}"}
        finally:
            col.close()


def cmd_export(out_path: str, legacy: bool) -> dict:
    """A reference deck written by Anki itself.

    Names are deliberately unlike Anki's stock ones: importing a deck whose
    notetype collides with an existing one makes Anki rename it to "Basic+",
    which would show up as a difference that is not ours.
    """
    with tempfile.TemporaryDirectory() as tmp:
        col = _fresh(tmp)
        try:
            notetype = col.models.new("Oracle Pair")
            for name in ("Term", "Meaning"):
                col.models.add_field(notetype, col.models.new_field(name))
            template = col.models.new_template("Recognition")
            template["qfmt"] = "{{Term}}"
            template["afmt"] = "{{FrontSide}}\n\n<hr id=answer>\n\n{{Meaning}}"
            col.models.add_template(notetype, template)
            col.models.add(notetype)
            notetype = col.models.by_name("Oracle Pair")

            deck_id = col.decks.id("Oracle::Sub")
            for term, meaning in [("alpha", "one"), ("beta", "two")]:
                note = col.new_note(notetype)
                note["Term"] = term
                note["Meaning"] = meaning
                note.tags = ["oracle"]
                col.add_note(note, DeckId(deck_id))

            col.export_anki_package(
                out_path=out_path,
                options=ExportAnkiPackageOptions(legacy=legacy, **FULL_EXPORT),
                limit=None,
            )
            return {"ok": True, "path": out_path, "legacy": legacy}
        finally:
            col.close()


def cmd_convert(legacy_path: str, out_path: str) -> dict:
    """Anki's own answer to 'what should this legacy package become'."""
    with tempfile.TemporaryDirectory() as tmp:
        col = _fresh(tmp)
        try:
            col.import_anki_package(
                ImportAnkiPackageRequest(package_path=legacy_path, options=FULL_IMPORT)
            )
            col.export_anki_package(
                out_path=out_path,
                options=ExportAnkiPackageOptions(legacy=False, **FULL_EXPORT),
                limit=None,
            )
            return {"ok": True, "path": out_path}
        finally:
            col.close()


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    command, *rest = argv
    if command == "import":
        result = cmd_import(rest[0])
    elif command == "export":
        result = cmd_export(rest[0], "--legacy" in rest)
    elif command == "convert":
        result = cmd_convert(rest[0], rest[1])
    elif command == "version":
        import anki.buildinfo

        result = {"ok": True, "anki": anki.buildinfo.version}
    else:
        result = {"ok": False, "error": f"unknown command {command!r}"}

    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
