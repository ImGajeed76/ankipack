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
import { tabSyntax } from "./tab-syntax.ts";
import { tabFromMarkdown } from "./tab-mdast.ts";
import { dedentBody, parseAdmonitionMeta } from "./parse.ts";

// mdast node for an admonition. The body is re-parsed as standalone markdown, so
// `children` holds normal mdast block nodes (including nested admonitions).
export interface Admonition {
  type: "admonition";
  /** Whether this renders as a collapsible `<details>` (`???` / `???+`). */
  collapsible: boolean;
  /** Whether a collapsible admonition starts open (`???+`). */
  open: boolean;
  /** The type word ("warning", "steps", ...); "" if omitted. */
  atype: string;
  /** The explicit quoted title, or "" if none was given. */
  title: string;
  /** Raw attr-list contents (between `{` and `}`), or "" if absent. */
  attrs: string;
  children: (BlockContent | DefinitionContent)[];
  data?: Data;
}

// Register the node so it is a valid mdast block (and root) child for consumers.
declare module "mdast" {
  interface RootContentMap {
    admonition: Admonition;
  }
  interface BlockContentMap {
    admonition: Admonition;
  }
}

/** Extension for `mdast-util-from-markdown` that builds admonition nodes. */
export function admonitionFromMarkdown(): FromMarkdownExtension {
  return {
    enter: { admonition: enterAdmonition },
    exit: {
      admonition: exitAdmonition,
      admonitionMarker: exitMarker,
      admonitionMeta: exitMeta,
    },
  };
}

function enterAdmonition(this: CompileContext, token: Token): void {
  this.enter(
    {
      type: "admonition",
      collapsible: false,
      open: false,
      atype: "",
      title: "",
      attrs: "",
      children: [],
    },
    token,
  );
}

function exitMarker(this: CompileContext, token: Token): void {
  const node = this.stack[this.stack.length - 1];
  if (node.type !== "admonition") return;
  const marker = this.sliceSerialize(token);
  node.collapsible = marker.startsWith("?");
  node.open = marker === "???+";
}

function exitMeta(this: CompileContext, token: Token): void {
  const node = this.stack[this.stack.length - 1];
  if (node.type !== "admonition") return;
  const meta = parseAdmonitionMeta(this.sliceSerialize(token));
  node.atype = meta.atype;
  node.title = meta.title;
  node.attrs = meta.attrs;
}

function exitAdmonition(this: CompileContext, token: Token): void {
  const node = this.stack[this.stack.length - 1];
  if (node.type === "admonition") {
    // Re-parse the dedented body as standalone markdown. GFM, the admonition
    // syntax, and the tab syntax are included so tables, task lists, nested
    // admonitions, and content tabs all work inside a callout/card. The
    // tab <-> admonition import cycle is safe: both extensions are hoisted
    // function declarations only called here at runtime. (When extracted to a
    // package, the reparse extension set becomes injectable; the set is hardcoded
    // here for the app's needs.)
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
