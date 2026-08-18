import type { BlockContent, Data, DefinitionContent } from "mdast";
import {
  fromMarkdown,
  type CompileContext,
  type Extension as FromMarkdownExtension,
  type Token,
} from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";
import { admonitionSyntax } from "./admonition-syntax.ts";
import { admonitionFromMarkdown } from "./admonition-mdast.ts";
import { tabSyntax } from "./tab-syntax.ts";
import { dedentBody, parseTabLabel } from "./parse.ts";

// mdast node for one content tab. The body is re-parsed as standalone markdown, so
// `children` holds normal mdast block nodes (including admonitions and nested
// tabs). A run of consecutive tabs is wrapped in a `docoTabbedSet` by the grouping
// transform (tab-group) before rendering.
export interface DocoTab {
  type: "docoTab";
  /** The tab's label (from the quoted meta). */
  label: string;
  children: (BlockContent | DefinitionContent)[];
  data?: Data;
}

export interface DocoTabbedSet {
  type: "docoTabbedSet";
  children: DocoTab[];
  data?: Data;
}

// Register both nodes so they are valid mdast block (and root) children.
declare module "mdast" {
  interface RootContentMap {
    docoTab: DocoTab;
    docoTabbedSet: DocoTabbedSet;
  }
  interface BlockContentMap {
    docoTab: DocoTab;
    docoTabbedSet: DocoTabbedSet;
  }
}

/** Extension for `mdast-util-from-markdown` that builds tab nodes. */
export function tabFromMarkdown(): FromMarkdownExtension {
  return {
    enter: { docoTab: enterTab },
    exit: {
      docoTab: exitTab,
      docoTabMeta: exitMeta,
    },
  };
}

function enterTab(this: CompileContext, token: Token): void {
  this.enter({ type: "docoTab", label: "", children: [] }, token);
}

function exitMeta(this: CompileContext, token: Token): void {
  const node = this.stack[this.stack.length - 1];
  if (node.type !== "docoTab") return;
  node.label = parseTabLabel(this.sliceSerialize(token));
}

function exitTab(this: CompileContext, token: Token): void {
  const node = this.stack[this.stack.length - 1];
  if (node.type === "docoTab") {
    // Re-parse the dedented body as standalone markdown. GFM, admonitions, and the
    // tab syntax itself are included so callouts, tables, and nested tabs work
    // inside a tab.
    const body = dedentBody(this.sliceSerialize(token));
    const tree = fromMarkdown(body, {
      extensions: [gfm(), math(), admonitionSyntax, tabSyntax],
      mdastExtensions: [
        gfmFromMarkdown(),
        mathFromMarkdown(),
        admonitionFromMarkdown(),
        tabFromMarkdown(),
      ],
    });
    node.children = tree.children as (BlockContent | DefinitionContent)[];
  }
  this.exit(token);
}
