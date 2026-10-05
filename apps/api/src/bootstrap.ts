import { WebSocketServer } from "ws";
import type { LocationProvider } from "@life/integrations";
import { VoiceService, type AsrSocketFactory } from "./media/voice.service.js";
import { AuthGuard } from "./common/security.js";
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

export async function createApiApp(
  options: { voiceSocketFactory?: AsrSocketFactory; locationProvider?: LocationProvider } = {},
): Promise<NestFastifyApplication> {
  checkWechatConfig();
  readAuthConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(options.voiceSocketFactory, options.locationProvider),
    new FastifyAdapter({ logger: true, bodyLimit: 3 * 1024 * 1024 }),
  );
  const fastify = app.getHttpAdapter().getInstance();
  const voice = app.get(VoiceService);
  const auth = app.get(AuthGuard);
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  fastify.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const ticket =
      url.pathname === "/v1/media/voice/stream" ? url.searchParams.get("ticket") : null;
    const session = ticket && /^[a-zA-Z0-9_-]{43}$/.test(ticket) ? voice.claim(ticket) : undefined;
    if (!session) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    void auth
      .assertActive(session.user)
      .then(() => {
        if (!socket.destroyed)
          socketServer.handleUpgrade(request, socket, head, (client) =>
            voice.relay(client, session),
          );
        else voice.discard(session.id);
      })
      .catch(() => {
        voice.discard(session.id);
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      });
  });
  fastify.addHook("onClose", (_instance, done) => {
    voice.shutdown();
    socketServer.close();
    done();
  });
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
