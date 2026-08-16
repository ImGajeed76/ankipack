/**
 * Ids counting up from `startFrom`, or from the clock when it is omitted. An
 * opened collection seeds it past the highest id already in the document,
 * because the clock alone reissues ids a package built moments ago has taken.
 */
export class IdGenerator {
  private counter: number;

  constructor(startFrom?: number) {
    this.counter = startFrom ?? Date.now();
  }

  next(): number {
    return this.counter++;
  }
}

const PART_SEPARATOR = String.fromCharCode(0);

/**
 * Deterministic 63-bit id derived from a name, so a rebuilt deck keeps matching
 * the same fields on re-import. Absent ids make Anki match by name instead,
 * which lets an id collision overwrite the user's own notetype in place.
 * FNV-1a because it must be synchronous, which rules out `crypto.subtle`.
 */
export function stableId(...parts: string[]): bigint {
  // Joined with a separator, or a field named "X" at index 10 would hash the
  // same as one named "X1" at index 0.
  const input = new TextEncoder().encode(parts.join(PART_SEPARATOR));

  let hash = 0xcbf29ce484222325n;
  for (const byte of input) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }

  // A zero id is dropped as a proto3 default, which would put Anki back on the
  // name-matching path these ids exist to avoid.
  return BigInt.asUintN(63, hash) || 1n;
}
