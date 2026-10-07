import { MediaController } from "./media/media.controller.js";
import { VoiceService, type AsrSocketFactory } from "./media/voice.service.js";
import { Module, type DynamicModule } from "@nestjs/common";
import { DatabaseModule } from "./common/database.module.js";
import { IdempotencyService } from "./common/idempotency.service.js";
import { AuthGuard } from "./common/security.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { CapturesController } from "./captures/captures.controller.js";
import { CapturesService } from "./captures/captures.service.js";
import { LifeController } from "./life/life.controller.js";
import { LifeService } from "./life/life.service.js";
import { LocationController } from "./locations/location.controller.js";
import { PlaceLocationService } from "./locations/place-location.service.js";
import { LocationChoiceService } from "./locations/location-choice.service.js";
import { LocationMapSelectionService } from "./locations/location-map-selection.service.js";
import { ContextController } from "./context/context.controller.js";
import type { LocationProvider } from "@life/integrations";
import {
  BuildDecisionContextService,
  LOCATION_PROVIDER,
} from "./context/build-decision-context.service.js";
import { ActionPlanService } from "./planning/action-plan.service.js";
import { NowController } from "./now/now.controller.js";
import { NowService } from "./now/now.service.js";
import { FeedbackController } from "./feedback/feedback.controller.js";
import { FeedbackService } from "./feedback/feedback.service.js";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [DatabaseModule],
  controllers: [
    AuthController,
    MediaController,
    CapturesController,
    LifeController,
    LocationController,
    NowController,
    ContextController,
    FeedbackController,
    HealthController,
  ],
  providers: [
    IdempotencyService,
    AuthGuard,
    AuthService,
    CapturesService,
    LifeService,
    PlaceLocationService,
    LocationChoiceService,
    LocationMapSelectionService,
    NowService,
    BuildDecisionContextService,
    ActionPlanService,
    FeedbackService,
  ],
})
export class AppModule {
  static forRoot(
    voiceSocketFactory?: AsrSocketFactory,
    locationProvider?: LocationProvider,
  ): DynamicModule {
    return {
      module: AppModule,
      providers: [
        ...(locationProvider ? [{ provide: LOCATION_PROVIDER, useValue: locationProvider }] : []),
        { provide: VoiceService, useFactory: () => new VoiceService(voiceSocketFactory) },
      ],
    };
  }
}
