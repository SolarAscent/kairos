import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { userSettings, users, type Database } from "@life/db";
import {
  userSettingsResponseSchema,
  recommendationSettingsSchema,
  privacySettingsSchema,
  notificationSettingsSchema,
  type PatchUserSettingsRequest,
} from "@life/contracts";
import { DATABASE } from "../common/tokens.js";
import { IdempotencyService } from "../common/idempotency.service.js";

type Reader = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async get(userId: string, reader: Reader = this.db) {
    const [user] = await reader
      .select({ onboardingVersion: users.onboardingVersion })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, "ACTIVE"), isNull(users.deletedAt)))
      .limit(1);
    if (!user) throw new NotFoundException({ code: "SETTINGS_USER_NOT_FOUND" });
    const [saved] = await reader
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    const recommendation = recommendationSettingsSchema.safeParse(
      saved?.recommendationSettings ?? {},
    );
    const privacy = privacySettingsSchema.safeParse(saved?.privacySettings ?? {});
    const notifications = notificationSettingsSchema.safeParse(saved?.notificationSettings ?? {});
    return userSettingsResponseSchema.parse({
      recommendation: recommendation.success
        ? recommendation.data
        : recommendationSettingsSchema.parse({}),
      privacy: privacy.success ? privacy.data : privacySettingsSchema.parse({}),
      notifications: notifications.success
        ? notifications.data
        : notificationSettingsSchema.parse({}),
      onboardingCompleted: (user.onboardingVersion ?? 0) >= 1,
      updatedAt: saved?.updatedAt.toISOString() ?? null,
    });
  }

  async patch(userId: string, input: PatchUserSettingsRequest, key: string | undefined) {
    const result = await this.idempotency.execute(
      userId,
      "PATCH /v1/settings",
      key,
      input,
      async (tx) => {
        // Serialize partial updates across different idempotency keys to avoid lost preferences.
        const [user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, userId), eq(users.status, "ACTIVE"), isNull(users.deletedAt)))
          // Non-key updates serialize preference merges without conflicting with
          // idempotency rows' foreign-key KEY SHARE locks on the same user.
          .for("no key update")
          .limit(1);
        if (!user) throw new NotFoundException({ code: "SETTINGS_USER_NOT_FOUND" });
        const [saved] = await tx
          .select()
          .from(userSettings)
          .where(eq(userSettings.userId, userId))
          .limit(1);
        const current = await this.get(userId, tx);
        const now = new Date();
        const values = {
          recommendationSettings: {
            ...(saved?.recommendationSettings ?? {}),
            ...current.recommendation,
            ...input.recommendation,
          },
          privacySettings: {
            ...(saved?.privacySettings ?? {}),
            ...current.privacy,
            ...input.privacy,
          },
          notificationSettings: {
            ...(saved?.notificationSettings ?? {}),
            ...current.notifications,
            ...input.notifications,
          },
          updatedAt: now,
        };
        await tx
          .insert(userSettings)
          .values({ userId, ...values })
          .onConflictDoUpdate({ target: userSettings.userId, set: values });
        if (input.onboardingCompleted !== undefined) {
          await tx
            .update(users)
            .set({ onboardingVersion: input.onboardingCompleted ? 1 : null, updatedAt: now })
            .where(eq(users.id, userId));
        }
        return this.get(userId, tx);
      },
    );
    return result.body;
  }
}
