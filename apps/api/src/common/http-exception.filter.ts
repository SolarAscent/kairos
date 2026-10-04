import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import type { ApiRequest } from "./http.js";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<ApiRequest>();
    const reply = context.getResponse();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const payload = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const code =
      typeof payload.code === "string"
        ? payload.code
        : status >= 500
          ? "INTERNAL_ERROR"
          : "REQUEST_ERROR";
    const message = typeof payload.message === "string" ? payload.message : code;
    this.adapterHost.httpAdapter.reply(
      reply,
      {
        error: {
          code,
          message,
          retryable: status >= 500 || status === 429,
          request_id: request.requestId ?? null,
        },
      },
      status,
    );
    if (status >= 500) {
      const diagnostic = exception as { code?: unknown } | null;
      const diagnosticCode =
        typeof diagnostic?.code === "string" && /^[A-Z0-9_]+$/u.test(diagnostic.code)
          ? diagnostic.code
          : null;
      console.error(
        JSON.stringify({
          level: "error",
          request_id: request.requestId,
          trace_id: request.traceId,
          code,
          exception_type: exception instanceof Error ? exception.constructor.name : "UNKNOWN",
          diagnostic_code: diagnosticCode,
        }),
      );
    }
  }
}
