import type { List, Root, RootContent } from "mdast";
import type { Node } from "unist";
import { toString as mdastToString } from "mdast-util-to-string";
import { SKIP, visit } from "unist-util-visit";
import { parseAttrs } from "./parse.ts";

// A nested unordered list flagged as a file tree by a trailing `{ .tree }`
// attribute list (the same block form as `{ .chart }`):
//
//   - src
//     - lib
//       - utils.ts # shared helpers
//     - main.ts
//   - assets/
//   - package.json
//   { .tree }
//
// The list stays the semantic backbone: the renderer keeps a real <ul>/<li>
// structure (screen readers, SEO, and AI ground against a plain nested list),
// styled as a file tree with folder/file icons and guide lines. Server-rendered
// only, no client JS. An item is a folder when it carries a nested sublist, or
// when its name ends with `/` (an empty folder); everything else is a file.
// ` # ` starts a muted per-entry comment, shell style. This module only promotes
// the list; src/lib/markdown/render/tree.ts renders it.

/** Custom mdast node: an unordered list promoted to a file tree. It keeps the
 *  original list as its only child so the render handler walks real list
 *  structure (and the source list survives canonicalization untouched). */
export interface DocoTree extends Node {
  type: "docoTree";
  /** Marker classes beyond `tree` itself, forwarded onto the rendered figure.
   *  This is what lets `{ .tree .annotate }` compose with the annotation pass
   *  (rehypeAnnotations picks any `.annotate` block up generically). */
  extraClasses: string[];
  children: [List];
}

/** remark: promote an unordered list immediately followed by a `{ .tree }`
 *  attribute list into a tree node. The list is preserved as the tree's
 *  structure; the marker paragraph is consumed. An ordered list is left alone
 *  (a numbered file tree is a contradiction, and the marker then renders
 *  visibly as the author's cue that something is off). */
export function remarkTree() {
  return (tree: Root): undefined => {
    visit(tree, "list", (node, index, parent) => {
      if (parent === undefined || index === undefined) return;
      if (node.ordered === true) return;
      const next = parent.children.at(index + 1);
      if (next?.type !== "paragraph") return;
      const parsed = parseAttrs(mdastToString(next).trim());
      if (!parsed?.classes.includes("tree")) return;

      const treeNode: DocoTree = {
        type: "docoTree",
        extraClasses: parsed.classes.filter((name) => name !== "tree"),
        children: [node],
      };
      // Replace the list + marker paragraph with the tree node, then skip past
      // it so the wrapped list (and its sublists) are not revisited.
      parent.children.splice(index, 2, treeNode as unknown as RootContent);
      return [SKIP, index + 1];
    });
  };
}
