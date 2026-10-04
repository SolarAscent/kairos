import { Module } from "@nestjs/common";
import { DatabaseModule } from "./common/database.module.js";
import { IdempotencyService } from "./common/idempotency.service.js";
import { AuthGuard } from "./common/security.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { CapturesController } from "./captures/captures.controller.js";
import { CapturesService } from "./captures/captures.service.js";
import { LifeController } from "./life/life.controller.js";
import { LifeService } from "./life/life.service.js";
import { NowController } from "./now/now.controller.js";
import { NowService } from "./now/now.service.js";
import { FeedbackController } from "./feedback/feedback.controller.js";
import { FeedbackService } from "./feedback/feedback.service.js";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [DatabaseModule],
  controllers: [
    AuthController,
    CapturesController,
    LifeController,
    NowController,
    FeedbackController,
    HealthController,
  ],
  providers: [
    IdempotencyService,
    AuthGuard,
    AuthService,
    CapturesService,
    LifeService,
    NowService,
    FeedbackService,
  ],
})
export class AppModule {}
