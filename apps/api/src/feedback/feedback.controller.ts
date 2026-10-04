import { ApiContract } from "../common/api-contract.js";
import { Body, Controller, Headers, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { createFeedbackRequestSchema, feedbackAcceptedSchema, uuidSchema } from "@life/contracts";
import { ApiRequest, CurrentUser, parseBody, success } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import { FeedbackService } from "./feedback.service.js";

@ApiTags("feedback")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("/v1/now/sessions/:sessionId/feedback")
export class FeedbackController {
  constructor(@Inject(FeedbackService) private readonly feedback: FeedbackService) {}
  @Post()
  @ApiContract(feedbackAcceptedSchema, createFeedbackRequestSchema, 201, true)
  async record(
    @CurrentUser() user: AuthenticatedUser,
    @Param("sessionId") sessionInput: string,
    @Headers("x-idempotency-key") key: string | undefined,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    const sessionId = parseBody(uuidSchema, sessionInput);
    const input = parseBody(createFeedbackRequestSchema, body);
    return success(
      request,
      await this.feedback.record(user.id, sessionId, input, key, request.traceId),
    );
  }
}
