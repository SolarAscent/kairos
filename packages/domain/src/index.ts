import type { NowContext, NowQuestion } from "@life/contracts";
import scoringConfig from "./config/now-engine-v0.3.json" with { type: "json" };

export const scoringVersion = scoringConfig.version;
export const interventionThreshold = scoringConfig.intervention_threshold;

export { planActions, planningFacts, selectRouteForWindow } from "./planning.js";
export type {
  PlanningFacts,
  PlanningPlace,
  PlanningContext,
  VerifiedRoute,
  VerifiedAvailability,
  PlannedAction,
  ActionPlan,
  DurationBasis,
} from "./planning.js";
export * from "./life-facts.js";
export * from "./preferences.js";
import {
  planActions,
  planningFacts,
  availableMinutes,
  type PlanningCandidate,
  type PlanningContext,
  type PlannedAction,
} from "./planning.js";

export interface DecisionCandidate extends PlanningCandidate {
  preferenceScore?: number;
}
export interface ScoredCandidate extends DecisionCandidate, PlannedAction {
  valueScore: number;
  fitScore: number;
  frictionScore: number;
  urgencyScore: number;
  uncertaintyScore: number;
  totalScore: number;
  hardFilterReason: string | null;
  rank: number | null;
}
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

export function scoreCandidates(
  candidates: DecisionCandidate[],
  context: PlanningContext,
  now = new Date(context.serverTime ?? Date.now()),
): ScoredCandidate[] {
  const scored = candidates.flatMap((candidate) => {
    const facts = planningFacts(candidate);
    const daysSinceCapture = Math.max(
      0,
      (now.getTime() - candidate.createdAt.getTime()) / 86400000,
    );
    const due =
      facts.deadline ?? facts.eventStart ?? facts.windowEnd ?? candidate.expiresAt?.getTime();
    return planActions(candidate, context, now).map((action): ScoredCandidate => {
      const valueScore = clamp(
        (0.48 +
          (candidate.importance ?? 0.5) * 0.35 +
          Math.min(daysSinceCapture / 90, 0.15) +
          Math.max(-1, Math.min(1, candidate.preferenceScore ?? 0)) * 0.25) *
          action.directness,
      );
      const urgencyScore =
        due != null
          ? clamp(1 - (due - now.getTime()) / (14 * 86400000))
          : clamp(daysSinceCapture / 180);
      const requiredMinutes = action.requiredSeconds == null ? null : action.requiredSeconds / 60;
      const available = availableMinutes(context);
      const fitScore =
        available == null
          ? 0.72
          : requiredMinutes == null
            ? 0.4
            : clamp(1 - Math.max(0, requiredMinutes - available) / Math.max(30, available));
      const frictionScore = clamp(
        0.14 +
          (action.requiresGoOut ? 0.22 : 0.04) +
          Math.min((action.requiredCostMaxMinor ?? action.requiredCostMinMinor ?? 0) / 30000, 0.4) +
          Math.min((requiredMinutes ?? 60) / 600, 0.15) +
          (context.mood === "LOW_ENERGY" && action.requiresGoOut ? 0.2 : 0),
      );
      const uncertaintyScore =
        action.actionMode === "PREPARE"
          ? 0.15
          : action.durationBasis === "UNKNOWN"
            ? 0.4
            : action.requiresGoOut && action.plan.verification !== "PROVIDER_VERIFIED"
              ? 0.3
              : 0.08;
      const totalScore = clamp(
        valueScore * scoringConfig.weights.value +
          fitScore * scoringConfig.weights.fit +
          urgencyScore * scoringConfig.weights.urgency +
          frictionScore * scoringConfig.weights.friction,
      );
      return {
        ...candidate,
        ...action,
        valueScore,
        fitScore,
        frictionScore,
        urgencyScore,
        uncertaintyScore,
        totalScore,
        hardFilterReason: action.filterReason,
        rank: null,
      };
    });
  });
  const eligible = scored
    .filter((item) => item.hardFilterReason == null)
    .sort(
      (a, b) =>
        b.totalScore - a.totalScore ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        a.actionKey.localeCompare(b.actionKey),
    );
  eligible.forEach((item, index) => {
    item.rank = index + 1;
  });
  return scored.sort(
    (a, b) =>
      (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
      a.actionKey.localeCompare(b.actionKey),
  );
}

export const questionPolicyVersion = "questions-adaptive-v0.3";
export const maximumNowQuestions = 2;
export const closeCandidateThreshold = 0.06;
type QuestionKey = NowQuestion["key"];
export interface DecisionQuestion {
  key: QuestionKey;
  text: string;
  options: Array<{ id: string; label: string; context: Partial<NowContext> }>;
  informationGain: number;
}

/** Ask only when a missing, factual constraint can change the leading choice. */
export function nextDecisionQuestion(
  candidates: DecisionCandidate[],
  context: PlanningContext,
  askedKeys: string[] = [],
  now = new Date(context.serverTime ?? Date.now()),
): DecisionQuestion | null {
  if (askedKeys.length >= maximumNowQuestions) return null;
  const eligible = scoreCandidates(candidates, context, now).filter(
    (item) => item.hardFilterReason == null,
  );
  // An alternative preparation step for the same goal is not a reason to
  // interrogate the user. Compare competing direct actions when available.
  const meaningful = eligible.filter((item, index) => index === 0 || item.id !== eligible[0]?.id);
  const [first, second] = meaningful;
  if (
    !first ||
    !second ||
    first.totalScore < interventionThreshold ||
    first.totalScore - second.totalScore > closeCandidateThreshold
  )
    return null;
  const questions: Omit<DecisionQuestion, "informationGain">[] = [];
  if (
    context.availableMinutes == null &&
    eligible.some((item) => item.actionMode === "DO" && item.requiredSeconds != null)
  ) {
    questions.push({
      key: "AVAILABLE_TIME",
      text: "这会儿你大约有多久可以留给自己？",
      options: [
        { id: "TIME_10", label: "十分钟左右", context: { availableMinutes: 10 } },
        { id: "TIME_30", label: "半小时左右", context: { availableMinutes: 30 } },
        { id: "TIME_60", label: "一小时左右", context: { availableMinutes: 60 } },
        { id: "TIME_FREE", label: "时间宽裕", context: { availableMinutes: 1440 } },
      ],
    });
  }
  if (
    context.budgetMinor == null &&
    eligible.some((item) => item.actionMode === "DO" && (item.requiredCostMinMinor ?? 0) > 0)
  ) {
    questions.push({
      key: "BUDGET",
      text: "这次你愿意花多少钱？",
      options: [
        { id: "BUDGET_0", label: "先不花钱", context: { budgetMinor: 0 } },
        { id: "BUDGET_20", label: "二十元以内", context: { budgetMinor: 2000 } },
        { id: "BUDGET_100", label: "一百元以内", context: { budgetMinor: 10000 } },
        { id: "BUDGET_FREE", label: "暂不限制", context: { budgetMinor: 100000000 } },
      ],
    });
  }
  if (
    context.willingToGoOut == null &&
    eligible.some((item) => item.actionMode === "DO" && item.requiresGoOut)
  ) {
    questions.push({
      key: "GO_OUT",
      text: "如果要出去走走，你现在愿意吗？",
      options: [
        { id: "GO_OUT_YES", label: "愿意出去走走", context: { willingToGoOut: true } },
        { id: "GO_OUT_NO", label: "想留在这里", context: { willingToGoOut: false } },
      ],
    });
  }
  const influential = questions
    .filter((question) => !askedKeys.includes(question.key))
    .map((question) => {
      const winners = question.options.map(
        (option) =>
          scoreCandidates(candidates, { ...context, ...option.context }, now).find(
            (item) => item.hardFilterReason == null && item.totalScore >= interventionThreshold,
          )?.actionKey,
      );
      // Losing every candidate is not a different recommendation. Require two real winners.
      const distinctWinners = new Set(winners.filter((id): id is string => id != null));
      const sources = new Set(
        winners.filter((id): id is string => id != null).map((id) => id.split(":")[0]),
      );
      const directWinner = winners.some(
        (id) => eligible.find((item) => item.actionKey === id)?.actionMode === "DO",
      );
      return {
        ...question,
        informationGain: sources.size === 1 && !directWinner ? 0 : distinctWinners.size - 1,
      };
    })
    .filter((question) => question.informationGain > 0);
  return influential.sort((a, b) => b.informationGain - a.informationGain)[0] ?? null;
}

/** Option IDs are a closed protocol; clients cannot supply arbitrary context patches. */
export function contextForQuestionAnswer(
  key: string,
  optionId: string,
): Partial<NowContext> | null {
  if (optionId === "SKIP" && ["AVAILABLE_TIME", "BUDGET", "GO_OUT"].includes(key)) return {};
  const options: Record<string, Record<string, Partial<NowContext>>> = {
    AVAILABLE_TIME: {
      TIME_10: { availableMinutes: 10 },
      TIME_30: { availableMinutes: 30 },
      TIME_60: { availableMinutes: 60 },
      TIME_FREE: { availableMinutes: 1440 },
    },
    BUDGET: {
      BUDGET_0: { budgetMinor: 0 },
      BUDGET_20: { budgetMinor: 2000 },
      BUDGET_100: { budgetMinor: 10000 },
      BUDGET_FREE: { budgetMinor: 100000000 },
    },
    GO_OUT: {
      GO_OUT_YES: { willingToGoOut: true },
      GO_OUT_NO: { willingToGoOut: false },
    },
  };
  return options[key]?.[optionId] ?? null;
}

export function derivePreferenceSignal(eventType: string, actionType: string, reasonCode?: string) {
  if (eventType === "ACCEPT" || eventType === "EXECUTE" || eventType === "COMPLETE") {
    return {
      dimension: "action_type",
      value: { type: actionType },
      polarity: 1,
      strength: eventType === "COMPLETE" ? 0.8 : 0.5,
      confidence: 0.65,
    };
  }
  if (eventType === "REJECT" && ["NOT_INTERESTED", "DISLIKE"].includes(reasonCode ?? "")) {
    return {
      dimension: "action_type",
      value: { type: actionType },
      polarity: -1,
      strength: 0.4,
      confidence: 0.5,
    };
  }
  return null;
}
