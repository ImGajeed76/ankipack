import { factorySpace } from "micromark-factory-space";
import { markdownLineEnding } from "micromark-util-character";
import { codes, types } from "micromark-util-symbol";
import type {
  Code,
  Construct,
  Effects,
  Extension,
  State,
  TokenizeContext,
} from "micromark-util-types";

// micromark syntax extension for MkDocs-style content tabs:
//
//   === "Tab label"
//       indented body
//
// A run of consecutive tabs forms one tabbed set (grouped in the mdast step). Like
// the admonition construct this is indentation-significant, so we tokenize it
// ourselves mirroring micromark's `codeIndented`: body lines are gathered until a
// line is less indented than the body column, and the construct ends *at* that
// line's preceding line ending (it does not consume it), which lets consecutive
// tabs parse as siblings. The body is re-parsed standalone in the mdast step (see
// tab-mdast). A label is required, which keeps `=== "x"` distinct from a setext
// heading underline (`===` alone). CLAUDE 3.8 sanctions parsing here; pinned tests
// live in tab.test.ts.

declare module "micromark-util-types" {
  interface TokenTypeMap {
    docoTab: "docoTab";
    docoTabMarker: "docoTabMarker";
    docoTabMeta: "docoTabMeta";
    docoTabChunk: "docoTabChunk";
  }
}

const BODY_INDENT = 4;
const MARKER_SIZE = 3;

function tokenizeTab(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const self = this;
  let markerSize = 0;

  const furtherStart: Construct = { tokenize: tokenizeFurtherStart, partial: true };

  return start;

  function start(code: Code): State | undefined {
    effects.enter("docoTab");
    effects.enter("docoTabMarker");
    return sequence(code);
  }

  function sequence(code: Code): State | undefined {
    if (code === codes.equalsTo && markerSize < MARKER_SIZE) {
      effects.consume(code);
      markerSize++;
      return sequence;
    }
    // Exactly three `=`, so `====` (or fewer) is not a tab.
    if (markerSize !== MARKER_SIZE || code === codes.equalsTo) return nok(code);
    return afterMarker(code);
  }

  function afterMarker(code: Code): State | undefined {
    effects.exit("docoTabMarker");
    // The marker must be followed by whitespace and a (required) label.
    if (code === codes.space || code === codes.horizontalTab) {
      effects.enter("docoTabMeta");
      return meta(code);
    }
    return nok(code);
  }

  function meta(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit("docoTabMeta");
      return openerEnd(code);
    }
    effects.consume(code);
    return meta;
  }

  function openerEnd(code: Code): State | undefined {
    if (code === codes.eof) {
      effects.exit("docoTab");
      return ok(code);
    }
    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    return firstLine;
  }

  // The first body line directly follows the opener line ending, so its
  // indentation is consumed here rather than via the furtherStart partial.
  function firstLine(code: Code): State | undefined {
    if (code === codes.eof) {
      return after(code);
    }
    if (markdownLineEnding(code)) {
      return atBreak(code);
    }
    return factorySpace(effects, afterFirstPrefix, types.linePrefix, BODY_INDENT + 1)(code);
  }

  function afterFirstPrefix(code: Code): State | undefined {
    return hasBodyIndent() ? atBreak(code) : after(code);
  }

  function atBreak(code: Code): State | undefined {
    if (code === codes.eof) {
      return after(code);
    }
    if (markdownLineEnding(code)) {
      return effects.attempt(furtherStart, atBreak, after)(code);
    }
    effects.enter("docoTabChunk");
    return inside(code);
  }

  function inside(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit("docoTabChunk");
      return atBreak(code);
    }
    effects.consume(code);
    return inside;
  }

  function after(code: Code): State | undefined {
    effects.exit("docoTab");
    return ok(code);
  }

  // Whether the most recently consumed line prefix reaches the body column.
  function hasBodyIndent(): boolean {
    const tail = self.events[self.events.length - 1];
    return (
      tail[1].type === types.linePrefix &&
      tail[2].sliceSerialize(tail[1], true).length >= BODY_INDENT
    );
  }

  function tokenizeFurtherStart(
    furtherEffects: Effects,
    furtherOk: State,
    furtherNok: State,
  ): State {
    return furtherStartState;

    function furtherStartState(code: Code): State | undefined {
      if (self.parser.lazy[self.now().line]) {
        return furtherNok(code);
      }
      if (markdownLineEnding(code)) {
        furtherEffects.enter(types.lineEnding);
        furtherEffects.consume(code);
        furtherEffects.exit(types.lineEnding);
        return furtherStartState;
      }
      return factorySpace(
        furtherEffects,
        furtherAfterPrefix,
        types.linePrefix,
        BODY_INDENT + 1,
      )(code);
    }

    function furtherAfterPrefix(code: Code): State | undefined {
      return hasBodyIndent() ? furtherOk(code) : furtherNok(code);
    }
  }
}

const tab: Construct = {
  name: "docoTab",
  tokenize: tokenizeTab,
};

export const tabSyntax: Extension = {
  flow: {
    [codes.equalsTo]: tab,
  },
};
