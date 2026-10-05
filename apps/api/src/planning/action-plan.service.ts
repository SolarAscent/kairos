import { Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { feedbackEvents, type Database } from "@life/db";
import { actionPlanSchema, type ActionPlan, type ActionProgress } from "@life/contracts";
import type { ScoredCandidate } from "@life/domain";

type Reader = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

@Injectable()
export class ActionPlanService {
  propose(
    action: ScoredCandidate,
    timezone = "Asia/Shanghai",
    now = new Date(),
  ): ActionPlan | null {
    const source = action.plan;
    if (!source || source.totalSeconds == null || source.totalSeconds <= 0) return null;
    const start = new Date(
      Math.max(now.getTime(), new Date(source.scheduledStartAt ?? now.toISOString()).getTime()),
    );
    const end = new Date(start.getTime() + source.totalSeconds * 1000);
    const clock = (time: Date) =>
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(time);
    return actionPlanSchema.parse({
      ...source,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      label: `${clock(start)}–${clock(end)} · 约 ${Math.ceil(source.totalSeconds / 60)} 分钟${source.mode === "PREPARE" ? "准备" : ""}`,
    });
  }

  retime(plan: ActionPlan, startAt: string, timezone = "Asia/Shanghai"): ActionPlan {
    const start = new Date(startAt),
      end = new Date(start.getTime() + plan.totalSeconds * 1000);
    const clock = (at: Date) =>
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(at);
    return {
      ...plan,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      label: `${clock(start)}–${clock(end)} · 约 ${Math.ceil(plan.totalSeconds / 60)} 分钟${plan.mode === "PREPARE" ? "准备" : ""}`,
    };
  }

  async progress(
    reader: Reader,
    userId: string,
    recommendationId: string,
    now = new Date(),
  ): Promise<ActionProgress> {
    const events = await reader
      .select({ type: feedbackEvents.eventType, at: feedbackEvents.createdAt })
      .from(feedbackEvents)
      .where(
        and(
          eq(feedbackEvents.userId, userId),
          eq(feedbackEvents.recommendationId, recommendationId),
        ),
      )
      .orderBy(asc(feedbackEvents.createdAt), asc(feedbackEvents.id));
    let state: ActionProgress["state"] = "NOT_STARTED";
    let started: Date | null = null;
    let ended: Date | null = null;
    for (const event of events) {
      if (["ACCEPT", "EXECUTE"].includes(event.type) && state === "NOT_STARTED") {
        state = "ACTIVE";
        started = event.at;
      } else if (event.type === "COMPLETE" && state === "ACTIVE") {
        state = "COMPLETED";
        ended = event.at;
      } else if (["REJECT", "DISMISS", "SKIP"].includes(event.type) && state === "ACTIVE") {
        state = "CANCELLED";
        ended = event.at;
      }
    }
    return {
      state,
      startedAt: started?.toISOString() ?? null,
      completedAt: ended?.toISOString() ?? null,
      elapsedSeconds: started
        ? Math.max(0, Math.floor(((ended ?? now).getTime() - started.getTime()) / 1000))
        : 0,
    };
  }
}
