import { BASE91_ALPHABET } from "./constants.js";

/**
 * A note GUID: 64 random bits in Anki's base91 alphabet, up to 10 characters.
 *
 * Random per call, so a deck rebuilt from the same source ships new identities
 * and re-importing it duplicates rather than updates. A publisher passes
 * `guid` to `Note` instead.
 */
export function generateGuid(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);

  let num = 0n;
  for (const byte of bytes) {
    num = (num << 8n) | BigInt(byte);
  }

  // Digits come out least significant first, so reverse to match Anki's
  // `to_base_n` (rslib/src/notes/mod.rs), which ends in `.rev()`.
  const chars: string[] = [];
  while (num > 0n) {
    chars.push(BASE91_ALPHABET[Number(num % 91n)]);
    num = num / 91n;
  }

  return chars.reverse().join("");
}
