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

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const imageInputSchema = z.strictObject({
  mimeType: z.enum(["image/jpeg", "image/png"]),
  base64: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});

export const MAX_AVATAR_BYTES = 256 * 1024;
export const avatarInputSchema = imageInputSchema.extend({
  base64: imageInputSchema.shape.base64.max(Math.ceil(MAX_AVATAR_BYTES / 3) * 4),
});
export const updateProfileRequestSchema = z.strictObject({
  nickname: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[^\u0000-\u001f\u007f]*$/),
  bio: z.string().trim().max(160),
  // Omitted retains the avatar; null removes it. Never accept client identity or remote URLs.
  avatar: avatarInputSchema.nullable().optional(),
});
export const userProfileSchema = z.object({
  userId: uuidSchema,
  nickname: z.string().nullable(),
  bio: z.string(),
  avatarVersion: uuidSchema.nullable(),
  identityProvider: z.enum(["WECHAT", "DEVELOPMENT", "NONE"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const userAvatarSchema = z.object({
  avatarVersion: uuidSchema.nullable(),
  image: avatarInputSchema.nullable(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;
export type AvatarInput = z.infer<typeof avatarInputSchema>;
const captureInputFields = {
  sourceChannel: z.enum(["MINIPROGRAM", "DEMO", "API"]).default("DEMO"),
  language: z.string().max(16).optional(),
};
export const createCaptureRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...captureInputFields,
    type: z.literal("TEXT"),
    text: z.string().trim().min(1).max(5000),
  }),
  z.strictObject({
    ...captureInputFields,
    type: z.literal("IMAGE"),
    text: z.string().trim().max(5000).optional(),
    image: imageInputSchema,
  }),
  z.strictObject({
    ...captureInputFields,
    type: z.literal("VOICE"),
    text: z.string().trim().min(1).max(5000),
    transcriptionSessionId: uuidSchema,
  }),
]);
export const mediaCapabilitiesSchema = z.object({
  text: z.boolean(),
  image: z.boolean(),
  voice: z.boolean(),
  provider: z.string(),
  reason: z.string().nullable(),
});
export const voiceSessionResponseSchema = z.object({
  sessionId: uuidSchema,
  ticket: z.string(),
  expiresIn: z.literal(60),
  socketPath: z.literal("/v1/media/voice/stream"),
  sampleRate: z.literal(16000),
  format: z.literal("pcm16"),
});
export const voiceServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), sessionId: uuidSchema }),
  z.object({ type: z.literal("partial"), text: z.string() }),
  z.object({ type: z.literal("final"), text: z.string() }),
  z.object({ type: z.literal("done"), text: z.string(), sessionId: uuidSchema }),
  z.object({ type: z.literal("error"), code: z.string() }),
]);

export const factPlaceSchema = z.strictObject({
  name: z.string().max(160).optional(),
  region: z.string().max(96).optional(),
  city: z.string().max(96).optional(),
  province: z.string().max(96).optional(),
  country: z.string().max(96).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  coordinateSystem: z.enum(["GCJ02", "WGS84"]).optional(),
});
export const structuredLifeFactsSchema = z.strictObject({
  origin: z.enum(["USER_STATED", "INFERRED"]),
  evidence: z.string().min(1).max(1200),
  duration: z
    .strictObject({
      minSeconds: z.number().int().nonnegative().max(31536000).nullable().optional(),
      maxSeconds: z.number().int().nonnegative().max(31536000).nullable().optional(),
      role: z.enum(["REQUIRED", "AVAILABLE"]).optional(),
      scope: z.enum(["CURRENT", "OBJECT"]).optional(),
    })
    .refine(
      (value) =>
        value.minSeconds == null ||
        value.maxSeconds == null ||
        value.minSeconds <= value.maxSeconds,
    )
    .optional(),
  money: z
    .strictObject({
      minMinor: z.number().int().nonnegative().max(100000000).nullable().optional(),
      maxMinor: z.number().int().nonnegative().max(100000000).nullable().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      role: z.enum(["COST", "BUDGET"]).optional(),
      scope: z.enum(["CURRENT", "OBJECT"]).optional(),
    })
    .refine(
      (value) =>
        value.minMinor == null || value.maxMinor == null || value.minMinor <= value.maxMinor,
    )
    .optional(),
  time: z
    .strictObject({
      windowStart: z.string().max(96).nullable().optional(),
      windowEnd: z.string().max(96).nullable().optional(),
      deadline: z.string().max(96).nullable().optional(),
      eventStart: z.string().max(96).nullable().optional(),
      eventEnd: z.string().max(96).nullable().optional(),
    })
    .optional(),
  place: factPlaceSchema.optional(),
  activityKind: z.enum(["TRAVEL", "LOCAL_OUTING", "HOME", "REMOTE", "OTHER"]).optional(),
  horizon: z.enum(["IMMEDIATE", "SCHEDULED", "LONG_TERM", "UNKNOWN"]).optional(),
  originContext: factPlaceSchema.optional(),
});
export type StructuredLifeFacts = z.infer<typeof structuredLifeFactsSchema>;
export type FactPlace = z.infer<typeof factPlaceSchema>;
// Explicit user statements constrain planning; they never verify routes or opening hours.
export const parsedFacetSchema = z.strictObject({
  type: facetTypeSchema,
  key: z.string().min(1).max(96),
  data: z.strictObject({
    intent: z.string().max(96).nullable(),
    description: z.string().max(1200).nullable(),
    verification: z.literal("UNVERIFIED"),
    facts: structuredLifeFactsSchema.optional(),
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

export const nowLocationSchema = z
  .object({
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    coordinateSystem: z.literal("GCJ02").optional(),
    region: z.string().min(1).max(120).optional(),
    city: z.string().min(1).max(120).optional(),
    source: z.enum(["USER_INPUT", "DEVICE", "SAVED_CURRENT", "SAVED_HOME"]),
    observedAt: z.iso.datetime().optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .refine(
    (p) =>
      (p.latitude == null) === (p.longitude == null) &&
      (p.latitude == null || p.coordinateSystem === "GCJ02") &&
      (p.latitude != null || p.region != null || p.city != null),
    "Location requires paired GCJ02 coordinates or a region",
  );
export const decisionCalendarSchema = z.object({
  isBusy: z.boolean(),
  availableUntil: z.iso.datetime().optional(),
  busyUntil: z.iso.datetime().optional(),
  nextEventAt: z.iso.datetime().optional(),
  freeMinutesUntilNextEvent: z.number().nonnegative().optional(),
  effectiveAvailableMinutes: z.number().nonnegative().optional(),
  eventIds: z.array(uuidSchema).max(200),
});
export const nowContextSchema = z.object({
  availableMinutes: z.number().int().min(0).max(1440).optional(),
  budgetMinor: z.number().int().min(0).max(100000000).optional(),
  willingToGoOut: z.boolean().optional(),
  mood: z.enum(["LOW_ENERGY", "NEUTRAL", "CURIOUS", "SOCIAL"]).optional(),
  localTime: z.string().datetime().optional(),
  location: nowLocationSchema.optional(),
  serverTime: z.iso.datetime().optional(),
  timezone: z.string().max(80).optional(),
  localDate: z.string().optional(),
  localClock: z.string().optional(),
  calendar: decisionCalendarSchema.optional(),
});
// Clock, calendar and remembered-location provenance are computed by the server.
export const nowInputContextSchema = nowContextSchema
  .pick({
    availableMinutes: true,
    budgetMinor: true,
    willingToGoOut: true,
    mood: true,
  })
  .extend({ location: nowLocationSchema.optional() })
  .refine(
    (context) => !context.location || ["USER_INPUT", "DEVICE"].includes(context.location.source),
    "Clients may only provide a current user-input or device location",
  );
export const createNowSessionRequestSchema = z.object({
  context: nowInputContextSchema.default({}),
  excludeObjectIds: z.array(uuidSchema).max(100).default([]),
  focusObjectId: uuidSchema.optional(),
});
export const actionPlanSchema = z.object({
  validUntil: z.iso.datetime().optional(),
  mode: z.enum(["DO", "PREPARE"]),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  totalSeconds: z.number().int().nonnegative(),
  activitySeconds: z.number().int().nonnegative(),
  travelSeconds: z.number().int().nonnegative(),
  returnSeconds: z.number().int().nonnegative(),
  basis: z.enum(["USER_STATED", "VERIFIED_ROUTE", "PLANNING_ESTIMATE", "UNKNOWN"]),
  steps: z.array(z.string().min(1).max(400)).max(12),
  requiresGoOut: z.boolean(),
  targetRegion: z.string().nullable().optional(),
  verification: z.string(),
  label: z.string().max(160),
});
export const actionProgressSchema = z.object({
  state: z.enum(["NOT_STARTED", "ACTIVE", "COMPLETED", "CANCELLED"]),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  elapsedSeconds: z.number().int().nonnegative(),
});

export const answerNowQuestionRequestSchema = z.object({
  questionId: uuidSchema,
  optionId: z.string().min(1).max(64),
});
export const nowQuestionSchema = z.object({
  id: uuidSchema,
  key: z.enum(["AVAILABLE_TIME", "BUDGET", "GO_OUT"]),
  text: z.string(),
  options: z
    .array(z.object({ id: z.string(), label: z.string() }))
    .min(2)
    .max(6),
  sequence: z.number().int().min(1).max(2),
  maxQuestions: z.literal(2),
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
export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type ActionProgress = z.infer<typeof actionProgressSchema>;
export type NowContext = z.infer<typeof nowContextSchema>;
export type CreateNowSessionRequest = z.infer<typeof createNowSessionRequestSchema>;
export type AnswerNowQuestionRequest = z.infer<typeof answerNowQuestionRequestSchema>;
export type NowQuestion = z.infer<typeof nowQuestionSchema>;
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
  title: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
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
  progress: actionProgressSchema.optional(),
});
const routePointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  coordinateSystem: z.literal("GCJ02"),
});
export const routeSegmentSchema = z.object({
  mode: z.enum(["walking", "bicycling", "transit"]),
  points: z
    .array(
      z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
    )
    .min(2)
    .max(4096),
});
export type RouteSegment = z.infer<typeof routeSegmentSchema>;
export const routeSegmentsSchema = z
  .array(routeSegmentSchema)
  .min(1)
  .max(64)
  .refine((segments) => segments.reduce((sum, segment) => sum + segment.points.length, 0) <= 4096)
  .optional()
  .catch(undefined);
export const routeCheckDetailSchema = z.object({
  origin: routePointSchema,
  destination: routePointSchema,
  destinationLabel: z.string().min(1).max(240),
  destinationAddress: z.string().min(1).max(512).optional(),
  destinationSource: z.enum(["USER_SELECTED_MAP", "USER_SELECTED_POI"]).optional(),
  destinationIdentityVerified: z.literal(false).optional(),
  outwardSeconds: z.number().nonnegative(),
  returnSeconds: z.number().nonnegative(),
  outwardMeters: z.number().nonnegative(),
  returnMeters: z.number().nonnegative(),
  departureBlocker: z.string().nullable(),
  requiredSeconds: z.number().nonnegative().nullable(),
  availableSeconds: z.number().nonnegative().nullable().optional(),
  mode: z.enum(["walking", "bicycling", "transit"]).optional(),
  transitKind: z.enum(["BUS", "SUBWAY", "RAIL", "MIXED"]).optional(),
  transitMixed: z.boolean().optional(),
  selectionReason: z
    .enum([
      "WALKING_FITS",
      "FASTER_MODE_FITS",
      "FASTEST_VERIFIED",
      "NO_MODE_FITS",
      "SCENIC_BUS_PREFERENCE",
    ])
    .optional(),
  observedAt: z.iso.datetime().optional(),
  expiresAt: z.iso.datetime().optional(),
  returnTimingVerified: z.boolean().optional(),
  comparisonComplete: z.boolean().optional(),
  transportCostMinor: z.number().nonnegative().nullable().optional(),
  segments: routeSegmentsSchema,
});
export type RouteCheckDetail = z.infer<typeof routeCheckDetailSchema>;
export const routeCheckSchema = z.object({
  status: z.enum(["READY", "UNAVAILABLE", "NOT_CHECKED"]),
  reason: z
    .enum([
      "NOT_CONFIGURED",
      "ORIGIN_NOT_PRECISE",
      "DESTINATION_UNRESOLVED",
      "TIMEOUT",
      "RATE_LIMITED",
      "QUOTA_EXCEEDED",
      "PROVIDER_REJECTED",
      "PROVIDER_UNAVAILABLE",
      "INVALID_LOCATION",
      "INVALID_RESPONSE",
      "ROUTE_TOO_CLOSE",
      "ROUTE_TOO_LONG",
      "NO_ROUTE",
      "AMBIGUOUS_ADDRESS",
      "LOOKUP_LIMIT",
      "CURRENTLY_BUSY",
      "NOT_GEOGRAPHIC",
    ])
    .nullable(),
  detail: routeCheckDetailSchema.optional(),
});
export type RouteCheck = z.infer<typeof routeCheckSchema>;
export const publicCandidateSchema = z.object({
  lifeObjectId: uuidSchema,
  routeCheck: routeCheckSchema.nullable().optional(),
  actionKey: z.string().optional(),
  actionMode: z.enum(["DO", "PREPARE"]).optional(),
  actionTitle: z.string().optional(),
  requiredSeconds: z.number().nonnegative().nullable().optional(),
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
  selectedDestination: z
    .object({
      lifeObjectId: uuidSchema,
      name: z.string().min(1).max(240),
      address: z.string().min(1).max(512),
      source: z.enum(["USER_SELECTED_MAP", "USER_SELECTED_POI"]),
    })
    .nullable()
    .optional(),
  sessionId: uuidSchema,
  focusObjectId: uuidSchema.nullable().optional(),
  routeCheck: routeCheckSchema.nullable().optional(),
  status: z.enum(["QUIET", "RECOMMENDED", "NEEDS_ANSWER"]),
  replayed: z.boolean(),
  question: nowQuestionSchema.nullable().default(null),
  quietReason: z.string().nullable().optional(),
  recommendation: z
    .object({
      id: uuidSchema,
      targetLifeObjectId: uuidSchema,
      headline: z.string(),
      body: z.string(),
      reasonText: z.string(),
      executionType: executionTypeSchema,
      plan: actionPlanSchema.nullable().optional(),
      progress: actionProgressSchema.optional(),
      score: z.number(),
    })
    .nullable(),
  candidates: z.array(publicCandidateSchema),
});

export const lifeListItemSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  summary: z.string().nullable(),
  kind: facetTypeSchema,
  status: lifeStatusSchema,
  importance: z.number().nullable(),
  createdAt: z.iso.datetime(),
  searchText: z.string().nullable(),
  displayKind: z.string().nullable(),
});
export const lifeListResponseSchema = z.array(lifeListItemSchema);
export const lifeSectionSchema = z.enum([
  "UPCOMING",
  "RECENT",
  "RETURN",
  "REMEMBERED",
  "THINKING",
  "HAPPENED",
]);
export const lifeSectionTitles: Record<z.infer<typeof lifeSectionSchema>, string> = {
  RECENT: "最近留下",
  UPCOMING: "快到了",
  RETURN: "常回去",
  REMEMBERED: "一直没忘",
  THINKING: "最近总在想",
  HAPPENED: "已经发生",
};
export const lifeBrowseItemSchema = lifeListItemSchema.extend({
  myRating: z.enum(["LIKE", "DISLIKE", "NONE"]).default("NONE"),
  preferenceScore: z.number().min(-1).max(1).default(0),
  objectVersion: z.number().int().positive().optional(),
  nextAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  hasLocation: z.boolean(),
  placeLabel: z.string().max(240).nullable().optional(),
  distanceMeters: z.number().nonnegative().nullable(),
});
export const lifeSearchRequestSchema = z
  .object({
    section: lifeSectionSchema.default("RECENT"),
    savedWithinDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
    kind: facetTypeSchema.optional(),
    location: z.enum(["ALL", "LOCATED", "UNLOCATED", "NEARBY"]).default("ALL"),
    center: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        coordinateSystem: z.literal("GCJ02"),
        radiusMeters: z.union([z.literal(1000), z.literal(3000), z.literal(10000)]),
      })
      .optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .refine((input) => input.location !== "NEARBY" || input.center != null, {
    message: "Nearby requires a coordinate and radius",
    path: ["center"],
  });
export const lifeSearchResponseSchema = z.object({
  items: z.array(lifeBrowseItemSchema),
  nextCursor: z.string().nullable(),
});
export const lifeSectionsResponseSchema = z.array(
  z.object({
    section: lifeSectionSchema,
    title: z.string(),
    items: z.array(lifeBrowseItemSchema),
  }),
);
export type LifeSection = z.infer<typeof lifeSectionSchema>;
export type LifeBrowseItem = z.infer<typeof lifeBrowseItemSchema>;
export type LifeSearchRequest = z.infer<typeof lifeSearchRequestSchema>;
export type LifeSections = z.infer<typeof lifeSectionsResponseSchema>;
export const captureListResponseSchema = z.array(captureResponseSchema);
export const logoutResponseSchema = z.object({ loggedOut: z.literal(true) });
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type LifeListItem = z.infer<typeof lifeListItemSchema>;
export type CaptureResponse = z.infer<typeof captureResponseSchema>;
export type NowResponse = z.infer<typeof nowResponseSchema>;

export const patchLifeObjectRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    summary: z.string().max(1200).nullable().optional(),
    status: z.enum(["ACTIVE", "RESOLVED", "ARCHIVED"]).optional(),
    facts: z
      .array(
        z.object({
          type: facetTypeSchema,
          key: z.string().min(1).max(96),
          facts: structuredLifeFactsSchema,
        }),
      )
      .max(24)
      .optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "Provide at least one change");
export const rebuildFactsAcceptedSchema = z.object({
  lifeObjectId: uuidSchema,
  accepted: z.literal(true),
  replayed: z.boolean(),
});
export type PatchLifeObjectRequest = z.infer<typeof patchLifeObjectRequestSchema>;

export const lifeUpdatedSchema = z.object({
  id: uuidSchema,
  updated: z.literal(true),
  objectVersion: z.number().int().positive(),
  replayed: z.boolean(),
});

export const locationStatusSchema = z.object({
  provider: z.literal("TENCENT"),
  configured: z.boolean(),
  geocoding: z.boolean(),
  walkingRoutes: z.boolean(),
  destinationPersistence: z.literal(true),
});
export const locationRefreshRequestSchema = z.object({
  objectIds: z
    .array(uuidSchema)
    .min(1)
    .max(5)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate object IDs"),
});
export const locationRefreshAcceptedSchema = z.object({
  items: z
    .array(
      z.object({
        lifeObjectId: uuidSchema,
        eventId: uuidSchema.nullable(),
        status: z.enum(["QUEUED", "PENDING", "NOT_CONFIGURED", "NO_ADDRESS", "ALREADY_LOCATED"]),
      }),
    )
    .min(1)
    .max(5),
  replayed: z.boolean(),
});
export type LocationRefreshRequest = z.infer<typeof locationRefreshRequestSchema>;

export const locationChoicesRequestSchema = z
  .object({
    lifeObjectId: uuidSchema,
  })
  .strict();
export const locationChoiceSchema = z.object({
  token: z.string().min(1).max(8192),
  title: z.string().min(1).max(240),
  address: z.string().min(1).max(512),
  city: z.string().min(1).max(80),
  district: z.string().max(80).optional(),
});
export const locationChoicesResponseSchema = z.object({
  lifeObjectId: uuidSchema,
  choices: z.array(locationChoiceSchema).max(6),
  expiresAt: z.iso.datetime(),
  reason: z.string().max(64).nullable(),
});
export const locationSelectRequestSchema = z
  .object({
    lifeObjectId: uuidSchema,
    choiceToken: z.string().min(1).max(8192),
  })
  .strict();
export const locationSelectResponseSchema = z.object({
  lifeObjectId: uuidSchema,
  selected: z.literal(true),
  replayed: z.boolean(),
});
export type LocationChoicesRequest = z.infer<typeof locationChoicesRequestSchema>;
export type LocationSelectRequest = z.infer<typeof locationSelectRequestSchema>;
export const locationPickerIntentRequestSchema = z.object({ lifeObjectId: uuidSchema }).strict();
export const locationPickerIntentResponseSchema = z.object({
  lifeObjectId: uuidSchema,
  intentToken: z.string().min(1).max(8192),
  expiresAt: z.iso.datetime(),
});
export const locationMapSelectRequestSchema = z
  .object({
    lifeObjectId: uuidSchema,
    intentToken: z.string().min(1).max(8192),
    name: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
    address: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
    location: z
      .object({
        latitude: z.number().finite().min(18).max(54),
        longitude: z.number().finite().min(73).max(135),
        coordinateSystem: z.literal("GCJ02"),
      })
      .strict(),
  })
  .strict();
export const locationMapSelectResponseSchema = locationSelectResponseSchema;
export type LocationPickerIntentRequest = z.infer<typeof locationPickerIntentRequestSchema>;
export type LocationMapSelectRequest = z.infer<typeof locationMapSelectRequestSchema>;
export type LocationChoice = z.infer<typeof locationChoiceSchema>;

export const lifeRatingSchema = z.enum(["LIKE", "DISLIKE", "NONE"]);
export const setLifeRatingRequestSchema = z.strictObject({ rating: lifeRatingSchema });
export const lifeRatingAcceptedSchema = z.object({
  id: uuidSchema,
  rating: lifeRatingSchema,
  updated: z.literal(true),
  replayed: z.boolean(),
});
export const lifeDeletedSchema = z.object({
  id: uuidSchema,
  deleted: z.literal(true),
  replayed: z.boolean(),
});
export const lifeDeckRequestSchema = z.strictObject({
  kind: facetTypeSchema,
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const lifeDeckResponseSchema = z.object({
  items: z.array(lifeBrowseItemSchema),
  nextCursor: z.string().nullable(),
  asOf: z.iso.datetime(),
});
export const lifeStacksResponseSchema = z.array(
  lifeDeckResponseSchema.extend({ kind: facetTypeSchema, title: z.string() }),
);
export type LifeRating = z.infer<typeof lifeRatingSchema>;
export type LifeDeckRequest = z.infer<typeof lifeDeckRequestSchema>;
