import type { Database, SqlJsStatic, SqlValue } from "sql.js";
import { unzipSync } from "fflate";
import { decompress } from "fzstd";
import { fromBinary } from "@bufbuild/protobuf";
import {
  MediaEntriesSchema,
  PackageMetadataSchema,
  PackageMetadata_Version,
} from "../generated/anki/import_export_pb.js";
import { normalizeMediaFilename } from "../util/media-name.js";
import { fail } from "../error.js";
import { SCHEMA_VERSION } from "./schema.js";
import { upgradeFromSchema11 } from "./legacy.js";
import type {
  CardRow,
  CollectionData,
  ColRow,
  ConfigRow,
  DeckConfigRow,
  DeckRow,
  FieldRow,
  GraveRow,
  MediaFile,
  NoteRow,
  NotetypeRow,
  RevlogRow,
  TagRow,
  TemplateRow,
} from "./data.js";

/** The package layouts Anki writes (import_export.proto PackageMetadata). */
const COLLECTION_FILENAME: Record<number, string> = {
  [PackageMetadata_Version.LEGACY_1]: "collection.anki2",
  [PackageMetadata_Version.LEGACY_2]: "collection.anki21",
  [PackageMetadata_Version.LATEST]: "collection.anki21b",
};

export interface ReadResult {
  data: CollectionData;
  /** The layout the file arrived in. Writing always produces LATEST. */
  version: PackageMetadata_Version;
}

/**
 * Reads an `.apkg` into the document model.
 *
 * The schema version is asserted rather than adapted: a collection this code
 * does not fully model would lose whatever it failed to read, so an unexpected
 * version is refused instead.
 */
export function readPackage(bytes: Uint8Array, SQL: SqlJsStatic): ReadResult {
  // An `.apkg` is a zip. fflate's own message for anything else says nothing
  // about what the caller actually handed over.
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    fail("invalid-package", `Not an .apkg file: it is not a zip archive (${String(error)})`);
  }

  const version = detectVersion(entries);

  const filename = COLLECTION_FILENAME[version];
  const stored = entries[filename];
  if (stored === undefined) {
    fail("invalid-package", `Package is missing ${filename}`);
  }

  const zstdCompressed = version === PackageMetadata_Version.LATEST;
  const collectionBytes = zstdCompressed
    ? attempt(() => decompress(stored), `${filename} is not valid zstd data`)
    : stored;

  const db = attempt(
    () => new SQL.Database(stripUnicaseCollation(collectionBytes, SQL)),
    `${filename} is not a readable SQLite database`,
  );
  try {
    const data = readCollection(db);
    // Schema 11 keeps notetypes, decks and presets as JSON on the col row, so
    // it is converted on the way in. Everything downstream sees schema 18.
    if (data.col.ver === LEGACY_SCHEMA_VERSION) {
      upgradeFromSchema11(data);
    } else if (data.col.ver !== SCHEMA_VERSION) {
      fail(
        "unsupported-schema",
        `Collection is at schema ${data.col.ver}, and ankipack reads schema ` +
          `${LEGACY_SCHEMA_VERSION} and ${SCHEMA_VERSION}. Re-export it from a current Anki.`,
      );
    }
    data.media = readMedia(entries, zstdCompressed);
    return { data, version };
  } finally {
    db.close();
  }
}

const LEGACY_SCHEMA_VERSION = 11;

/** Runs `read`, restating whatever a dependency threw as an `invalid-package`. */
function attempt<T>(read: () => T, what: string): T {
  try {
    return read();
  } catch (error) {
    fail("invalid-package", `${what} (${String(error)})`);
  }
}

/**
 * sql.js cannot register Anki's `unicase` collation, and `tags` is WITHOUT
 * ROWID keyed on such a column, so SQLite reports "no query solution".
 *
 * Nothing here depends on that order. The only query touching a folded column
 * is `ORDER BY tag`, and tags are written back in whatever order they arrive.
 */
function stripUnicaseCollation(bytes: Uint8Array, SQL: SqlJsStatic): Uint8Array {
  const db = new SQL.Database(bytes);
  try {
    // One predicate for both, because a collection can declare the collation in
    // any casing: LIKE folds ASCII case and `replace` does not. SQLite cannot
    // plan a query against a collation it does not have.
    const rows = db.exec("SELECT name, sql FROM sqlite_master WHERE sql LIKE '%collate unicase%'");
    if (rows.length === 0) return bytes;

    db.run("PRAGMA writable_schema = ON");
    for (const [name, sql] of rows[0].values) {
      db.run("UPDATE sqlite_master SET sql = ? WHERE name = ?", [
        String(sql).replace(/\s+collate\s+unicase/gi, ""),
        name,
      ]);
    }
    db.run("PRAGMA writable_schema = OFF");
    return db.export();
  } finally {
    db.close();
  }
}

/** Anki infers the layout from which collection file is present when `meta` is absent. */
function detectVersion(entries: Record<string, Uint8Array>): PackageMetadata_Version {
  const meta = entries["meta"];
  if (meta !== undefined) {
    const decoded = attempt(
      () => fromBinary(PackageMetadataSchema, meta),
      "Package meta record is damaged",
    );
    if (COLLECTION_FILENAME[decoded.version] !== undefined) return decoded.version;
    // Anki reports TooNew here. Falling through to the legacy probe would read
    // the dummy collection.anki2 every package carries, whose single note says
    // a newer Anki is required, and report it as the real contents.
    fail(
      "unsupported-schema",
      `Package declares layout version ${decoded.version}, which this version of ` +
        `ankipack does not know. It was written by a newer Anki, or its meta is damaged.`,
    );
  }
  return entries["collection.anki21"] !== undefined
    ? PackageMetadata_Version.LEGACY_2
    : PackageMetadata_Version.LEGACY_1;
}

function readMedia(entries: Record<string, Uint8Array>, zstdCompressed: boolean): MediaFile[] {
  const index = entries["media"];
  if (index === undefined || index.length === 0) return [];

  const names = zstdCompressed
    ? attempt(
        () =>
          fromBinary(MediaEntriesSchema, decompress(index)).entries.map(
            (entry, i): [string, string] => [String(i), entry.name],
          ),
        "Media index is damaged",
      )
    : legacyMediaNames(index);

  const files: MediaFile[] = [];
  for (const [key, name] of names) {
    const stored = entries[key];
    // Anki reports "{} missing from archive". Skipping it would drop the file
    // from the package on the next write, without ever saying so.
    if (stored === undefined) {
      fail("invalid-package", `Media file ${JSON.stringify(name)} is missing from the archive`);
    }
    // Normalised on the legacy path only, since that is the layout Anki repairs
    // rather than refuses. See `normalizeMediaFilename`.
    files.push({
      name: zstdCompressed ? name : normalizeMediaFilename(name),
      data: zstdCompressed
        ? attempt(
            () => decompress(stored),
            `Media file ${JSON.stringify(name)} is not valid zstd data`,
          )
        : stored,
    });
  }
  return files;
}

/**
 * The legacy index is `{index: filename}` JSON from an untrusted archive, so
 * the value has to be checked rather than asserted: a number here would reach
 * `normalizeMediaFilename` and throw a bare TypeError on `.normalize`.
 */
function legacyMediaNames(index: Uint8Array): Array<[string, string]> {
  const parsed = attempt(
    () => JSON.parse(new TextDecoder().decode(index)) as unknown,
    "Media index is not valid JSON",
  );
  if (typeof parsed !== "object" || parsed === null) {
    fail("invalid-package", "Media index is not a JSON object");
  }
  return Object.entries(parsed).map(([key, name]) => {
    if (typeof name !== "string") {
      fail("invalid-package", `Media index entry ${JSON.stringify(key)} is not a string`);
    }
    return [key, name];
  });
}

/** A row keyed by column name. */
type Row = Record<string, SqlValue>;

/**
 * Rows keyed by column rather than position. Indexing by position means adding
 * one column to a SELECT silently shifts every field after it, and most of them
 * are numbers, so nothing would fail to typecheck.
 */
function rows(db: Database, sql: string): Row[] {
  const result = db.exec(sql);
  if (result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i]])));
}

/**
 * Schema 11 has no notetypes, decks, templates, fields, deck_config, config or
 * tags tables, so those queries have to be skipped rather than allowed to fail.
 */
function tableNames(db: Database): Set<string> {
  return new Set(
    rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => str(row.name)),
  );
}

/** Reads a table that only exists at schema 18, or nothing if it is absent. */
function optionalTable<T>(
  db: Database,
  tables: Set<string>,
  table: string,
  sql: string,
  map: (row: Row) => T,
): T[] {
  return tables.has(table) ? rows(db, sql).map(map) : [];
}

const int = (v: SqlValue): number => Number(v ?? 0);
const str = (v: SqlValue): string => (v === null ? "" : String(v));
const blob = (v: SqlValue): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array());

/** Text columns a caller's own content reaches, per table. */
const TEXT_COLUMNS: Record<string, readonly string[]> = {
  col: ["conf", "models", "decks", "dconf", "tags"],
  notes: ["guid", "tags", "flds", "sfld", "data"],
  cards: ["data"],
  decks: ["name"],
  notetypes: ["name"],
  fields: ["name"],
  templates: ["name"],
  deck_config: ["name"],
  config: ["key"],
  tags: ["tag"],
};

/**
 * SQLite stores text as a C string, so a NUL truncates the value on the way
 * out and nothing reports it. Writing the truncated value back is worse than
 * failing: a note loses every field after the NUL and Anki then refuses it for
 * having the wrong field count. Anki strips the NUL instead, but it can see the
 * bytes and sql.js cannot, so the caller has to hear about it.
 */
function assertNoEmbeddedNul(db: Database, tables: Set<string>): void {
  for (const [table, columns] of Object.entries(TEXT_COLUMNS)) {
    if (!tables.has(table)) continue;
    const test = (column: string): string => `instr(CAST(${column} AS BLOB), x'00') > 0`;
    const naming = columns.map((column) => `WHEN ${test(column)} THEN '${column}'`).join(" ");
    const found = rows(
      db,
      `SELECT (CASE ${naming} END) AS col FROM ${table} ` +
        `WHERE ${columns.map(test).join(" OR ")} LIMIT 1`,
    )[0];
    if (found !== undefined) {
      fail(
        "invalid-package",
        `${table}.${String(found.col)} contains a NUL character, which SQLite ` +
          `truncates the value at. Remove it before importing this package.`,
      );
    }
  }
}

function readCollection(db: Database): CollectionData {
  const tables = tableNames(db);
  assertNoEmbeddedNul(db, tables);

  const colRow = rows(
    db,
    "SELECT id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags FROM col",
  )[0];
  if (colRow === undefined) fail("invalid-package", "Collection has no col row");

  const col: ColRow = {
    id: int(colRow.id),
    crt: int(colRow.crt),
    mod: int(colRow.mod),
    scm: int(colRow.scm),
    ver: int(colRow.ver),
    dty: int(colRow.dty),
    usn: int(colRow.usn),
    ls: int(colRow.ls),
    conf: str(colRow.conf),
    models: str(colRow.models),
    decks: str(colRow.decks),
    dconf: str(colRow.dconf),
    tags: str(colRow.tags),
  };

  const notes: NoteRow[] = rows(
    db,
    "SELECT id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data FROM notes ORDER BY id",
  ).map((r) => ({
    id: int(r.id),
    guid: str(r.guid),
    mid: int(r.mid),
    mod: int(r.mod),
    usn: int(r.usn),
    tags: str(r.tags),
    flds: str(r.flds),
    // Declared integer, so a numeric sort field comes back as a number.
    sfld: typeof r.sfld === "number" ? r.sfld : str(r.sfld),
    csum: int(r.csum),
    flags: int(r.flags),
    data: str(r.data),
  }));

  const cards: CardRow[] = rows(
    db,
    `SELECT id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps,
            lapses, left, odue, odid, flags, data FROM cards ORDER BY id`,
  ).map((r) => ({
    id: int(r.id),
    nid: int(r.nid),
    did: int(r.did),
    ord: int(r.ord),
    mod: int(r.mod),
    usn: int(r.usn),
    type: int(r.type),
    queue: int(r.queue),
    due: int(r.due),
    ivl: int(r.ivl),
    factor: int(r.factor),
    reps: int(r.reps),
    lapses: int(r.lapses),
    left: int(r.left),
    odue: int(r.odue),
    odid: int(r.odid),
    flags: int(r.flags),
    data: str(r.data),
  }));

  const revlog: RevlogRow[] = rows(
    db,
    "SELECT id, cid, usn, ease, ivl, lastIvl, factor, time, type FROM revlog ORDER BY id",
  ).map((r) => ({
    id: int(r.id),
    cid: int(r.cid),
    usn: int(r.usn),
    ease: int(r.ease),
    ivl: int(r.ivl),
    lastIvl: int(r.lastIvl),
    factor: int(r.factor),
    time: int(r.time),
    type: int(r.type),
  }));

  // Schema 11 declares graves as (usn, oid, type), so this must go by name.
  // It has no primary key either, while schema 18 keys on (oid, type), which is
  // why Anki's upgrade is an INSERT OR IGNORE: the first row for a key wins and
  // the rest would otherwise fail the write.
  const seenGraves = new Set<string>();
  const graves: GraveRow[] = [];
  for (const r of rows(db, "SELECT oid, type, usn FROM graves ORDER BY oid, type")) {
    const grave = { oid: int(r.oid), type: int(r.type), usn: int(r.usn) };
    const key = `${grave.oid}/${grave.type}`;
    if (seenGraves.has(key)) continue;
    seenGraves.add(key);
    graves.push(grave);
  }

  const deckConfig = optionalTable<DeckConfigRow>(
    db,
    tables,
    "deck_config",
    "SELECT id, name, mtime_secs, usn, config FROM deck_config ORDER BY id",
    (r) => ({
      id: int(r.id),
      name: str(r.name),
      mtimeSecs: int(r.mtime_secs),
      usn: int(r.usn),
      config: blob(r.config),
    }),
  );

  const config = optionalTable<ConfigRow>(
    db,
    tables,
    "config",
    "SELECT KEY, usn, mtime_secs, val FROM config ORDER BY KEY",
    (r) => ({
      key: str(r.KEY),
      usn: int(r.usn),
      mtimeSecs: int(r.mtime_secs),
      val: blob(r.val),
    }),
  );

  const tagRows = optionalTable<TagRow>(
    db,
    tables,
    "tags",
    "SELECT tag, usn, collapsed, config FROM tags ORDER BY tag",
    (r) => ({
      tag: str(r.tag),
      usn: int(r.usn),
      collapsed: int(r.collapsed) !== 0,
      config: r.config instanceof Uint8Array ? r.config : null,
    }),
  );

  const notetypes = optionalTable<NotetypeRow>(
    db,
    tables,
    "notetypes",
    "SELECT id, name, mtime_secs, usn, config FROM notetypes ORDER BY id",
    (r) => ({
      id: int(r.id),
      name: str(r.name),
      mtimeSecs: int(r.mtime_secs),
      usn: int(r.usn),
      config: blob(r.config),
    }),
  );

  const fields = optionalTable<FieldRow>(
    db,
    tables,
    "fields",
    "SELECT ntid, ord, name, config FROM fields ORDER BY ntid, ord",
    (r) => ({ ntid: int(r.ntid), ord: int(r.ord), name: str(r.name), config: blob(r.config) }),
  );

  const templates = optionalTable<TemplateRow>(
    db,
    tables,
    "templates",
    "SELECT ntid, ord, name, mtime_secs, usn, config FROM templates ORDER BY ntid, ord",
    (r) => ({
      ntid: int(r.ntid),
      ord: int(r.ord),
      name: str(r.name),
      mtimeSecs: int(r.mtime_secs),
      usn: int(r.usn),
      config: blob(r.config),
    }),
  );

  const decks = optionalTable<DeckRow>(
    db,
    tables,
    "decks",
    "SELECT id, name, mtime_secs, usn, common, kind FROM decks ORDER BY id",
    (r) => ({
      id: int(r.id),
      name: str(r.name),
      mtimeSecs: int(r.mtime_secs),
      usn: int(r.usn),
      common: blob(r.common),
      kind: blob(r.kind),
    }),
  );

  return {
    col,
    notes,
    cards,
    revlog,
    graves,
    deckConfig,
    config,
    tags: tagRows,
    notetypes,
    fields,
    templates,
    decks,
    media: [],
  };
}
