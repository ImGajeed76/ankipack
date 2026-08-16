import { Package, Deck, DeckConfig, Notetype, Note } from "../src/index";

// One fixture per scenario the package has to get right. Each builds a fresh
// Package, because ids are assigned at construction time. Every fixture is
// covered by both verification passes: the golden section dump and the
// integrity assertions.

export interface Fixture {
  name: string;
  /** What this fixture is here to pin down. */
  covers: string;
  build: () => Package;
}

function packageOf(...decks: Deck[]): Package {
  const pkg = new Package();
  for (const deck of decks) pkg.addDeck(deck);
  return pkg;
}

export const FIXTURES: Fixture[] = [
  {
    name: "basic-three-notes",
    covers: "the ordinary path: one deck, one notetype, one card per note",
    build: () => {
      const notetype = Notetype.basic();
      const deck = new Deck({ name: "Capitals" });
      deck.addNote(new Note({ notetype, fields: ["Capital of Peru", "Lima"] }));
      deck.addNote(new Note({ notetype, fields: ["Capital of Nepal", "Kathmandu"] }));
      deck.addNote(new Note({ notetype, fields: ["Capital of Ghana", "Accra"] }));
      return packageOf(deck);
    },
  },
  {
    name: "reversed-two-cards",
    covers: "one note generating a card per template",
    build: () => {
      const notetype = Notetype.basicAndReversed();
      const deck = new Deck({ name: "Reversed" });
      deck.addNote(new Note({ notetype, fields: ["oak", "Eiche"] }));
      return packageOf(deck);
    },
  },
  {
    name: "reversed-empty-back",
    covers: "a template that renders nothing produces no card of its own",
    build: () => {
      const notetype = Notetype.basicAndReversed();
      const deck = new Deck({ name: "Half Filled" });
      deck.addNote(new Note({ notetype, fields: ["only a front", ""] }));
      return packageOf(deck);
    },
  },
  {
    name: "typing-notetype",
    covers: "{{type:Field}} counting as content for card generation",
    build: () => {
      const notetype = Notetype.basicTyping();
      const deck = new Deck({ name: "Typing" });
      deck.addNote(new Note({ notetype, fields: ["spell: bicycle", "bicycle"] }));
      return packageOf(deck);
    },
  },
  {
    name: "cloze-two-deletions",
    covers: "one card per cloze ordinal, and cloze ords bypassing the template check",
    build: () => {
      const notetype = Notetype.cloze();
      const deck = new Deck({ name: "Cloze" });
      deck.addNote(
        new Note({
          notetype,
          fields: ["{{c1::Lima}} is the capital of {{c2::Peru}}", "South America"],
        }),
      );
      return packageOf(deck);
    },
  },
  {
    name: "custom-fsrs-config",
    covers: "DeckConfig values surviving into the deck_config protobuf",
    build: () => {
      const config = new DeckConfig({
        name: "Exam Preset",
        desiredRetention: 0.95,
        learnSteps: [1, 10],
        relearnSteps: [10],
        newPerDay: 140,
        reviewsPerDay: 9999,
        maximumReviewInterval: 4,
        buryNew: true,
        buryReviews: true,
      });
      const deck = new Deck({ name: "Exam", config });
      deck.addNote(new Note({ notetype: Notetype.basic(), fields: ["Q", "A"] }));
      return packageOf(deck);
    },
  },
  {
    name: "auto-config",
    covers: "config omitted: a generated preset named after the deck, never at id=1",
    build: () => {
      const deck = new Deck({ name: "Auto" });
      deck.addNote(new Note({ notetype: Notetype.basic(), fields: ["a", "b"] }));
      return packageOf(deck);
    },
  },
  {
    name: "no-preset",
    covers: "config: null shipping the id=1 placeholder Anki's gather pass requires",
    build: () => {
      const deck = new Deck({ name: "Inherits Default", config: null });
      deck.addNote(new Note({ notetype: Notetype.basic(), fields: ["a", "b"] }));
      return packageOf(deck);
    },
  },
  {
    name: "no-preset-two-decks",
    covers: "two NO_PRESET decks still shipping exactly one placeholder row",
    build: () => {
      const notetype = Notetype.basic();
      const first = new Deck({ name: "First", config: null });
      const second = new Deck({ name: "Second", config: null });
      first.addNote(new Note({ notetype, fields: ["a", "b"] }));
      second.addNote(new Note({ notetype, fields: ["c", "d"] }));
      return packageOf(first, second);
    },
  },
  {
    name: "two-decks-shared-notetype",
    covers: "one notetype inserted once across decks, cards landing in the right deck",
    build: () => {
      const notetype = Notetype.basic();
      const first = new Deck({ name: "Deck One" });
      const second = new Deck({ name: "Deck Two" });
      first.addNote(new Note({ notetype, fields: ["one", "eins"] }));
      second.addNote(new Note({ notetype, fields: ["two", "zwei"] }));
      return packageOf(first, second);
    },
  },
  {
    name: "media-and-tags",
    covers: "the media index, archive entries, and tag serialisation",
    build: () => {
      const notetype = Notetype.basic();
      const deck = new Deck({ name: "Media" });
      deck.addNote(
        new Note({
          notetype,
          fields: ['<img src="diagram.png">', "[sound:answer.mp3]"],
          tags: ["vocab", "chapter1"],
        }),
      );
      const pkg = packageOf(deck);
      pkg.addMedia("diagram.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      pkg.addMedia("answer.mp3", new Uint8Array([0x49, 0x44, 0x33]));
      return pkg;
    },
  },
  {
    name: "custom-notetype-subdeck",
    covers: "custom fields and templates, a :: subdeck name, and a deck description",
    build: () => {
      const notetype = new Notetype({
        name: "Vocab (FR to DE)",
        sortFieldIndex: 1,
        fields: [
          { name: "French", fontSize: 24 },
          { name: "German", sticky: true, description: "Zielsprache" },
          { name: "Note", plainText: true },
        ],
        templates: [
          {
            name: "Recognition",
            questionFormat: "{{French}}",
            answerFormat: '{{FrontSide}}<hr id="answer">{{German}}{{#Note}}<br>{{Note}}{{/Note}}',
          },
        ],
      });
      const deck = new Deck({
        name: "Languages::French::Chapter 1",
        description: "Chapter 1 vocabulary",
      });
      deck.addNote(new Note({ notetype, fields: ["chien", "Hund", ""] }));
      return packageOf(deck);
    },
  },
  {
    name: "explicit-guids",
    covers:
      "caller-supplied GUIDs being used verbatim, which decides update vs duplicate on re-import",
    build: () => {
      const notetype = Notetype.basic();
      const deck = new Deck({ name: "Stable Identity" });
      deck.addNote(
        new Note({ notetype, fields: ["first", "erste"], guid: "fixture-guid-first-note" }),
      );
      deck.addNote(
        new Note({ notetype, fields: ["second", "zweite"], guid: "fixture-guid-second-note" }),
      );
      return packageOf(deck);
    },
  },
  {
    name: "unicode-and-html",
    covers: "non-ASCII, quotes, and markup surviving into flds and sfld intact",
    build: () => {
      const notetype = Notetype.basic();
      const deck = new Deck({ name: "Encoding" });
      deck.addNote(
        new Note({
          notetype,
          fields: ['Grüße & <b>"bold"</b>', "日本語 / emoji \u{1F600}"],
        }),
      );
      return packageOf(deck);
    },
  },
];

export function fixtureByName(name: string): Fixture {
  const found = FIXTURES.find((fixture) => fixture.name === name);
  if (!found) throw new Error(`unknown fixture: ${name}`);
  return found;
}
