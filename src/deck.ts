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
  /** Scheduler preset for this deck. A unique config is auto-generated if omitted. */
  config?: DeckConfig;
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
export class Deck {
  readonly id: number;
  readonly name: string;
  readonly description?: string;
  readonly config?: DeckConfig;
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
   * Returns the deck's config, or creates a unique auto-generated one.
   * Never returns a config with id=1 to avoid overwriting the user's
   * existing default preset on import.
   */
  getEffectiveConfig(): DeckConfig {
    if (this.config) return this.config;
    if (!this._effectiveConfig) {
      this._effectiveConfig = new DeckConfig({
        name: `${this.name} Config`,
      });
    }
    return this._effectiveConfig;
  }
}
