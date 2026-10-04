import { BadRequestException, createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedUser } from "./security.js";

export type ApiRequest = FastifyRequest & {
  requestId: string;
  traceId: string;
  user?: AuthenticatedUser;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    if (!request.user) throw new Error("AUTH_CONTEXT_MISSING");
    return request.user;
  },
);

export function parseBody<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException({ code: "VALIDATION_ERROR", details: result.error.flatten() });
  return result.data;
}

export function success<T>(request: ApiRequest, data: T) {
  return { data, request_id: request.requestId };
}
