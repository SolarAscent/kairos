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
          ? "已有坐标"
          : item.placeLabel?.trim()
            ? `${item.placeLabel.trim()} · 待定位`
            : item.kind === "PLACE"
              ? "地点待补充"
              : "",
  };
}

export type LifeStack = {
  kind: LifeBrowseItem["kind"];
  title: string;
  items: ReturnType<typeof displayLifeItem>[];
  current: number;
  nextCursor: string | null;
  asOf: string;
  loading: boolean;
  error: string;
};
export function createLifeStack(
  group: {
    kind: LifeBrowseItem["kind"];
    title: string;
    items: LifeBrowseItem[];
    nextCursor: string | null;
    asOf?: string;
  },
  previous?: LifeStack,
): LifeStack {
  const currentId = previous?.items[previous.current]?.id;
  const currentIndex = group.items.findIndex((item) => item.id === currentId);
  return {
    ...group,
    items: group.items.map(displayLifeItem),
    current:
      currentIndex >= 0
        ? currentIndex
        : Math.max(0, Math.min(previous?.current ?? 0, group.items.length - 1)),
    asOf: group.asOf ?? "",
    loading: false,
    error: "",
  };
}
export function groupLifeItems(items: LifeBrowseItem[], previous: LifeStack[] = []): LifeStack[] {
  return kindOptions.flatMap((option) => {
    if (!option.value) return [];
    const grouped = items.filter((item) => item.kind === option.value);
    return grouped.length
      ? [
          createLifeStack(
            { kind: option.value, title: option.label, items: grouped, nextCursor: null },
            previous.find((group) => group.kind === option.value),
          ),
        ]
      : [];
  });
}
