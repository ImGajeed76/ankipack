import { describe, test, expect } from "bun:test";
import { Package, Deck, DeckConfig, Notetype, Note } from "../src/index";
import { fromBinary } from "@bufbuild/protobuf";
import {
  Notetype_ConfigSchema,
  Notetype_Template_ConfigSchema,
} from "../src/generated/anki/notetypes_pb";
import { FIELD_SEPARATOR } from "../src/util/constants";
import { stripHtmlPreservingMediaFilenames } from "../src/util/text";
import { templateRenders, templateRendersForRequirements } from "../src/util/template";
import { openPackage, column, scalar } from "./helpers/collection";

// Each test asserts what Anki does, cited to the Anki source above it.

const ANKI = "anki@26.08.1";

// Built from char codes so this file holds no bytes a reader cannot see.
const NBSP = String.fromCharCode(0x00a0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const NUL = String.fromCharCode(0);

async function cardOrds(
  notetype: Notetype,
  fields: string[],
  tags: string[] = [],
): Promise<number[]> {
  const deck = new Deck({ name: "T" });
  deck.addNote(new Note({ notetype, fields, tags }));
  const pkg = new Package();
  pkg.addDeck(deck);
  const opened = await openPackage(pkg);
  try {
    return column(opened.db, "SELECT ord FROM cards ORDER BY ord").map(Number);
  } finally {
    opened.db.close();
  }
}

// A single-template note type cannot test card generation, because Anki's
// ensure_not_empty fallback forces card 0 when nothing renders, so "renders"
// and "does not render" both produce [0]. Every case below therefore ships a
// control template at ord 0 that always renders, with the case under test at
// ord 1. Result [0, 1] means it rendered; [0] means it did not.
function withControl(questionFormat: string): Notetype {
  return new Notetype({
    name: `M:${questionFormat}`,
    fields: [{ name: "Control" }, { name: "Front" }, { name: "Back" }],
    templates: [
      { name: "Control", questionFormat: "{{Control}}", answerFormat: "x" },
      { name: "Subject", questionFormat, answerFormat: "x" },
    ],
  });
}

function subjectOrds(
  questionFormat: string,
  front = "hi",
  back = "",
  tags: string[] = [],
): Promise<number[]> {
  return cardOrds(withControl(questionFormat), ["always", front, back], tags);
}

describe("cloze ordinals", () => {
  // rslib/src/cloze.rs add_cloze_numbers_in_text_with_clozes: `if ordinal != 0`
  // rslib/src/card/mod.rs:80 `template_idx: u16` -> a -1 ord fails to decode and
  // aborts the whole import during the gather pass.
  test(`c0 is discarded, never written as ord -1 (${ANKI} cloze.rs)`, async () => {
    expect(await cardOrds(Notetype.cloze(), ["{{c0::x}}", ""])).toEqual([0]);
  });

  test(`c0 alongside c2 leaves only the c2 card (${ANKI} cloze.rs)`, async () => {
    expect(await cardOrds(Notetype.cloze(), ["{{c0::a}} {{c2::b}}", ""])).toEqual([1]);
  });

  // rslib/src/cloze.rs tokenize: take_while(is_ascii_digit || ','), then split(',')
  test(`comma-separated ordinals generate one card each (${ANKI} cloze.rs)`, async () => {
    expect(await cardOrds(Notetype.cloze(), ["{{c1,2,3::multi}}", ""])).toEqual([0, 1, 2]);
  });

  // The nastiest variant: a plain c1 matches, so nothing looks wrong, but the
  // c3 card is silently missing.
  test(`a comma list mixed with a plain marker keeps both (${ANKI} cloze.rs)`, async () => {
    expect(await cardOrds(Notetype.cloze(), ["{{c1::a}} {{c1,3::b}}", ""])).toEqual([0, 2]);
  });

  // rslib/src/notetype/cardgen.rs:169 `cloze_ord.saturating_sub(1).min(499)`.
  // The resulting card renders "No cloze 500 found": Anki clamps the ordinal
  // without rewriting the note text, and does the same for its own notes.
  test(`ordinals are clamped to 499 (${ANKI} cardgen.rs new_cards_required_cloze)`, async () => {
    expect(await cardOrds(Notetype.cloze(), ["{{c600::x}}", ""])).toEqual([499]);
  });

  // Above u16 the marker fails to parse in Anki, so it is not a cloze at all
  // and the note falls back to a single card at ord 0.
  test(`an ordinal beyond u16 is not treated as a cloze (${ANKI} cloze.rs)`, async () => {
    expect(await cardOrds(Notetype.cloze(), ["{{c999999::x}}", ""])).toEqual([0]);
  });

  // rslib/src/cloze.rs: a closed marker is pushed into its parent's nodes, and
  // ordinals are collected only from what is reachable at the top level, so an
  // unclosed outer marker discards everything nested inside it.
  test(`an unclosed outer marker discards its children (${ANKI} cloze.rs)`, async () => {
    expect(await cardOrds(Notetype.cloze(), ["{{c1::Berlin is in {{c2::Germany}}", ""])).toEqual([
      0,
    ]);
  });

  test(`a closed nested marker keeps both ordinals (${ANKI} cloze.rs)`, async () => {
    expect(await cardOrds(Notetype.cloze(), ["{{c1::outer {{c2::inner}}}}", ""])).toEqual([0, 1]);
  });

  // rslib/src/cloze.rs `if open_clozes.len() < 10`
  test(`nesting is tracked only 10 deep (${ANKI} cloze.rs)`, async () => {
    let text = "x";
    for (let n = 12; n >= 1; n--) text = `{{c${n}::${text}}}`;
    expect(await cardOrds(Notetype.cloze(), [text, ""])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("card generation", () => {
  // rslib/src/notetype/cardgen.rs:107 ensure_not_empty forces ord 0 so a note
  // always has at least one card. Without it the note is invisible in Anki.
  test(`a note whose templates all render empty still gets card 0 (${ANKI} cardgen.rs ensure_not_empty)`, async () => {
    const deck = new Deck({ name: "Orphans" });
    deck.addNote(new Note({ notetype: Notetype.basicAndReversed(), fields: ["", ""] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      const orphans = scalar(
        opened.db,
        "SELECT COUNT(*) FROM notes n LEFT JOIN cards c ON c.nid = n.id WHERE c.id IS NULL",
      );
      expect(orphans).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  // rslib/src/template.rs field_is_empty uses the POSIX class [[:space:]],
  // which in the Rust regex crate is ASCII only.
  test(`a field of only NBSP is NOT empty (${ANKI} template.rs field_is_empty)`, async () => {
    expect(await subjectOrds("{{Front}}", NBSP)).toEqual([0, 1]);
  });

  test(`a field of only an ideographic space is NOT empty (${ANKI} template.rs)`, async () => {
    expect(await subjectOrds("{{Front}}", IDEOGRAPHIC_SPACE)).toEqual([0, 1]);
  });

  // rslib/src/notetype/mod.rs:71 SPECIAL_FIELDS, seeded non-empty by
  // rslib/src/notetype/cardgen.rs (all except FrontSide, and Tags only if tagged)
  for (const special of ["Deck", "Subdeck", "Type", "Card", "CardFlag", "CardID"]) {
    test(`{{${special}}} counts as content (${ANKI} notetype/mod.rs SPECIAL_FIELDS)`, async () => {
      expect(await subjectOrds(`{{${special}}}`, "", "")).toEqual([0, 1]);
    });
  }

  test(`a negated gate on a special field yields no card (${ANKI} cardgen.rs)`, async () => {
    expect(await subjectOrds("{{^Deck}}{{Front}}{{/Deck}}")).toEqual([0]);
  });

  // rslib/src/template.rs comment_token: <!-- --> is lexed away before {{ }}
  test(`a field reference inside an HTML comment is not content (${ANKI} template.rs)`, async () => {
    expect(await subjectOrds("<!-- {{Front}} -->")).toEqual([0]);
  });

  // rslib/src/template.rs classify_handle: s.trim_start_matches('{'). The card
  // renders as the field value followed by a literal `}`, because Anki lexes
  // handlebars with take_until("}}") and leaves the third brace as text.
  test(`{{{Front}}} resolves to the field Front (${ANKI} template.rs classify_handle)`, async () => {
    expect(await subjectOrds("{{{Front}}}")).toEqual([0, 1]);
  });

  // rslib/src/notetype/templates.rs parsed_question() returns None on a parse
  // error, and rslib/src/notetype/cardgen.rs returns false for a None template.
  for (const [label, tpl] of [
    ["unclosed section", "{{#Back}}{{Front}}"],
    ["mismatched close", "{{#Back}}{{Front}}{{/Front}}"],
    ["stray close", "{{/Back}}{{Front}}"],
  ] as const) {
    test(`an unparseable template (${label}) generates no card (${ANKI} cardgen.rs)`, async () => {
      expect(await subjectOrds(tpl)).toEqual([0]);
    });
  }

  // rslib/src/template.rs: the key is rsplit(':').next() with no trim, so
  // "{{text: Front}}" looks for a field literally named " Front".
  test(`a filter key is not trimmed (${ANKI} template.rs)`, async () => {
    expect(await subjectOrds("{{text: Front}}")).toEqual([0]);
  });
});

describe("template rendering", () => {
  // Anki's own assertions from the `nonempty` test in rslib/src/template.rs,
  // copied verbatim. The last pair is the one that distinguishes the two entry
  // points: reqs count a negated section's children regardless of the key.
  const FIELDS = new Set(["1", "3"]);

  for (const [template, expected] of [
    ["{{2}}{{1}}", true],
    ["{{2}}", false],
    ["{{2}}{{4}}", false],
    ["{{#3}}{{^2}}{{1}}{{/2}}{{/3}}", true],
    ["{{^1}}{{3}}{{/1}}", false],
  ] as const) {
    test(`renders ${template} is ${expected} (${ANKI} template.rs nonempty test)`, () => {
      expect(templateRenders(template, FIELDS)).toBe(expected);
    });
  }

  test(`the same template renders for reqs (${ANKI} template.rs nonempty test)`, () => {
    expect(templateRendersForRequirements("{{^1}}{{3}}{{/1}}", FIELDS)).toBe(true);
  });

  // Consequences of Anki's `classify_handle` and its `take_until("}}")` lexer.
  test(`{{/}} is a replacement, not a section tag (${ANKI} template.rs)`, () => {
    expect(templateRenders("{{/}}{{Back}}", new Set(["Back"]))).toBe(true);
  });

  test(`leading braces are stripped before the sigil (${ANKI} template.rs)`, () => {
    expect(templateRenders("{{{{^Front}}{{Back}}", new Set(["Back", "Front"]))).toBe(false);
  });

  test(`a single } inside a handle is allowed (${ANKI} template.rs)`, () => {
    expect(templateRenders("{{a}b}}", new Set(["a}b"]))).toBe(true);
  });
});

describe("deck names", () => {
  // rslib/src/decks/name.rs from_human_name: components join with \x1f.
  // The schema-11 upgrade is the only place :: is converted, and ankipack ships
  // ver=18 so that upgrade never runs (rslib/src/storage/sqlite.rs:506).
  async function storedDeckName(name: string): Promise<string> {
    const deck = new Deck({ name });
    deck.addNote(new Note({ notetype: Notetype.basic(), fields: ["a", "b"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      return String(scalar(opened.db, "SELECT name FROM decks"));
    } finally {
      opened.db.close();
    }
  }

  test(`:: is stored as the native separator (${ANKI} decks/name.rs)`, async () => {
    expect(await storedDeckName("Languages::French::Chapter 1")).toBe(
      `Languages${FIELD_SEPARATOR}French${FIELD_SEPARATOR}Chapter 1`,
    );
  });

  // rslib/src/decks/name.rs normalized_deck_name_component
  test(`components are trimmed (${ANKI} decks/name.rs)`, async () => {
    expect(await storedDeckName("  Padded  ")).toBe("Padded");
  });

  test(`an empty component becomes "blank" (${ANKI} decks/name.rs)`, async () => {
    expect(await storedDeckName("A::::B")).toBe(`A${FIELD_SEPARATOR}blank${FIELD_SEPARATOR}B`);
  });

  test(`a separator in user input does not create a phantom subdeck (${ANKI} decks/name.rs)`, async () => {
    expect(await storedDeckName(`Sep${FIELD_SEPARATOR}Here`)).toBe("SepHere");
  });

  test("two decks with the same name fail with an actionable error, not raw SQLite", async () => {
    const notetype = Notetype.basic();
    const a = new Deck({ name: "Same" });
    const b = new Deck({ name: "Same" });
    a.addNote(new Note({ notetype, fields: ["a", "b"] }));
    b.addNote(new Note({ notetype, fields: ["c", "d"] }));
    const pkg = new Package();
    pkg.addDeck(a);
    pkg.addDeck(b);
    await expect(openPackage(pkg)).rejects.toThrow(/Same/);
  });
});

describe("field content sanitisation", () => {
  // rslib/src/notes/mod.rs invalid_char_for_field: ASCII controls except \n and
  // \t are stripped before Anki ever writes a note.
  async function storedFlds(fields: string[]): Promise<string> {
    const deck = new Deck({ name: "F" });
    deck.addNote(new Note({ notetype: Notetype.basic(), fields }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      return String(scalar(opened.db, "SELECT flds FROM notes"));
    } finally {
      opened.db.close();
    }
  }

  test(`the field separator inside a value does not create phantom fields (${ANKI} notes/mod.rs)`, async () => {
    const flds = await storedFlds([`a${FIELD_SEPARATOR}b`, "back"]);
    expect(flds.split(FIELD_SEPARATOR)).toHaveLength(2);
  });

  // sql.js binds JS strings as NUL-terminated, so an unstripped NUL would
  // silently truncate the rest of the note.
  test(`a NUL byte does not truncate the note (${ANKI} notes/mod.rs)`, async () => {
    const flds = await storedFlds([`a${NUL}b`, `back${NUL}end`]);
    expect(flds.split(FIELD_SEPARATOR)).toHaveLength(2);
  });

  // rslib/src/tags/mod.rs is_tag_separator: ' ' and U+3000 split tags.
  test("a tag containing a space is rejected rather than silently split", () => {
    expect(
      () => new Note({ notetype: Notetype.basic(), fields: ["a", "b"], tags: ["two words"] }),
    ).toThrow();
  });
});

describe("note type validation", () => {
  // rslib/src/notetype/mod.rs:484 require!(!self.fields.is_empty(), "1 field required")
  test("a note type with no fields is rejected at construction", () => {
    expect(() => new Notetype({ name: "Empty", fields: [], templates: [] })).toThrow();
  });

  test("a note type with no templates is rejected at construction", () => {
    expect(() => new Notetype({ name: "NoTpl", fields: [{ name: "F" }], templates: [] })).toThrow();
  });

  test("an empty notetype name is rejected", () => {
    expect(
      () =>
        new Notetype({
          name: "",
          fields: [{ name: "F" }],
          templates: [{ name: "C", questionFormat: "{{F}}", answerFormat: "{{F}}" }],
        }),
    ).toThrow();
  });

  // rslib/src/notetype/fields.rs fix_name strips : { } " and leading # / ^,
  // which desynchronises the field name from the {{Field}} refs shipped with it.
  test("a field name containing a colon is rejected", () => {
    expect(
      () =>
        new Notetype({
          name: "Colon",
          fields: [{ name: "Front: Text" }],
          templates: [{ name: "C", questionFormat: "{{Front: Text}}", answerFormat: "x" }],
        }),
    ).toThrow();
  });

  // rslib/src/notetype/fields.rs fix_name trims BOTH ends before stripping the
  // leading specials, so a trailing space is rewritten too.
  test("a field name with trailing whitespace is rejected", () => {
    expect(
      () =>
        new Notetype({
          name: "Trailing",
          fields: [{ name: "Front " }],
          templates: [{ name: "C", questionFormat: "{{Front}}", answerFormat: "x" }],
        }),
    ).toThrow();
  });

  // Anki strips quotes then requires the remainder to be non-empty, for both
  // notetype names (mod.rs) and template names (templates.rs).
  test("a note type name of only quotes is rejected", () => {
    expect(
      () =>
        new Notetype({
          name: '""',
          fields: [{ name: "F" }],
          templates: [{ name: "C", questionFormat: "{{F}}", answerFormat: "x" }],
        }),
    ).toThrow();
  });

  test("a template name of only quotes is rejected", () => {
    expect(
      () =>
        new Notetype({
          name: "QuoteTpl",
          fields: [{ name: "F" }],
          templates: [{ name: '""', questionFormat: "{{F}}", answerFormat: "x" }],
        }),
    ).toThrow();
  });

  // Would otherwise escape as a raw SQLite unique-constraint failure.
  test("duplicate template names are rejected", () => {
    expect(
      () =>
        new Notetype({
          name: "DupTpl",
          fields: [{ name: "F" }],
          templates: [
            { name: "Same", questionFormat: "{{F}}", answerFormat: "x" },
            { name: "Same", questionFormat: "{{F}}", answerFormat: "y" },
          ],
        }),
    ).toThrow();
  });

  // rslib/src/notetype/mod.rs reposition_sort_idx caps an out-of-range index
  // into bounds, so the sort field silently would not be the one requested.
  test("an out-of-range sortFieldIndex is rejected", () => {
    expect(
      () =>
        new Notetype({
          name: "SortIdx",
          sortFieldIndex: 5,
          fields: [{ name: "A" }, { name: "B" }],
          templates: [{ name: "C", questionFormat: "{{A}}", answerFormat: "x" }],
        }),
    ).toThrow();
  });

  // Beyond 2^53 a JS number cannot hold the id, so it would be written altered.
  test("a Notetype id beyond the safe integer range is rejected", () => {
    expect(
      () =>
        new Notetype({
          name: "BigId",
          id: 2 ** 53 + 1,
          fields: [{ name: "A" }],
          templates: [{ name: "C", questionFormat: "{{A}}", answerFormat: "x" }],
        }),
    ).toThrow();
  });

  // rslib/src/notetype/mod.rs ensure_names_unique uses UniCase and appends '+'
  test("case-only duplicate field names are rejected", () => {
    expect(
      () =>
        new Notetype({
          name: "CaseDupe",
          fields: [{ name: "Front" }, { name: "front" }],
          templates: [{ name: "C", questionFormat: "{{Front}}", answerFormat: "x" }],
        }),
    ).toThrow();
  });
});

describe("media", () => {
  // rslib/io/src/lib.rs filename_is_safe: exactly one Normal path component.
  // rslib/src/import_export/package/media.rs turns one bad name into
  // ImportError::Corrupt for the WHOLE archive.
  for (const bad of ["../evil.png", "sub/dir/pic.png", "", "..", "/abs.png"]) {
    test(`addMedia rejects ${JSON.stringify(bad)} (${ANKI} io/src/lib.rs)`, () => {
      const pkg = new Package();
      expect(() => pkg.addMedia(bad, new Uint8Array([1]))).toThrow();
    });
  }

  // rslib/src/media/files.rs normalize_filename applies NFC. Two names that
  // differ only by composition collapse on import, and which one survives is
  // nondeterministic (Rust HashMap iteration order).
  test(`filenames differing only by NFC/NFD collide (${ANKI} media/files.rs)`, () => {
    const pkg = new Package();
    const composed = "café.png";
    const decomposed = composed.normalize("NFD");
    expect(composed).not.toBe(decomposed);
    pkg.addMedia(composed, new Uint8Array([1]));
    expect(() => pkg.addMedia(decomposed, new Uint8Array([2]))).toThrow();
  });
});

describe("note identity", () => {
  // rslib/src/notes/mod.rs:206 both csum and sfld are computed from
  // strip_html_preserving_media_filenames(field), not the raw field.
  test(`csum ignores HTML markup (${ANKI} notes/mod.rs prepare_for_update)`, async () => {
    const notetype = Notetype.basic();
    const deck = new Deck({ name: "C" });
    deck.addNote(new Note({ notetype, fields: ["<b>test</b>", "x"] }));
    deck.addNote(new Note({ notetype, fields: ["test", "y"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      const [a, b] = column(opened.db, "SELECT csum FROM notes ORDER BY id");
      expect(a).toBe(b);
    } finally {
      opened.db.close();
    }
  });

  // Anki's own assertions from the `stripping` test in rslib/src/text.rs,
  // copied verbatim. Anki uses regexes here, so ankipack mirrors them rather
  // than hand-rolling a scanner: any difference in the pattern is a difference
  // in the output.
  for (const [input, expected] of [
    ["test", "test"],
    ["t<b>e</b>st", "test"],
    ["so<SCRIPT>t<b>e</b>st</script>me", "some"],
    ["<img src=foo.jpg>", " foo.jpg "],
    ["<img src='foo.jpg'><html>", " foo.jpg "],
    ["<html>", ""],
  ] as const) {
    test(`strips ${JSON.stringify(input)} (${ANKI} text.rs stripping test)`, () => {
      expect(stripHtmlPreservingMediaFilenames(input)).toBe(expected);
    });
  }

  // Cases Anki does not assert but its implementation determines: the media
  // regex keeps a filename containing spaces and tolerates a `>` inside a
  // quoted attribute, entities are decoded, and decode_entities only runs when
  // the text contains "&", so a lone non-breaking space is left alone.
  for (const [input, expected] of [
    ['<img src="my photo.png">', " my photo.png "],
    ['<img alt="a>b" src="x.png">', " x.png "],
    ["<style>.card{color:red}</style>Hi", "Hi"],
    ["<!-- a > b -->x", "x"],
    ["&#39;quoted&#39;", "'quoted'"],
    ["caf&eacute;", "café"],
    ["&amp;nbsp", "&nbsp"],
  ] as const) {
    test(`strips ${JSON.stringify(input)} (${ANKI} text.rs)`, () => {
      expect(stripHtmlPreservingMediaFilenames(input)).toBe(expected);
    });
  }

  test(`a non-breaking space alone is not folded (${ANKI} text.rs decode_entities)`, () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(stripHtmlPreservingMediaFilenames(`a${nbsp}b`)).toBe(`a${nbsp}b`);
  });

  test(`sfld has HTML stripped (${ANKI} notes/mod.rs prepare_for_update)`, async () => {
    const deck = new Deck({ name: "S" });
    deck.addNote(new Note({ notetype: Notetype.basic(), fields: ["<b>bold</b>", "x"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      expect(scalar(opened.db, "SELECT sfld FROM notes")).toBe("bold");
    } finally {
      opened.db.close();
    }
  });
});

describe("notetype config", () => {
  // rslib/src/template.rs requirements(): Any if any single field renders it;
  // otherwise start from every field and drop those whose removal still
  // renders, giving All; otherwise None.
  // KIND_NONE = 0, KIND_ANY = 1, KIND_ALL = 2 (proto/anki/notetypes.proto).
  async function reqsOf(questionFormat: string): Promise<{ kind: number; fieldOrds: number[] }> {
    const notetype = new Notetype({
      name: `R:${questionFormat}`,
      fields: [{ name: "a" }, { name: "b" }, { name: "c" }],
      templates: [{ name: "C", questionFormat, answerFormat: "x" }],
    });
    const deck = new Deck({ name: "R" });
    deck.addNote(new Note({ notetype, fields: ["1", "2", "3"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      const blob = scalar(opened.db, "SELECT config FROM notetypes") as Uint8Array;
      const req = fromBinary(Notetype_ConfigSchema, blob).reqs[0];
      return { kind: req.kind as number, fieldOrds: [...req.fieldOrds].sort((x, y) => x - y) };
    } finally {
      opened.db.close();
    }
  }

  test(`a conditional section requires ALL its fields (${ANKI} template.rs requirements)`, async () => {
    expect(await reqsOf("{{#a}}{{b}}{{/a}}")).toEqual({ kind: 2, fieldOrds: [0, 1] });
  });

  test(`a template referencing no real field is NONE (${ANKI} template.rs requirements)`, async () => {
    expect(await reqsOf("{{nosuchfield}}")).toEqual({ kind: 0, fieldOrds: [] });
  });

  test(`a filtered reference resolves to the underlying field (${ANKI} template.rs)`, async () => {
    expect(await reqsOf("{{text:b}}")).toEqual({ kind: 1, fieldOrds: [1] });
  });

  // Anki's own asserted cases from the requirements() tests in
  // rslib/src/template.rs. reqs are computed with check_negated=false, so a
  // negated section resolves to its children even when the key is non-empty.
  // Card-generation semantics would turn {{^a}}{{#b}}{{c}}{{/b}}{{/a}} into None.
  for (const [questionFormat, kind, fieldOrds] of [
    ["{{a}}{{b}}", 1, [0, 1]],
    ["{{#a}}{{b}}{{/a}}", 2, [0, 1]],
    ["{{z}}", 0, []],
    ["{{^a}}{{b}}{{/a}}", 1, [1]],
    ["{{^a}}{{#b}}{{c}}{{/b}}{{/a}}", 2, [1, 2]],
    ["{{#a}}{{#b}}{{a}}{{/b}}{{/a}}", 2, [0, 1]],
  ] as const) {
    test(`reqs for ${questionFormat} (${ANKI} template.rs requirements tests)`, async () => {
      expect(await reqsOf(questionFormat)).toEqual({ kind, fieldOrds: [...fieldOrds] });
    });
  }

  // rslib/src/notetype/cloze_styling.css ships a night-mode rule too.
  test(`Notetype.cloze() CSS includes the night-mode rule (${ANKI} cloze_styling.css)`, () => {
    expect(Notetype.cloze().css).toContain(".nightMode .cloze");
  });
});

describe("deck config validation", () => {
  // rslib/src/scheduler/states/load_balancer.rs parse_easy_days_percentages
  // requires exactly 0 or 7 entries, and the load balancer parses EVERY preset
  // in the collection, so one bad preset stops the user studying any deck.
  test("easyDaysPercentages must be 0 or 7 entries", () => {
    expect(() => new DeckConfig({ name: "P", easyDaysPercentages: [1, 1, 0.5] })).toThrow();
  });

  // rslib/src/deckconfig/mod.rs ensure_f32_valid: an out-of-range value is
  // RESET to Anki's default, not clamped.
  test("desiredRetention outside 0.7..0.99 is rejected", () => {
    expect(() => new DeckConfig({ name: "P", desiredRetention: 0.6 })).toThrow();
  });

  test("newPerDay above 9999 is rejected", () => {
    expect(() => new DeckConfig({ name: "P", newPerDay: 20000 })).toThrow();
  });

  // Anki stores these as u32, so a fraction fails to encode at build time with
  // a protobuf error naming the wire field rather than the option.
  test("a fractional value on a whole-number option is rejected", () => {
    expect(() => new DeckConfig({ name: "P", newPerDay: 20.5 })).toThrow();
  });

  test("initialEase below Anki's 1.31 minimum is rejected", () => {
    expect(() => new DeckConfig({ name: "P", initialEase: 1.3 })).toThrow();
  });

  // rslib/src/deckconfig/update.rs validates params with FSRS::new on the
  // deck-options save path, but the apkg importer skips that check entirely.
  test("an FSRS parameter vector of an invalid length is rejected", () => {
    expect(() => new DeckConfig({ name: "P", fsrsParams: [0.1, 0.2, 0.3] })).toThrow();
  });

  // Anki's importer does not uniquify preset names (unlike deck names), so an
  // unnamed config lands a second indistinguishable "Default" in the user's list.
  test("an unnamed DeckConfig does not collide with Anki's built-in Default", () => {
    expect(new DeckConfig({ desiredRetention: 0.85 }).name).not.toBe("Default");
  });

  // Only one row per id can ship, so the second preset's settings would be
  // silently replaced by the first's.
  test("two DeckConfigs sharing an id are rejected", async () => {
    const notetype = Notetype.basic();
    const a = new Deck({ name: "A", config: new DeckConfig({ id: 777, name: "Cram" }) });
    const b = new Deck({ name: "B", config: new DeckConfig({ id: 777, name: "Relax" }) });
    a.addNote(new Note({ notetype, fields: ["a", "b"] }));
    b.addNote(new Note({ notetype, fields: ["c", "d"] }));
    const pkg = new Package();
    pkg.addDeck(a);
    pkg.addDeck(b);
    await expect(openPackage(pkg)).rejects.toThrow(/share id 777/);
  });
});

describe("public API", () => {
  test("NO_PRESET is re-exported from the package entry point", async () => {
    const entry = await import("../src/index");
    expect(Object.keys(entry)).toContain("NO_PRESET");
  });

  // Anki reassigns deck ids on import and never remaps target_deck_id, so any
  // value shipped here would dangle.
  test("no template ships a target_deck_id that would dangle after import", async () => {
    const notetype = new Notetype({
      name: "Target",
      fields: [{ name: "F" }],
      templates: [{ name: "C", questionFormat: "{{F}}", answerFormat: "{{F}}" }],
    });
    const deck = new Deck({ name: "Home" });
    deck.addNote(new Note({ notetype, fields: ["x"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      const blob = scalar(opened.db, "SELECT config FROM templates") as Uint8Array;
      expect(Number(fromBinary(Notetype_Template_ConfigSchema, blob).targetDeckId)).toBe(0);
    } finally {
      opened.db.close();
    }
  });
});

// htmlescape 0.3.1 is a character-by-character state machine, not a set of
// entity regexes: every `&` opens an entity and anything that fails to resolve
// from there aborts the decode, leaving the whole string alone. Vectors below
// are traced against htmlescape-0.3.1/src/decode.rs:94-209 as vendored by
// anki@26.08.1 (Cargo.lock: htmlescape 0.3.1), which feeds sfld and csum.
describe(`entity decoding matches htmlescape 0.3.1 (${ANKI})`, () => {
  const CASES: Array<[string, string, string]> = [
    ["&amp;", "&", "a resolvable entity really does decode"],
    ["Tom & Jerry &amp; Co", "Tom & Jerry &amp; Co", "a bare & aborts the whole string"],
    ["Q&A", "Q&A", "a bare & with no semicolon aborts too"],
    ["1 &#38;lt; 2", "1 &lt; 2", "one pass: a decoded & is never rescanned"],
    ["&#x26;amp;", "&amp;", "same, via a hex entity"],
    ["&#X41;", "&#X41;", "the Numeric state accepts lowercase x only"],
    ["&#;", "&#;", "an empty numeric escape is malformed"],
    ["&#x;", "&#x;", "an empty hex escape is malformed"],
    ["&;", "&;", "an empty named entity is unknown"],
    ["&AMP;", "&AMP;", "named entities are case sensitive"],
    ["&nosuchentity;", "&nosuchentity;", "an unknown name aborts"],
  ];
  for (const [input, want, why] of CASES) {
    test(`${JSON.stringify(input)}: ${why}`, () => {
      expect(stripHtmlPreservingMediaFilenames(input)).toBe(want);
    });
  }

  // char::from_u32 rejects D800-DFFF, so this is a DecodeErr, not a lone
  // surrogate. Decoding it would put invalid UTF-8 in a TEXT column.
  test("a surrogate code point aborts the decode", () => {
    expect(stripHtmlPreservingMediaFilenames("A&#xD800;B")).toBe("A&#xD800;B");
    expect(stripHtmlPreservingMediaFilenames("A&#x10FFFF;B")).toBe("A\u{10FFFF}B");
    expect(stripHtmlPreservingMediaFilenames("A&#x110000;B")).toBe("A&#x110000;B");
  });

  // The entity table is a plain object, so an inherited key must not resolve.
  test("Object.prototype keys are not entities", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(stripHtmlPreservingMediaFilenames(`&${name};`)).toBe(`&${name};`);
    }
  });

  // U+00A0 is folded to a space only on the success path.
  test("the non-breaking space fold is skipped when the decode fails", () => {
    expect(stripHtmlPreservingMediaFilenames(`${NBSP}&amp;`)).toBe(" &");
    expect(stripHtmlPreservingMediaFilenames(`${NBSP}&1`)).toBe(`${NBSP}&1`);
  });
});

// Anki's regex crate is a DFA, so its HTML_MEDIA_TAGS pattern is linear no
// matter how ambiguous. A backtracking engine is not: the unnarrowed pattern
// and the two strip calls per note are on the path of every build.
test(`stripping a field with many quoted runs stays fast (${ANKI})`, () => {
  const field = '<img alt="pic"> ' + '"hi" '.repeat(400);
  const started = performance.now();
  stripHtmlPreservingMediaFilenames(field);
  expect(performance.now() - started).toBeLessThan(1000);
});

// rslib/src/text.rs `stripping`, plus the quoted-`>` case the ambiguous
// alternation existed to serve.
describe(`media filenames survive stripping (${ANKI})`, () => {
  const CASES: Array<[string, string]> = [
    ["<img src=foo.jpg>", " foo.jpg "],
    ['<img src="foo.jpg">', " foo.jpg "],
    ["<img src='foo.jpg'>", " foo.jpg "],
    ['<img src="foo bar.jpg">', " foo bar.jpg "],
    ['<audio src="a.mp3">', " a.mp3 "],
    ['<object data="x.swf">', " x.swf "],
    ['<img alt="a>b" src="c.jpg">', " c.jpg "],
    ["<img>", ""],
  ];
  for (const [input, want] of CASES) {
    test(JSON.stringify(input), () => {
      expect(stripHtmlPreservingMediaFilenames(input)).toBe(want);
    });
  }
});

// rslib/src/template.rs:136-146. A template whose first non-space content is
// the directive switches to <% %> for its whole body, which turns any
// remaining {{...}} into plain text. Anki pins both halves at :1145-1182.
describe(`legacy alt-handlebar syntax (${ANKI})`, () => {
  const FIELDS = new Set(["Front", "Back"]);
  test("the directive switches the delimiters", () => {
    expect(templateRenders("{{=<% %>=}}<%Front%>", FIELDS)).toBe(true);
  });
  test("leading whitespace before the directive is trimmed", () => {
    expect(templateRenders("\n{{=<% %>=}}\n<%Front%>\n<% #Back %>\n<%/Back%>", FIELDS)).toBe(true);
  });
  test("braces after the directive are plain text", () => {
    expect(templateRenders("{{=<% %>=}}{{Front}}", FIELDS)).toBe(false);
  });
  test("repeated directives are all stripped", () => {
    expect(templateRenders("{{=<% %>=}}{{=<% %>=}}<%Front%>", FIELDS)).toBe(true);
  });
  test("a template without the directive is unaffected", () => {
    expect(templateRenders("{{Front}}", FIELDS)).toBe(true);
    expect(templateRenders("<%Front%>", FIELDS)).toBe(false);
  });
  test("the alt directive also applies to the reqs variant", () => {
    expect(templateRendersForRequirements("{{=<% %>=}}<%Front%>", FIELDS)).toBe(true);
  });

  // The whole point: this changes which cards the user gets.
  test("a card is generated for an alt-syntax template", async () => {
    const notetype = new Notetype({
      name: "Alt",
      fields: [{ name: "Front" }, { name: "Back" }],
      templates: [
        { name: "C1", questionFormat: "{{Back}}", answerFormat: "x" },
        { name: "C2", questionFormat: "{{=<% %>=}}<%Front%>", answerFormat: "x" },
      ],
    });
    expect(await cardOrds(notetype, ["a", ""])).toEqual([1]);
  });
});

// sql.js binds strings as NUL-terminated, so a NUL silently discards the rest
// of the column. Anki stores these verbatim and has no rewrite to mirror.
describe("a NUL is refused rather than silently truncating", () => {
  const base = {
    fields: [{ name: "F" }],
    templates: [{ name: "C", questionFormat: "{{F}}", answerFormat: "x" }],
  };
  test("note type name", () => {
    expect(() => new Notetype({ ...base, name: `Note${NUL}Type` })).toThrow(/NUL/);
  });
  test("field name", () => {
    expect(() => new Notetype({ ...base, name: "M", fields: [{ name: `Fr${NUL}ont` }] })).toThrow(
      /NUL/,
    );
  });
  test("template name", () => {
    expect(
      () =>
        new Notetype({
          ...base,
          name: "M",
          templates: [{ name: `Ca${NUL}rd`, questionFormat: "{{F}}", answerFormat: "x" }],
        }),
    ).toThrow(/NUL/);
  });
  test("note guid", () => {
    expect(
      () => new Note({ notetype: Notetype.basic(), fields: ["a", "b"], guid: `gu${NUL}id` }),
    ).toThrow(/NUL/);
  });
  test("deck config name", () => {
    expect(() => new DeckConfig({ name: `Pre${NUL}set` })).toThrow(/NUL/);
  });

  // A NUL here would take the trailing delimiter with it, breaking the
  // " tag1 tag2 " format Anki parses. rslib/src/tags/register.rs:154.
  test("tag", () => {
    expect(
      () => new Note({ notetype: Notetype.basic(), fields: ["a", "b"], tags: [`chap${NUL}ter`] }),
    ).toThrow(/control character/);
  });

  // Deck names are the exception: Anki's invalid_char_for_deck_component
  // strips control characters, so ankipack strips them too.
  test("deck names strip it instead, as Anki does", async () => {
    const deck = new Deck({ name: `De${NUL}ck` });
    deck.addNote(new Note({ notetype: Notetype.basic(), fields: ["a", "b"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      expect(scalar(opened.db, "SELECT name FROM decks")).toBe("Deck");
    } finally {
      opened.db.close();
    }
  });
});

// Both columns are UNIQUE in the schema, so a collision otherwise surfaces as
// a raw SQLite error, or for a repeated note type id as a silently dropped
// notetype whose notes then carry the wrong field count.
describe("colliding ids and names are refused with a usable message", () => {
  const notetypeWith = (id: number | undefined, name: string, fieldNames: string[]) =>
    new Notetype({
      id,
      name,
      fields: fieldNames.map((n) => ({ name: n })),
      templates: [{ name: "C", questionFormat: `{{${fieldNames[0]}}}`, answerFormat: "x" }],
    });

  test("two different Notetypes sharing an id", async () => {
    const deck = new Deck({ name: "D" });
    deck.addNote(
      new Note({ notetype: notetypeWith(4242, "Alpha", ["Front", "Back"]), fields: ["a", "b"] }),
    );
    deck.addNote(
      new Note({ notetype: notetypeWith(4242, "Beta", ["Q", "A", "X"]), fields: ["c", "d", "e"] }),
    );
    const pkg = new Package();
    pkg.addDeck(deck);
    await expect(openPackage(pkg)).rejects.toThrow(/share id 4242.*Alpha.*Beta/s);
  });

  test("two different Notetypes sharing a name", async () => {
    const deck = new Deck({ name: "D" });
    deck.addNote(new Note({ notetype: notetypeWith(undefined, "Dup", ["F"]), fields: ["a"] }));
    deck.addNote(new Note({ notetype: notetypeWith(undefined, "Dup", ["G"]), fields: ["b"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    await expect(openPackage(pkg)).rejects.toThrow(/both named "Dup"/);
  });

  test("two Decks sharing an id", async () => {
    const notetype = Notetype.basic();
    const first = new Deck({ id: 999, name: "One" });
    const second = new Deck({ id: 999, name: "Two" });
    first.addNote(new Note({ notetype, fields: ["a", "b"] }));
    second.addNote(new Note({ notetype, fields: ["c", "d"] }));
    const pkg = new Package();
    pkg.addDeck(first);
    pkg.addDeck(second);
    await expect(openPackage(pkg)).rejects.toThrow(/share id 999/);
  });

  // Reusing one Notetype instance is the ordinary case and must stay allowed.
  test("one Notetype shared across notes is not a collision", async () => {
    const notetype = Notetype.basic();
    const deck = new Deck({ name: "D" });
    deck.addNote(new Note({ notetype, fields: ["a", "b"] }));
    deck.addNote(new Note({ notetype, fields: ["c", "d"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const opened = await openPackage(pkg);
    try {
      expect(Number(scalar(opened.db, "SELECT COUNT(*) FROM notetypes"))).toBe(1);
    } finally {
      opened.db.close();
    }
  });
});

// toProtobuf() reads the options at build time, so holding the caller's object
// would let a mutation land after validation had already passed.
describe("DeckConfig copies its options", () => {
  test("a scalar mutated after construction does not reach the preset", () => {
    const options = { name: "P", newPerDay: 20 };
    const config = new DeckConfig(options);
    options.newPerDay = 999999;
    expect(config.toProtobuf().newPerDay).toBe(20);
  });

  test("an array mutated after construction does not reach the preset", () => {
    const options = { name: "P", learnSteps: [1, 10] };
    const config = new DeckConfig(options);
    options.learnSteps.push(-5);
    expect(config.toProtobuf().learnSteps).toEqual([1, 10]);
  });
});

// Anki's importer never revalidates a preset, so a non-finite value reaches
// the scheduler on the first answered card.
describe("deck config array values are validated", () => {
  test("a NaN FSRS parameter is refused", () => {
    const params = Array.from({ length: 21 }, (_, i) => (i === 3 ? NaN : 0.5));
    expect(() => new DeckConfig({ name: "P", fsrsParams: params })).toThrow(/finite/);
  });
  test("a non-finite learning step is refused", () => {
    expect(() => new DeckConfig({ name: "P", learnSteps: [Infinity] })).toThrow(/finite/);
  });
  test("a negative learning step is refused", () => {
    expect(() => new DeckConfig({ name: "P", relearnSteps: [-5] })).toThrow(/negative/);
  });
  // seconds_to_show_question is a float in proto/anki/deck_config.proto:157.
  test("a fractional auto-advance delay is accepted", () => {
    expect(() => new DeckConfig({ name: "P", secondsToShowQuestion: 1.5 })).not.toThrow();
  });
});

// Verified by running Anki's HTML_MEDIA_TAGS verbatim under the regex crate at
// the version anki@26.08.1 pins (regex 1.11.2), over a 4024-input corpus: the
// pattern below reproduces its output exactly. These three cases are where a
// literal transcription into JavaScript disagreed.
describe(`media tag regex matches the regex crate (${ANKI})`, () => {
  // Anki's pattern is (?x), and the regex crate strips insignificant
  // whitespace inside a character class too, so `[^ >]` is really `[^>]`.
  test("a space after src= is part of the filename, not a delimiter", () => {
    expect(stripHtmlPreservingMediaFilenames("<img src= foo.jpg>")).toBe("  foo.jpg ");
    expect(stripHtmlPreservingMediaFilenames("<img data= x>")).toBe("  x ");
    expect(stripHtmlPreservingMediaFilenames("<audio src= a.mp3>")).toBe("  a.mp3 ");
  });

  // Rust's \b is Unicode-aware and JavaScript's is ASCII, so a literal
  // transcription matches these where Anki does not. A tag the media pass leaves alone is then
  // removed wholesale by the HTML pass, so "" means "was not a media tag".
  test("a non-ASCII letter around the tag name blocks the match", () => {
    expect(stripHtmlPreservingMediaFilenames("<imgé src=a.jpg>")).toBe("");
    expect(stripHtmlPreservingMediaFilenames("<img ésrc=a.jpg>")).toBe("");
  });

  test("the ASCII neighbours of those cases are unchanged", () => {
    expect(stripHtmlPreservingMediaFilenames("<imgx src=a.jpg>")).toBe("");
    expect(stripHtmlPreservingMediaFilenames("<img xsrc=a.jpg>")).toBe("");
    expect(stripHtmlPreservingMediaFilenames("<img src=a.jpg>")).toBe(" a.jpg ");
    expect(stripHtmlPreservingMediaFilenames("<IMG SRC=A.JPG>")).toBe(" A.JPG ");
  });
});

// rslib/src/notetype/mod.rs:486-489 and templates.rs:112-118 both strip `"`
// and then require the name to be non-empty. A name that merely contains one
// arrives renamed, where it can collide with a note type the user already has.
describe(`quotes in note type and template names (${ANKI})`, () => {
  const notetype = (name: string, templateName = "C") =>
    new Notetype({
      name,
      fields: [{ name: "F" }],
      templates: [{ name: templateName, questionFormat: "{{F}}", answerFormat: "x" }],
    });

  test("a quote in a note type name is refused", () => {
    expect(() => notetype('Say "hi"')).toThrow(/must not contain a quote/);
  });
  test("a quote in a template name is refused", () => {
    expect(() => notetype("M", 'Card "1"')).toThrow(/must not contain a quote/);
  });
  test("an empty note type name is still refused", () => {
    expect(() => notetype("")).toThrow(/must not be empty/);
  });
  test("an empty template name is still refused", () => {
    expect(() => notetype("M", "")).toThrow(/empty name/);
  });
  test("names without quotes are unaffected", () => {
    expect(() => notetype("Vocab (FR to DE)", "Recognition")).not.toThrow();
  });
});
