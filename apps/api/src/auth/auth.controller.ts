import { ApiContract } from "../common/api-contract.js";
import { Body, Controller, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  authResponseSchema,
  loginRequestSchema,
  refreshRequestSchema,
  logoutResponseSchema,
} from "@life/contracts";
import { ApiRequest, CurrentUser, parseBody, success } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import { AuthService } from "./auth.service.js";

@ApiTags("auth")
@Controller("/v1/auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("/wechat/login")
  @ApiContract(authResponseSchema, loginRequestSchema, 201)
  @ApiOperation({ summary: "通过微信临时代码建立会话" })
  async login(@Body() body: unknown, @Req() request: ApiRequest) {
    return success(request, await this.auth.login(parseBody(loginRequestSchema, body)));
  }

  @Post("/refresh")
  @ApiContract(authResponseSchema, refreshRequestSchema, 201)
  async refresh(@Body() body: unknown, @Req() request: ApiRequest) {
    return success(request, await this.auth.refresh(parseBody(refreshRequestSchema, body)));
  }

  @Post("/logout")
  @ApiContract(logoutResponseSchema, undefined, 201)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() request: ApiRequest) {
    return success(request, await this.auth.logout(user.id, user.sessionId));
  }
}
