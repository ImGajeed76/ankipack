---
title: Why ankipack refuses input instead of repairing it
description: ankipack throws on anything Anki would silently rewrite, drop or refuse, at the call that supplied it. The alternative is a package that imports and is quietly not what you built.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/explanation/validation
  type: explanation

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: intermediate
  time_estimate: 6m

  status: stable

  aliases:
    [
      why does this throw,
      ankipack validation,
      invalid-input,
      why not clamp,
      strict validation,
    ]

  prev: ./anki-import.md
  next: ./apkg-format.md
---

# Why ankipack refuses input instead of repairing it

Anki will accept things it does not keep. A value it will not store as given is
rewritten, replaced with a default, or thrown out along with the whole file, and
only one of those three tells anybody.

So ankipack refuses such values at the call that supplied them, which means it
rejects packages Anki would import without complaint: a deck name colliding with
another [only in case](./anki-import.md), a field named `Reading: kana`, a
desired retention [outside its range](../reference/deck-config.md), a tag with a
space in it.

## Anki disposes of bad input three ways

**It sometimes refuses the whole file.** One media filename that is not already
normalised makes the importer reject the entire package, with no indication of
which image caused it.

**It sometimes rewrites the value.** Field names lose characters Anki disallows,
and the templates shipped alongside are not rewritten to match, so the field
parts company with the `{{Field}}` reference pointing at it and every card of
that note type renders an error.

**Most often it replaces the value outright.** A deck preset value outside its
range is not brought to the nearest legal one, it is overwritten with the
default. Ship a desired retention of 0.5 and the recipient gets 0.9, not 0.7: a
number you never asked for, and the one everybody who set nothing is already
using.

## Failing early is the only useful place to fail

You build a package, it writes without complaint, and your own test import works,
because your collection does not have the deck whose name collides. A stranger's
does. By then the cause is a line in a build script on a machine you do not own.

Refusing moves that failure to the only place it can be acted on. The stack
trace points at the note, the message names the field, and nothing has been
written yet. It is also why every error carries a
[machine-readable code](../reference/errors.md).

A value that can be judged on its own is refused at the call that supplied it,
so nothing half-built ever exists. Anything needing the whole package to judge,
two decks colliding on name or two notes sharing a GUID, waits for the write, as
does anything reached through
[`col.data`](../reference/collection-document.md): an escape hatch that validated
every assignment would not be one.

## Not everything Anki changes is worth refusing

The rule is not "reject anything Anki would change". Control characters in a
field value are stripped silently, because Anki does the same and nothing in the
package refers back to the original form.

The line is whether the rewrite breaks something shipped alongside or discards a
decision you made. Field names are refused unless already in NFC, for the reason
above: Anki normalises the name and leaves the template alone. The same
normalisation applied to a field's contents is harmless, and allowed.

Duplicate note GUIDs show the shape of it. `Collection.addNote` refuses one
outright, and a `Package` carrying two refuses at the write, because Anki keeps
one note per GUID and a package with two would ship both while only ever
updating one. What neither does is refuse a duplicate pair that was already in a
file you opened: Anki's schema has no index on `notes.guid`, so a real
collection can legitimately hold one, and a library promising to leave files
unchanged cannot start rejecting it.

Checks live where ankipack is creating something, not where it is passing
something through.

## What this costs

You decide things Anki would have decided badly on your behalf, and you cannot
decline. There is no flag that turns any of this off.

A media file with a bracket in its name has to be renamed by you, because
ankipack renaming it would break the `img` tag in your template that refers to
it, and only you know which of the two is the real name.
