import { z } from "zod";
import { ApiContract } from "../common/api-contract.js";
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  captureAcceptedSchema,
  captureResponseSchema,
  captureImageResponseSchema,
  capturePageRequestSchema,
  capturePageResponseSchema,
  createCaptureRequestSchema,
  uuidSchema,
} from "@life/contracts";
import { ApiRequest, CurrentUser, parseBody, success } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import { CapturesService } from "./captures.service.js";

@ApiTags("captures")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("/v1/captures")
export class CapturesController {
  constructor(@Inject(CapturesService) private readonly captures: CapturesService) {}

  @Post()
  @ApiContract(captureAcceptedSchema, createCaptureRequestSchema, 201, true)
  @ApiOperation({ summary: "先保存文本输入，再异步理解" })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers("x-idempotency-key") key: string | undefined,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    const input = parseBody(createCaptureRequestSchema, body);
    return success(request, await this.captures.create(user.id, input, key, request.traceId));
  }

  @Get()
  @ApiContract(z.array(captureResponseSchema))
  async list(@CurrentUser() user: AuthenticatedUser, @Req() request: ApiRequest) {
    return success(request, await this.captures.list(user.id));
  }

  @Get("page")
  @ApiContract(capturePageResponseSchema)
  @ApiOperation({ summary: "按固定创建时间截止分页查看全部原始记录" })
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
    @Req() request: ApiRequest,
  ) {
    const input = parseBody(capturePageRequestSchema, query);
    return success(request, await this.captures.page(user.id, input.cursor));
  }

  @Get(":id")
  @ApiContract(captureResponseSchema)
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") idInput: string,
    @Req() request: ApiRequest,
  ) {
    return success(request, await this.captures.get(user.id, parseBody(uuidSchema, idInput)));
  }
  @Get(":id/image")
  @ApiContract(captureImageResponseSchema)
  async image(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") idInput: string,
    @Req() request: ApiRequest,
  ) {
    return success(request, await this.captures.image(user.id, parseBody(uuidSchema, idInput)));
  }
}
