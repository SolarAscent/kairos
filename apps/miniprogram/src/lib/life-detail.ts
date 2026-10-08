import "./zod-runtime";
import { z } from "zod";
import { lifeDetailResponseSchema, uiCapabilitiesResponseSchema } from "@life/contracts";
import { kindOptions } from "./life";

export const detailResponseSchema = lifeDetailResponseSchema;
export type LifeDetail = z.infer<typeof detailResponseSchema>;
export const uiCapabilitiesSchema = uiCapabilitiesResponseSchema;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
export function detailDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
export function displayDetail(detail: LifeDetail) {
  const facts = detail.facets.map((facet) => ({ facet, facts: record(facet.data.facts) }));
  const timeEntries = facts
    .filter((item) => Object.keys(record(item.facts.time)).length)
    .sort((a, b) => {
      const priority = (origin: unknown) =>
        origin === "USER_STATED" ? 0 : origin === "INFERRED" ? 2 : 1;
      return priority(a.facts.origin) - priority(b.facts.origin);
    });
  const endValue = (item: (typeof timeEntries)[number]) => {
    const time = record(item.facts.time);
    return text(time.deadline) || text(time.eventEnd) || text(time.windowEnd);
  };
  const endEntry = timeEntries.find((item) => endValue(item));
  const startEntry = timeEntries.find((item) => text(record(item.facts.time).eventStart));
  const placeEntry = facts.find((item) => Object.keys(record(item.facts.place)).length);
  const place = record(placeEntry?.facts.place);
  const asset = detail.facets.find((facet) => facet.facetType === "ASSET");
  const assetData = record(asset?.data);
  const ticket = record(assetData.ticket);
  const deadline = endEntry ? endValue(endEntry) : "";
  const eventStart = text(record(startEntry?.facts.time).eventStart);
  const labelTime = (value: string, origin: unknown) =>
    `${detailDate(value)}${origin === "INFERRED" ? "（待核对）" : ""}`;
  const deadlineLabel = deadline ? labelTime(deadline, endEntry?.facts.origin) : "待补充";
  const reminderEntry =
    detail.kind === "EVENT" && startEntry?.facts.origin === "USER_STATED" ? startEntry : endEntry;
  const reminderTime = reminderEntry === startEntry ? eventStart : deadline;
  const code = text(ticket.code) || text(assetData.voucherCode);
  const notes = facts.flatMap(({ facet, facts }) => {
    const evidence = text(facts.evidence);
    return evidence
      ? [
          {
            id: facet.id,
            kind: kindOptions.find((option) => option.value === facet.facetType)?.label ?? "线索",
            text: evidence,
            inferred: facts.origin === "INFERRED",
          },
        ]
      : [];
  });
  return {
    kindLabel: kindOptions.find((option) => option.value === detail.kind)?.label ?? "生活记录",
    statusLabel: {
      ACTIVE: "等待发生",
      RESOLVED: "已经发生",
      ARCHIVED: "已归档",
      DELETED: "已删除",
    }[detail.status],
    savedDate: detailDate(detail.createdAt),
    updatedDate: detailDate(detail.updatedAt),
    elapsedDays: Math.max(
      0,
      Math.floor((Date.now() - new Date(detail.createdAt).getTime()) / 86400000),
    ),
    sourceCount: new Set(
      detail.sources
        .filter((source) => source.sourceType === "CAPTURE")
        .map((source) => source.sourceId),
    ).size,
    deadline:
      detail.kind === "EVENT" && eventStart
        ? `开始：${labelTime(eventStart, startEntry?.facts.origin)}\n截止：${deadlineLabel}`
        : deadlineLabel,
    remindAt:
      reminderEntry?.facts.origin === "USER_STATED" &&
      z.iso.datetime().safeParse(reminderTime).success
        ? reminderTime
        : "",
    hasPlaceCandidate: detail.kind === "PLACE" || Object.keys(place).length > 0,
    placeName:
      text(detail.verifiedDestination?.name) ||
      text(detail.selectedDestination?.name) ||
      text(place.name) ||
      "待补充",
    placeAddress:
      text(detail.verifiedDestination?.address) ||
      text(detail.selectedDestination?.address) ||
      text(place.region) ||
      text(place.city) ||
      "待补充",
    ticketCode: code || "待补充",
    notes,
    captureSources: detail.sources
      .filter(
        (source, index, sources) =>
          source.sourceType === "CAPTURE" &&
          sources.findIndex(
            (entry) => entry.sourceType === "CAPTURE" && entry.sourceId === source.sourceId,
          ) === index,
      )
      .map((source) => ({
        id: source.sourceId,
        date: detailDate(source.createdAt),
        primary: source.isPrimary,
      })),
  };
}
