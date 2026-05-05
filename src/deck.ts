import { DeckConfig } from "./deck-config.js";
import type { Note } from "./note.js";
import { IdGenerator } from "./util/id.js";

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
   *   - `null`: ship NO preset. The deck's `config_id` is set to `1` so Anki
   *     resolves it to the user's existing built-in "Default" preset on
   *     import. The apkg contains no deck_config row, so nothing new appears
   *     in the user's preset list.
   */
  config?: DeckConfig | null;
}

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
 * deck.addNote(new Note({ model, fields: ["bonjour", "hello"] }));
 * ```
 */
/** Sentinel returned by `getEffectiveConfig` when the deck was created with
 *  `config: null`. The package writer reads this to skip the deck_config
 *  row entirely and reference Anki's built-in default preset (id=1). */
export const NO_PRESET = "no-preset" as const;
export type NoPreset = typeof NO_PRESET;

export class Deck {
  readonly id: number;
  readonly name: string;
  readonly description?: string;
  readonly config?: DeckConfig | null;
  readonly notes: Note[] = [];
  private _effectiveConfig?: DeckConfig;

  constructor(options: DeckOptions) {
    this.id = options.id ?? idGen.next();
    this.name = options.name;
    this.description = options.description;
    this.config = options.config;
  }

  /** Add a note to this deck. Each note generates one or more cards based on its model. */
  addNote(note: Note): void {
    this.notes.push(note);
  }

  /**
   * Returns the deck's config, the {@link NO_PRESET} sentinel when the deck
   * was created with `config: null`, or a unique auto-generated config when
   * `config` was omitted. Never returns a config with id=1: shipping that
   * would overwrite the user's existing default preset on import.
   */
  getEffectiveConfig(): DeckConfig | NoPreset {
    if (this.config === null) return NO_PRESET;
    if (this.config) return this.config;
    if (!this._effectiveConfig) {
      this._effectiveConfig = new DeckConfig({
        name: `${this.name} Config`,
      });
    }
    return this._effectiveConfig;
  }
}
