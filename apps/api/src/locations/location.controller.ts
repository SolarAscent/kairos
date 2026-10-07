import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  uuidSchema,
  locationChoicesRequestSchema,
  locationChoicesResponseSchema,
  locationSelectRequestSchema,
  locationSelectResponseSchema,
  locationPickerIntentRequestSchema,
  locationPickerIntentResponseSchema,
  locationMapSelectRequestSchema,
  locationMapSelectResponseSchema,
} from "@life/contracts";
import { ApiContract } from "../common/api-contract.js";
import { ApiRequest, CurrentUser, parseBody, success } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import {
  locationRefreshAcceptedSchema,
  locationRefreshRequestSchema,
  locationStatusSchema,
} from "./location.contracts.js";
import { PlaceLocationService } from "./place-location.service.js";
import { LocationChoiceService } from "./location-choice.service.js";
import { LocationMapSelectionService } from "./location-map-selection.service.js";

@ApiTags("locations")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("/v1/locations")
export class LocationController {
  constructor(
    @Inject(PlaceLocationService) private readonly locations: PlaceLocationService,
    @Inject(LocationChoiceService) private readonly choiceService: LocationChoiceService,
    @Inject(LocationMapSelectionService) private readonly mapSelection: LocationMapSelectionService,
  ) {}
  @Post("picker-intents")
  @ApiContract(locationPickerIntentResponseSchema, locationPickerIntentRequestSchema)
  async pickerIntent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.mapSelection.intent(user.id, parseBody(locationPickerIntentRequestSchema, body)),
    );
  }
  @Post("map-select")
  @ApiContract(locationMapSelectResponseSchema, locationMapSelectRequestSchema, 201, true)
  async mapSelect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.mapSelection.select(
        user.id,
        parseBody(locationMapSelectRequestSchema, body),
        key,
        request.traceId,
      ),
    );
  }
  @Post("choices")
  @ApiContract(locationChoicesResponseSchema, locationChoicesRequestSchema)
  async choices(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.choiceService.choices(user.id, parseBody(locationChoicesRequestSchema, body)),
    );
  }
  @Post("select")
  @ApiContract(locationSelectResponseSchema, locationSelectRequestSchema, 201, true)
  async select(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.choiceService.select(
        user.id,
        parseBody(locationSelectRequestSchema, body),
        key,
        request.traceId,
      ),
    );
  }
  @Get("status")
  @ApiContract(locationStatusSchema)
  async status(@CurrentUser() _user: AuthenticatedUser, @Req() request: ApiRequest) {
    return success(request, this.locations.status());
  }
  @Post("refresh")
  @ApiContract(locationRefreshAcceptedSchema, locationRefreshRequestSchema, 201, true)
  async refresh(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.locations.refresh(
        user.id,
        parseBody(locationRefreshRequestSchema, body),
        key,
        request.traceId,
      ),
    );
  }
  @Post(":id/refresh")
  @ApiContract(locationRefreshAcceptedSchema, undefined, 201, true)
  async single(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.locations.refresh(
        user.id,
        { objectIds: [parseBody(uuidSchema, id)] },
        key,
        request.traceId,
      ),
    );
  }
}
