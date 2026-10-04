import { Global, Module, OnApplicationShutdown } from "@nestjs/common";
import { createDatabase, type Database } from "@life/db";
import type { Pool } from "pg";
import { DATABASE, DATABASE_SOURCE, PG_POOL } from "./tokens.js";

class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(private readonly pool: Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: DATABASE_SOURCE, useFactory: () => createDatabase() },
    {
      provide: DATABASE,
      useFactory: (source: { db: Database }) => source.db,
      inject: [DATABASE_SOURCE],
    },
    {
      provide: PG_POOL,
      useFactory: (source: { pool: Pool }) => source.pool,
      inject: [DATABASE_SOURCE],
    },
    {
      provide: DatabaseLifecycle,
      useFactory: (pool: Pool) => new DatabaseLifecycle(pool),
      inject: [PG_POOL],
    },
  ],
  exports: [DATABASE, PG_POOL],
})
export class DatabaseModule {}

export type { Database };
