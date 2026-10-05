import type { LifeRating } from "@life/contracts";

export const preferenceWeights = {
  direct: 0.75,
  category: 0.08,
  behavior: 0.12,
  behaviorCategory: 0.04,
};
export interface LearnedPreference {
  myRating: LifeRating;
  preferenceScore: number;
}
/** Explicit votes dominate; category generalization and observed behavior stay bounded. */
export function learnedPreference(
  rating: LifeRating,
  categoryAffinity = 0,
  behaviorAffinity = 0,
  behaviorCategoryAffinity = 0,
): LearnedPreference {
  const clamp = (value: number) => Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  return {
    myRating: rating,
    preferenceScore: clamp(
      (rating === "LIKE" ? 1 : rating === "DISLIKE" ? -1 : 0) * preferenceWeights.direct +
        clamp(categoryAffinity) * preferenceWeights.category +
        clamp(behaviorAffinity) * preferenceWeights.behavior +
        clamp(behaviorCategoryAffinity) * preferenceWeights.behaviorCategory,
    ),
  };
}
