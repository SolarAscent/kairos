import type { LifeBrowseItem } from "@life/contracts";

export const kindOptions = [
  { label: "全部类型", value: undefined },
  { label: "地点", value: "PLACE" },
  { label: "愿望", value: "DESIRE" },
  { label: "内容", value: "MEDIA" },
  { label: "时间节点", value: "TIME_ANCHOR" },
  { label: "事件", value: "EVENT" },
  { label: "权益", value: "ASSET" },
  { label: "偏好", value: "PREFERENCE" },
  { label: "习惯", value: "ROUTINE" },
  { label: "未解决的事", value: "OPEN_LOOP" },
  { label: "经历", value: "MEMORY" },
  { label: "合集", value: "COLLECTION" },
] as const;
function dateLabel(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
export function displayLifeItem(item: LifeBrowseItem) {
  return {
    ...item,
    kindLabel: kindOptions.find((option) => option.value === item.kind)!.label,
    savedDate: dateLabel(item.createdAt),
    nextDate: item.nextAt ? dateLabel(item.nextAt) : "",
    expiryDate: item.expiresAt ? dateLabel(item.expiresAt) : "",
    locationLabel:
      item.distanceMeters != null
        ? `约 ${(item.distanceMeters / 1000).toFixed(1)} km · 直线距离`
        : item.hasLocation
          ? "已记录地点"
          : "未记录地点坐标",
  };
}
