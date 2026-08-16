import { decompress } from "fzstd";
import { fromBinary, toJson, type DescMessage, type JsonValue } from "@bufbuild/protobuf";
import type { SqlValue } from "sql.js";
import { DeckConfig_ConfigSchema } from "../../src/generated/anki/deck_config_pb";
import { Deck_CommonSchema, Deck_KindContainerSchema } from "../../src/generated/anki/decks_pb";
import {
  Notetype_ConfigSchema,
  Notetype_Field_ConfigSchema,
  Notetype_Template_ConfigSchema,
} from "../../src/generated/anki/notetypes_pb";
import { BASE91_ALPHABET } from "../../src/util/constants";
import { query, type OpenedPackage } from "./collection";

// Id namespaces are per entity kind: the module-level IdGenerators are seeded
// from Date.now(), so a deck and a notetype can genuinely share an id.

/** Ids at or above this are clock-derived. Smaller ones are meaningful constants. */
const GENERATED_ID_FLOOR = 1_000_000_000;

const BASE91_CHARS = new Set(BASE91_ALPHABET);

type IdNamespace = "dconf" | "deck" | "nt" | "note" | "card";

type ColumnSpec =
  | { kind: "id"; ns: IdNamespace; declares?: boolean }
  | { kind: "time" }
  | { kind: "guid" }
  | { kind: "proto"; schema: DescMessage; idRefs?: Record<string, IdNamespace> };

interface TableSpec {
  name: string;
  orderBy: string;
  /** Columns needing special rendering. Anything unlisted is printed literally. */
  columns: Record<string, ColumnSpec>;
}

// Order matters twice: ids are declared in this order, and a table's rows are
// symbol-numbered in the order they are dumped.
const TABLES: TableSpec[] = [
  {
    name: "col",
    orderBy: "id",
    columns: { crt: { kind: "time" }, mod: { kind: "time" }, scm: { kind: "time" } },
  },
  {
    name: "deck_config",
    orderBy: "name, id",
    columns: {
      id: { kind: "id", ns: "dconf", declares: true },
      mtime_secs: { kind: "time" },
      config: { kind: "proto", schema: DeckConfig_ConfigSchema },
    },
  },
  {
    name: "decks",
    orderBy: "name",
    columns: {
      id: { kind: "id", ns: "deck", declares: true },
      mtime_secs: { kind: "time" },
      common: { kind: "proto", schema: Deck_CommonSchema },
      kind: {
        kind: "proto",
        schema: Deck_KindContainerSchema,
        idRefs: { configId: "dconf" },
      },
    },
  },
  {
    name: "notetypes",
    orderBy: "name",
    columns: {
      id: { kind: "id", ns: "nt", declares: true },
      mtime_secs: { kind: "time" },
      config: { kind: "proto", schema: Notetype_ConfigSchema },
    },
  },
  {
    name: "fields",
    orderBy: "ntid, ord",
    columns: {
      ntid: { kind: "id", ns: "nt" },
      config: { kind: "proto", schema: Notetype_Field_ConfigSchema },
    },
  },
  {
    name: "templates",
    orderBy: "ntid, ord",
    columns: {
      ntid: { kind: "id", ns: "nt" },
      mtime_secs: { kind: "time" },
      config: {
        kind: "proto",
        schema: Notetype_Template_ConfigSchema,
        idRefs: { targetDeckId: "deck" },
      },
    },
  },
  {
    name: "notes",
    orderBy: "id",
    columns: {
      id: { kind: "id", ns: "note", declares: true },
      guid: { kind: "guid" },
      mid: { kind: "id", ns: "nt" },
      mod: { kind: "time" },
    },
  },
  {
    name: "cards",
    orderBy: "id",
    columns: {
      id: { kind: "id", ns: "card", declares: true },
      nid: { kind: "id", ns: "note" },
      did: { kind: "id", ns: "deck" },
      mod: { kind: "time" },
    },
  },
  { name: "revlog", orderBy: "id", columns: {} },
  { name: "graves", orderBy: "oid, type", columns: {} },
  { name: "config", orderBy: "KEY", columns: {} },
  { name: "tags", orderBy: "tag", columns: {} },
];

class Symbols {
  private readonly ids = new Map<string, Map<number, string>>();
  private readonly counters = new Map<string, number>();
  private readonly times = new Map<number, string>();
  private readonly guids = new Map<string, string>();

  declareId(ns: IdNamespace, raw: SqlValue): void {
    if (typeof raw !== "number") return;
    const map = this.namespace(ns);
    if (map.has(raw)) return;
    map.set(raw, raw >= GENERATED_ID_FLOOR ? `${ns}#${this.bump(ns)}` : `${ns}:${raw}`);
  }

  /** An id with no declared row renders MISSING: a dangling FK, visible in a diff. */
  renderId(ns: IdNamespace, raw: SqlValue): string {
    if (raw === 0) return "0";
    if (typeof raw !== "number") return `${ns}:INVALID(${formatLiteral(raw)})`;
    const known = this.namespace(ns).get(raw);
    if (known) return known;
    return `${ns}:MISSING(${raw >= GENERATED_ID_FLOOR ? "generated" : raw})`;
  }

  renderTime(raw: SqlValue): string {
    if (typeof raw !== "number") return formatLiteral(raw);
    let symbol = this.times.get(raw);
    if (!symbol) {
      symbol = `time#${this.times.size + 1}`;
      this.times.set(raw, symbol);
    }
    return symbol;
  }

  /** Generated GUIDs are random so they are symbolised; caller-supplied ones print literally. */
  renderGuid(raw: SqlValue): string {
    if (typeof raw !== "string") return formatLiteral(raw);
    if (!looksGenerated(raw)) return formatLiteral(raw);
    let symbol = this.guids.get(raw);
    if (!symbol) {
      symbol = `guid#${this.guids.size + 1}`;
      this.guids.set(raw, symbol);
    }
    return symbol;
  }

  private namespace(ns: string): Map<number, string> {
    let map = this.ids.get(ns);
    if (!map) {
      map = new Map();
      this.ids.set(ns, map);
    }
    return map;
  }

  private bump(ns: string): number {
    const next = (this.counters.get(ns) ?? 0) + 1;
    this.counters.set(ns, next);
    return next;
  }
}

/**
 * Heuristic: a caller GUID that is short and all-base91 is indistinguishable
 * from a generated one, so fixture GUIDs are long on purpose.
 */
function looksGenerated(guid: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- base91 is ASCII
  return guid.length > 0 && guid.length <= 10 && [...guid].every((c) => BASE91_CHARS.has(c));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Strings are JSON-quoted so the field separator and newlines stay visible. */
function formatLiteral(value: SqlValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  return `<blob ${value.length} bytes>`;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortJson(value[key]);
    return out;
  }
  return value;
}

/** Replace id-valued protobuf fields with their symbols, by field name. */
function remapIdRefs(
  value: JsonValue,
  refs: Record<string, IdNamespace>,
  symbols: Symbols,
): JsonValue {
  if (Array.isArray(value)) return value.map((item) => remapIdRefs(item, refs, symbols));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const ns = refs[key];
    // int64 fields arrive as JSON strings.
    out[key] = ns ? symbols.renderId(ns, Number(item)) : remapIdRefs(item, refs, symbols);
  }
  return out;
}

function renderProto(
  spec: Extract<ColumnSpec, { kind: "proto" }>,
  raw: SqlValue,
  symbols: Symbols,
): string {
  if (!(raw instanceof Uint8Array)) return `<expected blob, got ${formatLiteral(raw)}>`;
  const decoded = toJson(spec.schema, fromBinary(spec.schema, raw));
  const mapped = sortJson(remapIdRefs(decoded, spec.idRefs ?? {}, symbols));
  return JSON.stringify(mapped, null, 2).split("\n").join("\n    ");
}

function renderCell(spec: ColumnSpec | undefined, raw: SqlValue, symbols: Symbols): string {
  if (!spec) return formatLiteral(raw);
  switch (spec.kind) {
    case "id":
      return symbols.renderId(spec.ns, raw);
    case "time":
      return symbols.renderTime(raw);
    case "guid":
      return symbols.renderGuid(raw);
    case "proto":
      return renderProto(spec, raw, symbols);
  }
}

const HEADER = [
  "# Golden section dump of an apkg's collection.anki21b.",
  "#",
  "# Clock-derived values are symbolised: deck#1 / nt#1 / note#1 / card#1 /",
  "# dconf#1 for generated ids, dconf:1 for meaningful constants, time#1 for",
  "# timestamps, guid#1 for generated GUIDs. Equal raw values share a symbol,",
  "# so relationships are preserved and a dangling reference reads as MISSING.",
  "# Protobuf blobs are decoded to JSON. Everything else is literal.",
].join("\n");

/** Render every table of the collection as reviewable text. */
export function dumpCollection(opened: OpenedPackage): string {
  const symbols = new Symbols();
  const sections: string[] = [HEADER];

  // Declare ids first: references are dumped before the tables that own them.
  for (const table of TABLES) {
    const declaring = Object.entries(table.columns).filter(
      ([, spec]) => spec.kind === "id" && spec.declares,
    );
    if (declaring.length === 0) continue;
    const rows = query(opened.db, `SELECT * FROM ${table.name} ORDER BY ${table.orderBy}`);
    for (const row of rows.values) {
      for (const [name, spec] of declaring) {
        if (spec.kind !== "id") continue;
        symbols.declareId(spec.ns, row[rows.columns.indexOf(name)]);
      }
    }
  }

  sections.push(dumpObjects(opened));

  for (const table of TABLES) {
    const rows = query(opened.db, `SELECT * FROM ${table.name} ORDER BY ${table.orderBy}`);
    const lines = [`== ${table.name} (${plural(rows.values.length, "row")}) ==`];
    rows.values.forEach((row, index) => {
      lines.push(`  row ${index}`);
      rows.columns.forEach((name, col) => {
        lines.push(`    ${name}: ${renderCell(table.columns[name], row[col], symbols)}`);
      });
    });
    sections.push(lines.join("\n"));
  }

  sections.push(dumpMedia(opened));
  return `${sections.join("\n\n")}\n`;
}

/** Table and index names only; full DDL lives in the schema golden. */
function dumpObjects(opened: OpenedPackage): string {
  const rows = query(opened.db, "SELECT type, name FROM sqlite_master ORDER BY type, name");
  const lines = [`== sqlite objects (${rows.values.length}) ==`];
  for (const [type, name] of rows.values) {
    lines.push(`  ${String(type)} ${String(name)}`);
  }
  return lines.join("\n");
}

function dumpMedia(opened: OpenedPackage): string {
  const keys = Object.keys(opened.mediaIndex).sort();
  const lines = [`== media (${plural(keys.length, "file")}) ==`];
  for (const key of keys) {
    // Each entry is a zstd frame, so report the file's own size rather than
    // the stored one, which would move with any framing change.
    const bytes = opened.entries[key];
    const size = bytes ? `${decompress(bytes).length} bytes` : "ENTRY MISSING FROM ARCHIVE";
    lines.push(`  ${key} -> ${JSON.stringify(opened.mediaIndex[key])} (${size})`);
  }
  // The three fixed entries of Anki's latest layout, plus one per media file.
  const STRUCTURAL = new Set(["meta", "collection.anki21b", "media"]);
  const extras = Object.keys(opened.entries)
    .filter((name) => !STRUCTURAL.has(name) && !(name in opened.mediaIndex))
    .sort();
  for (const name of extras) {
    lines.push(`  UNINDEXED ARCHIVE ENTRY: ${JSON.stringify(name)}`);
  }
  return lines.join("\n");
}

export function dumpSchema(opened: OpenedPackage): string {
  const rows = query(opened.db, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
  const lines = ["# Complete DDL of the generated collection.anki21b."];
  for (const [type, name, sql] of rows.values) {
    lines.push(
      "",
      `== ${String(type)} ${String(name)} ==`,
      sql === null ? "  (implicit)" : String(sql),
    );
  }
  return `${lines.join("\n")}\n`;
}
