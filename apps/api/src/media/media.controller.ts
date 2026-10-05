import { Body, Controller, Get, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { mediaCapabilitiesSchema, voiceSessionResponseSchema } from "@life/contracts";
import { ApiContract } from "../common/api-contract.js";
import { CurrentUser, parseBody, success, type ApiRequest } from "../common/http.js";
import { AuthGuard, type AuthenticatedUser } from "../common/security.js";
import { VoiceService } from "./voice.service.js";

@Controller("/v1/media")
@UseGuards(AuthGuard)
export class MediaController {
  constructor(@Inject(VoiceService) private readonly voice: VoiceService) {}
  @Get("capabilities")
  @ApiContract(mediaCapabilitiesSchema)
  capabilities(@Req() request: ApiRequest) {
    return success(request, this.voice.capabilities());
  }
  @Post("voice/sessions")
  @ApiContract(voiceSessionResponseSchema, z.strictObject({}), 201)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    parseBody(z.strictObject({}), body ?? {});
    return success(request, this.voice.create(user));
  }
}
