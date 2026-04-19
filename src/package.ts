import type { SqlJsStatic } from "sql.js";
import { zipSync, strToU8 } from "fflate";
import type { Deck } from "./deck";
import { buildDatabase } from "./db";

/**
 * A collection of decks and media files that can be exported as an `.apkg` file.
 *
 * @example
 * ```ts
 * const pkg = new Package();
 * pkg.addDeck(deck);
 * pkg.addMedia("audio.mp3", audioBytes);
 *
 * // In Node/Bun:
 * await pkg.writeToFile("output.apkg", SQL);
 *
 * // In browser:
 * const bytes = await pkg.toUint8Array(SQL);
 * ```
 */
export class Package {
  private decks: Deck[] = [];
  private media: Map<string, Uint8Array> = new Map();

  /** Add a deck to this package. Multiple decks are supported. */
  addDeck(deck: Deck): void {
    this.decks.push(deck);
  }

  /**
   * Attach a media file (image, audio, etc.) to the package.
   * Reference it in card templates via its filename (e.g. `<img src="photo.jpg">`).
   */
  addMedia(filename: string, data: Uint8Array): void {
    this.media.set(filename, data);
  }

  /**
   * Build the `.apkg` as an in-memory ZIP archive.
   * Use this in browser environments where file system access is unavailable.
   *
   * @param SQL - An initialized sql.js instance (from `initSqlJs()`)
   * @returns The `.apkg` file contents as a `Uint8Array`
   */
  async toUint8Array(SQL: SqlJsStatic): Promise<Uint8Array> {
    if (this.decks.length === 0) {
      throw new Error("Package must contain at least one deck");
    }

    // Build the SQLite database
    const dbBytes = await buildDatabase(SQL, this.decks);

    // Build media index and files
    const mediaIndex: Record<string, string> = {};
    const zipEntries: Record<string, Uint8Array> = {};

    // Add the collection database
    zipEntries["collection.anki2"] = dbBytes;

    // Add media files
    let mediaIdx = 0;
    for (const [filename, data] of this.media) {
      const idxStr = String(mediaIdx);
      mediaIndex[idxStr] = filename;
      zipEntries[idxStr] = data;
      mediaIdx++;
    }

    // Add media index JSON
    zipEntries["media"] = strToU8(JSON.stringify(mediaIndex));

    // Create ZIP (store, no compression — the SQLite DB doesn't compress well
    // and Anki doesn't require compression)
    return zipSync(zipEntries, { level: 0 });
  }

  /**
   * Build the `.apkg` and write it to a file.
   * Only available in Node.js and Bun (not in browsers).
   *
   * @param path - Output file path
   * @param SQL - An initialized sql.js instance (from `initSqlJs()`)
   */
  async writeToFile(path: string, SQL: SqlJsStatic): Promise<void> {
    const data = await this.toUint8Array(SQL);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, data);
  }
}
