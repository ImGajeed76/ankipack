/**
 * Compute the checksum for a note's first field.
 * Uses SHA-1, takes the first 4 bytes as a big-endian unsigned 32-bit integer.
 * This matches Anki's `fieldChecksum` implementation.
 */
export async function fieldChecksum(firstField: string): Promise<number> {
  const encoder = new TextEncoder();
  const data = encoder.encode(firstField);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const view = new DataView(hashBuffer);
  return view.getUint32(0, false); // big-endian
}
