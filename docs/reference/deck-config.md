---
title: DeckConfig
description: Every scheduler option ankipack can set, with its type, default and the range it enforces, mapped to the section of Anki's manual that explains what the option actually does.
authors:
  - handle: imgajeed
  - name: Claude
    url: https://claude.ai

docolin:
  schema_version: 1
  kind: programming/ankipack/reference/deck-config
  type: reference

  applies_to:
    - ankipack >= 0.3
    - anki 26.08

  language: en
  difficulty: intermediate
  time_estimate: 8m

  status: stable

  aliases:
    [
      deck options,
      deck preset,
      scheduler settings,
      fsrs parameters,
      desired retention,
      learning steps,
      daily limits,
    ]

  references:
    - https://docs.ankiweb.net/deck-options.html

  prev: ./notetype.md
  next: ./collection.md
---

# DeckConfig

A deck options preset. Each deck references exactly one.

```ts
import { DeckConfig, Deck } from "ankipack";

const my_config = new DeckConfig({
  name: "Cramming",
  desiredRetention: 0.85,
  newPerDay: 100,
});

const my_deck = new Deck({ name: "Exam", config: my_config });
```

Every table below links to Anki's
[deck options documentation](https://docs.ankiweb.net/deck-options.html), which
explains what the options do. The options themselves are the
`DeckConfigOptions` interface.

A `DeckConfig` copies its options at construction, so mutating the object
afterwards does not change the preset.

!!! info "A preset may never reach the recipient"
    Presets are imported only if the recipient ticks the deck presets option in
    the import dialog, and `fsrsParams` additionally requires importing
    learning progress. Nothing in a package can enable FSRS itself, which is a
    collection-wide setting. See
    [what Anki does on import](../explanation/anki-import.md).

## Options

All 39 are top-level keys on `DeckConfigOptions`. The groups below exist to make
them readable and mean nothing structurally.

Most tables have a Range column. A value outside it throws at construction,
because Anki would
[replace it with its own default rather than clamping it](../explanation/validation.md).
Whole-number options refuse a fraction, list options refuse anything not finite,
and an empty cell means nothing is enforced.

### Identity

| Option | Type     | Default         | Range                    |
| ------ | -------- | --------------- | ------------------------ |
| `id`   | `number` | from the clock  | Safe integer             |
| `name` | `string` | `"Preset <id>"` | No NUL or lone surrogate |

Pin `id` if you [ship updates](../how-to/ship-updates.md), or each import leaves
another preset behind in the recipient's list. Presets are deduplicated by id
and never by name.

`name` is more permissive than a note type or deck name: empty, leading
whitespace and `:` are all accepted, because Anki matches presets on id rather
than on name. Two presets in one package whose names fold alike are still
refused, with `name-conflict`, since the recipient would be left unable to tell
them apart.

### Learning

Manual: [Learning Steps](https://docs.ankiweb.net/deck-options.html#learning-steps),
[Graduating Interval](https://docs.ankiweb.net/deck-options.html#graduating-interval),
[Easy Interval](https://docs.ankiweb.net/deck-options.html#easy-interval),
[Relearning Steps](https://docs.ankiweb.net/deck-options.html#relearning-steps).

| Option                   | Type       | Default   | Range                 |
| ------------------------ | ---------- | --------- | --------------------- |
| `learnSteps`             | `number[]` | `[1, 10]` | Minutes, no negatives |
| `relearnSteps`           | `number[]` | `[10]`    | Minutes, no negatives |
| `graduatingIntervalGood` | `number`   | `1`       | 1 to 36500, whole     |
| `graduatingIntervalEasy` | `number`   | `4`       | 1 to 36500, whole     |

### Daily limits

Manual: [New Cards/Day](https://docs.ankiweb.net/deck-options.html#new-cardsday),
[Maximum Reviews/Day](https://docs.ankiweb.net/deck-options.html#maximum-reviewsday).

| Option          | Type     | Default | Range            |
| --------------- | -------- | ------- | ---------------- |
| `newPerDay`     | `number` | `20`    | 0 to 9999, whole |
| `reviewsPerDay` | `number` | `200`   | 0 to 9999, whole |

### Intervals

Manual: [Maximum Interval](https://docs.ankiweb.net/deck-options.html#maximum-interval),
[Minimum Interval](https://docs.ankiweb.net/deck-options.html#minimum-interval).

| Option                  | Type     | Default | Range             |
| ----------------------- | -------- | ------- | ----------------- |
| `maximumReviewInterval` | `number` | `36500` | 1 to 36500, whole |
| `minimumLapseInterval`  | `number` | `1`     | 1 to 36500, whole |

### FSRS

Used only when FSRS is on, which is a collection-wide setting the recipient
controls. Manual:
[Desired Retention](https://docs.ankiweb.net/deck-options.html#desired-retention),
[FSRS Parameters](https://docs.ankiweb.net/deck-options.html#fsrs-parameters),
[Historical Retention](https://docs.ankiweb.net/deck-options.html#historical-retention),
[Ignore Cards Reviewed Before](https://docs.ankiweb.net/deck-options.html#ignore-cards-reviewed-before).

| Option                    | Type       | Default | Range                               |
| ------------------------- | ---------- | ------- | ----------------------------------- |
| `desiredRetention`        | `number`   | `0.9`   | 0.7 to 0.99                         |
| `fsrsParams`              | `number[]` | `[]`    | Empty, or at least 21 finite values |
| `historicalRetention`     | `number`   | `0.9`   | 0.7 to 0.97                         |
| `ignoreRevlogsBeforeDate` | `string`   | `""`    | `YYYY-MM-DD`, not validated         |

A shorter `fsrsParams` than 21 entries is refused because Anki reads index 20
as the FSRS-6 decay, so a shorter vector is silently downgraded to FSRS-5. The
values themselves are not checked, by ankipack or by the importer.

### Display order

Manual: [Insertion Order](https://docs.ankiweb.net/deck-options.html#insertion-order),
[New Card Gather Order](https://docs.ankiweb.net/deck-options.html#new-card-gather-order),
[New Card Sort Order](https://docs.ankiweb.net/deck-options.html#new-card-sort-order),
[Review Sort Order](https://docs.ankiweb.net/deck-options.html#review-sort-order),
[New/Review Order](https://docs.ankiweb.net/deck-options.html#newreview-order),
[Interday Learning/Review Order](https://docs.ankiweb.net/deck-options.html#interday-learningreview-order).

| Option                  | Type                    | Default            |
| ----------------------- | ----------------------- | ------------------ |
| `newCardInsertOrder`    | `NewCardInsertOrder`    | `"due"`            |
| `newCardGatherPriority` | `NewCardGatherPriority` | `"deck"`           |
| `newCardSortOrder`      | `NewCardSortOrder`      | `"template"`       |
| `reviewOrder`           | `ReviewCardOrder`       | `"day"`            |
| `newMix`                | `ReviewMix`             | `"mixWithReviews"` |
| `interdayLearningMix`   | `ReviewMix`             | `"mixWithReviews"` |

Each is an exported union of string literals:

| Type                    | Values                                                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NewCardInsertOrder`    | `"due"`, `"random"`                                                                                                                                                                                                                                            |
| `NewCardGatherPriority` | `"deck"`, `"deckThenRandom"`, `"lowestPosition"`, `"highestPosition"`, `"randomNotes"`, `"randomCards"`                                                                                                                                                        |
| `NewCardSortOrder`      | `"template"`, `"noSort"`, `"templateThenRandom"`, `"randomNoteThenTemplate"`, `"randomCard"`                                                                                                                                                                   |
| `ReviewCardOrder`       | `"day"`, `"dayThenDeck"`, `"deckThenDay"`, `"intervalsAscending"`, `"intervalsDescending"`, `"easeAscending"`, `"easeDescending"`, `"retrievabilityAscending"`, `"retrievabilityDescending"`, `"relativeOverdueness"`, `"random"`, `"added"`, `"reverseAdded"` |
| `ReviewMix`             | `"mixWithReviews"`, `"afterReviews"`, `"beforeReviews"`                                                                                                                                                                                                        |

### Burying and leeches

Manual: [Burying](https://docs.ankiweb.net/deck-options.html#burying),
[Leeches](https://docs.ankiweb.net/deck-options.html#leeches).

| Option                 | Type          | Default     | Range                      |
| ---------------------- | ------------- | ----------- | -------------------------- |
| `buryNew`              | `boolean`     | `false`     |                            |
| `buryReviews`          | `boolean`     | `false`     |                            |
| `buryInterdayLearning` | `boolean`     | `false`     |                            |
| `leechAction`          | `LeechAction` | `"tagOnly"` | `"suspend"` or `"tagOnly"` |
| `leechThreshold`       | `number`      | `8`         | 1 to 9999, whole           |

### Timers and audio

Manual: [Audio](https://docs.ankiweb.net/deck-options.html#audio),
[Internal Timer](https://docs.ankiweb.net/deck-options.html#internal-timer),
[On-screen Timer](https://docs.ankiweb.net/deck-options.html#on-screen-timer),
[Auto Advance](https://docs.ankiweb.net/deck-options.html#auto-advance).

| Option                            | Type      | Default | Range                 |
| --------------------------------- | --------- | ------- | --------------------- |
| `disableAutoplay`                 | `boolean` | `false` |                       |
| `waitForAudio`                    | `boolean` | `true`  |                       |
| `skipQuestionWhenReplayingAnswer` | `boolean` | `false` |                       |
| `capAnswerTimeToSecs`             | `number`  | `60`    | 1 to 9999, whole      |
| `showTimer`                       | `boolean` | `false` |                       |
| `stopTimerOnAnswer`               | `boolean` | `false` |                       |
| `secondsToShowQuestion`           | `number`  | `0`     | Unbounded. 0 disables |
| `secondsToShowAnswer`             | `number`  | `0`     | Unbounded. 0 disables |

`waitForAudio` is the one option with no entry in the manual. It sits in Anki's
Auto Advance panel.

### SM-2 fallback

Used only when FSRS is off. Manual:
[Starting Ease](https://docs.ankiweb.net/deck-options.html#starting-ease),
[Easy Bonus](https://docs.ankiweb.net/deck-options.html#easy-bonus),
[Hard Interval](https://docs.ankiweb.net/deck-options.html#hard-interval),
[New Interval](https://docs.ankiweb.net/deck-options.html#new-interval),
[Interval Modifier](https://docs.ankiweb.net/deck-options.html#interval-modifier).

| Option               | Type     | Default | Range       |
| -------------------- | -------- | ------- | ----------- |
| `initialEase`        | `number` | `2.5`   | 1.31 to 5.0 |
| `easyMultiplier`     | `number` | `1.3`   | 1.0 to 5.0  |
| `hardMultiplier`     | `number` | `1.2`   | 0.5 to 1.3  |
| `lapseMultiplier`    | `number` | `0.0`   | 0.0 to 1.0  |
| `intervalMultiplier` | `number` | `1.0`   | 0.5 to 2.0  |

### Easy days

Manual: [Easy Days](https://docs.ankiweb.net/deck-options.html#easy-days).

| Option                | Type       | Default | Range                        |
| --------------------- | ---------- | ------- | ---------------------------- |
| `easyDaysPercentages` | `number[]` | `[]`    | Exactly 0 or 7 finite values |

Anki's load balancer parses every preset in the collection and errors on any
other length, which stops the recipient studying any deck at all, not just
yours.
