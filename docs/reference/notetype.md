---
title: Notetype
description: Every option, default and validation rule for note types, fields and templates, plus the places ankipack's card generation is observable and Anki's manual is silent or out of date.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/reference/notetype
  type: reference

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: intermediate
  time_estimate: 12m

  status: stable

  aliases:
    [
      Notetype,
      NotetypeOptions,
      FieldDef,
      TemplateDef,
      model,
      note type,
      cloze,
      basic,
      card templates,
      sortFieldIndex,
    ]

  references:
    - https://docs.ankiweb.net/templates/fields.html
    - https://docs.ankiweb.net/templates/generation.html
    - https://docs.ankiweb.net/templates/styling.html
    - https://docs.ankiweb.net/editing.html#customizing-fields
    - https://docs.ankiweb.net/math.html
---

# Notetype

A note type is the shape of a note: which fields it holds, and which cards those
fields produce. Every note points at one.

Settle that shape before you publish. Renaming a field, or the note type itself,
makes your next release arrive as a second note type with all of its notes
skipped.

## Stock note types

Four, and between them they cover most decks:

| Constructor                   | Fields           | Cards per note       | Use when                                          |
| ----------------------------- | ---------------- | -------------------- | ------------------------------------------------- |
| `Notetype.basic()`            | Front, Back      | 1                    | One direction is enough                           |
| `Notetype.basicAndReversed()` | Front, Back      | 2                    | Every note should be tested both ways             |
| `Notetype.basicTyping()`      | Front, Back      | 1                    | The answer should be typed rather than recalled   |
| `Notetype.cloze()`            | Text, Back Extra | one per cloze number | Material is sentences with gaps rather than pairs |

Each accepts an optional `{ name?, css? }`. Renaming is the usual reason to
pass `name`, so your note type sits alongside a recipient's own Basic rather
than colliding with it.

A stock note type records which of Anki's own it came from, so Restore to
Default knows which one it means without asking.

## When none of those fit

The constructor takes `NotetypeOptions`, and needs a name, at least one field
and at least one template:

```ts novars
import { Notetype } from "ankipack";

const my_notetype = new Notetype({
  name: "Vocab (Spanish)",
  fields: [{ name: "Spanish" }, { name: "English" }, { name: "Note" }],
  templates: [
    {
      name: "Card 1",
      questionFormat: "{{Spanish}}",
      answerFormat: '{{FrontSide}}<hr id="answer">{{English}}<br>{{Note}}',
    },
  ],
});
```

The template bodies are Anki's own syntax, documented in
[field replacements](https://docs.ankiweb.net/templates/fields.html). The `css`
option is ordinary card styling, documented in
[styling and HTML](https://docs.ankiweb.net/templates/styling.html). Neither is
restated here.

| Option           | Type                  | Default                 | Description                                                              |
| ---------------- | --------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `name`           | `string`              | required                | Shown in Anki's note type list                                           |
| `fields`         | `FieldDef[]`          | required                | At least one. Order is significant                                       |
| `templates`      | `TemplateDef[]`       | required                | At least one                                                             |
| `type`           | `"normal" \| "cloze"` | `"normal"`              | Cloze changes how cards are generated                                    |
| `css`            | `string`              | Anki's default          | Applied to every card of this note type                                  |
| `sortFieldIndex` | `number`              | `0`                     | Which field the browser sorts on                                         |
| `latexPre`       | `string`              | Anki's default preamble | LaTeX header. See [Math and Symbols](https://docs.ankiweb.net/math.html) |
| `latexPost`      | `string`              | `\end{document}`        | LaTeX footer                                                             |
| `latexSvg`       | `boolean`             | `false`                 | Render LaTeX as SVG rather than PNG                                      |
| `id`             | `number`              | from the clock          | Pin it to [publish updates](../how-to/ship-updates.md)                   |

`sortFieldIndex` must be an integer within the field count. Anki clamps an
out-of-range value into bounds, so shipping one silently sorts on a field you
did not choose.

!!! warning "`css`, the LaTeX strings and the template bodies are never checked"
    Names go through validation. These do not, because they land in protobuf
    columns rather than in columns Anki indexes. Neither ankipack nor Anki
    limits their length, and neither refuses a lone surrogate: the encoder
    replaces it with U+FFFD, which corrupts the stylesheet or the template
    rather than the import, so the deck installs and renders wrong.

    The same applies to `questionFormat`, `answerFormat`, their browser
    variants, `browserFontName`, and a field's `description` and `fontName`.
    Sanitise any of them you build from data you do not control.

## FieldDef

| Option        | Type      | Default   | Description                                        |
| ------------- | --------- | --------- | -------------------------------------------------- |
| `name`        | `string`  | required  | Unique within the note type, compared without case |
| `sticky`      | `boolean` | `false`   | Keep the value when adding the next note           |
| `rtl`         | `boolean` | `false`   | Right-to-left text direction                       |
| `fontName`    | `string`  | `"Arial"` | Editor font                                        |
| `fontSize`    | `number`  | `20`      | Editor font size                                   |
| `description` | `string`  | `""`      | Placeholder shown in the editor                    |
| `plainText`   | `boolean` | `false`   | Edit as plain text rather than HTML                |

Everything except `name` affects the editor rather than the finished card, and
[Customizing Fields](https://docs.ankiweb.net/editing.html#customizing-fields)
describes them, apart from `sticky` and `description`. The exception is
`Notetype.basicTyping()`, where `fontName` and `fontSize` also style the
type-in-the-answer box on the card itself.

`plainText` is the checkbox Anki labels "Use HTML editor by default", set
directly rather than inverted. Anki's name for editing raw HTML is the plain
text editor, which is why the option and its label read as opposites.

### Field name rules

Anki rewrites or refuses several kinds of field name on import and does not
rewrite the `{{Field}}` references in the templates shipped alongside, so the
two stop matching. ankipack refuses them at construction instead.

| A field name must not                      | Because Anki would                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Be empty                                   | Refuse it                                                                                              |
| Contain `:`, `{`, `}` or `"`               | Strip the character, breaking its template reference                                                   |
| Start with `#`, `/` or `^`                 | Strip it, breaking its template reference                                                              |
| Have leading or trailing whitespace        | Trim it, breaking its template reference                                                               |
| Differ from its own NFC form               | Normalise it, breaking its template reference                                                          |
| Contain a lone surrogate                   | Refuse the whole collection, since it has no UTF-8 form                                                |
| Contain a NUL                              | Nothing. SQLite binds strings NUL-terminated, so ankipack refuses it to avoid writing a truncated name |
| Match another field without regard to case | Rename one of them                                                                                     |

Whitespace here is Rust's definition, not JavaScript's. The two differ in both
directions: `U+0085` is whitespace to Rust but not to `\s`, and `U+FEFF` is the
reverse.

Anki's manual advises against naming a field `Tags`, `Type`, `Deck`, `Card` or
`FrontSide`, because those are special names in templates. ankipack **does not
refuse them**. A field that shadows a special name wins: card generation and
rendering both read your field, and the special value becomes unreachable from
that note type's templates.

## TemplateDef

| Option                  | Type     | Default  | Description                                        |
| ----------------------- | -------- | -------- | -------------------------------------------------- |
| `name`                  | `string` | required | Shown in the card type list                        |
| `questionFormat`        | `string` | required | Front side. Decides whether the card exists at all |
| `answerFormat`          | `string` | required | Back side. `{{FrontSide}}` includes the question   |
| `questionFormatBrowser` | `string` | `""`     | Alternative front for the browser view             |
| `answerFormatBrowser`   | `string` | `""`     | Alternative back for the browser view              |
| `browserFontName`       | `string` | `""`     | Browser column font                                |
| `browserFontSize`       | `number` | `0`      | Browser column font size                           |

Template names carry the same rules as note type names: not empty, no `"`, NFC
only, no NUL or lone surrogate, and no two differing only in case.

## Why renaming anything is expensive

Field and template ids are derived, not stored. Each is a hash of the note
type's name, the member's own name, and its index. All three go into it, so
renaming the note type changes every field and template id at once, and
inserting a field anywhere but the end changes the id of everything after it.

Those ids are [how Anki decides](../explanation/anki-import.md) whether your
note type is the one it saw last time, and pinning the note type's `id` does not
protect them.

## Card generation

How many cards a note produces is Anki's rule, and the manual explains it in
[Card Generation](https://docs.ankiweb.net/templates/generation.html): a card
exists for each template whose question side would not be blank. ankipack
implements the same rule so that a package it builds already contains the cards
Anki would have generated.

!!! warning "The manual is out of date on special fields"
    It states that Anki "does not consider special fields or non-field text"
    when generating cards. The non-field-text half is correct. The
    special-fields half is not, as of Anki 26.08: every special name except
    `{{FrontSide}}` counts as non-empty, unless a real field of the same name
    shadows it, and `{{Tags}}` counts only when the note actually has tags. A
    front template of just `{{Deck}}` generates a card.

Three things decide what counts as blank, and each of them surprises somebody:

**Empty is narrower and wider than it looks.** A field counts as empty when it
holds nothing but ASCII whitespace and `<br>` or `<div>` tags, which is what a
WYSIWYG editor leaves behind in a field the user cleared. It does **not** count
as empty when it holds a non-breaking or ideographic space, so a field of those
still generates a card.

**HTML comments do not count.** Text inside `<!-- ... -->` is not content for
this purpose.

**`{{{Field}}}` resolves to `Field`.** Leading braces are stripped before the
name is read, so a triple-braced reference is the field, not a literal.

Separately from all of that, **a template that fails to parse counts as
generating nothing**, rather than producing a card that renders an error.

**A note is never left cardless.** When nothing above generates a card, Anki
gives the note one anyway, on the first template, so an incomplete note can be
added and finished later.

### Cloze

A cloze note type ignores template count and generates one card per distinct
cloze number found in the fields.

| Written                                | Produces                                                  |
| -------------------------------------- | --------------------------------------------------------- |
| `{{c1::text}}`                         | One card                                                  |
| `{{c1,2,3::text}}`                     | Three cards, one per number                               |
| `{{c500::text}}` to `{{c65535::text}}` | All collapse onto one card                                |
| `{{c0::text}}`                         | No cloze card. Zero is discarded                          |
| A number above 65535                   | No cloze card. It is not recognised as a marker           |
| An unclosed marker                     | No cloze card, and anything nested inside it is discarded |

Nesting is tracked ten deep.

The last three rows do not leave the note cardless either. The same fallback
applies: one card, on the first template.
