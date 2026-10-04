import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authSessions, users, type Database } from "@life/db";
import { DATABASE } from "./tokens.js";
import type { ApiRequest } from "./http.js";

import { z } from "zod";
import { uuidSchema } from "@life/contracts";
import { readAuthConfig } from "./auth-config.js";

const tokenHeaderSchema = z.object({ alg: z.literal("HS256"), typ: z.literal("JWT") });
const tokenPayloadSchema = z.object({
  sub: uuidSchema,
  sid: uuidSchema,
  exp: z.number().int(),
  iss: z.literal("life-api"),
  aud: z.literal("life-client"),
});

export interface AuthenticatedUser {
  id: string;
  sessionId: string;
}

function signature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createAccessToken(
  userId: string,
  sessionId: string,
  now = Math.floor(Date.now() / 1000),
) {
  const { JWT_SECRET: secret, ACCESS_TOKEN_TTL_SECONDS: ttl } = readAuthConfig();
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      sid: sessionId,
      iat: now,
      exp: now + ttl,
      iss: "life-api",
      aud: "life-client",
    }),
  ).toString("base64url");
  const content = header + "." + payload;
  return content + "." + signature(content, secret);
}

export function verifyAccessToken(
  token: string,
  now = Math.floor(Date.now() / 1000),
): AuthenticatedUser {
  const { JWT_SECRET: secret } = readAuthConfig();
  const parts = token.split(".");
  if (parts.length !== 3) throw new UnauthorizedException({ code: "INVALID_TOKEN" });
  const content = parts[0] + "." + parts[1];
  const expected = Buffer.from(signature(content, secret));
  const supplied = Buffer.from(parts[2]!);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    throw new UnauthorizedException({ code: "INVALID_TOKEN" });
  try {
    tokenHeaderSchema.parse(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
    const payload = tokenPayloadSchema.parse(
      JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")),
    );
    if (payload.exp <= now) throw new UnauthorizedException({ code: "TOKEN_EXPIRED_OR_INVALID" });
    return { id: payload.sub, sessionId: payload.sid };
  } catch (error) {
    if (error instanceof UnauthorizedException) throw error;
    throw new UnauthorizedException({ code: "INVALID_TOKEN" });
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer "))
      throw new UnauthorizedException({ code: "AUTH_REQUIRED" });
    const user = verifyAccessToken(authorization.slice(7));
    const [session] = await this.db
      .select({ id: authSessions.id })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(
        and(
          eq(authSessions.id, user.sessionId),
          eq(authSessions.userId, user.id),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, new Date()),
          eq(users.status, "ACTIVE"),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!session) throw new UnauthorizedException({ code: "SESSION_REVOKED" });
    request.user = user;
    return true;
  }
}
