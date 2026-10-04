import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import type { Pool } from "pg";
import { PG_POOL } from "./common/tokens.js";

@Controller()
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get("/health/live")
  @ApiExcludeEndpoint()
  live() {
    return { status: "ok" };
  }

  @Get("/health/ready")
  @ApiExcludeEndpoint()
  async ready() {
    try {
      await this.pool.query("SELECT 1 FROM outbox_events LIMIT 1");
      return { status: "ready", dependencies: { postgres: "ok" } };
    } catch {
      throw new ServiceUnavailableException({ code: "DATABASE_NOT_READY" });
    }
  }
}
