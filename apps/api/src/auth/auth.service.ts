import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { authSessions, userIdentities, users, type Database } from "@life/db";
import type { LoginRequest, RefreshRequest } from "@life/contracts";
import { DATABASE } from "../common/tokens.js";
import { readAuthConfig } from "../common/auth-config.js";
import { createAccessToken } from "../common/security.js";
import { resolveWechatCode } from "./wechat.provider.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

@Injectable()
export class AuthService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async login(input: LoginRequest) {
    const identity = await resolveWechatCode(input.code);
    const sessionId = uuidv7();
    const refreshToken = randomBytes(48).toString("base64url");
    const days = readAuthConfig().REFRESH_TOKEN_TTL_DAYS;
    const expiresAt = new Date(Date.now() + days * 86400000);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${"WECHAT:" + identity.openId}, 0))`,
      );
      const [found] = await tx
        .select({ userId: userIdentities.userId })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.provider, "WECHAT"),
            eq(userIdentities.providerSubject, identity.openId),
          ),
        )
        .limit(1);
      const userId = found?.userId ?? uuidv7();
      if (!found) {
        await tx.insert(users).values({ id: userId });
        await tx.insert(userIdentities).values({
          id: uuidv7(),
          userId,
          provider: "WECHAT",
          providerSubject: identity.openId,
          unionSubject: identity.unionId,
        });
      }
      const [user] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, userId), eq(users.status, "ACTIVE"), isNull(users.deletedAt)))
        .for("update");
      if (!user) throw new UnauthorizedException({ code: "ACCOUNT_INACTIVE" });
      await tx.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, userId));
      await tx.insert(authSessions).values({
        id: sessionId,
        userId,
        refreshTokenHash: sha256(refreshToken),
        clientInstallationId: input.clientInstallationId,
        expiresAt,
      });
      return {
        userId,
        accessToken: createAccessToken(userId, sessionId),
        refreshToken,
        expiresIn: readAuthConfig().ACCESS_TOKEN_TTL_SECONDS,
      };
    });
  }

  async refresh(input: RefreshRequest) {
    const oldHash = sha256(input.refreshToken);
    const sessionId = uuidv7();
    const refreshToken = randomBytes(48).toString("base64url");
    const days = readAuthConfig().REFRESH_TOKEN_TTL_DAYS;
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(authSessions)
        .where(and(eq(authSessions.refreshTokenHash, oldHash), isNull(authSessions.revokedAt)))
        .for("update")
        .limit(1);
      if (!session || session.expiresAt <= new Date())
        throw new UnauthorizedException({ code: "REFRESH_TOKEN_INVALID" });
      const [user] = await tx
        .select()
        .from(users)
        .where(
          and(eq(users.id, session.userId), eq(users.status, "ACTIVE"), isNull(users.deletedAt)),
        )
        .for("update");
      if (!user) throw new UnauthorizedException({ code: "ACCOUNT_INACTIVE" });
      await tx.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, session.userId));
      await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(eq(authSessions.id, session.id));
      await tx.insert(authSessions).values({
        id: sessionId,
        userId: session.userId,
        refreshTokenHash: sha256(refreshToken),
        clientInstallationId: session.clientInstallationId,
        expiresAt: new Date(Date.now() + days * 86400000),
      });
      return {
        userId: session.userId,
        accessToken: createAccessToken(session.userId, sessionId),
        refreshToken,
        expiresIn: readAuthConfig().ACCESS_TOKEN_TTL_SECONDS,
      };
    });
  }

  async logout(userId: string, sessionId: string) {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)));
    return { loggedOut: true };
  }
}
