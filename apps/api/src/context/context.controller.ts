import { Controller, Get, Inject, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { nowContextSchema } from "@life/contracts";
import { ApiContract } from "../common/api-contract.js";
import { ApiRequest, CurrentUser, success } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import { BuildDecisionContextService } from "./build-decision-context.service.js";

@ApiTags("context")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("/v1/context")
export class ContextController {
  constructor(
    @Inject(BuildDecisionContextService) private readonly context: BuildDecisionContextService,
  ) {}
  @Get()
  @ApiContract(nowContextSchema)
  async get(@CurrentUser() user: AuthenticatedUser, @Req() request: ApiRequest) {
    return success(request, (await this.context.build(user.id)).context);
  }
}
