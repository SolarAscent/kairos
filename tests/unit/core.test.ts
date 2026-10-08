import { describe, expect, it, vi, afterEach } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { captureParseResultSchema, createCaptureRequestSchema } from "@life/contracts";
import { scoreCandidates, derivePreferenceSignal, type DecisionCandidate } from "@life/domain";
import { createModelGateway, MockModelProvider, OpenAIResponsesProvider } from "@life/agent-core";
import { createAccessToken, verifyAccessToken } from "../../apps/api/dist/common/security.js";
import { readAuthConfig } from "../../apps/api/dist/common/auth-config.js";

const now = new Date("2026-10-04T12:00:00Z");
const candidate: DecisionCandidate = {
  id: randomUUID(),
  title: "学画画",
  summary: null,
  kind: "DESIRE",
  importance: 0.6,
  createdAt: now,
  expiresAt: null,
  costMinMinor: null,
  costMaxMinor: null,
  durationMinSeconds: null,
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("recommendation constraints", () => {
  it("does not invent a duration constraint for unknown activities", () => {
    const [result] = scoreCandidates([candidate], { availableMinutes: 5 }, now);
    expect(result?.hardFilterReason).toBeNull();
    expect(result?.headline).toContain("5 分钟");
  });
  it.each([
    [{ expiresAt: now }, {}, "EXPIRED"],
    [{ durationMinSeconds: 1800 }, { availableMinutes: 15 }, "TIME_LIMIT"],
    [{ costMinMinor: 2000 }, { budgetMinor: 1000 }, "BUDGET_LIMIT"],
    [{ kind: "PLACE" }, { willingToGoOut: false }, "NOT_GOING_OUT"],
  ])("filters proven hard constraints", (overrides, context, reason) => {
    const result = scoreCandidates([{ ...candidate, ...overrides }], context, now).find((item) =>
      item.actionKey.endsWith(":DO"),
    );
    expect(result?.hardFilterReason).toBe(reason);
    expect(result?.rank).toBeNull();
  });
  it("resolves ties deterministically without modifying the input", () => {
    const inputs = [
      { ...candidate, id: "b" },
      { ...candidate, id: "a" },
    ];
    expect(
      scoreCandidates(inputs, {}, now)
        .filter((item) => item.hardFilterReason == null)
        .map((item) => item.id),
    ).toEqual(["a", "b"]);
    expect(inputs[0]?.id).toBe("b");
  });
  it("ignores impressions and situational skips, and learns explicit dislike", () => {
    expect(derivePreferenceSignal("IMPRESSION", "VIEW_CONTENT")).toBeNull();
    expect(derivePreferenceSignal("SKIP", "VIEW_CONTENT")).toBeNull();
    expect(derivePreferenceSignal("REJECT", "VIEW_CONTENT", "TOO_FAR")).toBeNull();
    expect(derivePreferenceSignal("REJECT", "VIEW_CONTENT", "DISLIKE")?.polarity).toBe(-1);
  });
});

describe("contracts and model boundary", () => {
  it("rejects blank/oversized captures", () => {
    expect(createCaptureRequestSchema.safeParse({ type: "TEXT", text: "  " }).success).toBe(false);
    expect(
      createCaptureRequestSchema.safeParse({ type: "TEXT", text: "a".repeat(5001) }).success,
    ).toBe(false);
  });
  it("rejects invented provider names", () => {
    expect(() => createModelGateway({ MODEL_PROVIDER: "typo" })).toThrow("MODEL_PROVIDER_INVALID");
  });
  it("forbids simulated recommendations for production users", () => {
    expect(() => createModelGateway({ MODEL_PROVIDER: "mock", NODE_ENV: "production" })).toThrow(
      "MOCK_MODEL_FORBIDDEN_IN_PRODUCTION",
    );
    expect(createModelGateway({ MODEL_PROVIDER: "mock", NODE_ENV: "test" })).toBeInstanceOf(
      MockModelProvider,
    );
  });
  it("rejects dangling relations and fabricated verification", async () => {
    const result = await new MockModelProvider().parseCapture("我想去书店");
    expect(
      captureParseResultSchema.safeParse({
        ...result,
        relations: [{ fromIndex: 0, toIndex: 9, type: "RELATED_TO", confidence: 1 }],
      }).success,
    ).toBe(false);
    result.objects[0]!.facets[0]!.source = "VERIFIED" as never;
    expect(captureParseResultSchema.safeParse(result).success).toBe(false);
  });
  it("derives closed JSON Schema with mandatory extraction fields and optional life facts", () => {
    function inspect(value: unknown) {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.type === "object") {
        expect(node.additionalProperties).toBe(false);
        for (const key of (node.required as string[] | undefined) ?? [])
          expect(node.properties).toHaveProperty(key);
      }
      Object.values(node).forEach(inspect);
    }
    inspect(z.toJSONSchema(captureParseResultSchema));
  });
  it("uses Responses schema and rejects incomplete outputs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "incomplete", output: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new OpenAIResponsesProvider("test-key", "test-model").parseCapture("test"),
    ).rejects.toThrow("MODEL_INCOMPLETE_OUTPUT");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.store).toBe(false);
    expect(body.text.format.schema).toEqual(z.toJSONSchema(captureParseResultSchema));
  });
});

describe("access tokens", () => {
  const secret = "test-only-secret-at-least-32-bytes-long";
  it("validates claims, expiry and signatures", () => {
    vi.stubEnv("JWT_SECRET", secret);
    const userId = randomUUID(),
      sessionId = randomUUID();
    const token = createAccessToken(userId, sessionId, 100);
    expect(verifyAccessToken(token, 101)).toEqual({ id: userId, sessionId });
    expect(() => verifyAccessToken(token, 10000)).toThrow();
    expect(() => verifyAccessToken(token + "x", 101)).toThrow();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const content = header + "." + token.split(".")[1];
    const forged = content + "." + createHmac("sha256", secret).update(content).digest("base64url");
    expect(() => verifyAccessToken(forged, 101)).toThrow();
  });
  it("rejects invalid TTL at startup", () => {
    expect(() => readAuthConfig({ JWT_SECRET: secret, ACCESS_TOKEN_TTL_SECONDS: "NaN" })).toThrow(
      "AUTH_CONFIGURATION_INVALID",
    );
  });
});
