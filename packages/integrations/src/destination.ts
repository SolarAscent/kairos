import {
  isVerifiedGeocodedPlace,
  isDomesticGeoPoint,
  type GeoPoint,
  type GeocodedPlace,
} from "./index.js";

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
export interface UserSelectedMapSelection {
  readonly name: string;
  readonly address: string;
  readonly location: Readonly<GeoPoint>;
}
export interface UserSelectedDestination {
  readonly location: Readonly<GeoPoint>;
  readonly name: string;
  readonly address: string;
  readonly source: "USER_SELECTED_MAP" | "USER_SELECTED_POI";
  readonly scope: "USER_CONFIRMED_INTENT";
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
function selectionText(value: unknown, maximum: number) {
  const result = text(value, maximum);
  return result && !/[\u0000-\u001f\u007f]/u.test(result) ? result : undefined;
}
export function isUserSelectedMapSelection(value: unknown): value is UserSelectedMapSelection {
  const selection = record(value);
  return Boolean(
    selectionText(selection.name, 240) &&
    selectionText(selection.address, 512) &&
    isDomesticGeoPoint(selection.location),
  );
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
/** Fallback title is only an explicit native-selection binding, never a geocoding query. */
export function destinationSelectionQueryForObject(
  object: { title: string; kind: string },
  facets: DestinationFacet[],
): DestinationQuery | undefined {
  const destination = destinationQueryForObject(object, facets);
  if (destination) return destination;
  const address = selectionText(object.title, 240);
  return address ? { address, label: address } : undefined;
}
export function userSelectedDestinationData(
  destination: DestinationQuery,
  selection: UserSelectedMapSelection,
  observedAt: string,
) {
  if (
    !selectionText(destination.address, 240) ||
    !selectionText(destination.label, 240) ||
    (destination.city != null && !selectionText(destination.city, 80)) ||
    !isUserSelectedMapSelection(selection) ||
    !Number.isFinite(Date.parse(observedAt))
  )
    throw new Error("INVALID_USER_SELECTED_DESTINATION");
  const location: GeoPoint = {
    latitude: selection.location.latitude,
    longitude: selection.location.longitude,
    coordinateSystem: "GCJ02",
  };
  return {
    intent: null,
    description: destination.label,
    verification: "USER_CONFIRMED",
    location: {
      source: "USER_SELECTED_MAP",
      provider: "WECHAT_NATIVE",
      ...location,
      query: {
        address: destination.address,
        ...(destination.city ? { city: destination.city } : {}),
      },
      selection: {
        name: selection.name.trim(),
        address: selection.address.trim(),
        location: { ...location },
      },
      observedAt,
    },
  };
}
export function userSelectedDestinationForObject(
  object: { title: string; kind: string },
  facets: DestinationFacet[],
): UserSelectedDestination | undefined {
  const nativeQuery = destinationSelectionQueryForObject(object, facets);
  const strictQuery = destinationQueryForObject(object, facets);
  for (const facet of facets) {
    if (facet.facetKey !== tencentDestinationFacetKey) continue;
    const location = record(facet.data.location),
      storedQuery = record(location.query);
    const native =
      facet.originType === "USER_STATED" &&
      location.source === "USER_SELECTED_MAP" &&
      location.provider === "WECHAT_NATIVE" &&
      facet.data.verification === "USER_CONFIRMED";
    const destination = native ? nativeQuery : strictQuery;
    if (
      !destination ||
      storedQuery.address !== destination.address ||
      (storedQuery.city ?? "") !== (destination.city ?? "") ||
      !isDomesticGeoPoint(location)
    )
      continue;
    if (native) {
      const selection = location.selection;
      if (
        typeof location.observedAt !== "string" ||
        !Number.isFinite(Date.parse(location.observedAt)) ||
        !isUserSelectedMapSelection(selection) ||
        selection.location.latitude !== location.latitude ||
        selection.location.longitude !== location.longitude
      )
        continue;
      return {
        location: {
          latitude: location.latitude,
          longitude: location.longitude,
          coordinateSystem: "GCJ02",
        },
        name: selection.name.trim(),
        address: selection.address.trim(),
        source: "USER_SELECTED_MAP",
        scope: "USER_CONFIRMED_INTENT",
      };
    }
    if (
      facet.originType !== "EXTERNAL_VERIFIED" ||
      location.source !== "EXTERNAL_VERIFIED" ||
      location.provider !== "TENCENT" ||
      location.verificationMethod !== "USER_SELECTED_POI" ||
      facet.data.verification !== "EXTERNAL_VERIFIED"
    )
      continue;
    const place: GeocodedPlace = {
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        coordinateSystem: "GCJ02",
      },
      verificationMethod: "USER_SELECTED_POI",
      selection: location.selection as GeocodedPlace["selection"],
      city: location.city as string | undefined,
      region: location.region as string | undefined,
    };
    if (!isVerifiedGeocodedPlace(place, destination) || !place.selection) continue;
    return {
      location: { ...place.location },
      name: place.selection.title,
      address: place.selection.address,
      source: "USER_SELECTED_POI",
      scope: "USER_CONFIRMED_INTENT",
    };
  }
  return undefined;
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
          selection: location.selection as GeocodedPlace["selection"],
          city: location.city as string | undefined,
          region: location.region as string | undefined,
          district: location.district as string | undefined,
          title: location.title as string | undefined,
          address: location.address as string | undefined,
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
  if (
    result.verificationMethod === "USER_SELECTED_POI" &&
    !isVerifiedGeocodedPlace(result, destination)
  )
    throw new Error("INVALID_VERIFIED_DESTINATION");
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
      ...(result.district ? { district: result.district } : {}),
      ...(result.title ? { title: result.title } : {}),
      ...(result.address ? { address: result.address } : {}),
      ...(result.verificationMethod ? { verificationMethod: result.verificationMethod } : {}),
      ...(result.verificationMethod === "USER_SELECTED_POI"
        ? { selection: result.selection }
        : result.verificationMethod === "POI_SEARCH"
          ? { poi: result.poi }
          : {
              reliability: result.reliability,
              level: result.level,
            }),
      observedAt,
    },
  };
}
