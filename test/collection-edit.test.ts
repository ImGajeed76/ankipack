import { describe, test, expect } from "bun:test";
import { Collection, Deck, Notetype, Note, Package } from "../src/index";
import { FIELD_SEPARATOR } from "../src/util/constants";
import { getSql } from "./helpers/collection";

// Editing an existing collection has one rule that matters more than the
// rest: it must not disturb what the user has already studied. These build a
// package, give it the review history a real collection would have, edit it,
// and check what moved and what did not.

async function reviewedCollection(): Promise<Collection> {
  const SQL = await getSql();
  const notetype = Notetype.basicAndReversed({ name: "Pair" });
  const deck = new Deck({ name: "Verbs" });
  deck.addNote(new Note({ notetype, fields: ["laufen", "to run"], tags: ["verb"] }));
  deck.addNote(new Note({ notetype, fields: ["only front", ""] }));
  const pkg = new Package();
  pkg.addDeck(deck);

  const col = Collection.open(await pkg.toUint8Array(SQL), SQL);

  // Put the first note's cards mid-review, and give one a log entry.
  const first = col.notes()[0];
  for (const card of col.data.cards.filter((c) => c.nid === first.id)) {
    Object.assign(card, {
      type: 2,
      queue: 2,
      due: 500,
      ivl: 40,
      factor: 2300,
      reps: 12,
      lapses: 2,
      usn: 5,
    });
    col.data.revlog.push({
      id: 1_690_000_000_000 + card.ord,
      cid: card.id,
      usn: 5,
      ease: 3,
      ivl: 40,
      lastIvl: 20,
      factor: 2300,
      time: 7000,
      type: 1,
    });
  }
  return col;
}

describe("editing a note", () => {
  test("changes the field and the derived columns", async () => {
    const col = await reviewedCollection();
    const note = col.notes()[0];
    const before = { csum: note.row.csum, sfld: note.row.sfld };

    await note.setField("Front", "rennen");

    expect(note.fields).toEqual(["rennen", "to run"]);
    expect(note.row.flds).toBe(`rennen${FIELD_SEPARATOR}to run`);
    expect(note.row.sfld).toBe("rennen");
    expect(note.row.sfld).not.toBe(before.sfld);
    expect(note.row.csum).not.toBe(before.csum);
    expect(note.row.usn).toBe(-1);
  });

  test("leaves review history and scheduling alone", async () => {
    const col = await reviewedCollection();
    const note = col.notes()[0];
    const before = col.data.cards
      .filter((c) => c.nid === note.id)
      .map((c) => ({ ...c }))
      .sort((a, b) => a.ord - b.ord);
    const revlogBefore = col.data.revlog.length;

    await note.setField("Front", "rennen");

    const after = col.data.cards
      .filter((c) => c.nid === note.id)
      .map((c) => ({ ...c }))
      .sort((a, b) => a.ord - b.ord);
    expect(after).toEqual(before);
    expect(col.data.revlog.length).toBe(revlogBefore);
  });

  test("filling an empty field adds the card it now renders", async () => {
    const col = await reviewedCollection();
    // The second note has an empty Back, so the reverse template renders nothing.
    const note = col.notes()[1];
    expect(col.data.cards.filter((c) => c.nid === note.id).map((c) => c.ord)).toEqual([0]);

    await note.setField("Back", "now filled");

    const ords = col.data.cards
      .filter((c) => c.nid === note.id)
      .map((c) => c.ord)
      .sort();
    expect(ords).toEqual([0, 1]);
  });

  test("emptying a field does not delete the card, as Anki also does not", async () => {
    const col = await reviewedCollection();
    const note = col.notes()[0];
    await note.setField("Back", "");
    expect(col.data.cards.filter((c) => c.nid === note.id).length).toBe(2);
  });

  test("a wrong field count is refused", async () => {
    const col = await reviewedCollection();
    await expect(col.notes()[0].setFields(["only one"])).rejects.toThrow(/has 2 fields, got 1/);
  });

  test("an unknown field name is refused", async () => {
    const col = await reviewedCollection();
    await expect(col.notes()[0].setField("Nope", "x")).rejects.toThrow(/has no field "Nope"/);
  });

  test("the edit survives a save and reopen", async () => {
    const SQL = await getSql();
    const col = await reviewedCollection();
    await col.notes()[0].setField("Front", "rennen");

    const reopened = Collection.open(await col.toUint8Array(SQL), SQL);
    const note = reopened.notes().find((n) => n.fields[0] === "rennen");
    expect(note).toBeDefined();
    expect(note?.field("Back")).toBe("to run");
    expect(reopened.data.revlog.length).toBe(2);
    expect(reopened.data.cards.find((c) => c.ivl === 40)).toBeDefined();
  });
});

describe("tags", () => {
  test("round trip through the stored format", async () => {
    const col = await reviewedCollection();
    const note = col.notes()[0];
    expect(note.tags).toEqual(["verb"]);

    note.addTag("chapter1");
    expect(note.tags).toEqual(["verb", "chapter1"]);
    expect(note.row.tags).toBe(" verb chapter1 ");

    note.removeTag("verb");
    expect(note.tags).toEqual(["chapter1"]);

    note.setTags([]);
    expect(note.row.tags).toBe("");
  });

  test("a tag containing a space is refused", async () => {
    const col = await reviewedCollection();
    expect(() => col.notes()[0].setTags(["two words"])).toThrow(/must not contain a space/);
  });
});

describe("adding and removing notes", () => {
  test("addNote creates the note and its cards in the named deck", async () => {
    const col = await reviewedCollection();
    const deckId = col.data.decks[0].id;

    const note = await col.addNote({
      notetype: "Pair",
      deck: "Verbs",
      fields: ["gehen", "to go"],
      tags: ["verb"],
    });

    expect(note.fields).toEqual(["gehen", "to go"]);
    const cards = col.data.cards.filter((c) => c.nid === note.id);
    expect(cards.map((c) => c.ord).sort()).toEqual([0, 1]);
    expect(cards.every((c) => c.did === deckId)).toBe(true);
    expect(note.row.csum).toBeGreaterThan(0);
  });

  test("addNote refuses a notetype or deck the collection does not have", async () => {
    const col = await reviewedCollection();
    await expect(
      col.addNote({ notetype: "Nope", deck: "Verbs", fields: ["a", "b"] }),
    ).rejects.toThrow(/No note type named "Nope"/);
    await expect(
      col.addNote({ notetype: "Pair", deck: "Nowhere", fields: ["a", "b"] }),
    ).rejects.toThrow(/No deck named "Nowhere"/);
  });

  test("removeNote takes its cards and log with it and leaves graves", async () => {
    const col = await reviewedCollection();
    const note = col.notes()[0];
    const cardIds = col.data.cards.filter((c) => c.nid === note.id).map((c) => c.id);

    col.removeNote(note.id);

    expect(col.data.notes.some((n) => n.id === note.id)).toBe(false);
    expect(col.data.cards.some((c) => c.nid === note.id)).toBe(false);
    expect(col.data.revlog.some((r) => cardIds.includes(r.cid))).toBe(false);
    // Type 1 is a note grave, type 0 a card grave.
    expect(col.data.graves.filter((g) => g.type === 1).map((g) => g.oid)).toEqual([note.id]);
    expect(
      col.data.graves
        .filter((g) => g.type === 0)
        .map((g) => g.oid)
        .sort(),
    ).toEqual([...cardIds].sort());
  });
});

describe("decks and media", () => {
  test("renameDeck writes the machine name", async () => {
    const col = await reviewedCollection();
    col.renameDeck("Verbs", "German::Verbs");

    expect(col.deckNames()).toEqual(["German::Verbs"]);
    expect(col.data.decks[0].name).toBe(`German${FIELD_SEPARATOR}Verbs`);
    expect(col.data.decks[0].usn).toBe(-1);
  });

  test("renameDeck refuses an unknown name", async () => {
    const col = await reviewedCollection();
    expect(() => col.renameDeck("Nope", "X")).toThrow(/No deck named "Nope"/);
  });

  test("renameDeck refuses a name another deck already holds", async () => {
    const col = await reviewedCollection();
    await col.addDeck(new Deck({ name: "Nouns" }));
    expect(() => col.renameDeck("Verbs", "nouns")).toThrow(/already exists/);
  });
});

describe("adding decks and note types", () => {
  test("addDeck makes the deck available to addNote", async () => {
    const col = await reviewedCollection();
    await col.addDeck(new Deck({ name: "Nouns::Chapter 1" }));

    expect(col.deckNames()).toContain("Nouns::Chapter 1");
    const note = await col.addNote({
      notetype: "Pair",
      deck: "Nouns::Chapter 1",
      fields: ["Hund", "dog"],
    });
    const deckId = col.data.decks.find((d) => d.name.endsWith("Chapter 1"))?.id;
    expect(col.data.cards.filter((c) => c.nid === note.id).every((c) => c.did === deckId)).toBe(
      true,
    );
  });

  test("addDeck brings the deck's own notes and note types with it", async () => {
    const col = await reviewedCollection();
    const deck = new Deck({ name: "Nouns" });
    deck.addNote(new Note({ notetype: Notetype.basic({ name: "Solo" }), fields: ["a", "b"] }));
    await col.addDeck(deck);

    expect(col.notes({ deck: "Nouns" }).length).toBe(1);
    expect(col.data.notetypes.some((nt) => nt.name === "Solo")).toBe(true);
  });

  test("addNotetype makes the note type available to addNote", async () => {
    const col = await reviewedCollection();
    col.addNotetype(Notetype.cloze({ name: "Gaps" }));

    const note = await col.addNote({
      notetype: "Gaps",
      deck: "Verbs",
      fields: ["{{c1::a}} and {{c2::b}}", ""],
    });
    expect(col.data.cards.filter((c) => c.nid === note.id).length).toBe(2);
  });

  // Anki compares both case-insensitively, so these would merge on import.
  test("a deck or note type whose name is taken is refused", async () => {
    const col = await reviewedCollection();
    await expect(col.addDeck(new Deck({ name: "verbs" }))).rejects.toThrow(/already/i);
    expect(() => col.addNotetype(Notetype.basic({ name: "pair" }))).toThrow(/already/i);
  });

  // The same contract addNote already keeps: a call that throws leaves the
  // document as it found it, rather than half a deck and some of its notes.
  test("a rejected addDeck leaves nothing behind", async () => {
    const col = await reviewedCollection();
    const before = {
      decks: col.data.decks.length,
      notes: col.data.notes.length,
      notetypes: col.data.notetypes.length,
      cards: col.data.cards.length,
      deckConfig: col.data.deckConfig.length,
    };

    const deck = new Deck({ name: "Nouns" });
    const notetype = Notetype.basic({ name: "Solo" });
    deck.addNote(new Note({ notetype, fields: ["ok", "fine"] }));
    // A note whose field count its note type does not accept, which addNote
    // refuses partway through the loop.
    deck.notes.push({ notetype, fields: ["only one"], tags: [], guid: undefined } as never);

    await expect(col.addDeck(deck)).rejects.toThrow();
    expect({
      decks: col.data.decks.length,
      notes: col.data.notes.length,
      notetypes: col.data.notetypes.length,
      cards: col.data.cards.length,
      deckConfig: col.data.deckConfig.length,
    }).toEqual(before);
  });

  test("a deck or note type whose id is taken is refused", async () => {
    const col = await reviewedCollection();
    const takenDeck = col.data.decks[0].id;
    const takenNotetype = col.data.notetypes[0].id;
    await expect(col.addDeck(new Deck({ name: "Fresh", id: takenDeck }))).rejects.toThrow(/id/i);
    expect(() =>
      col.addNotetype(
        new Notetype({
          id: takenNotetype,
          name: "Fresh",
          fields: [{ name: "F" }],
          templates: [{ name: "C", questionFormat: "{{F}}", answerFormat: "x" }],
        }),
      ),
    ).toThrow(/id/i);
  });

  test("media can be added, replaced and removed", async () => {
    const SQL = await getSql();
    const col = await reviewedCollection();
    col.setMedia("a.png", new Uint8Array([1, 2, 3]));
    col.setMedia("a.png", new Uint8Array([4, 5]));
    col.setMedia("b.mp3", new Uint8Array([6]));
    col.removeMedia("b.mp3");

    const reopened = Collection.open(await col.toUint8Array(SQL), SQL);
    expect(reopened.data.media).toEqual([{ name: "a.png", data: new Uint8Array([4, 5]) }]);
  });
});

describe("finding notes", () => {
  test("by tag, notetype and deck", async () => {
    const col = await reviewedCollection();
    expect(col.notes({ tag: "verb" }).length).toBe(1);
    expect(col.notes({ notetype: "Pair" }).length).toBe(2);
    expect(col.notes({ deck: "Verbs" }).length).toBe(2);
    expect(col.notes({ deck: "Nowhere" }).length).toBe(0);
  });
});

// The build path and the edit path derive sfld and csum independently. If they
// drift, the same content sorts and dedupes differently depending on which one
// produced it.
describe("an edited note gets the same derived values as a built one", () => {
  async function editedNote(front: string): Promise<{ sfld: unknown; csum: unknown }> {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Derive" });
    const deck = new Deck({ name: "Derive" });
    deck.addNote(new Note({ notetype, fields: ["placeholder", "back"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);
    const note = col.notes()[0];
    await note.setField("Front", front);
    return { sfld: note.row.sfld, csum: note.row.csum };
  }

  async function builtNote(front: string): Promise<{ sfld: unknown; csum: unknown }> {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Derive" });
    const deck = new Deck({ name: "Derive" });
    deck.addNote(new Note({ notetype, fields: [front, "back"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);
    const row = col.notes()[0].row;
    return { sfld: row.sfld, csum: row.csum };
  }

  test("markup is stripped from the sort field and the checksum", async () => {
    const edited = await editedNote("<b>hund</b>");
    expect(edited.sfld).toBe("hund");
    expect(edited).toEqual(await builtNote("<b>hund</b>"));
  });

  test("a control character is stripped from the stored field, as on the build path", async () => {
    const SQL = await getSql();
    const notetype = Notetype.basic({ name: "Control" });
    const deck = new Deck({ name: "Control" });
    deck.addNote(new Note({ notetype, fields: ["placeholder", "back"] }));
    const pkg = new Package();
    pkg.addDeck(deck);
    const col = Collection.open(await pkg.toUint8Array(SQL), SQL);
    const note = col.notes()[0];
    await note.setField("Front", `hu${String.fromCharCode(0x07)}nd`);
    expect(note.field("Front")).toBe("hund");
  });
});
