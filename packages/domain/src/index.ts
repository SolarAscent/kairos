import type { NowContext } from "@life/contracts";
import scoringConfig from "./config/now-engine-v0.2.json" with { type: "json" };

export const scoringVersion = scoringConfig.version;
export const interventionThreshold = scoringConfig.intervention_threshold;

export interface DecisionCandidate {
  id: string;
  title: string;
  summary: string | null;
  kind: string;
  importance: number | null;
  createdAt: Date;
  expiresAt: Date | null;
  costMinMinor: number | null;
  costMaxMinor: number | null;
  durationMinSeconds: number | null;
}

export interface ScoredCandidate extends DecisionCandidate {
  valueScore: number;
  fitScore: number;
  frictionScore: number;
  urgencyScore: number;
  uncertaintyScore: number;
  totalScore: number;
  hardFilterReason: string | null;
  rank: number | null;
  executionType: string;
  headline: string;
  body: string;
  reasonText: string;
}

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

function createAction(
  candidate: DecisionCandidate,
  context: NowContext,
): { headline: string; body: string; reasonText: string } {
  const title = candidate.title;
  const minutes = Math.min(context.availableMinutes ?? 20, 20);
  if (candidate.kind === "PLACE") {
    return {
      headline: "确认「" + title + "」现在是否营业",
      body: "先核对营业时间和交通，再决定是否出发。",
      reasonText: "这是你亲自留下的地点想法；地点和营业状态尚未验证，所以先建议做低成本确认。",
    };
  }
  if (candidate.kind === "MEDIA") {
    return {
      headline:
        "留 " + String(Math.min(context.availableMinutes ?? 20, 30)) + " 分钟给「" + title + "」",
      body: "从你保存的内容开始，体验一小段即可。",
      reasonText: "这项内容来自你的记录，所需准备少，适合作为当前的一段轻量体验。",
    };
  }
  return {
    headline: `用 ${minutes} 分钟推进「${title}」`,
    body: "只做一个很小的开始，结束后再决定要不要继续。",
    reasonText: "这是你亲自保存的愿望；先用一个短时段降低启动成本。",
  };
}

export function scoreCandidates(
  candidates: DecisionCandidate[],
  context: NowContext,
  now = new Date(),
): ScoredCandidate[] {
  const scored = candidates.map((candidate): ScoredCandidate => {
    const daysSinceCapture = Math.max(
      0,
      (now.getTime() - candidate.createdAt.getTime()) / 86400000,
    );
    const valueScore = clamp(
      0.48 + (candidate.importance ?? 0.5) * 0.35 + Math.min(daysSinceCapture / 90, 0.15),
    );
    const urgencyScore = candidate.expiresAt
      ? clamp(1 - (candidate.expiresAt.getTime() - now.getTime()) / (14 * 86400000))
      : clamp(daysSinceCapture / 180);
    const requiredMinutes =
      candidate.durationMinSeconds == null
        ? Math.min(context.availableMinutes ?? 20, 20)
        : candidate.durationMinSeconds / 60;
    let hardFilterReason: string | null = null;
    if (candidate.expiresAt && candidate.expiresAt.getTime() <= now.getTime())
      hardFilterReason = "EXPIRED";
    else if (
      context.availableMinutes != null &&
      candidate.durationMinSeconds != null &&
      requiredMinutes > context.availableMinutes
    )
      hardFilterReason = "TIME_LIMIT";
    else if (
      context.budgetMinor != null &&
      candidate.costMinMinor != null &&
      candidate.costMinMinor > context.budgetMinor
    )
      hardFilterReason = "BUDGET_LIMIT";
    else if (context.willingToGoOut === false && candidate.kind === "PLACE")
      hardFilterReason = "NOT_GOING_OUT";
    const fitScore =
      context.availableMinutes == null
        ? 0.72
        : clamp(
            1 -
              Math.max(0, requiredMinutes - context.availableMinutes) /
                Math.max(30, context.availableMinutes),
          );
    const frictionScore = clamp(
      0.22 +
        (candidate.kind === "PLACE" ? 0.28 : 0.08) +
        (candidate.costMaxMinor == null ? 0.04 : Math.min(candidate.costMaxMinor / 30000, 0.4)) +
        (context.mood === "LOW_ENERGY" && candidate.kind === "PLACE" ? 0.2 : 0),
    );
    const uncertaintyScore = candidate.kind === "PLACE" ? 0.25 : 0.12;
    const totalScore = clamp(
      valueScore * scoringConfig.weights.value +
        fitScore * scoringConfig.weights.fit +
        urgencyScore * scoringConfig.weights.urgency +
        frictionScore * scoringConfig.weights.friction,
    );
    return {
      ...candidate,
      valueScore,
      fitScore,
      frictionScore,
      urgencyScore,
      uncertaintyScore,
      totalScore,
      hardFilterReason,
      rank: null,
      executionType:
        candidate.kind === "PLACE" || candidate.kind === "MEDIA" ? "VIEW_CONTENT" : "START_TIMER",
      ...createAction(candidate, context),
    };
  });
  const eligible = scored
    .filter((item) => item.hardFilterReason == null)
    .sort(
      (a, b) =>
        b.totalScore - a.totalScore ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  eligible.forEach((item, index) => {
    item.rank = index + 1;
  });
  return scored.sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );
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
  if (eventType === "SKIP" || eventType === "REJECT") {
    return {
      dimension: reasonCode ? "rejection_reason" : "action_type",
      value: reasonCode ? { reason: reasonCode } : { type: actionType },
      polarity: -1,
      strength: 0.4,
      confidence: 0.5,
    };
  }
  return null;
}
