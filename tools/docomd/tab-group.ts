import type { Root, RootContent } from "mdast";
import type { DocoTab, DocoTabbedSet } from "./tab-mdast.ts";

// Wraps each run of consecutive `docoTab` siblings in a `docoTabbedSet`, so the
// renderer sees one tabbed container per run (matching MkDocs, where adjacent
// `=== "..."` blocks form one set). Recurses through the tree first, so tabs
// nested inside admonitions or other tabs group too.
function groupRun(children: RootContent[]): RootContent[] {
  const out: RootContent[] = [];
  let run: DocoTab[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    out.push({ type: "docoTabbedSet", children: run } satisfies DocoTabbedSet);
    run = [];
  };
  for (const child of children) {
    if ("children" in child) {
      child.children = groupRun(child.children) as typeof child.children;
    }
    if (child.type === "docoTab") {
      run.push(child);
    } else {
      flush();
      out.push(child);
    }
  }
  flush();
  return out;
}

/** remark transform: group consecutive content tabs into tabbed sets. */
export function remarkTabGroup() {
  return (tree: Root): undefined => {
    tree.children = groupRun(tree.children);
  };
}
