import { describe, test, expect } from "bun:test";
import { unzipSync } from "fflate";
import { decompress } from "fzstd";
import { fromBinary } from "@bufbuild/protobuf";
import {
  PackageMetadataSchema,
  PackageMetadata_Version,
  MediaEntriesSchema,
} from "../src/generated/anki/import_export_pb";
import { sha1 } from "../src/util/checksum";
import { readPackage } from "../src/collection/read";
import { writePackage } from "../src/collection/write";
import type { CollectionData } from "../src/collection/data";
import { FIXTURES } from "./fixtures";
import { getSql } from "./helpers/collection";

// The invariant the document model exists to provide: anything read and
// written back unedited comes out the same. If a column is ever dropped from
// the model, one of these fails rather than a user losing their scheduling.

async function bytesOf(fixtureIndex: number): Promise<Uint8Array> {
  const SQL = await getSql();
  return FIXTURES[fixtureIndex].build().toUint8Array(SQL);
}

describe("read then write preserves the collection", () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, async () => {
      const SQL = await getSql();
      const original = await fixture.build().toUint8Array(SQL);

      const first = readPackage(original, SQL);
      const rewritten = await writePackage(first.data, SQL);
      const second = readPackage(rewritten, SQL);

      expect(second.data).toEqual(first.data);
    });
  }
});

describe("the written package is Anki's latest layout", () => {
  test("meta declares LATEST and the collection is the 21b name", async () => {
    const SQL = await getSql();
    const { data } = readPackage(await bytesOf(0), SQL);
    const entries = unzipSync(await writePackage(data, SQL));

    expect(Object.keys(entries).sort()).toEqual(["collection.anki21b", "media", "meta"]);
    expect(fromBinary(PackageMetadataSchema, entries["meta"]).version).toBe(
      PackageMetadata_Version.LATEST,
    );
  });

  test("the collection is a zstd frame carrying schema 18", async () => {
    const SQL = await getSql();
    const { data } = readPackage(await bytesOf(0), SQL);
    const entries = unzipSync(await writePackage(data, SQL));

    // RFC 8878 magic, little-endian 0xFD2FB528.
    expect(Array.from(entries["collection.anki21b"].slice(0, 4))).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(readPackage(await writePackage(data, SQL), SQL).data.col.ver).toBe(18);
  });

  test("media is indexed by protobuf with size and sha1", async () => {
    const SQL = await getSql();
    const media = FIXTURES.findIndex((f) => f.name === "media-and-tags");
    const { data } = readPackage(await bytesOf(media), SQL);
    const entries = unzipSync(await writePackage(data, SQL));

    const index = fromBinary(MediaEntriesSchema, decompress(entries["media"]));
    expect(index.entries.map((e) => e.name).sort()).toEqual(["answer.mp3", "diagram.png"]);

    // Anki's MediaCopier hashes and counts what it reads, before handing the
    // bytes to the encoder, so both describe the file and not its zstd frame.
    for (const entry of index.entries) {
      const file = data.media.find((f) => f.name === entry.name);
      expect(file).toBeDefined();
      expect(entry.size).toBe(file!.data.length);
      expect(Array.from(entry.sha1)).toEqual(Array.from(await sha1(file!.data)));
    }
  });

  // The zstd frames ankipack writes are stored blocks, so they carry the
  // collection at full size and the archive is what actually compresses it.
  // Storing the archive instead would ship a package around 20x larger.
  test("the archive is deflated, not stored", async () => {
    const SQL = await getSql();
    const { data } = readPackage(await bytesOf(0), SQL);
    const written = await writePackage(data, SQL);
    const entries = unzipSync(written);
    const uncompressed = Object.values(entries).reduce((sum, e) => sum + e.length, 0);

    expect(written.length).toBeLessThan(uncompressed / 4);
  });

  test("media bytes survive the round trip", async () => {
    const SQL = await getSql();
    const media = FIXTURES.findIndex((f) => f.name === "media-and-tags");
    const first = readPackage(await bytesOf(media), SQL);
    const second = readPackage(await writePackage(first.data, SQL), SQL);

    expect(second.data.media).toEqual(first.data.media);
    expect(second.data.media.length).toBe(2);
  });
});

describe("a collection ankipack cannot fully model is refused", () => {
  // 11 and 18 are handled; anything between is a schema whose columns this code
  // has never seen, so reading it would drop whatever it failed to model.
  test("an unhandled schema throws rather than silently dropping data", async () => {
    const SQL = await getSql();
    const { data } = readPackage(await bytesOf(0), SQL);
    const unknown: CollectionData = { ...data, col: { ...data.col, ver: 17 } };

    const bytes = await writePackage(unknown, SQL);
    expect(() => readPackage(bytes, SQL)).toThrow(/schema 17.*reads schema 11 and 18/s);
  });
});

// `col.data` is the documented escape hatch, so a caller can put the document
// into a state Anki refuses. These are the shapes its importer rejects, or
// worse accepts and then shows as an empty deck, so the write names the row
// instead of letting a raw SQLite error or a silent corruption through.
describe("a document that would not import is refused at write time", () => {
  async function edited(mutate: (data: CollectionData) => void): Promise<Uint8Array> {
    const SQL = await getSql();
    const { data } = readPackage(await bytesOf(0), SQL);
    mutate(data);
    return writePackage(data, SQL);
  }

  test("a note referring to a note type that is not there", async () => {
    await expect(edited((d) => (d.notes[0].mid = 999_999))).rejects.toThrow(/notes\.mid.*999999/s);
  });

  test("a card referring to a note that is not there", async () => {
    await expect(edited((d) => (d.cards[0].nid = 999_999))).rejects.toThrow(/cards\.nid.*999999/s);
  });

  test("a card referring to a deck that is not there", async () => {
    await expect(edited((d) => (d.cards[0].did = 999_999))).rejects.toThrow(/cards\.did.*999999/s);
  });

  test("two notes sharing an id", async () => {
    await expect(edited((d) => d.notes.push({ ...d.notes[0] }))).rejects.toThrow(
      /notes.*duplicate id/is,
    );
  });

  test("two cards sharing an id", async () => {
    await expect(edited((d) => d.cards.push({ ...d.cards[0] }))).rejects.toThrow(
      /cards.*duplicate id/is,
    );
  });

  test("a note whose field count does not match its note type", async () => {
    await expect(edited((d) => (d.notes[0].flds = "only one"))).rejects.toThrow(/field/is);
  });

  test("an untouched document still writes", async () => {
    await expect(edited(() => {})).resolves.toBeInstanceOf(Uint8Array);
  });
});
