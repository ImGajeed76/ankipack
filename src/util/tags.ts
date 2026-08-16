import { IS_ASCII_CONTROL, rejectLoneSurrogates } from "./text.js";
import { fail } from "../error.js";

/** U+3000, the other character Anki splits the stored tag string on. */
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

/**
 * A tag Anki will store as the one tag it was given.
 *
 * Building a package and editing one both call this, so a tag accepted by one
 * cannot be refused by the other. A space would silently become several tags in
 * the user's tag tree, and `invalid_char_for_tag` strips a control character.
 */
export function assertTag(tag: string): void {
  if (tag.length === 0) fail("invalid-input", "Tags must not be empty");
  if (tag.includes(" ") || tag.includes(IDEOGRAPHIC_SPACE)) {
    fail("invalid-input", `Tag ${JSON.stringify(tag)} must not contain a space`);
  }
  if (IS_ASCII_CONTROL.test(tag)) {
    fail("invalid-input", `Tag ${JSON.stringify(tag)} must not contain a control character`);
  }
  rejectLoneSurrogates(tag, `Tag ${JSON.stringify(tag)}`);
}
