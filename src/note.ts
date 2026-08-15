import type { Model } from "./model.js";
import { rejectNul } from "./util/text.js";

/** U+3000, the other character Anki splits the stored tag string on. */
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

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
    // Anki splits the stored tag string on spaces and U+3000, so a tag holding
    // one would silently become several tags in the user's tag tree.
    for (const tag of options.tags ?? []) {
      if (tag.length === 0) throw new Error("Tags must not be empty");
      if (tag.includes(" ") || tag.includes(IDEOGRAPHIC_SPACE)) {
        throw new Error(`Tag ${JSON.stringify(tag)} must not contain a space`);
      }
      // Anki's `invalid_char_for_tag` strips these on import, and a NUL would
      // truncate the stored tag string here first, delimiter included.
      if (CONTROL_CHAR.test(tag)) {
        throw new Error(`Tag ${JSON.stringify(tag)} must not contain a control character`);
      }
    }
    if (options.guid !== undefined) rejectNul(options.guid, "Note guid");

    this.model = options.model;
    this.fields = [...options.fields];
    this.tags = [...(options.tags ?? [])];
    this.guid = options.guid;
  }
}
