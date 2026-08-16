import type { Notetype } from "./notetype.js";
import { rejectLoneSurrogates, rejectNul } from "./util/text.js";
import { assertTag } from "./util/tags.js";
import { fail } from "./error.js";

export interface NoteOptions {
  /** The note type that defines this note's fields and card templates. */
  notetype: Notetype;
  /** Field values in the same order as the note type's field definitions. */
  fields: string[];
  /** Tags to attach to this note (e.g. `["vocab", "chapter1"]`). */
  tags?: string[];
  /** Custom GUID. Auto-generated if omitted. */
  guid?: string;
}

/**
 * A single note, which generates one card per template its note type renders.
 *
 * @example
 * ```ts
 * const note = new Note({
 *   notetype: Notetype.basic(),
 *   fields: ["What is 2+2?", "4"],
 *   tags: ["math"],
 * });
 * ```
 *
 * @throws If the number of fields does not match the note type's field count.
 */
export class Note {
  readonly notetype: Notetype;
  readonly fields: string[];
  readonly tags: string[];
  readonly guid?: string;

  constructor(options: NoteOptions) {
    if (options.fields.length !== options.notetype.fields.length) {
      fail(
        "invalid-input",
        `Note has ${options.fields.length} fields but note type ` +
          `"${options.notetype.name}" expects ${options.notetype.fields.length}`,
      );
    }
    for (const tag of options.tags ?? []) assertTag(tag);
    options.fields.forEach((value, index) => {
      const name = options.notetype.fields[index]?.name;
      rejectLoneSurrogates(value, `Field ${JSON.stringify(name ?? String(index + 1))}`);
    });
    if (options.guid !== undefined) {
      rejectNul(options.guid, "Note guid");
      rejectLoneSurrogates(options.guid, "Note guid");
    }

    this.notetype = options.notetype;
    this.fields = [...options.fields];
    this.tags = [...(options.tags ?? [])];
    this.guid = options.guid;
  }
}
