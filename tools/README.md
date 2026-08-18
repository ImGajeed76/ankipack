# tools

Vendored from [docolin](https://github.com/ImGajeed76/docolin), so that
ankipack's documentation can be checked inside ankipack.

| Directory          | Copied from                         |
| ------------------ | ----------------------------------- |
| `docomd/`          | `src/lib/markdown/docomd/`          |
| `prettier-docomd/` | `src/lib/markdown/prettier-docomd/` |

`docomd` is docolin's markdown dialect: admonitions, collapsibles, steppers,
cards, content tabs, file trees. `prettier-docomd` is the prettier plugin that
parses and prints it. Enabling the plugin in `.prettierrc` is what lets
`bun run format:check` validate the structure of every page under `docs/`: a
block body that is not indented four spaces does not survive the round trip.

**Do not edit these.** They are a copy, and docolin is where the parser is
developed and tested. To pick up changes, copy the two directories again and
delete the `.test.ts` files, which depend on `bun:test` and on docolin's own
fixtures.

The upstream module is deliberately free of docolin-specific dependencies so it
can be lifted into a standalone package later. Keeping this a plain copy rather
than a fork is what makes that possible.
