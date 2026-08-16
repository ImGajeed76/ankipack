import { DeckConfig } from "./deck-config.js";
import type { Note } from "./note.js";
import { IdGenerator } from "./util/id.js";
import { rejectLoneSurrogates, toNormalizedDeckName } from "./util/text.js";
import { fail } from "./error.js";

const idGen = new IdGenerator();

export interface DeckOptions {
  /** Custom deck ID. Auto-generated if omitted. */
  id?: number;
  /** Deck name as shown in Anki. Use `::` for subdecks (e.g. `"French::Vocab"`). */
  name: string;
  /** Description shown in Anki's deck list. Supports HTML. */
  description?: string;
  /**
   * Scheduler preset for this deck.
   *
   *   - `DeckConfig` instance: ship that preset; the deck references it.
   *   - `undefined` (omitted): ship a unique auto-generated preset named
   *     `"<deck name> Config"` with library defaults.
   *   - `null`: ship no preset of your own. The deck's `config_id` is `1`, the
   *     user's existing built-in "Default". The package still carries a
   *     placeholder row at that id, which Anki's gather pass needs and its
   *     `INSERT OR IGNORE` then drops, so their preset list is unchanged.
   */
  config?: DeckConfig | null;
}

/**
 * What `getEffectiveConfig` returns for a deck created with `config: null`. The
 * deck points at preset 1, the user's own Default, and the package carries a
 * placeholder row there that Anki's import drops.
 */
export const NO_PRESET = "no-preset" as const;
export type NoPreset = typeof NO_PRESET;

/**
 * An Anki deck containing notes.
 *
 * @example
 * ```ts
 * const deck = new Deck({
 *   name: "French Vocab",
 *   description: "Chapter 1 vocabulary",
 *   config: new DeckConfig({ desiredRetention: 0.9 }),
 * });
 * deck.addNote(new Note({ notetype, fields: ["bonjour", "hello"] }));
 * ```
 */
export class Deck {
  readonly id: number;
  readonly name: string;
  readonly description?: string;
  readonly config?: DeckConfig | null;
  readonly notes: Note[] = [];
  private _effectiveConfig?: DeckConfig;

  constructor(options: DeckOptions) {
    if (options.id !== undefined && !Number.isSafeInteger(options.id)) {
      fail("invalid-input", `Deck id must be a safe integer, got ${options.id}`);
    }
    this.id = options.id ?? idGen.next();
    rejectLoneSurrogates(options.name, `Deck name ${JSON.stringify(options.name)}`);
    this.name = options.name;
    this.description = options.description;
    this.config = options.config;
  }

  /** Add a note. It generates one card per template its note type renders. */
  addNote(note: Note): void {
    this.notes.push(note);
  }

  /**
   * Returns the deck's config, the {@link NO_PRESET} sentinel when the deck
   * was created with `config: null`, or a unique auto-generated config when
   * `config` was omitted.
   */
  getEffectiveConfig(): DeckConfig | NoPreset {
    if (this.config === null) return NO_PRESET;
    if (this.config) return this.config;
    if (!this._effectiveConfig) {
      // Named after the deck as Anki will display it, not as it was passed in:
      // the raw name can hold characters the deck name itself drops.
      this._effectiveConfig = new DeckConfig({
        name: `${toNormalizedDeckName(this.name)} Config`,
      });
    }
    return this._effectiveConfig;
  }
}
