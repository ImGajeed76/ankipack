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

// micromark syntax extension for MkDocs-style admonitions:
//
//   !!! type "Optional title"     static callout
//   ??? type "Optional title"     collapsible, starts collapsed
//   ???+ type "Optional title"    collapsible, starts open
//
// with a 4-space-indented body. The format is indentation-significant (not
// CommonMark), so we tokenize it ourselves, mirroring micromark's own
// `codeIndented` construct: body lines are gathered until a line is less
// indented than the body column, and the construct ends *at* that line's
// preceding line ending (it does not consume it), which is what lets consecutive
// and nested admonitions parse correctly. The construct only claims the source
// span; the body is re-parsed as standalone markdown in the mdast step (see
// admonition-mdast). CLAUDE 3.8 sanctions parsing code here; pinned tests live in
// admonition.test.ts.

// Custom token types this construct emits, declared so effects.enter() is typed.
declare module "micromark-util-types" {
  interface TokenTypeMap {
    admonition: "admonition";
    admonitionMarker: "admonitionMarker";
    admonitionMeta: "admonitionMeta";
    admonitionChunk: "admonitionChunk";
  }
}

// Spaces a body is indented under its marker (MkDocs uses four). Because the body
// is re-parsed standalone, nesting re-bases to column 0, so a fixed 4 is correct
// at every depth.
const BODY_INDENT = 4;

function tokenizeAdmonition(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  // micromark state functions are nested callbacks, so the tokenizer context is
  // captured for the partial below and the indentation check (the standard
  // extension pattern; `this` is not bound inside the state functions).
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const self = this;
  let markerChar: Code = null;
  let markerSize = 0;

  // Consumes the line ending(s) and the body indentation before a continuation
  // line; fails (resetting any blank lines it ate) when the next non-blank line
  // is less indented, ending the admonition.
  const furtherStart: Construct = { tokenize: tokenizeFurtherStart, partial: true };

  return start;

  function start(code: Code): State | undefined {
    effects.enter("admonition");
    effects.enter("admonitionMarker");
    markerChar = code;
    return sequence(code);
  }

  function sequence(code: Code): State | undefined {
    if (code === markerChar && markerSize < 3) {
      effects.consume(code);
      markerSize++;
      return sequence;
    }
    if (markerSize < 3) return nok(code);
    // `???+` opens collapsed-but-expanded; the trailing `+` joins the marker.
    if (markerChar === codes.questionMark && code === codes.plusSign) {
      effects.consume(code);
      return afterMarker;
    }
    return afterMarker(code);
  }

  function afterMarker(code: Code): State | undefined {
    effects.exit("admonitionMarker");
    if (code === codes.eof || markdownLineEnding(code)) {
      return openerEnd(code);
    }
    // The marker must be followed by whitespace, so `!!!important` stays text.
    if (code === codes.space || code === codes.horizontalTab) {
      effects.enter("admonitionMeta");
      return meta(code);
    }
    return nok(code);
  }

  function meta(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit("admonitionMeta");
      return openerEnd(code);
    }
    effects.consume(code);
    return meta;
  }

  function openerEnd(code: Code): State | undefined {
    if (code === codes.eof) {
      effects.exit("admonition");
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
      // A blank first line: let atBreak attempt the next line.
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
    effects.enter("admonitionChunk");
    return inside(code);
  }

  function inside(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit("admonitionChunk");
      return atBreak(code);
    }
    effects.consume(code);
    return inside;
  }

  function after(code: Code): State | undefined {
    effects.exit("admonition");
    return ok(code);
  }

  // Whether the most recently consumed line prefix reaches the body column.
  // Always called right after factorySpace, so the tail event exists.
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
      // A lazy continuation line cannot be part of the body.
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

const admonition: Construct = {
  name: "admonition",
  tokenize: tokenizeAdmonition,
};

export const admonitionSyntax: Extension = {
  flow: {
    [codes.exclamationMark]: admonition,
    [codes.questionMark]: admonition,
  },
};
