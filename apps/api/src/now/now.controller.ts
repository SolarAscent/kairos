import { ApiContract } from "../common/api-contract.js";
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
import { createNowSessionRequestSchema, nowResponseSchema, uuidSchema } from "@life/contracts";
import { ApiRequest, CurrentUser, parseBody, success } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import { NowService } from "./now.service.js";

@ApiTags("now")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("/v1/now")
export class NowController {
  constructor(@Inject(NowService) private readonly now: NowService) {}
  @Post("sessions")
  @ApiContract(nowResponseSchema, createNowSessionRequestSchema, 201, true)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers("x-idempotency-key") key: string | undefined,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.now.create(user.id, parseBody(createNowSessionRequestSchema, body), key),
    );
  }
  @Get("sessions/:id")
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") idInput: string,
    @Req() request: ApiRequest,
  ) {
    return success(request, await this.now.get(user.id, parseBody(uuidSchema, idInput)));
  }
}
