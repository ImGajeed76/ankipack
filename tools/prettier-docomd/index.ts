import type { Doc, Parser, Plugin, Printer } from "prettier";
import { parsers as markdownParsers } from "prettier/plugins/markdown";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown, frontmatterToMarkdown } from "mdast-util-frontmatter";
import { math } from "micromark-extension-math";
import { mathFromMarkdown, mathToMarkdown } from "mdast-util-math";
import {
  admonitionSyntax,
  admonitionFromMarkdown,
  admonitionToMarkdown,
  tabSyntax,
  tabFromMarkdown,
  tabToMarkdown,
} from "../docomd/index.ts";

// prettier-plugin-docomd: teaches Prettier to format docomd markdown. Prettier's
// built-in markdown formatter flattens indentation-significant admonitions
// because they are not CommonMark. Rather than reproduce Prettier's private mdast
// dialect (its frontMatter node, etc.), this plugin is self-contained: it parses
// markdown into standard mdast (frontmatter + GFM + docomd admonitions) and
// serializes it back with mdast-util-to-markdown, which round-trips every node,
// including admonitions, with their 4-space body indentation preserved. Built to
// be lifted into a standalone `prettier-plugin-docomd` package; depends only on
// the design-agnostic `remark-docomd` parser (here ../docomd).
//
// It overrides the built-in "markdown" parser so every .md file is formatted
// this way. The only difference for non-admonition files is mdast-util-to-
// markdown's conventions (bare URLs/emails become autolinks, `[` is escaped);
// all non-breaking, and admonitions keep their 4-space body indentation.

const AST_FORMAT = "docomd-mdast";

export const parsers: Record<string, Parser<Nodes>> = {
  markdown: {
    ...markdownParsers.markdown,
    astFormat: AST_FORMAT,
    parse(text: string): Nodes {
      return fromMarkdown(text, {
        extensions: [frontmatter(["yaml"]), gfm(), math(), admonitionSyntax, tabSyntax],
        mdastExtensions: [
          frontmatterFromMarkdown(["yaml"]),
          gfmFromMarkdown(),
          mathFromMarkdown(),
          admonitionFromMarkdown(),
          tabFromMarkdown(),
        ],
      });
    },
  },
};

export const printers: Record<string, Printer<Nodes>> = {
  [AST_FORMAT]: {
    // Serialize the whole tree at the root. mdast-util-to-markdown handles the
    // full document (no per-node delegation needed), and our admonition handler
    // restores the !!!/??? blocks.
    print(path): Doc {
      const node = path.node;
      if (node.type !== "root") return "";
      return toMarkdown(node, {
        extensions: [
          frontmatterToMarkdown(["yaml"]),
          gfmToMarkdown(),
          mathToMarkdown(),
          admonitionToMarkdown(),
          tabToMarkdown(),
        ],
        bullet: "-",
        emphasis: "_",
        rule: "-",
        listItemIndent: "one",
      });
    },
  },
};

const plugin: Plugin<Nodes> = { parsers, printers };
export default plugin;
