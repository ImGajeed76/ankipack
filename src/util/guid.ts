import { BASE91_ALPHABET } from "./constants.js";

/**
 * Generate a globally unique ID for a note using base91 encoding.
 * Uses a random 64-bit value encoded in base91 (10 chars).
 */
export function generateGuid(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);

  let num = 0n;
  for (const byte of bytes) {
    num = (num << 8n) | BigInt(byte);
  }

  const chars: string[] = [];
  while (num > 0n) {
    chars.push(BASE91_ALPHABET[Number(num % 91n)]);
    num = num / 91n;
  }

  return chars.join("");
}
