import { FIELD_SEPARATOR } from "./constants.js";
import { NAMED_ENTITIES } from "./html-entities.js";

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
 * of its to mirror and the caller has to hear about it instead.
 */
export function rejectNul(value: string, label: string): void {
  if (value.includes("\0")) {
    throw new Error(`${label} contains a NUL character, which cannot be stored in the collection`);
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
 *   engine: a 136-character field took 29 seconds before this was narrowed.
 */
const MEDIA_TAG = new RegExp(
  `<(?:img|audio|video|object|source)(?![${RUST_WORD}])` +
    `(?:[^>]|"[^">]*>[^"]*"|'[^'>]*>[^']*')+?` +
    `(?<![${RUST_WORD}])(?:src|data)(?![${RUST_WORD}])=` +
    `(?:"([^"]+?)"[^>]*>|'([^']+?)'[^>]*>|([^>]+?)(?: [^>]*>|>))`,
  "gisu",
);

/**
 * Anki's `HTML`. Comments, style blocks and script blocks are removed with
 * their contents, not just their tags.
 */
const HTML_TAG = /<!--.*?-->|<style.*?>.*?<\/style>|<script.*?>.*?<\/script>|<.*?>/gis;

const NON_BREAKING_SPACE = new RegExp(String.fromCharCode(0xa0), "g");

/**
 * Anki's `strip_html_preserving_media_filenames` (rslib/src/text.rs), which
 * feeds both `sfld` and the duplicate-detection checksum.
 */
export function stripHtmlPreservingMediaFilenames(text: string): string {
  const withFilenames = text.replace(MEDIA_TAG, (_match, dq, sq, bare) => ` ${dq ?? sq ?? bare} `);
  return decodeEntities(withFilenames.replace(HTML_TAG, ""));
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

/** Anki's `NativeDeckName::human_name`: the deck name as Anki will display it. */
export function toNormalizedDeckName(humanName: string): string {
  return toNativeDeckName(humanName).split(FIELD_SEPARATOR).join("::");
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
