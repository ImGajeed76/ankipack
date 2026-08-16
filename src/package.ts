import type { SqlJsStatic } from "sql.js";
import type { Deck } from "./deck.js";
import { buildCollection } from "./collection/build.js";
import { writePackage } from "./collection/write.js";
import type { CollectionData } from "./collection/data.js";
import { assertMediaFilename } from "./util/media-name.js";
import { fail } from "./error.js";

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
    assertMediaFilename(filename);
    if (this.media.has(filename)) {
      fail("invalid-input", `Media filename ${JSON.stringify(filename)} was already added`);
    }
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
      fail("invalid-input", "Package must contain at least one deck");
    }
    return writePackage(await this.toCollection(), SQL);
  }

  /**
   * The document this package describes, before serialisation. Building and
   * reading produce the same shape, so both go out through one writer.
   */
  async toCollection(): Promise<CollectionData> {
    const media = [...this.media].map(([name, data]) => ({ name, data }));
    return buildCollection(this.decks, media);
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
