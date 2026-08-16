import type { Database } from "sql.js";
import { zipSync, strToU8 } from "fflate";
import type { getSql } from "./collection";

/**
 * Schema 11 keeps notetypes, decks and presets as JSON on the col row, so the
 * only way to test the converter is to hand-build a collection in that shape.
 * This is what genanki and every pre-2.1.50 Anki export look like.
 *
 * Shared so the two suites that build one cannot drift into testing different
 * shapes, which would only show up as one of them quietly passing.
 */
export const SCHEMA_11_SQL = `
CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL,
  scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL,
  ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL,
  dconf text NOT NULL, tags text NOT NULL);
CREATE TABLE notes (id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL,
  mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL, flds text NOT NULL,
  sfld integer NOT NULL, csum integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE cards (id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL,
  ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, type integer NOT NULL,
  queue integer NOT NULL, due integer NOT NULL, ivl integer NOT NULL, factor integer NOT NULL,
  reps integer NOT NULL, lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL,
  odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE revlog (id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL,
  ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL, factor integer NOT NULL,
  time integer NOT NULL, type integer NOT NULL);
CREATE TABLE graves (oid integer NOT NULL, type integer NOT NULL, usn integer NOT NULL);
`;

/** Runs `fill` against an empty schema 11 database and zips the result. */
export function legacyPackage(
  SQL: Awaited<ReturnType<typeof getSql>>,
  fill: (db: Database) => void,
  media: Record<string, Uint8Array> = {},
): Uint8Array {
  const db = new SQL.Database();
  try {
    db.run(SCHEMA_11_SQL);
    fill(db);
    return zipSync({ "collection.anki2": db.export(), media: strToU8("{}"), ...media });
  } finally {
    db.close();
  }
}
