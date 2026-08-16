import { describe, test, expect } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { AnkipackError, Collection, Deck, Note, Notetype, Package } from "../src/index";
import { getSql } from "./helpers/collection";

// Every error the library raises carries a code, so a caller can branch on the
// kind of failure instead of matching on message text that is free to change.

async function collection(): Promise<Collection> {
  const SQL = await getSql();
  const deck = new Deck({ name: "Verbs" });
  deck.addNote(new Note({ notetype: Notetype.basic({ name: "Pair" }), fields: ["a", "b"] }));
  const pkg = new Package();
  pkg.addDeck(deck);
  return Collection.open(await pkg.toUint8Array(SQL), SQL);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AnkipackError) return error.code;
    return `not an AnkipackError: ${String(error)}`;
  }
  return "did not throw";
}

async function asyncCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AnkipackError) return error.code;
    return `not an AnkipackError: ${String(error)}`;
  }
  return "did not throw";
}

describe("errors carry a code", () => {
  test("a note type the collection does not have", async () => {
    const col = await collection();
    expect(
      await asyncCodeOf(() => col.addNote({ notetype: "Nope", deck: "Verbs", fields: ["a", "b"] })),
    ).toBe("notetype-not-found");
  });

  test("a deck the collection does not have", async () => {
    const col = await collection();
    expect(
      await asyncCodeOf(() => col.addNote({ notetype: "Pair", deck: "Nope", fields: ["a", "b"] })),
    ).toBe("deck-not-found");
    expect(codeOf(() => col.renameDeck("Nope", "X"))).toBe("deck-not-found");
  });

  test("a name another deck or note type already holds", async () => {
    const col = await collection();
    expect(await asyncCodeOf(() => col.addDeck(new Deck({ name: "verbs" })))).toBe("name-conflict");
    expect(codeOf(() => col.addNotetype(Notetype.basic({ name: "pair" })))).toBe("name-conflict");
  });

  test("recasing a deck's own name is not a conflict", async () => {
    const col = await collection();
    expect(codeOf(() => col.renameDeck("Verbs", "verbs"))).toBe("did not throw");
    expect(col.deckNames()).toContain("verbs");
  });

  test("an id another row already holds", async () => {
    const col = await collection();
    const takenDeck = col.data.decks[0].id;
    expect(await asyncCodeOf(() => col.addDeck(new Deck({ name: "Fresh", id: takenDeck })))).toBe(
      "id-conflict",
    );
    const takenNotetype = col.data.notetypes[0].id;
    expect(
      codeOf(() =>
        col.addNotetype(
          new Notetype({
            id: takenNotetype,
            name: "Fresh",
            fields: [{ name: "F" }],
            templates: [{ name: "C", questionFormat: "{{F}}", answerFormat: "x" }],
          }),
        ),
      ),
    ).toBe("id-conflict");
  });

  test("input the caller supplied and Anki would not keep", async () => {
    const col = await collection();
    const lone = String.fromCharCode(0xd800);
    expect(codeOf(() => new Note({ notetype: Notetype.basic(), fields: ["only one"] }))).toBe(
      "invalid-input",
    );
    expect(await asyncCodeOf(() => col.notes()[0].setFields(["one"]))).toBe("invalid-input");
    expect(codeOf(() => col.notes()[0].setTags(["two words"]))).toBe("invalid-input");
    expect(codeOf(() => col.renameDeck("Verbs", `bad${lone}`))).toBe("invalid-input");
  });

  test("a media filename Anki would rewrite", async () => {
    const col = await collection();
    expect(codeOf(() => new Package().addMedia("a:b.png", new Uint8Array([1])))).toBe("media-name");
    expect(codeOf(() => col.setMedia("a:b.png", new Uint8Array([1])))).toBe("media-name");
  });

  test("a package that is not one", async () => {
    const SQL = await getSql();
    expect(codeOf(() => Collection.open(new Uint8Array([1, 2, 3, 4]), SQL))).toBe(
      "invalid-package",
    );
    const notAnApkg = zipSync({ "readme.txt": strToU8("hello") });
    expect(codeOf(() => Collection.open(notAnApkg, SQL))).toBe("invalid-package");
  });

  test("a schema ankipack does not read", async () => {
    const SQL = await getSql();
    const col = await collection();
    col.data.col.ver = 17;
    const bytes = await col.toUint8Array(SQL);
    expect(codeOf(() => Collection.open(bytes, SQL))).toBe("unsupported-schema");
  });

  test("a document that would not import", async () => {
    const SQL = await getSql();
    for (const corrupt of [
      (c: Collection) => (c.data.notes[0].mid = 999_999),
      (c: Collection) => c.data.notes.push({ ...c.data.notes[0] }),
      (c: Collection) => {
        c.data.decks.push({ ...c.data.decks[0], id: c.data.decks[0].id + 1 });
      },
    ]) {
      const col = await collection();
      corrupt(col);
      expect(await asyncCodeOf(() => col.toUint8Array(SQL))).toBe("invalid-document");
    }
  });

  test("an AnkipackError is still an Error", async () => {
    const col = await collection();
    try {
      col.renameDeck("Nope", "X");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AnkipackError);
      expect((error as AnkipackError).name).toBe("AnkipackError");
      expect((error as Error).message).toMatch(/No deck named/);
    }
  });
});
