import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Patch,
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
  patchLifeObjectRequestSchema,
  lifeUpdatedSchema,
  rebuildFactsAcceptedSchema,
  lifeListResponseSchema,
  lifeSearchRequestSchema,
  lifeSearchResponseSchema,
  lifeSectionsResponseSchema,
  lifeRatingAcceptedSchema,
  setLifeRatingRequestSchema,
  lifeDeletedSchema,
  lifeDeckRequestSchema,
  lifeDeckResponseSchema,
  lifeStacksResponseSchema,
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
  @Get("stacks")
  @ApiContract(lifeStacksResponseSchema)
  async stacks(@CurrentUser() user: AuthenticatedUser, @Req() request: ApiRequest) {
    return success(request, await this.life.stacks(user.id));
  }
  @Post("deck")
  @HttpCode(200)
  @ApiContract(lifeDeckResponseSchema, lifeDeckRequestSchema)
  async deck(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    return success(request, await this.life.deck(user.id, parseBody(lifeDeckRequestSchema, body)));
  }
  @Post(":id/rating")
  @ApiContract(lifeRatingAcceptedSchema, setLifeRatingRequestSchema, 201, true)
  async rate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Headers("x-idempotency-key") key: string | undefined,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.life.rate(
        user.id,
        parseBody(uuidSchema, id),
        parseBody(setLifeRatingRequestSchema, body).rating,
        key,
      ),
    );
  }
  @Delete(":id")
  @ApiContract(lifeDeletedSchema, undefined, 200, true)
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.life.delete(user.id, parseBody(uuidSchema, id), key, request.traceId),
    );
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
  @Patch(":id")
  @ApiContract(lifeUpdatedSchema, patchLifeObjectRequestSchema, 200, true)
  async patch(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") idInput: string,
    @Headers("x-idempotency-key") key: string | undefined,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.life.patch(
        user.id,
        parseBody(uuidSchema, idInput),
        parseBody(patchLifeObjectRequestSchema, body),
        key,
      ),
    );
  }
  @Post(":id/rebuild-facts")
  @ApiContract(rebuildFactsAcceptedSchema, undefined, 201, true)
  async rebuild(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") idInput: string,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() request: ApiRequest,
  ) {
    return success(
      request,
      await this.life.rebuildFacts(user.id, parseBody(uuidSchema, idInput), key, request.traceId),
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
