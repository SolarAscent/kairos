import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  lifeObjectFacets,
  lifeObjectProjection,
  lifeObjectSources,
  lifeObjects,
  type Database,
} from "@life/db";
import { DATABASE } from "../common/tokens.js";

@Injectable()
export class LifeService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(userId: string) {
    return this.db
      .select({
        id: lifeObjects.id,
        title: lifeObjects.title,
        summary: lifeObjects.summary,
        kind: lifeObjects.kind,
        status: lifeObjects.status,
        importance: lifeObjects.importanceScore,
        createdAt: lifeObjects.createdAt,
        searchText: lifeObjectProjection.searchText,
        displayKind: lifeObjectProjection.displayKind,
      })
      .from(lifeObjects)
      .leftJoin(lifeObjectProjection, eq(lifeObjectProjection.lifeObjectId, lifeObjects.id))
      .where(
        and(
          eq(lifeObjects.userId, userId),
          eq(lifeObjects.status, "ACTIVE"),
          isNull(lifeObjects.deletedAt),
        ),
      )
      .orderBy(desc(lifeObjects.updatedAt))
      .limit(100);
  }

  async get(userId: string, id: string) {
    const [object] = await this.db
      .select()
      .from(lifeObjects)
      .where(
        and(eq(lifeObjects.userId, userId), eq(lifeObjects.id, id), isNull(lifeObjects.deletedAt)),
      )
      .limit(1);
    if (!object) throw new NotFoundException({ code: "LIFE_OBJECT_NOT_FOUND" });
    const facets = await this.db
      .select()
      .from(lifeObjectFacets)
      .where(
        and(
          eq(lifeObjectFacets.userId, userId),
          eq(lifeObjectFacets.lifeObjectId, id),
          isNull(lifeObjectFacets.deletedAt),
        ),
      );
    const sources = await this.db
      .select()
      .from(lifeObjectSources)
      .where(and(eq(lifeObjectSources.userId, userId), eq(lifeObjectSources.lifeObjectId, id)));
    return { ...object, facets, sources };
  }
}
