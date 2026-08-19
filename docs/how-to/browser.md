---
title: Generate a deck in the browser
description: Building an .apkg client side, from loading the sql.js WASM binary to handing the file to the user, plus the bundler warning ankipack triggers and why it is harmless.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/how-to/browser
  type: how-to

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: intermediate
  time_estimate: 8m

  status: stable

  aliases:
    [
      browser,
      client side,
      wasm,
      locateFile,
      browser extension,
      chrome extension,
      bundler,
      vite,
      webpack,
      download apkg,
    ]

  references:
    - https://sql.js.org/
    - https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static

  prev: ./media.md
  next: ../reference/package-deck-note.md
---

# Generate a deck in the browser

ankipack has no filesystem dependency in its build path, so the whole library
works client side. What changes is where sql.js finds its WASM binary, and what
you do with the bytes once you have them.

## Point sql.js at its WASM binary

ankipack never creates the sql.js instance, you do, and that is what puts you in
charge of how its WASM binary loads. In Node sql.js finds the binary sitting
next to itself. A browser has no filesystem to look in, so it asks you instead.

Copy `sql-wasm.wasm` out of `node_modules/sql.js/dist/` into whatever your
bundler serves as static assets, `public/` in Vite, and hand back its URL:

```ts
import initSqlJs from "sql.js";

const SQL = await initSqlJs({
  locateFile: () => "/assets/sql-wasm.wasm", // (1)!
});
```

1. Your own path, rather than the filename sql.js asked for. Which name it asks
   for changed in sql.js 1.14, so answering with a fixed URL is the version
   proof way to do it.

Nothing checks any of this while you build, so a wrong path compiles cleanly and
404s at runtime, which your browser's network panel will show you.

Serve the file yourself rather than pointing at a CDN. `https://sql.js.org/dist/`
carries no version in its URL, so what it hands back can drift away from the
sql.js you installed.

## Take bytes, not a file

`writeToFile` is Node and Bun only. In a browser use `toUint8Array`, which
returns the same package contents in memory.

```ts hl_lines="13"
import initSqlJs from "sql.js";
import { Deck, Note, Notetype, Package } from "ankipack";

export async function buildDeck(): Promise<Uint8Array> {
  const SQL = await initSqlJs({ locateFile: () => "/assets/sql-wasm.wasm" });

  const my_notetype = Notetype.basic();
  const my_deck = new Deck({ name: "My Deck" });
  my_deck.addNote(new Note({ notetype: my_notetype, fields: ["front", "back"] }));

  const pkg = new Package();
  pkg.addDeck(my_deck);
  return pkg.toUint8Array(SQL);
}
```

## Hand the file to the user

The bytes are yours to deliver. The ordinary route is an object URL and a
synthetic anchor click, which is
[MDN's territory](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static)
rather than ankipack's.

```ts
export function download(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
```

!!! note "Why the cast"
    `toUint8Array` is typed `Promise<Uint8Array>`, which in current TypeScript
    is `Uint8Array<ArrayBufferLike>`, while `BlobPart` wants an
    `ArrayBuffer`-backed view. The cast is a type-level annoyance with no
    runtime effect.

Do not name the file `collection.apkg` or anything matching `backup-*.apkg`.
Anki's desktop importer treats both as collection packages, and your user is
asked whether to replace their whole collection instead of being given your
deck. The [Package reference](../reference/package-deck-note.md) has the
detail.

## The bundler warning

A browser build that includes ankipack emits a warning. With Vite it reads:

!!! output "Vite 8, production build"
    ```
    [plugin rolldown:vite-resolve] Module "node:fs/promises" has been externalized for browser compatibility, imported by ".../node_modules/ankipack/dist/package.js". See https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.
    ```

Expected and harmless. `writeToFile` imports `node:fs/promises` dynamically;
bundlers resolve dynamic imports statically and see it even though the branch
never runs. The build succeeds and the module is replaced with a stub.

If your build treats warnings as errors, silence this one rather than
suppressing externalisation warnings as a class. In Vite that is a
`build.rollupOptions.onwarn` handler that returns early when the message names
`node:fs/promises`. Match on the message: this warning carries no `code`.

## Browser extensions

Extensions add one constraint, and it is narrower than it looks. Manifest V3
defaults to `script-src 'self'`, which blocks **compiling** WebAssembly but
leaves fetching alone. So the binary downloads fine and then dies at
`WebAssembly.instantiate` with a `CompileError` naming the policy.

Grant the extension pages permission to compile WASM in the manifest:

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

Ship the binaries in your extension assets and resolve them at runtime:

```ts
declare const chrome: { runtime: { getURL(path: string): string } };
import initSqlJs from "sql.js";

const SQL = await initSqlJs({
  locateFile: () => chrome.runtime.getURL("sql/sql-wasm.wasm"),
});
```

Bundling them rather than fetching from a CDN is the right call, but for a
policy reason rather than a technical one: the Chrome Web Store does not allow
remotely hosted code. `web_accessible_resources` is a separate matter, and is
only needed if a content script or a web page has to reach the file, not for
your own extension pages.
