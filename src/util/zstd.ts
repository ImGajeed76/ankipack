// Anki's latest package format stores the collection and every media file as
// zstd frames. Writing one does not require a compressor: RFC 8878 allows
// blocks to be stored raw, so a conforming frame is a header plus the payload
// chunked into raw blocks. Reading still needs a real decoder.

const MAGIC = 0xfd2fb528;

/** RFC 8878 caps a block at the window size, 128 KiB here. This stays under it. */
const BLOCK_SIZE = 64 * 1024;

const BLOCK_TYPE_RAW = 0;

/**
 * Wraps `data` in a zstd frame that stores it uncompressed.
 *
 * Frame_Header_Descriptor 0x80: a 4-byte Frame_Content_Size, no single-segment
 * flag, no checksum, no dictionary. Window_Descriptor 0x38 is Window_Log 17.
 */
export function zstdRawFrame(data: Uint8Array): Uint8Array {
  if (data.length > 0xffffffff) {
    throw new Error(`Cannot write a zstd frame for ${data.length} bytes`);
  }

  const blockCount = Math.max(1, Math.ceil(data.length / BLOCK_SIZE));
  const out = new Uint8Array(4 + 1 + 1 + 4 + blockCount * 3 + data.length);
  const view = new DataView(out.buffer);
  let at = 0;

  view.setUint32(at, MAGIC, true);
  at += 4;
  out[at++] = 0x80;
  out[at++] = 0x38;
  view.setUint32(at, data.length, true);
  at += 4;

  for (let i = 0; i < blockCount; i++) {
    const start = i * BLOCK_SIZE;
    const size = Math.min(BLOCK_SIZE, data.length - start);
    const last = i === blockCount - 1 ? 1 : 0;
    const header = (size << 3) | (BLOCK_TYPE_RAW << 1) | last;
    out[at++] = header & 0xff;
    out[at++] = (header >>> 8) & 0xff;
    out[at++] = (header >>> 16) & 0xff;
    out.set(data.subarray(start, start + size), at);
    at += size;
  }

  return out.subarray(0, at);
}
