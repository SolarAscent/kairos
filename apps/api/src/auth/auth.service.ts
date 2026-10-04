import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { authSessions, userIdentities, users, type Database } from "@life/db";
import type { LoginRequest, RefreshRequest } from "@life/contracts";
import { DATABASE } from "../common/tokens.js";
import { readAuthConfig } from "../common/auth-config.js";
import { createAccessToken } from "../common/security.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

@Injectable()
export class AuthService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private async resolveWechatCode(code: string): Promise<{ openId: string; unionId?: string }> {
    const mockEnabled = process.env.WECHAT_MOCK_LOGIN === "true";
    if (mockEnabled && process.env.NODE_ENV !== "production")
      return { openId: "local-demo:" + code };
    if (!process.env.WECHAT_APP_ID || !process.env.WECHAT_APP_SECRET)
      throw new ServiceUnavailableException({ code: "WECHAT_LOGIN_NOT_CONFIGURED" });
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.searchParams.set("appid", process.env.WECHAT_APP_ID);
    url.searchParams.set("secret", process.env.WECHAT_APP_SECRET);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok)
      throw new ServiceUnavailableException({ code: "WECHAT_PROVIDER_UNAVAILABLE" });
    const payload = (await response.json()) as {
      openid?: string;
      unionid?: string;
      errcode?: number;
    };
    if (!payload.openid || payload.errcode)
      throw new BadRequestException({ code: "WECHAT_CODE_INVALID" });
    return { openId: payload.openid, unionId: payload.unionid };
  }

  async login(input: LoginRequest) {
    const identity = await this.resolveWechatCode(input.code);
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
        .for("share");
      if (!user) throw new UnauthorizedException({ code: "ACCOUNT_INACTIVE" });
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
        .for("share");
      if (!user) throw new UnauthorizedException({ code: "ACCOUNT_INACTIVE" });
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
