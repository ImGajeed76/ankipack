import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";
import { unzipSync, strFromU8 } from "fflate";
import type { Package } from "../../src/index";

let sqlPromise: Promise<SqlJsStatic> | undefined;

/** sql.js takes ~100ms to initialise, so the whole suite shares one instance. */
export function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs();
  return sqlPromise;
}

export interface OpenedPackage {
  /** The apkg's `collection.anki2`, opened. Callers must `close()` it. */
  db: Database;
  /** The apkg's `media` index: archive entry name -> original filename. */
  mediaIndex: Record<string, string>;
  /** Every entry in the apkg archive, keyed by name. */
  entries: Record<string, Uint8Array>;
}

/** Build a package and crack it open so tests can inspect what actually shipped. */
export async function openPackage(pkg: Package): Promise<OpenedPackage> {
  const SQL = await getSql();
  const entries = unzipSync(await pkg.toUint8Array(SQL));

  const collection = entries["collection.anki2"];
  if (!collection) throw new Error("apkg contains no collection.anki2 entry");
  const media = entries["media"];
  if (!media) throw new Error("apkg contains no media index entry");

  return {
    db: new SQL.Database(collection),
    mediaIndex: JSON.parse(strFromU8(media)) as Record<string, string>,
    entries,
  };
}

export interface Rows {
  columns: string[];
  values: SqlValue[][];
}

/** Run a query and return its rows, or an empty result when nothing matched. */
export function query(db: Database, sql: string): Rows {
  const result = db.exec(sql);
  return result[0] ?? { columns: [], values: [] };
}

/** Single-column query flattened to an array. */
export function column(db: Database, sql: string): SqlValue[] {
  return query(db, sql).values.map((row) => row[0]);
}

/** Single-value query. Throws when the query returned no row. */
export function scalar(db: Database, sql: string): SqlValue {
  const values = column(db, sql);
  if (values.length === 0) throw new Error(`query returned no rows: ${sql}`);
  return values[0];
}
