import type { Root } from "mdast";
import type { Plugin } from "unified";
import { admonitionSyntax } from "./admonition-syntax.ts";
import { admonitionFromMarkdown, type Admonition } from "./admonition-mdast.ts";
import { tabSyntax } from "./tab-syntax.ts";
import { tabFromMarkdown, type DocoTab, type DocoTabbedSet } from "./tab-mdast.ts";

// docomd: docolin's MkDocs-inspired markdown syntax. This design-agnostic remark
// plugin only parses the syntax into mdast nodes; rendering (HTML classes, icons)
// is the consumer's job via a remark-rehype handler. Kept free of any
// docolin-specific dependency so it can be lifted into a standalone
// `remark-docomd` package and shared with the `prettier-plugin-docomd` formatter.
// Covers admonitions (callouts + collapsibles + steps/cards/accordion) and content
// tabs. Two transforms run alongside this in the render pipeline: remarkAttrList
// (buttons) and remarkTabGroup (grouping consecutive tabs into sets).

export type { Admonition, DocoTab, DocoTabbedSet };
export type { DocoAttrs } from "./parse.ts";
export {
  parseAdmonitionMeta,
  admonitionTitle,
  parseTabLabel,
  parseAttrs,
  dedentBody,
} from "./parse.ts";
export { admonitionSyntax } from "./admonition-syntax.ts";
export { admonitionFromMarkdown } from "./admonition-mdast.ts";
export { admonitionToMarkdown } from "./admonition-to-markdown.ts";
export { tabSyntax } from "./tab-syntax.ts";
export { tabFromMarkdown } from "./tab-mdast.ts";
export { tabToMarkdown } from "./tab-to-markdown.ts";
export { remarkTabGroup } from "./tab-group.ts";
export { remarkAttrList, remarkBlockAttrList } from "./attr-list.ts";
export { remarkChart } from "./chart.ts";
export type { ChartSpec, ChartType, DocoChart } from "./chart.ts";
export { remarkTree } from "./tree.ts";
export type { DocoTree } from "./tree.ts";

/** Adds docomd admonition + content-tab syntax to a unified/remark processor. */
export const remarkDocomd: Plugin<[], Root> = function (): undefined {
  const data = this.data();
  const micromarkExtensions = data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  micromarkExtensions.push(admonitionSyntax, tabSyntax);
  fromMarkdownExtensions.push(admonitionFromMarkdown(), tabFromMarkdown());
};
