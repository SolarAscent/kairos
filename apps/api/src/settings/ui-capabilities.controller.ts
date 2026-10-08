import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiResponse,
  ApiTags,
  type SchemaObject,
} from "@nestjs/swagger";
import { z } from "zod";
import {
  captureArrangementRequestSchema,
  nearbyDiscoveryRequestSchema,
  recordExportPageSchema,
  recordExportRequestSchema,
  reminderSubscriptionRequestSchema,
  ticketVerificationRequestSchema,
  uiCapabilitiesResponseSchema,
  uuidSchema,
} from "@life/contracts";
import { ApiContract } from "../common/api-contract.js";
import { ApiRequest, CurrentUser, parseBody, success } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import { LifeService } from "../life/life.service.js";
import { CapturesService } from "../captures/captures.service.js";

@ApiTags("integration-boundaries")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("/v1")
export class UiCapabilitiesController {
  constructor(
    @Inject(LifeService) private readonly life: LifeService,
    @Inject(CapturesService) private readonly captures: CapturesService,
  ) {}
  @Get("ui-capabilities")
  @ApiContract(uiCapabilitiesResponseSchema)
  get(@Req() request: ApiRequest) {
    return success(request, {
      ticketVerification: { available: false, reason: "NOT_INTEGRATED" },
      reminderDelivery: { available: false, reason: "NOT_INTEGRATED" },
      mediaArchive: { available: true, reason: "AVAILABLE" },
      recordExport: { available: true, reason: "AVAILABLE" },
    });
  }
  private async owned(userId: string, objectId: string, key: string | undefined) {
    if (!uuidSchema.safeParse(key).success)
      throw new BadRequestException({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await this.life.get(userId, objectId);
  }
  @Post("tickets/verify")
  @ApiBody({ schema: z.toJSONSchema(ticketVerificationRequestSchema) as SchemaObject })
  @ApiHeader({
    name: "X-Idempotency-Key",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiResponse({
    status: 501,
    description:
      "Ticket issuer verification has not been integrated; no verification is performed.",
  })
  async verify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Headers("x-idempotency-key") key: string | undefined,
  ) {
    const input = parseBody(ticketVerificationRequestSchema, body);
    await this.owned(user.id, input.lifeObjectId, key);
    throw new HttpException(
      { code: "TICKET_VERIFICATION_NOT_INTEGRATED" },
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
  @Post("reminders/subscriptions")
  @ApiBody({ schema: z.toJSONSchema(reminderSubscriptionRequestSchema) as SchemaObject })
  @ApiHeader({
    name: "X-Idempotency-Key",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiResponse({
    status: 501,
    description:
      "Reminder scheduling and WeChat subscription delivery have not been integrated; no reminder is created.",
  })
  async reminder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Headers("x-idempotency-key") key: string | undefined,
  ) {
    const input = parseBody(reminderSubscriptionRequestSchema, body);
    await this.owned(user.id, input.lifeObjectId, key);
    throw new HttpException(
      { code: "REMINDER_DELIVERY_NOT_INTEGRATED" },
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
  @Get("records/export")
  @ApiContract(recordExportPageSchema)
  async exportRecords(@CurrentUser() user: AuthenticatedUser, @Req() request: ApiRequest) {
    const input = parseBody(recordExportRequestSchema, request.query);
    return success(request, await this.captures.exportPage(user.id, input.cursor));
  }
  @Post("captures/arrangements")
  @ApiBody({ schema: z.toJSONSchema(captureArrangementRequestSchema) as SchemaObject })
  @ApiHeader({
    name: "X-Idempotency-Key",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiResponse({
    status: 501,
    description: "Capture scheduling and ticket association are reserved; no arrangement is saved.",
  })
  async arrange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Headers("x-idempotency-key") key: string | undefined,
  ) {
    const input = parseBody(captureArrangementRequestSchema, body);
    if (!uuidSchema.safeParse(key).success)
      throw new BadRequestException({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await this.captures.get(user.id, input.captureId);
    if (input.ticketLifeObjectId) {
      const ticket = await this.life.get(user.id, input.ticketLifeObjectId);
      if (ticket.kind !== "ASSET") throw new BadRequestException({ code: "TICKET_ASSET_REQUIRED" });
    }
    throw new HttpException(
      { code: "CAPTURE_ARRANGEMENT_NOT_INTEGRATED" },
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
  @Get("places/discover")
  @ApiResponse({
    status: 501,
    description: "Nearby POI discovery is reserved; no places or travel times are invented.",
  })
  discover(@Req() request: ApiRequest) {
    parseBody(nearbyDiscoveryRequestSchema, request.query);
    throw new HttpException(
      { code: "NEARBY_DISCOVERY_NOT_INTEGRATED" },
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
}
