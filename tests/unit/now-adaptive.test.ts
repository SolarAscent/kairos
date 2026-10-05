import { describe, expect, it } from "vitest";
import {
  closeCandidateThreshold,
  contextForQuestionAnswer,
  nextDecisionQuestion,
  scoreCandidates,
  type DecisionCandidate,
  type PlanningContext,
} from "@life/domain";

const now = new Date("2026-10-05T10:00:00Z");
const candidate: DecisionCandidate = {
  id: "a",
  title: "散步",
  summary: null,
  kind: "DESIRE",
  importance: 0.6,
  createdAt: now,
  expiresAt: null,
  costMinMinor: 0,
  costMaxMinor: 0,
  durationMinSeconds: null,
};
const durationPair = [
  { ...candidate, id: "long", importance: 0.8, durationMinSeconds: 3600 },
  { ...candidate, id: "short", importance: 0.6, durationMinSeconds: 900 },
];
const scenePair = [
  {
    ...candidate,
    id: "place",
    kind: "PLACE",
    importance: 0.9,
    durationMinSeconds: 600,
    latitude: 23.14,
    longitude: 113.28,
    coordinateSystem: "GCJ02",
    route: {
      durationSeconds: 60,
      returnDurationSeconds: 60,
      mode: "walking",
      provider: "TENCENT",
      verification: "PROVIDER_VERIFIED" as const,
      observedAt: now,
      expiresAt: new Date(now.getTime() + 600000),
      origin: { latitude: 23.13, longitude: 113.27, coordinateSystem: "GCJ02" },
      destination: { latitude: 23.14, longitude: 113.28, coordinateSystem: "GCJ02" },
    },
  },
  { ...candidate, id: "home", importance: 0.5, durationMinSeconds: 600 },
];
const sceneContext: PlanningContext = {
  availableMinutes: 15,
  location: { source: "DEVICE", latitude: 23.13, longitude: 113.27, coordinateSystem: "GCJ02" },
};

describe("adaptive Now questioning", () => {
  it("goes directly to ranking without a usable comparison or known constraints", () => {
    expect(nextDecisionQuestion([], {}, [], now)).toBeNull();
    expect(nextDecisionQuestion([candidate], {}, [], now)).toBeNull();
    expect(nextDecisionQuestion([candidate, { ...candidate, id: "b" }], {}, [], now)).toBeNull();
    expect(nextDecisionQuestion([{ ...candidate, kind: "PLACE" }], {}, [], now)).toBeNull();
  });
  it("asks for time only when its answer changes the winner, then stops after a resolving answer", () => {
    const question = nextDecisionQuestion(durationPair, {}, [], now)!;
    expect(question.key).toBe("AVAILABLE_TIME");
    const context = contextForQuestionAnswer(question.key, "TIME_30")!;
    expect(scoreCandidates(durationPair, context, now)[0]!.id).toBe("short");
    expect(nextDecisionQuestion(durationPair, context, [question.key], now)).toBeNull();
    expect(nextDecisionQuestion(durationPair, { availableMinutes: 60 }, [], now)).toBeNull();
  });
  it("does not ask about a far-behind alternative even if a constraint could remove the leader", () => {
    const inputs = durationPair.map((item, i) => ({ ...item, importance: i ? 0 : 1 }));
    const ranked = scoreCandidates(inputs, {}, now);
    expect(ranked[0]!.totalScore - ranked[1]!.totalScore).toBeGreaterThan(closeCandidateThreshold);
    expect(nextDecisionQuestion(inputs, {}, [], now)).toBeNull();
  });
  it("asks whether to go out only when that answer can swap a close leading place", () => {
    expect(nextDecisionQuestion(scenePair, sceneContext, [], now)?.key).toBe("GO_OUT");
    expect(
      nextDecisionQuestion(scenePair, { ...sceneContext, willingToGoOut: false }, ["GO_OUT"], now),
    ).toBeNull();
    const homeLeads = scenePair.map((item) => ({ ...item, importance: 0.5 }));
    expect(nextDecisionQuestion(homeLeads, sceneContext, [], now)).toBeNull();
  });
  it("asks about budget when known minimum costs affect the first choice", () => {
    const inputs = [
      {
        ...candidate,
        importance: 0.9,
        costMinMinor: 5000,
        costMaxMinor: 5000,
        durationMinSeconds: 600,
      },
      { ...candidate, id: "b", importance: 0.6, durationMinSeconds: 600 },
    ];
    expect(nextDecisionQuestion(inputs, {}, [], now)?.key).toBe("BUDGET");
    expect(nextDecisionQuestion(inputs, { budgetMinor: 0 }, ["BUDGET"], now)).toBeNull();
  });
  it("never asks a repeated field or a third question, even when another answer could change the winner", () => {
    expect(nextDecisionQuestion(durationPair, {}, ["AVAILABLE_TIME"], now)).toBeNull();
    expect(nextDecisionQuestion(scenePair, {}, ["AVAILABLE_TIME", "BUDGET"], now)).toBeNull();
  });
  it("does not treat filtering every candidate to empty as a different winner", () => {
    const inputs = durationPair.map((item) => ({ ...item, durationMinSeconds: 7200 }));
    expect(nextDecisionQuestion(inputs, {}, [], now)).toBeNull();
  });
  it("maps only documented answers, including the explicit skip", () => {
    expect(contextForQuestionAnswer("GO_OUT", "GO_OUT_YES")).toEqual({ willingToGoOut: true });
    expect(contextForQuestionAnswer("GO_OUT", "SKIP")).toEqual({});
    expect(contextForQuestionAnswer("BUDGET", "TIME_30")).toBeNull();
    expect(contextForQuestionAnswer("UNKNOWN", "SKIP")).toBeNull();
  });
});
