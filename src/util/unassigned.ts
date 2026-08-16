/**
 * The code points Anki treats as unassigned, and so strips out of a media
 * filename (rslib/src/media/files.rs `disallowed_char`).
 *
 * Anki asks `unic-ucd-category`, pinned at 0.9.0, which carries Unicode 10.0.0
 * tables from 2017. JavaScript's own `\p{Cn}` answers for whatever Unicode
 * version the host runtime ships, so it calls U+1F970 assigned where Anki does
 * not, and a package named with it is refused whole. Unicode only ever assigns,
 * so this table is a superset of every runtime's `\p{Cn}` and replaces it.
 *
 * Generated from the crate itself, as `gap.length` pairs in hex, each gap
 * counted from the end of the previous range:
 *
 *   unic-ucd-category = "=0.9.0"
 *   GeneralCategory::of(c) == GeneralCategory::Unassigned, for every char
 *
 * Surrogates are absent because a Rust `char` cannot be one, so Anki never
 * tests them. They are rejected earlier, as invalid UTF-8.
 */
const UNASSIGNED_RANGES_UNICODE_10 = [
  "378.1,6.3,7.0,1.0,14.0,18d.0,26.1,7.0,27.0,2.1,3.0,37.7,1b.4,5.a,1d.0,f0.0,3c.1,65.d,3b.4,",
  "2e.1,f.0,1c.1,1.0,b.34,15.0,8.15,b0.0,8.1,2.1,16.0,7.0,1.2,4.1,9.1,2.1,4.7,1.3,2.0,5.1,18.2,",
  "3.0,6.3,2.1,16.0,7.0,2.0,2.0,2.1,1.0,5.3,2.1,3.2,1.6,4.0,1.6,10.a,3.0,9.0,3.0,16.0,7.0,2.0,",
  "5.1,a.0,3.0,3.1,1.e,4.1,c.6,7.0,3.0,8.1,2.1,16.0,7.0,2.0,5.1,9.1,2.1,3.7,2.3,2.0,5.1,12.9,",
  "2.0,6.2,3.0,4.2,2.0,1.0,2.2,2.2,3.2,c.3,5.2,3.0,4.1,1.5,1.d,15.4,4.0,8.0,3.0,17.0,10.2,8.0,",
  "3.0,4.6,2.0,3.4,4.1,a.7,c.0,8.0,3.0,17.0,a.0,5.1,9.0,3.0,4.6,2.6,1.0,4.1,a.0,2.c,4.0,8.0,3.0,",
  "33.0,3.0,6.3,10.1,1a.1,2.0,12.2,18.0,9.0,1.1,7.2,1.3,6.0,1.0,8.5,a.1,3.b,3a.3,1d.24,2.0,1.1,",
  "2.0,1.1,1.5,4.0,7.0,3.0,1.0,1.1,2.0,d.0,3.1,5.0,1.0,6.1,a.1,4.1f,48.0,24.3,27.0,24.0,f.0,",
  "d.24,c6.0,1.4,1.1,179.0,4.1,7.0,1.0,4.1,29.0,4.1,21.0,4.1,7.0,1.0,4.1,f.0,39.0,4.1,43.1,20.2,",
  "1a.5,56.1,6.1,29d.2,59.6,d.0,7.a,17.8,14.b,d.0,3.0,2.b,5e.1,a.5,a.5,f.0,a.5,58.7,2b.4,46.9,",
  "1f.0,c.3,c.3,1.2,2a.1,5.a,2c.3,1a.5,b.2,3e.1,41.0,1d.1,b.5,a.5,e.1,f.40,4c.3,2d.2,74.7,3c.2,",
  "f.2,3c.36,8.7,2a.5,fa.0,11b.1,6.1,26.1,6.1,8.0,1.0,1.0,1.0,1f.1,35.0,f.0,e.1,6.0,13.1,3.0,",
  "9.0,65.0,c.1,1b.0,d.2,20.f,21.e,8c.3,297.18,b.14,714.1,20.1,22.2,c.0,9.18,4.f,2f.0,2f.0,94.4,",
  "2d.0,1.4,1.1,38.6,2.d,18.8,7.0,7.0,7.0,7.0,7.0,7.0,7.0,7.0,6a.35,1a.0,59.b,d6.19,c.3,40.0,",
  "56.1,67.4,2a.1,5e.0,2b.4,24.b,2f.0,df.0,1ab6.9,522b.14,48d.2,37.8,15c.13,b8.7,af.0,8.3e,35.3,",
  "a.5,38.7,46.7,c.5,1e.1,54.a,1e.2,4e.0,b.3,21.0,37.8,e.1,a.1,67.17,1c.9,6.1,6.1,6.8,7.0,7.0,",
  "36.9,7e.1,a.5,2ba4.b,17.3,31.3,226e.1,6a.25,7.b,5.4,1a.0,5.0,1.0,2.0,2.0,7c.10,16d.f,40.1,",
  "36.27,e.1,1a.5,33.0,13.0,4.3,5.0,87.1,1.0,be.2,6.1,6.1,6.1,3.2,7.0,7.9,5.1,c.0,1a.0,13.0,2.0,",
  "f.1,e.21,7b.4,3.3,2d.2,58.0,c.3,1.2e,2e.81,1d.2,31.e,1c.3,24.8,1e.4,2b.4,1e.0,25.3,e.29,9e.1,",
  "a.5,24.3,24.3,28.7,34.a,1.8f,137.8,16.9,8.97,6.1,1.0,2c.0,2.2,1.1,17.0,48.7,9.2f,13.0,2.4,",
  "21.2,1b.4,1.3f,38.3,14.1,32.0,2.4,8.0,3.0,1b.3,3.3,9.7,9.6,40.1f,27.3,c.8,36.2,1d.1,1b.4,",
  "1a.6,4.b,7.4f,49.36,33.c,33.6,6.15f,1f.180,4e.3,1e.e,43.d,19.6,a.5,35.0,e.b,27.8,4e.1,10.0,",
  "14.a,12.0,2c.40,7.0,1.0,4.0,f.0,b.5,3b.4,a.5,4.0,8.1,2.1,16.0,7.0,2.0,5.1,9.1,2.1,3.1,1.5,",
  "1.4,7.1,7.2,5.8a,5a.0,1.0,1.21,48.7,a.a5,36.1,26.21,45.a,a.5,d.12,38.7,a.35,1a.2,f.3,10.15f,",
  "53.b,1.ff,48.7,34.1,17.0,5.1c,39.106,9.0,2d.0,e.9,1d.2,20.1,16.0,e.48,7.0,2.0,2c.2,1.0,2.0,",
  "9.7,a.2a5,39a.65,6f.0,5.a,c4.abb,42f.fd0,247.21b8,239.6,1f.0,a.3,2.5f,1e.1,6.9,46.9,a.0,7.0,",
  "15.4,13.36f,45.a,2f.f,11.3f,2.1d,17ed.12,2f3.250c,11f.50,18c.903,6b.4,d.2,9.6,a.1,8.135b,",
  "f6.9,27.1,c0.16,46.b9,57.8,12.8d,55.0,47.0,2.1,1.1,2.1,4.0,c.0,1.0,7.0,41.0,4.1,8.0,7.0,1c.0,",
  "4.0,5.0,1.2,7.0,154.1,124.1,2be.e,5.0,f.54f,7.0,11.1,7.0,2.0,5.7d4,c5.1,10.28,4b.4,a.3,2.49f,",
  "4.0,1b.0,2.0,1.1,1.0,a.0,4.0,1.0,1.5,1.3,1.0,1.0,1.0,3.0,2.0,1.1,1.0,1.0,1.0,1.0,1.0,2.0,1.1,",
  "4.0,7.0,4.0,4.0,1.0,a.0,11.4,3.0,5.0,11.33,2.10d,2c.3,64.b,f.1,f.0,f.0,25.9,d.2,1f.0,3c.3,",
  "3d.38,1d.c,2c.3,9.6,2.d,6.99,3d5.a,d.2,9.6,74.b,55.2a,c.3,38.7,a.5,28.7,1e.51,c.3,2f.0,d.2,",
  "1c.13,18.27,1.e,17.618,a6d7.28,1035.a,de.1,1682.d,1d31.c1e,21e.b05e2,1.1d,60.7f,f0.fe0f,",
  "fffe.1,fffe.1",
].join("");

const RANGES: ReadonlyArray<readonly [number, number]> = decodeRanges(UNASSIGNED_RANGES_UNICODE_10);

function decodeRanges(encoded: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let end = -1;
  for (const pair of encoded.split(",")) {
    const [gap, length] = pair.split(".");
    const start = end + 1 + Number.parseInt(gap, 16);
    end = start + Number.parseInt(length, 16);
    ranges.push([start, end]);
  }
  return ranges;
}

/** Whether Unicode 10.0.0, and so Anki, considers this code point unassigned. */
export function isUnassignedForAnki(codePoint: number): boolean {
  let low = 0;
  let high = RANGES.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = RANGES[mid];
    if (codePoint < start) high = mid - 1;
    else if (codePoint > end) low = mid + 1;
    else return true;
  }
  return false;
}
