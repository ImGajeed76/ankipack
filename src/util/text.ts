import { FIELD_SEPARATOR } from "./constants.js";
import { NAMED_ENTITIES } from "./html-entities.js";
import { fail } from "../error.js";

// Text transforms ported from Anki 26.08.1 so the generated collection holds
// what Anki itself would write.

/**
 * Rust's `char::is_whitespace` is the Unicode White_Space property, which JS
 * `\s` gets wrong in both directions: it omits U+0085 and adds U+FEFF.
 */
const RUST_SPACE =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const TRIM_START = new RegExp(`^[${RUST_SPACE}]+`);
const TRIM_END = new RegExp(`[${RUST_SPACE}]+$`);

/** Rust's `str::trim_start`. */
export function trimStartRust(text: string): string {
  return text.replace(TRIM_START, "");
}

/** Rust's `str::trim`. */
export function trimRust(text: string): string {
  return text.replace(TRIM_START, "").replace(TRIM_END, "");
}

/**
 * sql.js binds strings as NUL-terminated, so a NUL silently discards the rest
 * of the column. Anki stores these identifiers verbatim, so there is no rewrite
 * of Anki's to copy and the caller has to hear about it instead.
 */
export function rejectNul(value: string, label: string): void {
  if (value.includes("\0")) {
    fail(
      "invalid-input",
      `${label} contains a NUL character, which cannot be stored in the collection`,
    );
  }
}

/** Anki's `is_ascii_control`: stripped from tags and note fields, refused in a media name. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const IS_ASCII_CONTROL = /[\u0000-\u001f\u007f]/;

/** A UTF-16 code unit with no partner, which no UTF-8 encoding can represent. */
export function isLoneSurrogate(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0xd800 && code <= 0xdfff;
}

/**
 * SQLite stores text as UTF-8, and `String.fromCharCode(0xd800)` has no UTF-8
 * form, so it is written as replacement bytes. Anki's Rust core reads the
 * column as `&str` and refuses the whole collection with a Utf8 error, which
 * surfaces as "not a valid .apkg file" with nothing naming the note.
 */
export function rejectLoneSurrogates(value: string, label: string): void {
  for (const char of value) {
    if (isLoneSurrogate(char)) {
      const point = (char.codePointAt(0) ?? 0).toString(16).toUpperCase();
      fail(
        "invalid-input",
        `${label} contains the lone surrogate U+${point}, which cannot be encoded as ` +
          `UTF-8. Anki refuses the entire collection rather than the one value.`,
      );
    }
  }
}

/**
 * Anki's `invalid_char_for_field` (rslib/src/notes/mod.rs). The field separator
 * is in the stripped set, so this also stops a value splitting `flds`.
 */
export function stripInvalidFieldChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = (code < 0x20 && ch !== "\n" && ch !== "\t") || code === 0x7f;
    if (!isControl) out += ch;
  }
  return out;
}

/** The word set Rust's `\w` uses, which is wider than JavaScript's. */
const RUST_WORD = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}";

/**
 * Anki's `HTML_MEDIA_TAGS` (rslib/src/text.rs). The attribute scan tolerates a
 * `>` inside a quoted value, and each branch captures the filename whole, so a
 * name containing spaces survives.
 *
 * Three deliberate departures from the literal source text, each verified to
 * produce identical output to Anki's own pattern under the regex crate:
 *
 * - `\b` is written out, because Rust's is Unicode-aware and JavaScript's is
 *   ASCII, which made `<imgé src=a.jpg>` match here but not in Anki.
 * - the unquoted-filename class is `[^>]`, not `[^ >]`: Anki's pattern is
 *   `(?x)`, and the regex crate strips insignificant whitespace inside a
 *   character class too, so the space there was never part of the class.
 * - the quoted branches require the `>` that is their whole reason to exist.
 *   Anki's `"[^"]+?"` also matches quoted runs the `[^>]` branch can consume,
 *   and that ambiguity is free under a DFA but exponential in a backtracking
 *   engine, where a field of a few hundred characters does not finish.
 */
const MEDIA_TAG = new RegExp(
  `<(?:img|audio|video|object|source)(?![${RUST_WORD}])` +
    `(?:[^>]|"[^">]*>[^"]*"|'[^'>]*>[^']*')+?` +
    `(?<![${RUST_WORD}])(?:src|data)(?![${RUST_WORD}])=` +
    `(?:"([^"]+?)"[^>]*>|'([^']+?)'[^>]*>|([^>]+?)(?: [^>]*>|>))`,
  "gisu",
);

/**
 * Anki's `HTML` regex, as a single pass: comments, style and script blocks go
 * with their contents, not just their tags.
 *
 * Hand-written because every alternative in that regex ends in a lazy `.*?`, so
 * an unterminated `<` scans to end of input once per `<`, which is quadratic.
 * Once a terminator is missing, none follows any later `<` either.
 */
function stripHtmlTags(text: string): string {
  let out = "";
  let at = 0;
  let noComment = false;
  let noStyle = false;
  let noScript = false;

  for (;;) {
    const open = text.indexOf("<", at);
    if (open < 0) break;

    let end = -1;

    if (!noComment && text.startsWith("<!--", open)) {
      end = text.indexOf("-->", open + 4);
      if (end < 0) noComment = true;
      else end += 3;
    } else if (!noStyle && matchesAt(text, open, "<style")) {
      end = closingBlock(text, open, "</style>");
      if (end < 0) noStyle = true;
    } else if (!noScript && matchesAt(text, open, "<script")) {
      end = closingBlock(text, open, "</script>");
      if (end < 0) noScript = true;
    }

    if (end < 0) {
      const gt = text.indexOf(">", open + 1);
      // No `>` after this `<` means none after any later one either.
      if (gt < 0) break;
      end = gt + 1;
    }

    out += text.slice(at, open);
    at = end;
  }

  return out + text.slice(at);
}

/** The opening tag's `>`, then everything up to the matching closer. */
function closingBlock(text: string, open: number, closer: string): number {
  const gt = text.indexOf(">", open + 1);
  if (gt < 0) return -1;
  const close = indexOfCaseless(text, closer, gt + 1);
  return close < 0 ? -1 : close + closer.length;
}

/**
 * Whether `text` holds `lower` at `at`, compared the way Anki's `(?i)` does.
 *
 * In place, not against a lowercased copy: U+0130's `toLowerCase()` changes
 * UTF-16 length so indices stop lining up, and a copy per tag is quadratic.
 */
function matchesAt(text: string, at: number, lower: string): boolean {
  if (at + lower.length > text.length) return false;
  for (let i = 0; i < lower.length; i++) {
    if (!foldsTo(text[at + i], lower[i])) return false;
  }
  return true;
}

/** Closers all begin with `<`, so the scan can skip between candidates. */
function indexOfCaseless(text: string, lower: string, from: number): number {
  for (let at = text.indexOf("<", from); at >= 0; at = text.indexOf("<", at + 1)) {
    if (matchesAt(text, at, lower)) return at;
  }
  return -1;
}

/**
 * Rust's `(?i)` folds through Unicode case-folding orbits, which `toLowerCase`
 * does not: U+017F LATIN SMALL LETTER LONG S folds with `s`, so Anki reads
 * `<ſtyle>` as a style tag.
 */
function foldsTo(char: string, lowerAscii: string): boolean {
  return (
    char === lowerAscii || char.toLowerCase() === lowerAscii || LONG_S_FOLD[lowerAscii] === char
  );
}

const LONG_S_FOLD: Record<string, string> = { s: "ſ" };

const NON_BREAKING_SPACE = new RegExp(String.fromCharCode(0xa0), "g");

/**
 * Anki's `strip_html_preserving_media_filenames` (rslib/src/text.rs), which
 * feeds both `sfld` and the duplicate-detection checksum.
 */
export function stripHtmlPreservingMediaFilenames(text: string): string {
  const withFilenames = text.replace(MEDIA_TAG, (_match, dq, sq, bare) => ` ${dq ?? sq ?? bare} `);
  return decodeEntities(stripHtmlTags(withFilenames));
}

type DecodeState = "normal" | "entity" | "named" | "numeric" | "hex" | "dec";

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isHexDigit = (ch: string): boolean =>
  isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");

/**
 * Anki's `decode_entities`, which is htmlescape 0.3.1's `decode_html` state
 * machine (src/decode.rs) plus a U+00A0 fold on the success path only.
 *
 * Every `&` opens an entity, and anything that does not resolve from there
 * aborts the whole string, so a bare `&` leaves the text completely undecoded.
 * One left-to-right pass, so a decoded `&` is never rescanned.
 */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;

  let state: DecodeState = "normal";
  let out = "";
  let buf = "";

  for (const ch of text) {
    switch (state) {
      case "normal":
        if (ch === "&") state = "entity";
        else out += ch;
        break;

      case "entity":
        if (ch === "#") state = "numeric";
        else if (ch === ";") return text;
        else {
          state = "named";
          buf += ch;
        }
        break;

      case "named":
        if (ch !== ";") {
          buf += ch;
          break;
        }
        // Own-property check: `&constructor;` would otherwise resolve off the
        // prototype chain and stringify a function into the note.
        if (!Object.hasOwn(NAMED_ENTITIES, buf)) return text;
        out += NAMED_ENTITIES[buf];
        buf = "";
        state = "normal";
        break;

      case "numeric":
        // Only lowercase `x`; htmlescape rejects `&#X41;`.
        if (isDigit(ch)) {
          state = "dec";
          buf += ch;
        } else if (ch === "x") state = "hex";
        else return text;
        break;

      case "dec":
      case "hex": {
        const radix = state === "hex" ? 16 : 10;
        if (ch === ";") {
          const decoded = decodeCodePoint(buf, radix);
          if (decoded === undefined) return text;
          out += decoded;
          buf = "";
          state = "normal";
        } else if (radix === 16 ? isHexDigit(ch) : isDigit(ch)) buf += ch;
        else return text;
        break;
      }
    }
  }

  if (state !== "normal") return text;
  return out.replace(NON_BREAKING_SPACE, " ");
}

/** `u32::from_str_radix` then `char::from_u32`, which rejects the surrogates. */
function decodeCodePoint(digits: string, radix: number): string | undefined {
  if (digits.length === 0) return undefined;
  const code = Number.parseInt(digits, radix);
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  return String.fromCodePoint(code);
}

/**
 * Anki's `NativeDeckName::from_human_name` (rslib/src/decks/name.rs). The
 * `decks.name` column holds the machine name, whose components are separated
 * by U+001F, not by `::`.
 */
export function toNativeDeckName(humanName: string): string {
  return humanName.split("::").map(normalizeDeckNameComponent).join(FIELD_SEPARATOR);
}

/** Anki's `NativeDeckName::human_name`: a stored name as Anki will display it. */
export function toHumanDeckName(nativeName: string): string {
  return nativeName.split(FIELD_SEPARATOR).join("::");
}

/** The name Anki will display for a name the caller supplied. */
export function toNormalizedDeckName(humanName: string): string {
  return toHumanDeckName(toNativeDeckName(humanName));
}

const TRIM_COMPONENT_START = new RegExp(`^[${RUST_SPACE}:]+`);
const TRIM_COMPONENT_END = new RegExp(`[${RUST_SPACE}:]+$`);

/** Anki's `normalized_deck_name_component`. */
function normalizeDeckNameComponent(component: string): string {
  let out = "";
  for (const ch of component.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  const trimmed = out.replace(TRIM_COMPONENT_START, "").replace(TRIM_COMPONENT_END, "");
  return trimmed.length > 0 ? trimmed : "blank";
}
