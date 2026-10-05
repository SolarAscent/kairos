import type { GeoPoint, GeocodedPlace } from "./index.js";

export const tencentDestinationFacetKey = "tencent_destination_location";
export interface DestinationFacet {
  facetType?: string;
  facetKey?: string;
  originType?: string;
  data: Record<string, unknown>;
}
export interface DestinationQuery {
  address: string;
  city?: string;
  label: string;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, maximum = 240): string | undefined {
  return typeof value === "string" && value.trim() && value.trim().length <= maximum
    ? value.trim()
    : undefined;
}
function locality(value: string) {
  return value.replace(/\s/g, "").replace(/(?:特别行政区|自治区|省|市)$/u, "");
}
function query(
  address: string | undefined,
  place: Record<string, unknown>,
): DestinationQuery | undefined {
  if (!address) return undefined;
  const coarse = [place.country, place.province, place.region, place.city]
    .map((value) => text(value))
    .filter((value): value is string => Boolean(value));
  if (
    coarse.some((value) => locality(value) === locality(address)) ||
    /^(?:[\p{Script=Han}]{2,8}(?:省|市|自治区|特别行政区)|中国|北京|上海|天津|重庆|广东|新疆|西藏|内蒙古|宁夏|广西|香港|澳门|台湾)$/u.test(
      address,
    )
  )
    return undefined;
  const city = text(place.city, 80);
  return { address, label: address, ...(city ? { city } : {}) };
}
/** Visit destinations only: never geocode current GPS, originContext, or a HOME location. */
export function destinationQueryForObject(
  object: { title: string; kind: string },
  facets: DestinationFacet[],
): DestinationQuery | undefined {
  let hasHome = false;
  let hasCurrent = false;
  let hasStructuredFacts = false;
  for (const facet of facets) {
    if (/^source_current_/u.test(facet.facetKey ?? "")) {
      hasCurrent = true;
      continue;
    }
    if (facet.originType === "INFERRED") continue;
    const facts = record(facet.data.facts);
    if (Object.keys(facts).length) hasStructuredFacts = true;
    if (facts.activityKind === "HOME") {
      hasHome = true;
      continue;
    }
    if (facts.origin !== "USER_STATED") continue;
    if (facts.originContext && !facts.place) hasCurrent = true;
    const place = record(facts.place);
    const found = query(text(place.name), place);
    if (found) return found;
  }
  if (hasHome || hasCurrent || hasStructuredFacts) return undefined;
  // Legacy PLACE titles are destinations, while other object kinds require an explicit place fact.
  if (object.kind !== "PLACE") return undefined;
  if (
    /^(?:他说|她说|朋友说|有人说|引用)[：:]|^(?:我|本人)(?:现在|目前|此刻)?(?:在|住在|家在|家位于)|^(?:现在|目前|此刻)(?:在|位于)|^(?:我家|家里|我的家)$|^[“"‘'].+[”"’']$/u.test(
      object.title.trim(),
    )
  )
    return undefined;
  return query(text(object.title.replace(/^(?:想去|去|到|前往)\s*/u, "")), {});
}

/** Provider coordinates remain authoritative only while bound to the same declared destination. */
export function verifiedDestinationForObject(
  object: { title: string; kind: string },
  facets: DestinationFacet[],
): GeoPoint | undefined {
  const destination = destinationQueryForObject(object, facets);
  if (!destination) return undefined;
  for (const facet of facets) {
    if (facet.originType !== "EXTERNAL_VERIFIED" || facet.facetKey !== tencentDestinationFacetKey)
      continue;
    const location = record(facet.data.location),
      storedQuery = record(location.query);
    if (
      location.source !== "EXTERNAL_VERIFIED" ||
      location.provider !== "TENCENT" ||
      storedQuery.address !== destination.address ||
      (storedQuery.city ?? "") !== (destination.city ?? "") ||
      location.coordinateSystem !== "GCJ02" ||
      typeof location.latitude !== "number" ||
      typeof location.longitude !== "number" ||
      !Number.isFinite(location.latitude) ||
      !Number.isFinite(location.longitude) ||
      Math.abs(location.latitude) > 90 ||
      Math.abs(location.longitude) > 180 ||
      typeof location.reliability !== "number" ||
      location.reliability < 7 ||
      typeof location.level !== "number" ||
      location.level < 9
    )
      continue;
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      coordinateSystem: "GCJ02",
    };
  }
  return undefined;
}
export function verifiedDestinationData(
  destination: DestinationQuery,
  result: GeocodedPlace,
  observedAt: string,
) {
  return {
    intent: null,
    description: destination.label,
    verification: "EXTERNAL_VERIFIED",
    location: {
      source: "EXTERNAL_VERIFIED",
      provider: "TENCENT",
      ...result.location,
      query: {
        address: destination.address,
        ...(destination.city ? { city: destination.city } : {}),
      },
      label: destination.label,
      ...(result.city ? { city: result.city } : {}),
      ...(result.region ? { region: result.region } : {}),
      reliability: result.reliability,
      level: result.level,
      observedAt,
    },
  };
}
