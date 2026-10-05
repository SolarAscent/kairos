import { describe, expect, it } from "vitest";
import { learnedPreference, derivePreferenceSignal } from "@life/domain";

describe("bounded preference learning", () => {
  it("same-object explicit opinion dominates behavioral/category evidence", () => {
    const liked = learnedPreference("LIKE", -1, -1, -1);
    const disliked = learnedPreference("DISLIKE", 1, 1, 1);
    expect(liked.preferenceScore).toBeGreaterThan(0.5);
    expect(disliked.preferenceScore).toBeLessThan(-0.5);
    expect(learnedPreference("NONE", 1, 1, 1).preferenceScore).toBeLessThan(0.3);
  });
  it("bounds malformed affinity and treats withdrawal as neutral", () => {
    expect(learnedPreference("NONE").preferenceScore).toBe(0);
    expect(learnedPreference("LIKE", 200, 200, 200).preferenceScore).toBeLessThanOrEqual(1);
    expect(learnedPreference("NONE", Number.NaN).preferenceScore).toBe(0);
  });
  it("situational rejection is not permanent category dislike", () => {
    for (const reason of [undefined, "NO_TIME", "TOO_FAR", "LOW_ENERGY"])
      expect(derivePreferenceSignal("REJECT", "VIEW_CONTENT", reason)).toBeNull();
    expect(derivePreferenceSignal("SKIP", "VIEW_CONTENT", "NOT_INTERESTED")).toBeNull();
    expect(derivePreferenceSignal("REJECT", "VIEW_CONTENT", "NOT_INTERESTED")?.polarity).toBe(-1);
  });
});
