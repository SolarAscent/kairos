import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  uuidSchema,
  lifeListResponseSchema,
  lifeSearchRequestSchema,
  lifeSearchResponseSchema,
  lifeSectionsResponseSchema,
} from "@life/contracts";
import { ApiContract } from "../common/api-contract.js";
import { ApiRequest, CurrentUser, parseBody, success } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import { LifeService } from "./life.service.js";

@ApiTags("life")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("/v1/life")
export class LifeController {
  constructor(@Inject(LifeService) private readonly life: LifeService) {}
  @Get()
  @ApiContract(lifeListResponseSchema)
  async list(@CurrentUser() user: AuthenticatedUser, @Req() request: ApiRequest) {
    return success(request, await this.life.list(user.id));
  }
  @Get("sections")
  @ApiContract(lifeSectionsResponseSchema)
  async sections(@CurrentUser() user: AuthenticatedUser, @Req() request: ApiRequest) {
    return success(request, await this.life.sections(user.id));
  }
  // Read-only POST keeps temporary coordinates out of URL/access logs.
  @Post("search")
  @HttpCode(200)
  @ApiContract(lifeSearchResponseSchema, lifeSearchRequestSchema)
  async search(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.life.search(user.id, parseBody(lifeSearchRequestSchema, body)),
    );
  }
  @Get(":id")
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") idInput: string,
    @Req() request: ApiRequest,
  ) {
    return success(request, await this.life.get(user.id, parseBody(uuidSchema, idInput)));
  }
}
