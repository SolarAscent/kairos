import { applyDecorators } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiResponse } from "@nestjs/swagger";
import type { SchemaObject } from "@nestjs/swagger";
import { successEnvelope } from "@life/contracts";
import { z } from "zod";

export function ApiContract(
  response: z.ZodType,
  body?: z.ZodType,
  status = 200,
  idempotent = false,
) {
  return applyDecorators(
    ApiResponse({ status, schema: z.toJSONSchema(successEnvelope(response)) as SchemaObject }),
    ...(body ? [ApiBody({ schema: z.toJSONSchema(body, { io: "input" }) as SchemaObject })] : []),
    ...(idempotent
      ? [
          ApiHeader({
            name: "X-Idempotency-Key",
            required: true,
            schema: { type: "string", format: "uuid" },
          }),
        ]
      : []),
  );
}
