import { z } from "zod";

export const uuidSchema = z.string().uuid();
export const captureTypeSchema = z.enum([
  "TEXT",
  "IMAGE",
  "VOICE",
  "URL",
  "FILE",
  "FUTURE_CONNECTOR",
]);
export const captureStatusSchema = z.enum([
  "UPLOADED",
  "PROCESSING",
  "READY",
  "NEEDS_REVIEW",
  "FAILED",
  "DELETED",
]);
export const lifeStatusSchema = z.enum(["ACTIVE", "RESOLVED", "ARCHIVED", "DELETED"]);
export const sourceTypeSchema = z.enum([
  "CAPTURE",
  "USER",
  "CONNECTOR",
  "MODEL",
  "INFERENCE",
  "SYSTEM",
]);
export const facetTypeSchema = z.enum([
  "PLACE",
  "DESIRE",
  "MEDIA",
  "TIME_ANCHOR",
  "EVENT",
  "ASSET",
  "PREFERENCE",
  "ROUTINE",
  "OPEN_LOOP",
  "MEMORY",
  "COLLECTION",
]);
export const executionTypeSchema = z.enum([
  "NAVIGATE",
  "OPEN_URL",
  "PLAY_MEDIA",
  "VIEW_CONTENT",
  "START_TIMER",
  "OPEN_MINIPROGRAM",
  "CONNECTOR_ACTION",
  "NONE",
]);
export const decisionStatusSchema = z.enum([
  "BUILDING",
  "NEEDS_ANSWER",
  "RECOMMENDED",
  "QUIET",
  "FAILED",
  "CLOSED",
]);
export const feedbackEventTypeSchema = z.enum([
  "IMPRESSION",
  "ACCEPT",
  "SKIP",
  "EXECUTE",
  "NAVIGATE",
  "DISMISS",
  "REJECT",
  "COMPLETE",
]);

export const loginRequestSchema = z.object({
  code: z.string().trim().min(1).max(128),
  clientInstallationId: z.string().max(128).optional(),
});

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(32).max(512) });

export const createCaptureRequestSchema = z.object({
  type: z.literal("TEXT"),
  text: z.string().trim().min(1).max(5000),
  sourceChannel: z.enum(["MINIPROGRAM", "DEMO", "API"]).default("DEMO"),
  language: z.string().max(16).optional(),
});

// Text-demo facets contain descriptions only; verified execution facts need provider/user confirmation.
export const parsedFacetSchema = z.strictObject({
  type: facetTypeSchema,
  key: z.string().min(1).max(96),
  data: z.strictObject({
    intent: z.string().max(96).nullable(),
    description: z.string().max(1200).nullable(),
    verification: z.literal("UNVERIFIED"),
  }),
  confidence: z.number().min(0).max(1),
  source: z.enum(["EXTRACTED", "INFERRED"]),
});

export const parsedLifeObjectSchema = z.strictObject({
  title: z.string().trim().min(1).max(240),
  summary: z.string().max(1200).nullable(),
  kind: facetTypeSchema,
  importance: z.number().min(0).max(1),
  facets: z.array(parsedFacetSchema).max(24),
  confidence: z.number().min(0).max(1),
  uncertainFields: z.array(z.string().max(240)).max(48),
});

export const captureParseResultSchema = z
  .strictObject({
    objects: z.array(parsedLifeObjectSchema).max(12),
    relations: z
      .array(
        z.strictObject({
          fromIndex: z.number().int().nonnegative(),
          toIndex: z.number().int().nonnegative(),
          type: z.enum([
            "TARGETS",
            "LOCATED_AT",
            "VALID_AT",
            "RELATED_TO",
            "PART_OF",
            "REMEMBERED_WITH",
            "DEPENDS_ON",
          ]),
          confidence: z.number().min(0).max(1),
        }),
      )
      .max(144),
    uncertainFields: z.array(z.string().max(240)).max(48),
    suggestedEnrichments: z.array(z.string().max(240)).max(48),
  })
  .superRefine((result, ctx) => {
    result.relations.forEach((relation, index) => {
      if (
        relation.fromIndex >= result.objects.length ||
        relation.toIndex >= result.objects.length ||
        relation.fromIndex === relation.toIndex
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["relations", index],
          message: "Relation must reference two distinct objects in this result.",
        });
      }
    });
  });

export const nowContextSchema = z.object({
  availableMinutes: z.number().int().min(1).max(1440).optional(),
  budgetMinor: z.number().int().min(0).max(100000000).optional(),
  willingToGoOut: z.boolean().optional(),
  mood: z.enum(["LOW_ENERGY", "NEUTRAL", "CURIOUS", "SOCIAL"]).optional(),
  localTime: z.string().datetime().optional(),
});

export const createNowSessionRequestSchema = z.object({
  context: nowContextSchema.default({}),
  excludeObjectIds: z.array(uuidSchema).max(100).default([]),
});

export const createFeedbackRequestSchema = z.object({
  clientEventId: uuidSchema,
  eventType: feedbackEventTypeSchema,
  reasonCode: z.string().max(96).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type CreateCaptureRequest = z.infer<typeof createCaptureRequestSchema>;
export type CaptureParseResult = z.infer<typeof captureParseResultSchema>;
export type ParsedLifeObject = z.infer<typeof parsedLifeObjectSchema>;
export type NowContext = z.infer<typeof nowContextSchema>;
export type CreateNowSessionRequest = z.infer<typeof createNowSessionRequestSchema>;
export type CreateFeedbackRequest = z.infer<typeof createFeedbackRequestSchema>;

export const successEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({
    data,
    request_id: uuidSchema,
  });

export const authResponseSchema = z.object({
  userId: uuidSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().positive(),
});
export const captureResponseSchema = z.object({
  id: uuidSchema,
  type: captureTypeSchema,
  status: captureStatusSchema,
  text: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const captureAcceptedSchema = z.object({
  captureId: uuidSchema,
  status: z.literal("UPLOADED"),
  accepted: z.literal(true),
  replayed: z.boolean(),
});
export const feedbackAcceptedSchema = z.object({
  feedbackId: uuidSchema,
  eventType: feedbackEventTypeSchema,
  replayedClientEvent: z.boolean(),
  replayed: z.boolean(),
});
export const publicCandidateSchema = z.object({
  lifeObjectId: uuidSchema,
  title: z.string(),
  totalScore: z.number(),
  rank: z.number().int().nullable(),
  filtered: z.boolean(),
  filterReason: z.string().nullable(),
  scores: z.object({
    value: z.number(),
    fit: z.number(),
    urgency: z.number(),
    friction: z.number(),
    uncertainty: z.number(),
  }),
});
export const nowResponseSchema = z.object({
  sessionId: uuidSchema,
  status: z.enum(["QUIET", "RECOMMENDED"]),
  replayed: z.boolean(),
  recommendation: z
    .object({
      id: uuidSchema,
      targetLifeObjectId: uuidSchema,
      headline: z.string(),
      body: z.string(),
      reasonText: z.string(),
      executionType: executionTypeSchema,
      score: z.number(),
    })
    .nullable(),
  candidates: z.array(publicCandidateSchema),
});
