/** SHA-1 of arbitrary bytes, which is what Anki records for each media entry. */
export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  // Copied rather than passed by reference: the view may sit on a shared or
  // oversized buffer, and digest() would hash the whole thing.
  return new Uint8Array(await crypto.subtle.digest("SHA-1", Uint8Array.from(data)));
}

/** Anki's `field_checksum` (rslib/src/notes/mod.rs): the first four SHA-1 bytes. */
export async function fieldChecksum(firstField: string): Promise<number> {
  const digest = await sha1(new TextEncoder().encode(firstField));
  return new DataView(digest.buffer).getUint32(0, false); // big-endian
}
