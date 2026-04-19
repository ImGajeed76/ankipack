import type { Model } from "./model";

export interface NoteOptions {
  /** The model (note type) that defines this note's fields and card templates. */
  model: Model;
  /** Field values in the same order as the model's field definitions. */
  fields: string[];
  /** Tags to attach to this note (e.g. `["vocab", "chapter1"]`). */
  tags?: string[];
  /** Custom GUID. Auto-generated if omitted. */
  guid?: string;
}

/**
 * A single note that generates one or more cards based on its model's templates.
 *
 * @example
 * ```ts
 * const note = new Note({
 *   model: Model.basic(),
 *   fields: ["What is 2+2?", "4"],
 *   tags: ["math"],
 * });
 * ```
 *
 * @throws If the number of fields does not match the model's field count.
 */
export class Note {
  readonly model: Model;
  readonly fields: string[];
  readonly tags: string[];
  readonly guid?: string;

  constructor(options: NoteOptions) {
    if (options.fields.length !== options.model.fields.length) {
      throw new Error(
        `Note has ${options.fields.length} fields but model "${options.model.name}" expects ${options.model.fields.length}`,
      );
    }
    this.model = options.model;
    this.fields = options.fields;
    this.tags = options.tags ?? [];
    this.guid = options.guid;
  }
}
