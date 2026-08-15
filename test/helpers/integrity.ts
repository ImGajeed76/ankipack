import { fromBinary } from "@bufbuild/protobuf";
import { Deck_KindContainerSchema } from "../../src/generated/anki/decks_pb";
import { Notetype_ConfigSchema, Notetype_Config_Kind } from "../../src/generated/anki/notetypes_pb";
import { FIELD_SEPARATOR } from "../../src/util/constants";
import { query, type OpenedPackage } from "./collection";

// Anki's importer rejects an apkg whose internal references do not resolve
// inside the apkg itself; these checks catch that class without Anki.

export interface IntegrityProblem {
  check: string;
  detail: string;
}

export function checkIntegrity(opened: OpenedPackage): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];
  checkForeignKeys(opened, problems);
  checkDeckConfigReferences(opened, problems);
  checkGuidsUnique(opened, problems);
  checkFieldCounts(opened, problems);
  checkCardOrdinals(opened, problems);
  checkCardPositions(opened, problems);
  checkMedia(opened, problems);
  return problems;
}

interface ForeignKey {
  child: string;
  childColumn: string;
  parent: string;
  parentColumn: string;
}

const FOREIGN_KEYS: ForeignKey[] = [
  { child: "cards", childColumn: "nid", parent: "notes", parentColumn: "id" },
  { child: "cards", childColumn: "did", parent: "decks", parentColumn: "id" },
  { child: "notes", childColumn: "mid", parent: "notetypes", parentColumn: "id" },
  { child: "fields", childColumn: "ntid", parent: "notetypes", parentColumn: "id" },
  { child: "templates", childColumn: "ntid", parent: "notetypes", parentColumn: "id" },
];

function checkForeignKeys(opened: OpenedPackage, problems: IntegrityProblem[]): void {
  for (const fk of FOREIGN_KEYS) {
    const dangling = query(
      opened.db,
      `SELECT COUNT(*) FROM ${fk.child} c
       LEFT JOIN ${fk.parent} p ON c.${fk.childColumn} = p.${fk.parentColumn}
       WHERE p.${fk.parentColumn} IS NULL`,
    ).values[0]?.[0];

    if (typeof dangling === "number" && dangling > 0) {
      problems.push({
        check: `${fk.child}.${fk.childColumn} -> ${fk.parent}.${fk.parentColumn}`,
        detail: `${dangling} row(s) reference a ${fk.parent} row that is not in the package`,
      });
    }
  }
}

/**
 * Every deck's `config_id` must resolve inside the apkg, including the id=1
 * placeholder a NO_PRESET deck points at.
 */
function checkDeckConfigReferences(opened: OpenedPackage, problems: IntegrityProblem[]): void {
  const present = new Set(
    query(opened.db, "SELECT id FROM deck_config").values.map((row) => Number(row[0])),
  );

  for (const [name, kindBlob] of query(opened.db, "SELECT name, kind FROM decks").values) {
    if (!(kindBlob instanceof Uint8Array)) continue;
    const kind = fromBinary(Deck_KindContainerSchema, kindBlob);
    if (kind.kind.case !== "normal") continue;

    const configId = Number(kind.kind.value.configId);
    if (!present.has(configId)) {
      problems.push({
        check: "decks.config_id -> deck_config.id",
        detail: `deck ${JSON.stringify(String(name))} points at config_id ${configId}, which the package does not contain`,
      });
    }
  }
}

/** Two notes sharing a GUID collapse into one on import, silently losing a note. */
function checkGuidsUnique(opened: OpenedPackage, problems: IntegrityProblem[]): void {
  const duplicates = query(
    opened.db,
    "SELECT guid, COUNT(*) FROM notes GROUP BY guid HAVING COUNT(*) > 1",
  );
  for (const [guid, count] of duplicates.values) {
    problems.push({
      check: "notes.guid unique",
      detail: `GUID ${JSON.stringify(String(guid))} used by ${String(count)} notes`,
    });
  }
}

/** A note whose field count differs from its notetype renders wrong in Anki. */
function checkFieldCounts(opened: OpenedPackage, problems: IntegrityProblem[]): void {
  const expected = new Map<number, number>();
  for (const [ntid, count] of query(opened.db, "SELECT ntid, COUNT(*) FROM fields GROUP BY ntid")
    .values) {
    expected.set(Number(ntid), Number(count));
  }

  for (const [id, mid, flds] of query(opened.db, "SELECT id, mid, flds FROM notes").values) {
    const want = expected.get(Number(mid));
    const have = String(flds).split(FIELD_SEPARATOR).length;
    if (want !== undefined && have !== want) {
      problems.push({
        check: "notes.flds field count",
        detail: `note ${String(id)} has ${have} fields, its notetype defines ${want}`,
      });
    }
  }
}

/**
 * For normal notetypes a card's ordinal must name a real template. Cloze cards
 * are exempt: their ordinal is the cloze number, not a template index.
 */
function checkCardOrdinals(opened: OpenedPackage, problems: IntegrityProblem[]): void {
  const clozeNotetypes = new Set<number>();
  for (const [id, config] of query(opened.db, "SELECT id, config FROM notetypes").values) {
    if (!(config instanceof Uint8Array)) continue;
    if (fromBinary(Notetype_ConfigSchema, config).kind === Notetype_Config_Kind.CLOZE) {
      clozeNotetypes.add(Number(id));
    }
  }

  const rows = query(
    opened.db,
    `SELECT c.id, n.mid, c.ord FROM cards c
     JOIN notes n ON n.id = c.nid
     LEFT JOIN templates t ON t.ntid = n.mid AND t.ord = c.ord
     WHERE t.ntid IS NULL`,
  );
  for (const [cardId, mid, ord] of rows.values) {
    if (clozeNotetypes.has(Number(mid))) continue;
    problems.push({
      check: "cards.ord -> templates.ord",
      detail: `card ${String(cardId)} has ord ${String(ord)}, which its notetype does not define`,
    });
  }
}

/**
 * New-card positions must be a gapless 0..n-1 run, or the deck's order is
 * wrong. Positions are package-wide, not per deck.
 */
function checkCardPositions(opened: OpenedPackage, problems: IntegrityProblem[]): void {
  const positions = query(opened.db, "SELECT due FROM cards ORDER BY due").values.map((row) =>
    Number(row[0]),
  );
  positions.forEach((due, index) => {
    if (due !== index) {
      problems.push({
        check: "cards.due positions",
        detail: `expected a gapless 0..${positions.length - 1} run, found ${due} at index ${index}`,
      });
    }
  });
}

function checkMedia(opened: OpenedPackage, problems: IntegrityProblem[]): void {
  const shipped = new Set(Object.values(opened.mediaIndex));

  for (const [entry, filename] of Object.entries(opened.mediaIndex)) {
    if (!(entry in opened.entries)) {
      problems.push({
        check: "media index -> archive",
        detail: `index names ${JSON.stringify(filename)} as entry ${entry}, which the archive lacks`,
      });
    }
  }

  for (const [id, flds] of query(opened.db, "SELECT id, flds FROM notes").values) {
    for (const reference of extractMediaReferences(String(flds))) {
      if (!shipped.has(reference)) {
        problems.push({
          check: "note media references",
          detail: `note ${String(id)} references ${JSON.stringify(reference)}, which the package does not ship`,
        });
      }
    }
  }
}

/** Pull `src="..."` and `[sound:...]` targets out of a field. */
function extractMediaReferences(field: string): string[] {
  const found: string[] = [];
  collectBetween(field, 'src="', '"', found);
  collectBetween(field, "[sound:", "]", found);
  return found;
}

function collectBetween(text: string, open: string, close: string, out: string[]): void {
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(open, cursor);
    if (start < 0) return;
    const from = start + open.length;
    const end = text.indexOf(close, from);
    if (end < 0) return;
    out.push(text.slice(from, end));
    cursor = end + close.length;
  }
}
