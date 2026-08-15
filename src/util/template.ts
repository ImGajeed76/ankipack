// Anki's mustache handling, ported from rslib/src/template.rs at 26.08.1. Both
// card generation and the notetype `reqs` ask the same question of a template,
// and differ only in how they treat negated sections, which is why Anki exposes
// `renders_with_fields` and `renders_with_fields_for_reqs` over one walker.

import { trimRust, trimStartRust } from "./text.js";

type ParsedNode =
  | { kind: "replacement"; key: string }
  | { kind: "section"; key: string; negated: boolean; children: ParsedNode[] };

/** True if these non-empty field names are enough to render the template. */
export function templateRenders(src: string, nonempty: ReadonlySet<string>): boolean {
  return renders(src, nonempty, true);
}

/**
 * The variant `reqs` is computed with. Negated sections resolve to their
 * children even when the key is non-empty, which keeps the requirement cache
 * matching older Anki versions.
 */
export function templateRendersForRequirements(
  src: string,
  nonempty: ReadonlySet<string>,
): boolean {
  return renders(src, nonempty, false);
}

function renders(src: string, nonempty: ReadonlySet<string>, checkNegated: boolean): boolean {
  const parsed = parseTemplate(src);
  return parsed === null ? false : nodesRender(parsed, nonempty, checkNegated);
}

function nodesRender(
  nodes: ParsedNode[],
  nonempty: ReadonlySet<string>,
  checkNegated: boolean,
): boolean {
  for (const node of nodes) {
    if (node.kind === "replacement") {
      if (nonempty.has(node.key)) return true;
      continue;
    }
    const satisfied = node.negated
      ? !checkNegated || !nonempty.has(node.key)
      : nonempty.has(node.key);
    if (satisfied && nodesRender(node.children, nonempty, checkNegated)) return true;
  }
  return false;
}

/**
 * Anki's lexer (`next_token`): at each position it tries a handlebar, then an
 * HTML comment, then falls through to text. A handlebar runs to the first
 * closing delimiter, so a single `}` inside one is allowed. Comments are not
 * affected by the alt-handlebar mode, so their delimiters stay literal.
 *
 * Returns null for the parse errors Anki raises, which generate no card.
 */
function parseTemplate(source: string): ParsedNode[] | null {
  const root: ParsedNode[] = [];
  const stack: Array<{ key: string; negated: boolean; children: ParsedNode[] }> = [];
  const currentList = (): ParsedNode[] =>
    stack.length > 0 ? stack[stack.length - 1].children : root;

  const { src, open, close: closeTag } = altSyntax(source);

  let index = 0;
  while (index < src.length) {
    if (src.startsWith(open, index)) {
      const close = src.indexOf(closeTag, index + 2);
      if (close >= 0) {
        const handle = classifyHandle(src.slice(index + 2, close));
        index = close + 2;

        if (handle.kind === "open") {
          stack.push({ key: handle.key, negated: handle.negated, children: [] });
        } else if (handle.kind === "close") {
          const section = stack.pop();
          if (!section || section.key !== handle.key) return null;
          currentList().push({
            kind: "section",
            key: section.key,
            negated: section.negated,
            children: section.children,
          });
        } else {
          currentList().push({ kind: "replacement", key: handle.key });
        }
        continue;
      }
    }

    if (src.startsWith("<!--", index)) {
      const close = src.indexOf("-->", index + 4);
      if (close >= 0) {
        index = close + 3;
        continue;
      }
    }

    index++;
  }

  return stack.length > 0 ? null : root;
}

const ALT_HANDLEBAR_DIRECTIVE = "{{=<% %>=}}";

/**
 * Anki's legacy alt-handlebar mode (`TemplateMode::LegacyAltSyntax`). A template
 * whose first non-space content is `{{=<% %>=}}` switches to `<% %>` delimiters
 * for its whole body, which turns any remaining `{{...}}` into plain text.
 */
function altSyntax(source: string): { src: string; open: string; close: string } {
  let src = trimStartRust(source);
  if (!src.startsWith(ALT_HANDLEBAR_DIRECTIVE)) {
    return { src: source, open: "{{", close: "}}" };
  }
  while (src.startsWith(ALT_HANDLEBAR_DIRECTIVE)) {
    src = src.slice(ALT_HANDLEBAR_DIRECTIVE.length);
  }
  return { src, open: "<%", close: "%>" };
}

type Handle =
  | { kind: "replacement"; key: string }
  | { kind: "open"; key: string; negated: boolean }
  | { kind: "close"; key: string };

/**
 * Anki's `classify_handle`. Leading braces are stripped before the sigil is
 * read, so `{{{Front}}}` is the field `Front`, and a handle shorter than two
 * characters is a replacement, so `{{/}}` is not a section tag.
 */
function classifyHandle(raw: string): Handle {
  const start = trimRust(raw.replace(/^\{+/, ""));
  if (start.length < 2) return { kind: "replacement", key: start };

  if (start.startsWith("#"))
    return { kind: "open", key: trimStartRust(start.slice(1)), negated: false };
  if (start.startsWith("/")) return { kind: "close", key: trimStartRust(start.slice(1)) };
  if (start.startsWith("^"))
    return { kind: "open", key: trimStartRust(start.slice(1)), negated: true };

  // Filters are stripped by taking the last colon segment, with no further
  // trimming, so `{{text: Front}}` looks for a field named " Front".
  const colon = start.lastIndexOf(":");
  return { kind: "replacement", key: colon >= 0 ? start.slice(colon + 1) : start };
}
