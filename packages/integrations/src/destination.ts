import { isVerifiedGeocodedPlace, type GeoPoint, type GeocodedPlace } from "./index.js";

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
  const district = text(place.region, 20);
  const province = text(place.province, 20);
  // Keep explicit district disambiguation; a venue's name alone can geocode to a fuzzy match.
  // Already qualified addresses and street addresses are left intact rather than duplicated.
  let name = address;
  if (province && name.startsWith(province)) name = name.slice(province.length);
  const fullCity = city ? (city.endsWith("市") ? city : city + "市") : undefined;
  if (fullCity && name.startsWith(fullCity)) name = name.slice(fullCity.length);
  const refine =
    city &&
    name &&
    /^[\p{Script=Han}]{1,12}(?:区|县)$/u.test(district ?? "") &&
    !address.includes(district!) &&
    !/(?:区|县|路|街|巷|号|大道)/u.test(address) &&
    !/^[\p{Script=Han}]{2,10}?(?:省|市|自治区|特别行政区)/u.test(name);
  const refined = refine
    ? `${province && /^[\p{Script=Han}]{2,8}(?:省|自治区|特别行政区)$/u.test(province) ? province : ""}${fullCity}${district}${name}`
    : address;
  if (refined.length > 240) return undefined;
  return { address: refined, label: address, ...(city ? { city } : {}) };
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
      !isVerifiedGeocodedPlace(
        {
          location: {
            latitude: location.latitude,
            longitude: location.longitude,
            coordinateSystem: "GCJ02",
          },
          verificationMethod: location.verificationMethod as GeocodedPlace["verificationMethod"],
          reliability: location.reliability as number | undefined,
          level: location.level as number | undefined,
          poi: location.poi as GeocodedPlace["poi"],
          city: location.city as string | undefined,
        },
        destination,
      )
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
      ...(result.verificationMethod ? { verificationMethod: result.verificationMethod } : {}),
      ...(result.verificationMethod === "POI_SEARCH"
        ? { poi: result.poi }
        : {
            reliability: result.reliability,
            level: result.level,
          }),
      observedAt,
    },
  };
}
