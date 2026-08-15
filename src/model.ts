import { create } from "@bufbuild/protobuf";
import {
  Notetype_ConfigSchema,
  type Notetype_Config,
  Notetype_Config_Kind,
  Notetype_Config_CardRequirementSchema,
  Notetype_Config_CardRequirement_Kind,
  Notetype_Field_ConfigSchema,
  type Notetype_Field_Config,
  Notetype_Template_ConfigSchema,
  type Notetype_Template_Config,
  StockNotetype_OriginalStockKind,
} from "./generated/anki/notetypes_pb.js";
import { IdGenerator, stableId } from "./util/id.js";
import { rejectNul } from "./util/text.js";
import { templateRendersForRequirements } from "./util/template.js";
import {
  DEFAULT_CSS,
  DEFAULT_CLOZE_CSS,
  DEFAULT_LATEX_PRE,
  DEFAULT_LATEX_POST,
} from "./util/constants.js";

const idGen = new IdGenerator();

// Anki's stock notetypes record which preset they came from, and its stock
// Cloze tags its two fields. Kept off ModelOptions because they describe Anki's
// own presets rather than anything a caller composes.
const STOCK_KIND = new WeakMap<Model, StockNotetype_OriginalStockKind>();

function asStock(model: Model, kind: StockNotetype_OriginalStockKind): Model {
  STOCK_KIND.set(model, kind);
  return model;
}

export interface FieldDef {
  /** Field name (must be unique within the model). */
  name: string;
  /** Keep the field value when adding new notes. @default false */
  sticky?: boolean;
  /** Right-to-left text direction. @default false */
  rtl?: boolean;
  /** Font used in the editor. @default "Arial" */
  fontName?: string;
  /** Font size in the editor. @default 20 */
  fontSize?: number;
  /** Placeholder text shown when the field is empty. @default "" */
  description?: string;
  /** Treat as plain text (no HTML). @default false */
  plainText?: boolean;
}

export interface TemplateDef {
  /** Template name (e.g. "Card 1"). */
  name: string;
  /** HTML template for the question side. Use `{{FieldName}}` for substitutions. */
  questionFormat: string;
  /** HTML template for the answer side. Use `{{FrontSide}}` to include the question. */
  answerFormat: string;
  /** Alternative question template for the browser view. @default "" */
  questionFormatBrowser?: string;
  /** Alternative answer template for the browser view. @default "" */
  answerFormatBrowser?: string;
  /** Font used in the browser column. @default "" */
  browserFontName?: string;
  /** Font size in the browser column. @default 0 */
  browserFontSize?: number;
}

export interface ModelOptions {
  /** Custom model ID. Auto-generated if omitted. */
  id?: number;
  /** Note type name as shown in Anki. */
  name: string;
  /** `"normal"` for standard cards, `"cloze"` for cloze deletions. @default "normal" */
  type?: "normal" | "cloze";
  /** CSS applied to all cards of this note type. */
  css?: string;
  /** Index of the field used for sorting in the browser. @default 0 */
  sortFieldIndex?: number;
  /** Field definitions. Order matters: fields are referenced by index. */
  fields: FieldDef[];
  /** Card templates. Each template generates one card per note (except cloze). */
  templates: TemplateDef[];
  /** LaTeX preamble. @default standard Anki LaTeX preamble */
  latexPre?: string;
  /** LaTeX postamble. @default "\\end{document}" */
  latexPost?: string;
  /** Render LaTeX as SVG instead of PNG. @default false */
  latexSvg?: boolean;
}

/**
 * A note type (model) defining fields and card templates.
 *
 * Use the static constructors for common note types, or create a custom one:
 *
 * @example
 * ```ts
 * // Built-in presets
 * const basic = Model.basic();
 * const reversed = Model.basicAndReversed();
 * const typing = Model.basicTyping();
 * const cloze = Model.cloze();
 *
 * // Custom model
 * const custom = new Model({
 *   name: "Vocab (FR > DE)",
 *   fields: [{ name: "French" }, { name: "German" }],
 *   templates: [{
 *     name: "Card 1",
 *     questionFormat: "{{French}}",
 *     answerFormat: '{{FrontSide}}<hr id="answer">{{German}}',
 *   }],
 * });
 * ```
 */
export class Model {
  readonly id: number;
  readonly name: string;
  readonly type: "normal" | "cloze";
  readonly css: string;
  readonly sortFieldIndex: number;
  readonly fields: FieldDef[];
  readonly templates: TemplateDef[];
  readonly latexPre: string;
  readonly latexPost: string;
  readonly latexSvg: boolean;

  constructor(options: ModelOptions) {
    validateModelOptions(options);
    this.id = options.id ?? idGen.next();
    this.name = options.name;
    this.type = options.type ?? "normal";
    this.css = options.css ?? DEFAULT_CSS;
    this.sortFieldIndex = options.sortFieldIndex ?? 0;
    this.fields = options.fields;
    this.templates = options.templates;
    this.latexPre = options.latexPre ?? DEFAULT_LATEX_PRE;
    this.latexPost = options.latexPost ?? DEFAULT_LATEX_POST;
    this.latexSvg = options.latexSvg ?? false;
  }

  /** Front/Back card type. One card per note. */
  static basic(options?: { name?: string; css?: string }): Model {
    return asStock(
      new Model({
        name: options?.name ?? "Basic",
        css: options?.css,
        fields: [{ name: "Front" }, { name: "Back" }],
        templates: [
          {
            name: "Card 1",
            questionFormat: "{{Front}}",
            answerFormat: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
          },
        ],
      }),
      StockNotetype_OriginalStockKind.BASIC,
    );
  }

  /** Front/Back with an additional reversed card. Two cards per note. */
  static basicAndReversed(options?: { name?: string; css?: string }): Model {
    return asStock(
      new Model({
        name: options?.name ?? "Basic (and reversed card)",
        css: options?.css,
        fields: [{ name: "Front" }, { name: "Back" }],
        templates: [
          {
            name: "Card 1",
            questionFormat: "{{Front}}",
            answerFormat: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
          },
          {
            name: "Card 2",
            questionFormat: "{{Back}}",
            answerFormat: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}",
          },
        ],
      }),
      StockNotetype_OriginalStockKind.BASIC_AND_REVERSED,
    );
  }

  /** Front/Back where the answer must be typed. Uses Anki's `{{type:Field}}` syntax. */
  static basicTyping(options?: { name?: string; css?: string }): Model {
    return asStock(
      new Model({
        name: options?.name ?? "Basic (type in the answer)",
        css: options?.css,
        fields: [{ name: "Front" }, { name: "Back" }],
        templates: [
          {
            name: "Card 1",
            questionFormat: "{{Front}}\n\n{{type:Back}}",
            answerFormat: "{{Front}}\n\n<hr id=answer>\n\n{{type:Back}}",
          },
        ],
      }),
      StockNotetype_OriginalStockKind.BASIC_TYPING,
    );
  }

  /** Cloze deletion card type. Use `{{c1::text}}` syntax in the Text field. */
  static cloze(options?: { name?: string; css?: string }): Model {
    return asStock(
      new Model({
        name: options?.name ?? "Cloze",
        type: "cloze",
        css: options?.css ?? DEFAULT_CSS + DEFAULT_CLOZE_CSS,
        fields: [{ name: "Text" }, { name: "Back Extra" }],
        templates: [
          {
            name: "Cloze",
            questionFormat: "{{cloze:Text}}",
            answerFormat: "{{cloze:Text}}<br>\n{{Back Extra}}",
          },
        ],
      }),
      StockNotetype_OriginalStockKind.CLOZE,
    );
  }

  toNotetypeConfigProtobuf(): Notetype_Config {
    const reqs = this.type === "cloze" ? [] : this.computeRequirements();

    return create(Notetype_ConfigSchema, {
      kind: this.type === "cloze" ? Notetype_Config_Kind.CLOZE : Notetype_Config_Kind.NORMAL,
      // Anki needs this to offer "Restore to Default" on the notetype.
      originalStockKind: STOCK_KIND.get(this) ?? StockNotetype_OriginalStockKind.UNKNOWN,
      sortFieldIdx: this.sortFieldIndex,
      css: this.css,
      latexPre: this.latexPre,
      latexPost: this.latexPost,
      latexSvg: this.latexSvg,
      reqs: reqs.map((req) =>
        create(Notetype_Config_CardRequirementSchema, {
          cardOrd: req.ord,
          kind:
            req.kind === "all"
              ? Notetype_Config_CardRequirement_Kind.ALL
              : req.kind === "none"
                ? Notetype_Config_CardRequirement_Kind.NONE
                : Notetype_Config_CardRequirement_Kind.ANY,
          fieldOrds: req.fieldOrds,
        }),
      ),
    });
  }

  toFieldConfigProtobuf(fieldIndex: number): Notetype_Field_Config {
    const field = this.fields[fieldIndex];
    // Anki's stock Cloze tags Text and Back Extra, and stops Text being
    // deleted in the editor. ClozeField::Text is 0 and BackExtra is 1.
    const stockCloze =
      STOCK_KIND.get(this) === StockNotetype_OriginalStockKind.CLOZE && fieldIndex < 2;
    return create(Notetype_Field_ConfigSchema, {
      sticky: field.sticky ?? false,
      rtl: field.rtl ?? false,
      fontName: field.fontName ?? "Arial",
      fontSize: field.fontSize ?? 20,
      description: field.description ?? "",
      plainText: field.plainText ?? false,
      tag: stockCloze ? fieldIndex : undefined,
      preventDeletion: stockCloze && fieldIndex === 0,
      // See the note on template ids below.
      id: stableId(this.name, "field", field.name, String(fieldIndex)),
    });
  }

  toTemplateConfigProtobuf(templateIndex: number): Notetype_Template_Config {
    const tmpl = this.templates[templateIndex];
    return create(Notetype_Template_ConfigSchema, {
      qFormat: tmpl.questionFormat,
      aFormat: tmpl.answerFormat,
      qFormatBrowser: tmpl.questionFormatBrowser ?? "",
      aFormatBrowser: tmpl.answerFormatBrowser ?? "",
      browserFontName: tmpl.browserFontName ?? "",
      browserFontSize: tmpl.browserFontSize ?? 0,
      // Stable so a rebuilt deck keeps matching the same template on
      // re-import. Absent ids make Anki fall back to matching by name, which
      // lets an id collision overwrite the user's own notetype in place.
      id: stableId(this.name, "template", tmpl.name, String(templateIndex)),
    });
  }

  /**
   * Compute card requirements for standard (non-cloze) models.
   * For each template, determine which fields must be non-empty for a card to be generated.
   */
  private computeRequirements(): CardRequirement[] {
    const names = this.fields.map((field) => field.name);

    return this.templates.map((tmpl, ord) => {
      const renders = (nonempty: Set<string>): boolean =>
        templateRendersForRequirements(tmpl.questionFormat, nonempty);

      // Any: a single field on its own is enough to render the template.
      const anyOrds = names.flatMap((name, index) => (renders(new Set([name])) ? [index] : []));
      if (anyOrds.length > 0) return { ord, kind: "any", fieldOrds: anyOrds };

      // All: start from every field, then drop the ones whose removal still
      // renders. What remains is required.
      const required = new Set(names.map((_, index) => index));
      names.forEach((name, index) => {
        const without = new Set(names);
        without.delete(name);
        if (renders(without)) required.delete(index);
      });
      if (required.size > 0 && renders(new Set(names))) {
        return { ord, kind: "all", fieldOrds: [...required].sort((a, b) => a - b) };
      }

      return { ord, kind: "none", fieldOrds: [] };
    });
  }
}

interface CardRequirement {
  ord: number;
  kind: "all" | "any" | "none";
  fieldOrds: number[];
}

/** Anki either refuses or silently rewrites all of these on import. */
function validateModelOptions(options: ModelOptions): void {
  // Anki strips quotes from a notetype name and then requires it to be
  // non-empty, so a name of only quotes aborts the import and any other name
  // holding one arrives renamed, where it can collide with an existing notetype.
  if (options.name.length === 0) {
    throw new Error("Model name must not be empty");
  }
  if (options.name.includes('"')) {
    throw new Error(
      `Model name ${JSON.stringify(options.name)} must not contain a quote, ` +
        `which Anki strips on import`,
    );
  }
  rejectNul(options.name, `Model name ${JSON.stringify(options.name)}`);
  if (options.fields.length === 0) {
    throw new Error(`Model "${options.name}" must have at least 1 field`);
  }
  if (options.templates.length === 0) {
    throw new Error(`Model "${options.name}" must have at least 1 template`);
  }

  const seen = new Map<string, string>();
  for (const field of options.fields) {
    if (field.name.length === 0) {
      throw new Error(`Model "${options.name}" has a field with an empty name`);
    }
    // Anki strips these on import but does not rewrite the {{Field}} references
    // in the templates we shipped, so the two would stop matching. It trims
    // both ends, hence the trailing-whitespace check too.
    if (/[:{}"]/.test(field.name) || /^[#/^\s]/.test(field.name) || /\s$/.test(field.name)) {
      throw new Error(
        `Field name ${JSON.stringify(field.name)} is rewritten by Anki on import: ` +
          `it must not contain : { } " , start with # / ^ , or have leading or ` +
          `trailing whitespace`,
      );
    }
    rejectNul(field.name, `Field name ${JSON.stringify(field.name)}`);
    // Anki compares field names case-insensitively and renames collisions.
    const folded = field.name.toLowerCase();
    const clash = seen.get(folded);
    if (clash !== undefined) {
      throw new Error(
        `Model "${options.name}" has fields ${JSON.stringify(clash)} and ` +
          `${JSON.stringify(field.name)}, which Anki compares case-insensitively`,
      );
    }
    seen.set(folded, field.name);
  }

  // Anki clamps an out-of-range index into bounds, so shipping one means the
  // sort field silently is not the one that was asked for.
  const sortIndex = options.sortFieldIndex;
  if (sortIndex !== undefined) {
    if (!Number.isInteger(sortIndex) || sortIndex < 0 || sortIndex >= options.fields.length) {
      throw new Error(
        `sortFieldIndex must be an integer between 0 and ${options.fields.length - 1}, ` +
          `got ${sortIndex}`,
      );
    }
  }

  if (options.id !== undefined && !Number.isSafeInteger(options.id)) {
    throw new Error(`Model id must be a safe integer, got ${options.id}`);
  }

  const seenTemplates = new Map<string, string>();
  for (const tmpl of options.templates) {
    // Anki strips quotes from a template name and then requires it non-empty.
    if (tmpl.name.length === 0) {
      throw new Error(`Model "${options.name}" has a template with an empty name`);
    }
    if (tmpl.name.includes('"')) {
      throw new Error(
        `Template name ${JSON.stringify(tmpl.name)} must not contain a quote, ` +
          `which Anki strips on import`,
      );
    }
    rejectNul(tmpl.name, `Template name ${JSON.stringify(tmpl.name)}`);
    // Anki renames a colliding template rather than failing, but ankipack's own
    // unique index would abort with a raw SQLite error first.
    const folded = tmpl.name.toLowerCase();
    const clash = seenTemplates.get(folded);
    if (clash !== undefined) {
      throw new Error(
        `Model "${options.name}" has templates ${JSON.stringify(clash)} and ` +
          `${JSON.stringify(tmpl.name)}, which Anki compares case-insensitively`,
      );
    }
    seenTemplates.set(folded, tmpl.name);
  }
}
