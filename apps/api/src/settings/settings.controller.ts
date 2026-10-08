import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { patchUserSettingsRequestSchema, userSettingsResponseSchema } from "@life/contracts";
import { ApiContract } from "../common/api-contract.js";
import { ApiRequest, CurrentUser, parseBody, success } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import { SettingsService } from "./settings.service.js";

@ApiTags("settings")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("/v1/settings")
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}
  @Get()
  @ApiContract(userSettingsResponseSchema)
  async get(@CurrentUser() user: AuthenticatedUser, @Req() request: ApiRequest) {
    return success(request, await this.settings.get(user.id));
  }
  @Patch()
  @ApiContract(userSettingsResponseSchema, patchUserSettingsRequestSchema, 200, true)
  async patch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.settings.patch(user.id, parseBody(patchUserSettingsRequestSchema, body), key),
    );
  }
  @Post("update")
  @HttpCode(200)
  @ApiContract(userSettingsResponseSchema, patchUserSettingsRequestSchema, 200, true)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() request: ApiRequest,
  ) {
    return this.patch(user, body, key, request);
  }
}
