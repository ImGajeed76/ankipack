import type { Options as ToMarkdownExtension } from "mdast-util-to-markdown";
import type { Admonition } from "./admonition-mdast.ts";

// Register the construct name so state.enter("admonition") is type-safe.
declare module "mdast-util-to-markdown" {
  interface ConstructNameMap {
    admonition: "admonition";
  }
}

// mdast-util-to-markdown extension: serializes an admonition node back to docomd
// source (`!!! type "title" { attrs }` + a 4-space-indented body). Mirrors the
// blockquote serializer (the canonical indented container), substituting four
// spaces for the `> ` prefix. Lives in the design-agnostic package so both the
// Prettier formatter and any round-trip use share it.
export function admonitionToMarkdown(): ToMarkdownExtension {
  return {
    handlers: {
      admonition(node: Admonition, _parent, state, info): string {
        const marker = node.collapsible ? (node.open ? "???+" : "???") : "!!!";
        let header = marker;
        if (node.atype.length > 0) header += " " + node.atype;
        if (node.title.length > 0) header += ' "' + node.title + '"';
        if (node.attrs.length > 0) header += " { " + node.attrs + " }";

        const value = state.containerFlow(node, info);
        const body = state.indentLines(value, (line, _index, blank) =>
          blank ? "" : "    " + line,
        );
        return header + "\n" + body;
      },
    },
  };
}
