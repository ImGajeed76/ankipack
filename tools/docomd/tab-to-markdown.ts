import type { Options as ToMarkdownExtension } from "mdast-util-to-markdown";
import type { DocoTab } from "./tab-mdast.ts";

// Register the construct name so state.enter("docoTab") is type-safe.
declare module "mdast-util-to-markdown" {
  interface ConstructNameMap {
    docoTab: "docoTab";
  }
}

// mdast-util-to-markdown extension: serializes a content tab back to docomd source
// (`=== "label"` + a 4-space-indented body). Mirrors the admonition serializer.
// The Prettier path serializes individual `docoTab` nodes (it does not group them
// into sets), so only the tab handler is needed.
export function tabToMarkdown(): ToMarkdownExtension {
  return {
    handlers: {
      docoTab(node: DocoTab, _parent, state, info): string {
        const header = `=== "${node.label}"`;
        const value = state.containerFlow(node, info);
        const body = state.indentLines(value, (line, _index, blank) =>
          blank ? "" : "    " + line,
        );
        return header + "\n" + body;
      },
    },
  };
}
