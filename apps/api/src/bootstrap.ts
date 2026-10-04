import "reflect-metadata";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { v7 as uuidv7 } from "uuid";
import { uuidSchema } from "@life/contracts";
import { readAuthConfig } from "./common/auth-config.js";
import type { ApiRequest } from "./common/http.js";
import { AppModule } from "./app.module.js";
import { HttpExceptionFilter } from "./common/http-exception.filter.js";
import { checkWechatConfig } from "./auth/wechat.provider.js";

export async function createApiApp(): Promise<NestFastifyApplication> {
  checkWechatConfig();
  readAuthConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onRequest", (request, reply, done) => {
    const apiRequest = request as ApiRequest;
    apiRequest.requestId = uuidv7();
    const incomingTrace = request.headers["x-trace-id"];
    apiRequest.traceId = uuidSchema.safeParse(incomingTrace).success
      ? (incomingTrace as string)
      : uuidv7();
    reply.header("x-request-id", apiRequest.requestId);
    reply.header("x-trace-id", apiRequest.traceId);
    done();
  });
  app.enableCors({
    origin: process.env.DEMO_ORIGIN ?? "http://localhost:5173",
    credentials: false,
  });
  app.enableShutdownHooks();
  app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
  const config = new DocumentBuilder()
    .setTitle("Life Decision API")
    .setDescription("Capture → Life → Context → Action")
    .setVersion("0.2.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.openapi = "3.1.0";
  SwaggerModule.setup("/docs", app, document);
  return app;
}
