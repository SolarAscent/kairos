import { Body, Controller, Get, Headers, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { userProfileSchema, userAvatarSchema, updateProfileRequestSchema } from "@life/contracts";
import { ApiContract } from "../common/api-contract.js";
import { ApiRequest, CurrentUser, parseBody, success } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import { ProfileService } from "./profile.service.js";

@ApiTags("users")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("/v1/users/me")
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly profiles: ProfileService) {}

  @Get()
  @ApiContract(userProfileSchema)
  @ApiOperation({ summary: "读取当前账户的个人资料" })
  async get(@CurrentUser() user: AuthenticatedUser, @Req() request: ApiRequest) {
    return success(request, await this.profiles.get(user.id));
  }

  @Get("avatar")
  @ApiContract(userAvatarSchema)
  async avatar(@CurrentUser() user: AuthenticatedUser, @Req() request: ApiRequest) {
    return success(request, await this.profiles.avatar(user.id));
  }

  @Post("profile")
  @ApiContract(userProfileSchema, updateProfileRequestSchema, 201, true)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.profiles.update(user.id, parseBody(updateProfileRequestSchema, body), key),
    );
  }
}
