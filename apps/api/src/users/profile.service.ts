import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { users, userIdentities, type Database } from "@life/db";
import { MAX_AVATAR_BYTES, type UpdateProfileRequest, type UserProfile } from "@life/contracts";
import { DATABASE } from "../common/tokens.js";
import { IdempotencyService } from "../common/idempotency.service.js";

type Reader = Pick<Database, "select">;
const activeUser = (userId: string) =>
  and(eq(users.id, userId), eq(users.status, "ACTIVE"), isNull(users.deletedAt));

@Injectable()
export class ProfileService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async get(userId: string, reader: Reader = this.db): Promise<UserProfile> {
    const [user] = await reader
      .select({
        userId: users.id,
        nickname: users.nickname,
        bio: users.bio,
        avatarVersion: users.avatarVersion,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(activeUser(userId))
      .limit(1);
    if (!user) throw new UnauthorizedException({ code: "ACCOUNT_INACTIVE" });
    const identities = await reader
      .select({ subject: userIdentities.providerSubject })
      .from(userIdentities)
      .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, "WECHAT")));
    const identityProvider = identities.some((item) => !item.subject.startsWith("local-demo:"))
      ? "WECHAT"
      : identities.length
        ? "DEVELOPMENT"
        : "NONE";
    return {
      ...user,
      identityProvider,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  async avatar(userId: string) {
    const [user] = await this.db
      .select({
        avatarVersion: users.avatarVersion,
        mimeType: users.avatarMimeType,
        base64: users.avatarBase64,
      })
      .from(users)
      .where(activeUser(userId))
      .limit(1);
    if (!user) throw new UnauthorizedException({ code: "ACCOUNT_INACTIVE" });
    return {
      avatarVersion: user.avatarVersion,
      image: user.avatarVersion ? { mimeType: user.mimeType, base64: user.base64 } : null,
    };
  }

  async update(userId: string, input: UpdateProfileRequest, key: string | undefined) {
    if (input.avatar) {
      const bytes = Buffer.from(input.avatar.base64, "base64");
      const valid =
        bytes.length > 8 &&
        bytes.length <= MAX_AVATAR_BYTES &&
        bytes.toString("base64") === input.avatar.base64 &&
        (input.avatar.mimeType === "image/png"
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])));
      if (!valid) throw new BadRequestException({ code: "AVATAR_FORMAT_OR_SIZE_INVALID" });
    }
    const result = await this.idempotency.execute(
      userId,
      "POST /v1/users/me/profile",
      key,
      input,
      async (tx) => {
        await tx
          .update(users)
          .set({
            nickname: input.nickname,
            bio: input.bio,
            updatedAt: new Date(),
            ...(input.avatar === undefined
              ? {}
              : input.avatar === null
                ? { avatarVersion: null, avatarMimeType: null, avatarBase64: null }
                : {
                    avatarVersion: uuidv7(),
                    avatarMimeType: input.avatar.mimeType,
                    avatarBase64: input.avatar.base64,
                  }),
          })
          .where(activeUser(userId));
        return this.get(userId, tx);
      },
    );
    return result.body;
  }
}
