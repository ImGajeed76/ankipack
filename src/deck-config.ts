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
  /** Preset name as shown in Anki's deck options. @default "Default" */
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

  /** Target recall probability (0 to 1). FSRS tunes intervals to hit this. @default 0.9 */
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
 * Generated configs never use id=1, so importing will not overwrite
 * the user's existing default preset.
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
    this.id = options.id ?? idGen.next();
    this.name = options.name ?? "Default";
    this.options = options;
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
