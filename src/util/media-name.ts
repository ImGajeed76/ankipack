import { IS_ASCII_CONTROL, isLoneSurrogate } from "./text.js";
import { isUnassignedForAnki } from "./unassigned.js";
import { fail } from "../error.js";

/**
 * Anki's media filename rules (rslib/src/media/files.rs `normalize_filename`).
 *
 * The current package format does not tolerate a name that merely *could* be
 * normalised: `SafeMediaEntry::from_entry` refuses unless the name already is,
 * and it refuses the whole archive rather than the one file. So a name Anki
 * would rewrite is rejected here, at the call that supplied it, instead of
 * producing a package that imports as "not a valid .apkg file".
 */

/** Anki's `MAX_MEDIA_FILENAME_LENGTH`, counted in UTF-8 bytes. */
const MAX_LENGTH = 120;

/** Anki's `disallowed_char`, minus the control and unassigned checks below. */
const DISALLOWED = `[]<>:"/?*^\\|`;

const NON_BREAKING_SPACE = String.fromCharCode(0x00a0);

/** Anki's `WINDOWS_DEVICE_NAME`: the name alone, or before the extension. */
const WINDOWS_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

/**
 * Explains why Anki would rewrite this filename, or undefined if it would not.
 * Reported rather than corrected so the caller can decide what the file is
 * really called; renaming it here would break the `<img src="...">` that
 * refers to it.
 */
export function mediaFilenameProblem(name: string): string | undefined {
  if (name.length === 0) return "is empty";
  if (name === "." || name === "..") return "is a directory reference";
  if (name.normalize("NFC") !== name) {
    return "is not NFC-normalised, which is what a macOS filesystem returns";
  }

  for (const char of name) {
    const problem = disallowedCharProblem(char);
    if (problem !== undefined) return problem;
  }

  if (name.includes(NON_BREAKING_SPACE)) return "contains a non-breaking space";
  if (WINDOWS_DEVICE.test(name)) return "is a reserved Windows device name";
  if (name.endsWith(" ") || name.endsWith(".")) return "ends with a space or a period";
  if (new TextEncoder().encode(name).length > MAX_LENGTH) {
    return `is longer than ${MAX_LENGTH} bytes`;
  }
  return undefined;
}

/**
 * Anki's `disallowed_char`, which `normalize_nfc_filename` deletes outright.
 * One predicate, so the checker and the normaliser cannot disagree about what a
 * bad character is.
 */
function disallowedCharProblem(char: string): string | undefined {
  if (DISALLOWED.includes(char)) return `contains ${JSON.stringify(char)}`;
  if (IS_ASCII_CONTROL.test(char)) return "contains a control character";
  if (isLoneSurrogate(char)) return `contains the lone surrogate ${codePoint(char)}`;
  if (isUnassignedForAnki(char.codePointAt(0) ?? 0)) {
    return (
      `contains ${codePoint(char)}, which Anki reads as unassigned because its ` +
      `character tables are Unicode 10`
    );
  }
  return undefined;
}

/**
 * Anki's `normalize_filename`. Legacy packages get this rather than the refusal
 * above, because `from_legacy` repairs a name where `from_entry` rejects one.
 */
export function normalizeMediaFilename(name: string): string {
  let out = "";
  for (const char of name.normalize("NFC")) {
    if (disallowedCharProblem(char) !== undefined) continue;
    out += char === NON_BREAKING_SPACE ? " " : char;
  }
  out = out.replace(WINDOWS_DEVICE, "$1_$2");
  if (out.endsWith(" ") || out.endsWith(".")) out += "_";
  return truncateFilename(out);
}

const utf8 = new TextEncoder();

/** Anki's `truncate_filename`: trim the stem, cap the extension at 10 bytes. */
function truncateFilename(name: string): string {
  if (utf8.encode(name).length <= MAX_LENGTH) return name;

  // `rsplitn(2, '.')`: any dot splits, including a leading one, which leaves an
  // empty stem and the rest as extension.
  const dot = name.lastIndexOf(".");
  const hasExt = dot >= 0;
  const ext = clampBytes(hasExt ? name.slice(dot + 1) : "", 10);
  // Room for the dot Anki rejoins with and for the underscore it may append.
  const stem = clampBytes(
    hasExt ? name.slice(0, dot) : name,
    MAX_LENGTH - utf8.encode(ext).length - 2,
  );

  const rejoined = ext.length > 0 ? `${stem}.${ext}` : stem;
  return rejoined.endsWith(" ") || rejoined.endsWith(".") ? `${rejoined}_` : rejoined;
}

/** The longest prefix that fits in `max` UTF-8 bytes without splitting a character. */
function clampBytes(text: string, max: number): string {
  if (utf8.encode(text).length <= max) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = utf8.encode(char).length;
    if (used + size > max) break;
    out += char;
    used += size;
  }
  return out;
}

/** Throws unless Anki would store this filename unchanged. */
export function assertMediaFilename(name: string): void {
  const problem = mediaFilenameProblem(name);
  if (problem !== undefined) {
    fail(
      "media-name",
      `Media filename ${JSON.stringify(name)} ${problem}. Anki rejects the entire ` +
        `package when a media name is not already normalised, so rename the file first.`,
    );
  }
}

function codePoint(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}
