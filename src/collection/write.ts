import type { Database, SqlJsStatic } from "sql.js";
import { zipSync } from "fflate";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  MediaEntriesSchema,
  PackageMetadataSchema,
  PackageMetadata_Version,
} from "../generated/anki/import_export_pb.js";
import { sha1 } from "../util/checksum.js";
import { zstdRawFrame } from "../util/zstd.js";
import { SCHEMA_SQL } from "./schema.js";
import { assertWritable } from "./validate.js";
import { fail } from "../error.js";
import type { CollectionData } from "./data.js";

/**
 * Serialises the document to an `.apkg` in Anki's latest layout: a
 * `PackageMetadata`, a zstd-framed schema 18 collection, and one zstd-framed
 * file per media entry indexed by a `MediaEntries` protobuf.
 */
export async function writePackage(data: CollectionData, SQL: SqlJsStatic): Promise<Uint8Array> {
  assertWritable(data);

  const db = new SQL.Database();
  let collectionBytes: Uint8Array;
  try {
    db.run(SCHEMA_SQL);
    writeCollection(db, data);
    collectionBytes = db.export();
  } finally {
    db.close();
  }

  const files: Record<string, Uint8Array> = {
    meta: toBinary(
      PackageMetadataSchema,
      create(PackageMetadataSchema, { version: PackageMetadata_Version.LATEST }),
    ),
    "collection.anki21b": zstdRawFrame(collectionBytes),
  };

  // A plain zip holds its entry count in 16 bits and fflate writes no zip64
  // record, so past this the count wraps and a reader loses the entries it
  // needs most: integer-like names sort first, leaving `meta`, the collection
  // and the media index at the end of the central directory.
  const MAX_MEDIA_FILES = 0xffff - Object.keys(files).length - 1;
  if (data.media.length > MAX_MEDIA_FILES) {
    fail(
      "invalid-document",
      `A package can hold at most ${MAX_MEDIA_FILES} media files, and this one has ` +
        `${data.media.length}. Past that the zip entry count overflows.`,
    );
  }

  const entries = [];
  for (const [index, file] of data.media.entries()) {
    files[String(index)] = zstdRawFrame(file.data);
    entries.push({
      name: file.name,
      size: file.data.length,
      sha1: await sha1(file.data),
    });
  }
  // The index is framed like everything else, including when it is empty:
  // Anki decodes it unconditionally, so a bare zero-length entry fails the
  // import with "incomplete frame" (colpkg/export.rs write_media_map).
  files["media"] = zstdRawFrame(
    toBinary(MediaEntriesSchema, create(MediaEntriesSchema, { entries })),
  );

  // Deflated: the zstd frames above are stored blocks, so the zip is what
  // actually compresses. Anki reads it with a general zip reader.
  return zipSync(files, { level: 6 });
}

/**
 * One transaction, not one per INSERT. SQLite otherwise commits every row on
 * its own, which dominates the cost of a collection-sized write.
 */
function writeCollection(db: Database, data: CollectionData): void {
  db.run("BEGIN");
  try {
    writeRows(db, data);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

function writeRows(db: Database, data: CollectionData): void {
  const c = data.col;
  db.run(
    `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.id,
      c.crt,
      c.mod,
      c.scm,
      c.ver,
      c.dty,
      c.usn,
      c.ls,
      c.conf,
      c.models,
      c.decks,
      c.dconf,
      c.tags,
    ],
  );

  for (const n of data.notes) {
    db.run(
      `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [n.id, n.guid, n.mid, n.mod, n.usn, n.tags, n.flds, n.sfld, n.csum, n.flags, n.data],
    );
  }

  for (const c2 of data.cards) {
    db.run(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor,
                          reps, lapses, left, odue, odid, flags, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c2.id,
        c2.nid,
        c2.did,
        c2.ord,
        c2.mod,
        c2.usn,
        c2.type,
        c2.queue,
        c2.due,
        c2.ivl,
        c2.factor,
        c2.reps,
        c2.lapses,
        c2.left,
        c2.odue,
        c2.odid,
        c2.flags,
        c2.data,
      ],
    );
  }

  for (const r of data.revlog) {
    db.run(
      `INSERT INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.cid, r.usn, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type],
    );
  }

  for (const g of data.graves) {
    db.run("INSERT INTO graves (oid, type, usn) VALUES (?, ?, ?)", [g.oid, g.type, g.usn]);
  }

  for (const d of data.deckConfig) {
    db.run("INSERT INTO deck_config (id, name, mtime_secs, usn, config) VALUES (?, ?, ?, ?, ?)", [
      d.id,
      d.name,
      d.mtimeSecs,
      d.usn,
      d.config,
    ]);
  }

  for (const cfg of data.config) {
    db.run("INSERT INTO config (KEY, usn, mtime_secs, val) VALUES (?, ?, ?, ?)", [
      cfg.key,
      cfg.usn,
      cfg.mtimeSecs,
      cfg.val,
    ]);
  }

  for (const t of data.tags) {
    db.run("INSERT INTO tags (tag, usn, collapsed, config) VALUES (?, ?, ?, ?)", [
      t.tag,
      t.usn,
      t.collapsed ? 1 : 0,
      t.config,
    ]);
  }

  for (const nt of data.notetypes) {
    db.run("INSERT INTO notetypes (id, name, mtime_secs, usn, config) VALUES (?, ?, ?, ?, ?)", [
      nt.id,
      nt.name,
      nt.mtimeSecs,
      nt.usn,
      nt.config,
    ]);
  }

  for (const f of data.fields) {
    db.run("INSERT INTO fields (ntid, ord, name, config) VALUES (?, ?, ?, ?)", [
      f.ntid,
      f.ord,
      f.name,
      f.config,
    ]);
  }

  for (const t of data.templates) {
    db.run(
      "INSERT INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?, ?, ?, ?, ?, ?)",
      [t.ntid, t.ord, t.name, t.mtimeSecs, t.usn, t.config],
    );
  }

  for (const d of data.decks) {
    db.run(
      "INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, ?, ?, ?, ?)",
      [d.id, d.name, d.mtimeSecs, d.usn, d.common, d.kind],
    );
  }
}
