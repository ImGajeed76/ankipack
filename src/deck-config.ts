import { create } from "@bufbuild/protobuf";
import {
  DeckConfig_ConfigSchema,
  type DeckConfig_Config,
  DeckConfig_Config_NewCardInsertOrder,
  DeckConfig_Config_NewCardGatherPriority,
  DeckConfig_Config_NewCardSortOrder,
  DeckConfig_Config_ReviewCardOrder,
  DeckConfig_Config_ReviewMix,
  DeckConfig_Config_LeechAction,
} from "./generated/anki/deck_config_pb.js";
import { IdGenerator } from "./util/id.js";
import { rejectNul } from "./util/text.js";

const idGen = new IdGenerator();

export type NewCardInsertOrder = "due" | "random";

export type NewCardGatherPriority =
  | "deck"
  | "deckThenRandom"
  | "lowestPosition"
  | "highestPosition"
  | "randomNotes"
  | "randomCards";

export type NewCardSortOrder =
  | "template"
  | "noSort"
  | "templateThenRandom"
  | "randomNoteThenTemplate"
  | "randomCard";

export type ReviewCardOrder =
  | "day"
  | "dayThenDeck"
  | "deckThenDay"
  | "intervalsAscending"
  | "intervalsDescending"
  | "easeAscending"
  | "easeDescending"
  | "retrievabilityAscending"
  | "retrievabilityDescending"
  | "relativeOverdueness"
  | "random"
  | "added"
  | "reverseAdded";

export type ReviewMix = "mixWithReviews" | "afterReviews" | "beforeReviews";

export type LeechAction = "suspend" | "tagOnly";

export interface DeckConfigOptions {
  /** Custom config ID. Auto-generated if omitted. */
  id?: number;
  /** Preset name as shown in Anki's deck options. @default "Preset <id>" */
  name?: string;

  // ── Learning ──────────────────────────────────────────────────────────

  /** Learning steps in minutes. @default [1, 10] */
  learnSteps?: number[];
  /** Relearning steps in minutes for lapsed cards. @default [10] */
  relearnSteps?: number[];
  /** Interval in days after pressing Good on the last learning step. @default 1 */
  graduatingIntervalGood?: number;
  /** Interval in days after pressing Easy on a learning card. @default 4 */
  graduatingIntervalEasy?: number;

  // ── Limits ────────────────────────────────────────────────────────────

  /** Maximum new cards per day. @default 20 */
  newPerDay?: number;
  /** Maximum reviews per day. @default 200 */
  reviewsPerDay?: number;

  // ── Intervals ─────────────────────────────────────────────────────────

  /** Upper bound for review intervals in days. @default 36500 */
  maximumReviewInterval?: number;
  /** Minimum interval in days for lapsed cards. @default 1 */
  minimumLapseInterval?: number;

  // ── FSRS ──────────────────────────────────────────────────────────────

  /** Target recall probability (0.7 to 0.99). FSRS tunes intervals to hit this. @default 0.9 */
  desiredRetention?: number;
  /** Custom FSRS model weights. Leave empty to use Anki's defaults. @default [] */
  fsrsParams?: number[];
  /** Historical retention used for FSRS optimization. @default 0.9 */
  historicalRetention?: number;
  /** Ignore review logs before this date (YYYY-MM-DD) for FSRS training. @default "" */
  ignoreRevlogsBeforeDate?: string;

  // ── Card ordering ─────────────────────────────────────────────────────

  /** How new card positions are assigned. @default "due" */
  newCardInsertOrder?: NewCardInsertOrder;
  /** How new cards are gathered from subdecks. @default "deck" */
  newCardGatherPriority?: NewCardGatherPriority;
  /** Sort order of gathered new cards. @default "template" */
  newCardSortOrder?: NewCardSortOrder;
  /** Sort order for review cards. @default "day" */
  reviewOrder?: ReviewCardOrder;
  /** When to show new cards relative to reviews. @default "mixWithReviews" */
  newMix?: ReviewMix;
  /** When to show interday learning cards relative to reviews. @default "mixWithReviews" */
  interdayLearningMix?: ReviewMix;

  // ── Leech ─────────────────────────────────────────────────────────────

  /** What to do when a card becomes a leech. @default "tagOnly" */
  leechAction?: LeechAction;
  /** Number of lapses before a card is flagged as a leech. @default 8 */
  leechThreshold?: number;

  // ── Burying ───────────────────────────────────────────────────────────

  /** Bury new sibling cards until the next day. @default false */
  buryNew?: boolean;
  /** Bury review sibling cards until the next day. @default false */
  buryReviews?: boolean;
  /** Bury interday learning sibling cards. @default false */
  buryInterdayLearning?: boolean;

  // ── SM-2 fallback ─────────────────────────────────────────────────────

  /** Starting ease factor. @default 2.5 */
  initialEase?: number;
  /** Easy button multiplier. @default 1.3 */
  easyMultiplier?: number;
  /** Hard button multiplier. @default 1.2 */
  hardMultiplier?: number;
  /** Lapse interval multiplier (0 = reset to minimum). @default 0.0 */
  lapseMultiplier?: number;
  /** Global interval multiplier. @default 1.0 */
  intervalMultiplier?: number;

  // ── Timer / audio ─────────────────────────────────────────────────────

  /** Disable automatic audio playback. @default false */
  disableAutoplay?: boolean;
  /** Cap answer time recording to this many seconds. @default 60 */
  capAnswerTimeToSecs?: number;
  /** Show a timer on the review screen. @default false */
  showTimer?: boolean;
  /** Stop the timer when the answer is shown. @default false */
  stopTimerOnAnswer?: boolean;
  /** Auto-advance: seconds to show question (0 = disabled). @default 0 */
  secondsToShowQuestion?: number;
  /** Auto-advance: seconds to show answer (0 = disabled). @default 0 */
  secondsToShowAnswer?: number;
  /** Wait for audio to finish before showing the answer button. @default true */
  waitForAudio?: boolean;
  /** Skip question audio when replaying the answer. @default false */
  skipQuestionWhenReplayingAnswer?: boolean;

  // ── Easy days ─────────────────────────────────────────────────────────

  /** Per-weekday review load percentages for easy days scheduling. @default [] */
  easyDaysPercentages?: number[];
}

const INSERT_ORDER_MAP: Record<NewCardInsertOrder, DeckConfig_Config_NewCardInsertOrder> = {
  due: DeckConfig_Config_NewCardInsertOrder.DUE,
  random: DeckConfig_Config_NewCardInsertOrder.RANDOM,
};

const GATHER_PRIORITY_MAP: Record<NewCardGatherPriority, DeckConfig_Config_NewCardGatherPriority> =
  {
    deck: DeckConfig_Config_NewCardGatherPriority.DECK,
    deckThenRandom: DeckConfig_Config_NewCardGatherPriority.DECK_THEN_RANDOM_NOTES,
    lowestPosition: DeckConfig_Config_NewCardGatherPriority.LOWEST_POSITION,
    highestPosition: DeckConfig_Config_NewCardGatherPriority.HIGHEST_POSITION,
    randomNotes: DeckConfig_Config_NewCardGatherPriority.RANDOM_NOTES,
    randomCards: DeckConfig_Config_NewCardGatherPriority.RANDOM_CARDS,
  };

const SORT_ORDER_MAP: Record<NewCardSortOrder, DeckConfig_Config_NewCardSortOrder> = {
  template: DeckConfig_Config_NewCardSortOrder.TEMPLATE,
  noSort: DeckConfig_Config_NewCardSortOrder.NO_SORT,
  templateThenRandom: DeckConfig_Config_NewCardSortOrder.TEMPLATE_THEN_RANDOM,
  randomNoteThenTemplate: DeckConfig_Config_NewCardSortOrder.RANDOM_NOTE_THEN_TEMPLATE,
  randomCard: DeckConfig_Config_NewCardSortOrder.RANDOM_CARD,
};

const REVIEW_ORDER_MAP: Record<ReviewCardOrder, DeckConfig_Config_ReviewCardOrder> = {
  day: DeckConfig_Config_ReviewCardOrder.DAY,
  dayThenDeck: DeckConfig_Config_ReviewCardOrder.DAY_THEN_DECK,
  deckThenDay: DeckConfig_Config_ReviewCardOrder.DECK_THEN_DAY,
  intervalsAscending: DeckConfig_Config_ReviewCardOrder.INTERVALS_ASCENDING,
  intervalsDescending: DeckConfig_Config_ReviewCardOrder.INTERVALS_DESCENDING,
  easeAscending: DeckConfig_Config_ReviewCardOrder.EASE_ASCENDING,
  easeDescending: DeckConfig_Config_ReviewCardOrder.EASE_DESCENDING,
  retrievabilityAscending: DeckConfig_Config_ReviewCardOrder.RETRIEVABILITY_ASCENDING,
  retrievabilityDescending: DeckConfig_Config_ReviewCardOrder.RETRIEVABILITY_DESCENDING,
  relativeOverdueness: DeckConfig_Config_ReviewCardOrder.RELATIVE_OVERDUENESS,
  random: DeckConfig_Config_ReviewCardOrder.RANDOM,
  added: DeckConfig_Config_ReviewCardOrder.ADDED,
  reverseAdded: DeckConfig_Config_ReviewCardOrder.REVERSE_ADDED,
};

const REVIEW_MIX_MAP: Record<ReviewMix, DeckConfig_Config_ReviewMix> = {
  mixWithReviews: DeckConfig_Config_ReviewMix.MIX_WITH_REVIEWS,
  afterReviews: DeckConfig_Config_ReviewMix.AFTER_REVIEWS,
  beforeReviews: DeckConfig_Config_ReviewMix.BEFORE_REVIEWS,
};

const LEECH_ACTION_MAP: Record<LeechAction, DeckConfig_Config_LeechAction> = {
  suspend: DeckConfig_Config_LeechAction.SUSPEND,
  tagOnly: DeckConfig_Config_LeechAction.TAG_ONLY,
};

/**
 * Scheduler preset (deck options) that controls how Anki schedules cards.
 * Supports all FSRS settings. Each deck references exactly one config.
 *
 * @example
 * ```ts
 * const config = new DeckConfig({
 *   name: "Cramming Preset",
 *   desiredRetention: 0.85,
 *   learnSteps: [1, 10],
 *   newPerDay: 100,
 *   maximumReviewInterval: 7,
 * });
 * const deck = new Deck({ name: "My Deck", config });
 * ```
 */
export class DeckConfig {
  readonly id: number;
  readonly name: string;
  private readonly options: DeckConfigOptions;

  constructor(options: DeckConfigOptions = {}) {
    validateDeckConfigOptions(options);
    this.id = options.id ?? idGen.next();
    // Presets are deduped by id, not name, so a second "Default" would just
    // appear alongside the user's own in their preset list.
    this.name = options.name ?? `Preset ${this.id}`;
    // Copied, because toProtobuf() reads these at build time and the caller
    // could otherwise mutate past the validation above.
    this.options = { ...options };
    for (const key of ARRAY_OPTIONS) {
      const value = options[key];
      if (value !== undefined) this.options[key] = [...value];
    }
  }

  toProtobuf(): DeckConfig_Config {
    const o = this.options;
    return create(DeckConfig_ConfigSchema, {
      learnSteps: o.learnSteps ?? [1.0, 10.0],
      relearnSteps: o.relearnSteps ?? [10.0],

      fsrsParams6: o.fsrsParams ?? [],

      newPerDay: o.newPerDay ?? 20,
      reviewsPerDay: o.reviewsPerDay ?? 200,

      initialEase: o.initialEase ?? 2.5,
      easyMultiplier: o.easyMultiplier ?? 1.3,
      hardMultiplier: o.hardMultiplier ?? 1.2,
      lapseMultiplier: o.lapseMultiplier ?? 0.0,
      intervalMultiplier: o.intervalMultiplier ?? 1.0,

      maximumReviewInterval: o.maximumReviewInterval ?? 36500,
      minimumLapseInterval: o.minimumLapseInterval ?? 1,
      graduatingIntervalGood: o.graduatingIntervalGood ?? 1,
      graduatingIntervalEasy: o.graduatingIntervalEasy ?? 4,

      newCardInsertOrder: INSERT_ORDER_MAP[o.newCardInsertOrder ?? "due"],
      newCardGatherPriority: GATHER_PRIORITY_MAP[o.newCardGatherPriority ?? "deck"],
      newCardSortOrder: SORT_ORDER_MAP[o.newCardSortOrder ?? "template"],
      reviewOrder: REVIEW_ORDER_MAP[o.reviewOrder ?? "day"],
      newMix: REVIEW_MIX_MAP[o.newMix ?? "mixWithReviews"],
      interdayLearningMix: REVIEW_MIX_MAP[o.interdayLearningMix ?? "mixWithReviews"],

      leechAction: LEECH_ACTION_MAP[o.leechAction ?? "tagOnly"],
      leechThreshold: o.leechThreshold ?? 8,

      buryNew: o.buryNew ?? false,
      buryReviews: o.buryReviews ?? false,
      buryInterdayLearning: o.buryInterdayLearning ?? false,

      desiredRetention: o.desiredRetention ?? 0.9,
      historicalRetention: o.historicalRetention ?? 0.9,
      ignoreRevlogsBeforeDate: o.ignoreRevlogsBeforeDate ?? "",
      easyDaysPercentages: o.easyDaysPercentages ?? [],

      disableAutoplay: o.disableAutoplay ?? false,
      capAnswerTimeToSecs: o.capAnswerTimeToSecs ?? 60,
      showTimer: o.showTimer ?? false,
      stopTimerOnAnswer: o.stopTimerOnAnswer ?? false,
      secondsToShowQuestion: o.secondsToShowQuestion ?? 0,
      secondsToShowAnswer: o.secondsToShowAnswer ?? 0,
      waitForAudio: o.waitForAudio ?? true,
      skipQuestionWhenReplayingAnswer: o.skipQuestionWhenReplayingAnswer ?? false,

      paramSearch: "",
    });
  }
}

// Anki re-reads every preset through `ensure_deck_config_values_valid` and
// REPLACES an out-of-range value with its own default rather than clamping, so
// shipping one silently discards what the author asked for.
const VALID_RANGES: Array<[keyof DeckConfigOptions, number, number]> = [
  ["newPerDay", 0, 9999],
  ["reviewsPerDay", 0, 9999],
  ["initialEase", 1.31, 5.0],
  ["easyMultiplier", 1.0, 5.0],
  ["hardMultiplier", 0.5, 1.3],
  ["lapseMultiplier", 0.0, 1.0],
  ["intervalMultiplier", 0.5, 2.0],
  ["maximumReviewInterval", 1, 36500],
  ["minimumLapseInterval", 1, 36500],
  ["graduatingIntervalGood", 1, 36500],
  ["graduatingIntervalEasy", 1, 36500],
  ["leechThreshold", 1, 9999],
  ["capAnswerTimeToSecs", 1, 9999],
  ["desiredRetention", 0.7, 0.99],
  ["historicalRetention", 0.7, 0.97],
];

/** Options Anki stores as u32, so a fraction fails to encode later. */
const ARRAY_OPTIONS = [
  "learnSteps",
  "relearnSteps",
  "fsrsParams",
  "easyDaysPercentages",
] as const satisfies ReadonlyArray<keyof DeckConfigOptions>;

const INTEGER_OPTIONS: Array<keyof DeckConfigOptions> = [
  "newPerDay",
  "reviewsPerDay",
  "maximumReviewInterval",
  "minimumLapseInterval",
  "graduatingIntervalGood",
  "graduatingIntervalEasy",
  "leechThreshold",
  "capAnswerTimeToSecs",
];

function validateDeckConfigOptions(options: DeckConfigOptions): void {
  if (options.id !== undefined && !Number.isSafeInteger(options.id)) {
    throw new Error(`DeckConfig id must be a safe integer, got ${options.id}`);
  }
  if (options.name !== undefined) rejectNul(options.name, "DeckConfig name");

  for (const key of INTEGER_OPTIONS) {
    const value = options[key];
    if (typeof value === "number" && !Number.isInteger(value)) {
      throw new Error(`${String(key)} must be a whole number, got ${value}`);
    }
  }

  for (const [key, min, max] of VALID_RANGES) {
    const value = options[key];
    // NaN has to be caught explicitly: it compares false against both bounds,
    // and Anki's own check tests for it too.
    if (typeof value === "number" && (!Number.isFinite(value) || value < min || value > max)) {
      throw new Error(`${String(key)} must be between ${min} and ${max}, got ${value}`);
    }
  }

  // Anki's load balancer parses every preset in the collection and errors on
  // any other length, which stops the user studying any deck at all.
  const easyDays = options.easyDaysPercentages;
  if (easyDays !== undefined && easyDays.length !== 0 && easyDays.length !== 7) {
    throw new Error(`easyDaysPercentages must have 0 or 7 entries, got ${easyDays.length}`);
  }

  // Anki validates parameters when a preset is saved from its own UI, but the
  // apkg importer skips that check, so a bad vector surfaces on the first
  // answered card instead.
  const fsrs = options.fsrsParams;
  // Anki reads `params[20]` as the FSRS-6 decay, so a shorter vector is
  // silently downgraded to FSRS-5.
  if (fsrs !== undefined && fsrs.length !== 0 && fsrs.length < 21) {
    throw new Error(
      `fsrsParams must be empty or hold at least 21 FSRS-6 values, got ${fsrs.length}`,
    );
  }

  // A NaN or Infinity here encodes into the preset and reaches the scheduler,
  // which the importer never revalidates.
  for (const key of ARRAY_OPTIONS) {
    for (const value of options[key] ?? []) {
      if (!Number.isFinite(value)) {
        throw new Error(`${key} must hold finite numbers, got ${value}`);
      }
    }
  }

  // Steps are delays in minutes. FSRS parameter bounds live in the fsrs crate
  // rather than Anki, so those are left to Anki to judge.
  for (const key of ["learnSteps", "relearnSteps"] as const) {
    for (const value of options[key] ?? []) {
      if (value < 0) {
        throw new Error(`${key} must not hold negative delays, got ${value}`);
      }
    }
  }
}
