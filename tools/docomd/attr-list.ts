import type { Root, RootContent } from "mdast";
import { visit } from "unist-util-visit";
import { parseAttrs, type DocoAttrs } from "./parse.ts";

// MkDocs-style attribute lists for links and images: `[label](url){ .class #id }`
// or `![alt](src){ .class }`. This powers buttons (`{ .md-button }`) and the
// light/dark image variant classes (`{ .light-only }` / `{ .dark-only }`); the
// same `{ ... }` syntax also carries card props (`{ icon=... type=... }`), but
// those are read by the card renderer, so here we only act on a list that has
// classes or an id and leave a props-only list untouched. Parsing (parseAttrs)
// is string-based, no regex.

/** Attaches a trailing `{ .class #id }` attribute list to the preceding link or
 *  image. */
export function remarkAttrList() {
  return (tree: Root): undefined => {
    visit(tree, ["link", "image"], (node, index, parent) => {
      if (parent === undefined || index === undefined) return;
      if (node.type !== "link" && node.type !== "image") return;
      const next = parent.children.at(index + 1);
      if (next?.type !== "text") return;
      const parsed = parseAttrs(next.value);
      // Leave a props-only list (e.g. a card's { icon=... }) for the card renderer.
      if (parsed === null || (parsed.classes.length === 0 && parsed.id === null)) return;

      const data = node.data ?? (node.data = {});
      const props = data.hProperties ?? (data.hProperties = {});
      const existing = Array.isArray(props.className) ? props.className : [];
      props.className = [...existing, ...parsed.classes];
      if (parsed.id !== null) props.id = parsed.id;
      next.value = parsed.rest;
    });
  };
}

function applyBlockAttrs(target: RootContent, parsed: DocoAttrs): void {
  const data = target.data ?? (target.data = {});
  const props = data.hProperties ?? (data.hProperties = {});
  const existing = Array.isArray(props.className) ? props.className : [];
  props.className = [...existing, ...parsed.classes];
  if (parsed.id !== null) props.id = parsed.id;
}

/** MkDocs `attr_list` block form: a `{ .class #id }` on its own line attaches to the
 *  preceding block. It usually rides as the last line of a paragraph (no blank line,
 *  e.g. `text (1)\n{ .annotate }`); a standalone `{ ... }` paragraph attaches to the
 *  previous block instead. Powers `{ .annotate }` (annotations outside code blocks). */
export function remarkBlockAttrList() {
  return (tree: Root): undefined => {
    visit(tree, "paragraph", (node, index, parent) => {
      if (parent === undefined || index === undefined) return;
      const last = node.children.at(-1);
      if (last?.type !== "text") return;
      const newline = last.value.lastIndexOf("\n");
      const lastLine = (newline === -1 ? last.value : last.value.slice(newline + 1)).trim();
      const parsed = parseAttrs(lastLine);
      // Only a line that is purely an attr-list carrying a class or id.
      if (parsed === null || parsed.rest.trim().length > 0) return;
      if (parsed.classes.length === 0 && parsed.id === null) return;

      if (newline !== -1) {
        // The attr-list is the block's last line: drop it and mark this block.
        last.value = last.value.slice(0, newline);
        applyBlockAttrs(node, parsed);
        return;
      }
      // A standalone `{ ... }` paragraph: mark the previous block, drop this one.
      if (node.children.length === 1 && index > 0) {
        applyBlockAttrs(parent.children[index - 1], parsed);
        parent.children.splice(index, 1);
        return index;
      }
    });
  };
}
