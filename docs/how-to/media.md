---
title: Attach media to a deck
description: How to add images and audio to a package, and the filename rules that matter, because Anki refuses an entire .apkg over a single name it would have to rewrite.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/how-to/media
  type: how-to

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: intermediate
  time_estimate: 8m

  status: stable

  aliases:
    [
      media,
      images,
      audio,
      addMedia,
      setMedia,
      media-name,
      filename rules,
      sound,
    ]

  references:
    - https://docs.ankiweb.net/media.html
    - https://docs.ankiweb.net/templates/fields.html

  prev: ./edit-apkg.md
  next: ./browser.md
---

# Attach media to a deck

Attaching an image or a sound is two lines. The part worth reading first is
that Anki refuses an entire package over a single filename it would have to
rewrite, so the naming rules below decide whether your deck installs at all.

Media files are attached to the package and referenced from a note's fields or
its templates by bare filename. There are no paths inside a collection: every
media file lives in one flat namespace.

```ts novars hl_lines="22-23 30-31"
import { Deck, Note, Notetype, Package } from "ankipack";
import { readFile } from "node:fs/promises";

const my_notetype = new Notetype({
  name: "Bird calls",
  fields: [{ name: "Species" }, { name: "Photo" }, { name: "Call" }],
  templates: [
    {
      name: "Card 1",
      questionFormat: "{{Call}}<br>What bird is this?",
      answerFormat: "{{FrontSide}}<hr id=answer>{{Species}}<br>{{Photo}}",
    },
  ],
});

const my_deck = new Deck({ name: "Bird calls" });
my_deck.addNote(
  new Note({
    notetype: my_notetype,
    fields: [
      "Common blackbird",
      '<img src="blackbird.jpg">', // (1)!
      "[sound:blackbird.mp3]",
    ],
  }),
);

const pkg = new Package();
pkg.addDeck(my_deck);
pkg.addMedia("blackbird.jpg", await readFile("assets/blackbird.jpg")); // (2)!
pkg.addMedia("blackbird.mp3", await readFile("assets/blackbird.mp3"));
```

1. Anki's syntax rather than ankipack's: an `img` tag for a picture and
   `[sound:...]` for audio, both documented under
   [field replacements](https://docs.ankiweb.net/templates/fields.html).
2. This name and the one in the field have to match exactly, and nothing checks
   that they do. A reference with no file behind it renders broken, and a file
   nothing references just makes the deck bigger. Neither is reported.

Put the reference in a field, as above, or in a card template when every card
should carry the same asset. A template asset has to be named with a leading
`_`, as in `_logo.png`.

!!! danger "The underscore is not a convention, it is the rule"
    Anki decides which media to copy by scanning note fields, and nothing else.
    A file reachable only from a template is never marked as used, so it is
    dropped on the way in and the card renders a broken image or a silent
    sound. A leading `_` marks the file static, and static files are copied
    whether or not anything was found referencing them.

    Your own build is complete either way, so this only ever shows up on
    somebody else's machine.

Adding the same filename twice throws rather than replacing it silently. To
replace deliberately, use `col.setMedia` on an opened collection.

## Filenames are the part that bites

!!! warning "One bad filename costs the whole deck"
    Anki's `.apkg` importer refuses a package outright if any media filename is
    not already in the form it would store. Not the one file. The entire
    import fails with `The provided file is not a valid .apkg file.`, which
    names neither the file nor filenames as the problem.

So ankipack checks every name at the call that supplied it and throws
[`media-name`](../reference/errors.md) naming the rule that name breaks. The
manual's advice to run Tools then Check Media afterwards is for files you copy
into the media folder yourself, where there is a repair step. A package has
none.

## The rules

A filename must not:

- Be empty, or be `.` or `..`
- Contain any of `[ ] < > : " / ? * ^ \ |`, so `diagram [1].png` is out
- Contain an ASCII control character, a non-breaking space, or a lone surrogate
- Be a Windows device name, alone or before the extension. The set is `CON`,
  `PRN`, `AUX`, `NUL`, `COM1` to `COM9` and `LPT1` to `LPT9`, so `CON.png` and
  `lpt1.jpg` are both out
- End with a space or a period. The test is on the whole name, so `photo.` and
  a name with a trailing space both fail, while `photo .jpg` is fine
- Exceed 120 bytes encoded as UTF-8, which is fewer than 120 characters once
  the name is not ASCII
- Be anything but NFC normalised
- Contain a code point Anki reads as unassigned

The last two are the ones that catch people who did nothing obviously wrong.

**NFC.** macOS filesystems hand back decomposed filenames, so a name with an
accent in it read straight from `readdir` on a Mac is very likely to fail this
even though it looks identical to the composed form. JavaScript normalises it
for you, `name.normalize("NFC")`, so do that before you use it as the media
name, and rename the file on disk to match.

**Unassigned code points.** Anki carries Unicode 10 character tables, so a code
point assigned after Unicode 10 is one Anki considers unassigned and strips.
In practice this means recent emoji are refused in filenames.

## Rename the file, do not let ankipack do it

The fix is always the same shape: rename the asset, update the reference,
rebuild. ankipack reports the problem instead of correcting it
[by design](../explanation/validation.md), because a rename it chose would
break the reference pointing at the old name.

If you are generating filenames from data you do not control, sanitise them
before they reach `addMedia`, and key your references off the sanitised name.

## Media on an opened collection

`addMedia` is for a package you are building. On one you opened, the same job is
`col.setMedia(name, data)`, with one difference worth having: it replaces an
existing file rather than refusing, which is how you swap an image without
touching a single note that points at it. The filename rules are identical.

`col.removeMedia(name)` deletes one and checks nothing, since a name it cannot
find does no harm.

!!! warning "Opening a legacy package can rename its media"
    A schema 11 `.apkg` is the one case where ankipack does repair a filename
    instead of refusing it, because that is what Anki does with the legacy
    layout. `Collection.open` applies Anki's normalisation on the way in, so a
    name can arrive truncated to 120 bytes, stripped of disallowed characters,
    or with an underscore appended to a Windows device name.

    The note fields are not rewritten to match. If a note says
    `<img src="diagram [1].png">` and the file arrives as `diagram 1.png`, that
    card renders a broken image, and writing the collection back ships it that
    way. After opening a legacy package, compare
    `col.data.media.map((f) => f.name)` against the filenames your notes
    reference before you write anything.

Names are re-checked when the file is written, since `col.data.media` reaches
the writer directly. That one raises `invalid-document` rather than
`media-name`.

## Limits

There are two, and neither of them is Anki's.

A package holds at most 65,532 media files, which is the zip format's entry
count. Exceeding it is refused at the save.

Formats are not restricted in the package at all, so the real limit is whatever
the recipient's client can play. The manual's note on
[supported formats](https://docs.ankiweb.net/media.html#supported-formats) is
where to check before committing to a codec, and MP3 and MP4 are the safest
across mobile and AnkiWeb.
