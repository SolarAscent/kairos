import { createHash } from "node:crypto";
export {
  destinationQueryForObject,
  verifiedDestinationForObject,
  verifiedDestinationData,
  tencentDestinationFacetKey,
} from "./destination.js";
export type { DestinationFacet, DestinationQuery } from "./destination.js";

export interface GeoPoint {
  latitude: number;
  longitude: number;
  coordinateSystem: "GCJ02";
}
export interface GeocodedPlace {
  location: GeoPoint;
  city?: string;
  region?: string;
  reliability?: number;
  level?: number;
  verificationMethod?: "GEOCODE" | "POI_SEARCH" | "USER_SELECTED_POI";
  poi?: VerifiedPoi;
  selection?: PoiChoice;
}
export interface PoiChoice {
  id: string;
  title: string;
  address: string;
  city: string;
  province: string;
  district?: string;
  location: GeoPoint;
  match: "EXACT_NAME" | "EXACT_ADDRESS";
}
export interface VerifiedPoi {
  id: string;
  title: string;
  address: string;
  type: 0 | 1 | 2;
  city: string;
  province: string;
  district?: string;
  location: GeoPoint;
  query: string;
  searchCity: string;
  resultCount: number;
  complete: true;
  uniqueMatches: 1;
  match: "EXACT_NAME" | "EXACT_ADDRESS";
}
export type RouteMode = "walking" | "bicycling" | "transit";
export interface RouteLinePoint {
  latitude: number;
  longitude: number;
}
export interface RouteSegment {
  mode: RouteMode;
  points: RouteLinePoint[];
}
const maxRouteLinePoints = 4096;
const maxRouteSegments = 64;
/** Tencent's first lat/lng pair is absolute; later pairs are forward integer deltas. */
export function decodeTencentPolyline(value: unknown): RouteLinePoint[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 4 ||
    value.length % 2 !== 0 ||
    value.length > maxRouteLinePoints * 2
  )
    return undefined;
  const points: RouteLinePoint[] = [];
  let latitude = 0,
    longitude = 0;
  for (let index = 0; index < value.length; index += 2) {
    const lat = value[index],
      lng = value[index + 1];
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    )
      return undefined;
    if (index > 0 && (!Number.isSafeInteger(lat) || !Number.isSafeInteger(lng))) return undefined;
    latitude = index === 0 ? lat : latitude + lat / 1000000;
    longitude = index === 0 ? lng : longitude + lng / 1000000;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
    points.push({ latitude, longitude });
  }
  return points;
}
function segmentsForRoute(
  route: Record<string, unknown>,
  mode: RouteMode,
): RouteSegment[] | undefined {
  if (mode !== "transit") {
    const points = decodeTencentPolyline(route.polyline);
    return points ? [{ mode, points }] : undefined;
  }
  const steps = Array.isArray(route.steps) ? route.steps.map(record) : [];
  if (steps.length > maxRouteSegments) return undefined;
  const segments: RouteSegment[] = [];
  let pointCount = 0;
  for (const step of steps) {
    const line = Array.isArray(step.lines) ? record(step.lines[0]) : step;
    // Rail geometry is only station coordinates, not the railway's actual path.
    if (step.mode === "TRANSIT" && line.vehicle === "RAIL") continue;
    const points = decodeTencentPolyline(step.mode === "WALKING" ? step.polyline : line.polyline);
    if (!points) continue;
    pointCount += points.length;
    if (pointCount > maxRouteLinePoints) return undefined;
    segments.push({ mode: step.mode === "WALKING" ? "walking" : "transit", points });
  }
  return segments.length ? segments : undefined;
}
export type TransitKind = "BUS" | "SUBWAY" | "RAIL" | "MIXED";
export type TransitDurations = Partial<Record<Exclude<TransitKind, "MIXED">, number>>;
export function dominantTransitKind(durations: TransitDurations): TransitKind {
  const ranked = Object.entries(durations)
    .filter(([, duration]) => Number.isFinite(duration) && duration > 0)
    .sort((a, b) => b[1]! - a[1]!);
  return ranked.length && (ranked.length === 1 || ranked[0]![1] !== ranked[1]![1])
    ? (ranked[0]![0] as TransitKind)
    : "MIXED";
}
export interface RouteEstimate {
  durationSeconds: number;
  distanceMeters: number;
  mode: RouteMode;
  /** Exact provider fare in CNY minor units; null means unknown, never free. */
  costMinor?: number | null;
  transitKind?: TransitKind;
  transitDurations?: TransitDurations;
  /** Only geometry belonging to this exact directional route; segments never bridge gaps. */
  segments?: RouteSegment[];
  provider: "TENCENT";
  observedAt: string;
  expiresAt: string;
}
export type MapFailure =
  | "NOT_CONFIGURED"
  | "INVALID_LOCATION"
  | "AMBIGUOUS_ADDRESS"
  | "TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REJECTED"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "ROUTE_TOO_CLOSE"
  | "ROUTE_TOO_LONG"
  | "NO_ROUTE"
  | "INVALID_RESPONSE";
export type MapResult<T> = { ok: true; value: T } | { ok: false; reason: MapFailure };
export interface LocationProvider {
  readonly configured: boolean;
  geocode(address: string, city?: string, signal?: AbortSignal): Promise<MapResult<GeocodedPlace>>;
  cityForLocation?(origin: GeoPoint, signal?: AbortSignal): Promise<MapResult<{ city: string }>>;
  searchChoices?(
    address: string,
    city?: string,
    signal?: AbortSignal,
  ): Promise<MapResult<PoiChoice[]>>;
  route(from: GeoPoint, to: GeoPoint, signal?: AbortSignal): Promise<MapResult<RouteEstimate>>;
  routeForMode?(
    from: GeoPoint,
    to: GeoPoint,
    mode: RouteMode,
    signal?: AbortSignal,
    departureTime?: Date,
    options?: { avoidSubway?: boolean },
  ): Promise<MapResult<RouteEstimate>>;
}
export function isGeoPoint(value: unknown): value is GeoPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<GeoPoint>;
  return (
    point.coordinateSystem === "GCJ02" &&
    typeof point.latitude === "number" &&
    Number.isFinite(point.latitude) &&
    Math.abs(point.latitude) <= 90 &&
    typeof point.longitude === "number" &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.longitude) <= 180
  );
}
function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
const cityPrefixes = [
  "北京",
  "上海",
  "天津",
  "重庆",
  "广州",
  "深圳",
  "珠海",
  "佛山",
  "东莞",
  "中山",
  "惠州",
  "杭州",
  "南京",
  "武汉",
  "成都",
  "西安",
  "长沙",
  "福州",
  "厦门",
  "济南",
  "青岛",
  "郑州",
  "合肥",
  "南昌",
  "南宁",
  "昆明",
  "贵阳",
  "海口",
  "沈阳",
  "大连",
  "长春",
  "哈尔滨",
  "石家庄",
  "太原",
  "呼和浩特",
  "兰州",
  "西宁",
  "银川",
  "乌鲁木齐",
  "拉萨",
  "香港",
  "澳门",
];
const coarseRegions =
  /^(?:全国|中国|广东|广西|新疆|西藏|内蒙古|宁夏|河北|河南|山东|山西|陕西|四川|云南|贵州|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|湖北|湖南|甘肃|青海|海南|台湾)(?:省|自治区)?$/u;
const administrativeRegionPrefix =
  /^(?:全国|中国|广东|广西|新疆|西藏|内蒙古|宁夏|河北|河南|山东|山西|陕西|四川|云南|贵州|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|湖北|湖南|甘肃|青海|海南|台湾)/u;
function identity(value: string) {
  return value.normalize("NFKC").replace(/\s/gu, "");
}
function sameCity(a: string, b: string) {
  return identity(a).replace(/市$/u, "") === identity(b).replace(/市$/u, "");
}
function searchScope(address: string, suppliedCity?: string) {
  const named = identity(address);
  const administrative = named.match(
    /^(?:中国)?(?:[\p{Script=Han}]{2,6}?(?:省|自治区))?([\p{Script=Han}]{2,10}?市)/u,
  )?.[1];
  const prefix = cityPrefixes.find(
    (city) => named.startsWith(city) && !/^(?:路|街|巷|大道)/u.test(named.slice(city.length)),
  );
  const city = suppliedCity?.trim() || administrative || prefix;
  if (!city || !/^[\p{Script=Han}]{2,20}$/u.test(city) || coarseRegions.test(city))
    return undefined;
  if (administrative && !sameCity(city, administrative)) return undefined;
  if (prefix && !sameCity(city, prefix)) return undefined;
  const province = named.match(/^(?:中国)?([\p{Script=Han}]{2,6}?(?:省|自治区|特别行政区))/u)?.[1];
  const afterCity = administrative
    ? named.slice(named.indexOf(administrative) + administrative.length)
    : "";
  const district = afterCity.match(/^([\p{Script=Han}]{1,8}?(?:区|县))/u)?.[1];
  return { city, province, district };
}
function hasAdministrativeCityPrefix(address: string) {
  return /^(?:中国)?(?:[\p{Script=Han}]{2,6}?(?:省|自治区))?[\p{Script=Han}]{2,10}?市/u.test(
    identity(address),
  );
}
function poiMatch(
  query: string,
  title: string,
  address: string,
  scope: { city: string; province?: string; district?: string },
) {
  const value = identity(query);
  if (value === identity(address)) return "EXACT_ADDRESS" as const;
  if (genericQuery(title)) return undefined;
  if (value === identity(title)) return "EXACT_NAME" as const;
  // Compare only known administrative prefixes; preserve venue names and every suffix.
  const stripPrefixes = (name: string) => {
    let qualified = identity(name);
    const city = identity(scope.city).replace(/市$/u, "");
    for (const alternatives of [[scope.province], [`${city}市`, city], [scope.district]]) {
      const qualifier = alternatives.find(
        (value) => value && qualified.startsWith(identity(value)),
      );
      if (qualifier) qualified = qualified.slice(identity(qualifier).length);
    }
    return qualified;
  };
  const qualifiedQuery = stripPrefixes(query),
    qualifiedTitle = stripPrefixes(title);
  if (qualifiedTitle === value) return "EXACT_NAME" as const;
  // Keep a proper name such as 中山大学 intact rather than reducing it to a venue class.
  if (/^(?:大学|中学|小学|学校)$/u.test(qualifiedQuery)) return undefined;
  return qualifiedQuery && (qualifiedQuery === identity(title) || qualifiedQuery === qualifiedTitle)
    ? ("EXACT_NAME" as const)
    : undefined;
}
function genericQuery(address: string) {
  return (
    /^(?:图书馆|博物馆|公园|咖啡馆|咖啡店|酒店|餐厅|饭店|超市|学校|医院|书店|电影院|地铁站|火车站|机场)$/u.test(
      identity(address),
    ) || /附近|随便|任意|最近的|一家|的(?:图书馆|博物馆|公园|酒店|餐厅)$/u.test(address)
  );
}
/** A current city can scope an unqualified venue, never replace a stated destination region. */
export function canUseOriginCityForAddress(address: string, suppliedCity?: string): boolean {
  const value = identity(address);
  return (
    Boolean(value) &&
    address.length <= 240 &&
    !suppliedCity?.trim() &&
    !searchScope(address) &&
    !genericQuery(value) &&
    !coarseRegions.test(value) &&
    !administrativeRegionPrefix.test(value) &&
    !/^[\p{Script=Han}]{1,20}?(?:省|自治区|特别行政区|自治州|地区|盟|市|区|县)/u.test(value)
  );
}
/** Unqualified names require a user's choice even if the nearest city has only one match. */
export function requiresCityConfirmation(address: string, suppliedCity?: string): boolean {
  const named = identity(address);
  const scope = searchScope(address);
  return (
    Boolean(named) &&
    address.length <= 240 &&
    !suppliedCity?.trim() &&
    !hasAdministrativeCityPrefix(address) &&
    !genericQuery(named) &&
    !coarseRegions.test(named) &&
    !(scope && sameCity(named, scope.city)) &&
    !/^[\p{Script=Han}]{1,20}(?:省|自治区|特别行政区|自治州|地区|盟|市|区|县)$/u.test(named)
  );
}
function validPoiChoice(choice: PoiChoice): boolean {
  return (
    typeof choice.id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(choice.id) &&
    typeof choice.title === "string" &&
    Boolean(choice.title.trim()) &&
    choice.title.length <= 240 &&
    typeof choice.address === "string" &&
    Boolean(choice.address.trim()) &&
    choice.address.length <= 500 &&
    typeof choice.city === "string" &&
    /^[\p{Script=Han}]{2,20}$/u.test(choice.city) &&
    !coarseRegions.test(choice.city) &&
    typeof choice.province === "string" &&
    /^[\p{Script=Han}]{2,30}$/u.test(choice.province) &&
    (choice.district == null ||
      (typeof choice.district === "string" && /^[\p{Script=Han}]{0,30}$/u.test(choice.district))) &&
    isGeoPoint(choice.location) &&
    choice.location.latitude >= 18 &&
    choice.location.latitude <= 54 &&
    choice.location.longitude >= 73 &&
    choice.location.longitude <= 135 &&
    !sameCity(choice.title, choice.city) &&
    identity(choice.title) !== identity(choice.province) &&
    (!choice.district || identity(choice.title) !== identity(choice.district))
  );
}
function choiceMatch(choice: PoiChoice, query: { address: string; city?: string }) {
  if (
    !validPoiChoice(choice) ||
    !query.address.trim() ||
    query.address.length > 240 ||
    genericQuery(query.address) ||
    coarseRegions.test(identity(query.address))
  )
    return undefined;
  const exactTitle =
    identity(query.address) === identity(choice.title) ||
    poiMatch(query.address, choice.title, choice.address, {
      city: choice.city,
      province: choice.province,
      district: choice.district,
    }) === "EXACT_NAME";
  const declaredScope =
    exactTitle && !hasAdministrativeCityPrefix(query.address)
      ? query.city?.trim()
        ? searchScope("", query.city)
        : undefined
      : searchScope(query.address, query.city);
  if (query.city?.trim() && !declaredScope) return undefined;
  if (
    declaredScope &&
    (!sameCity(declaredScope.city, choice.city) ||
      (declaredScope.province && identity(declaredScope.province) !== identity(choice.province)) ||
      (declaredScope.district && declaredScope.district !== choice.district))
  )
    return undefined;
  const named = identity(query.address);
  const explicitProvince = named.match(
    /^(?:中国)?([\p{Script=Han}]{2,6}?(?:省|自治区|特别行政区))/u,
  )?.[1];
  const shortProvince = named.match(administrativeRegionPrefix)?.[0];
  if (
    (explicitProvince && identity(explicitProvince) !== identity(choice.province)) ||
    (shortProvince &&
      !["全国", "中国"].includes(shortProvince) &&
      !identity(choice.province).startsWith(shortProvince))
  )
    return undefined;
  const scope = {
    province: choice.province,
    city: choice.city,
    district: choice.district,
  };
  const matchWithCity = (address: string) => {
    for (const city of new Set([choice.city, choice.city.replace(/市$/u, "")])) {
      const match = poiMatch(address, choice.title, choice.address, { ...scope, city });
      if (match) return match;
    }
    return undefined;
  };
  const exact = matchWithCity(query.address);
  if (exact) return exact;
  // A stated provincial abbreviation remains a constraint, not a fuzzy venue alias.
  if (shortProvince && !["全国", "中国"].includes(shortProvince))
    return matchWithCity(named.slice(shortProvince.length));
  return undefined;
}
/** Validates persisted provenance as well as adapter results; POI never impersonates geocoder precision. */
export function isVerifiedGeocodedPlace(
  value: GeocodedPlace,
  query?: { address: string; city?: string },
): boolean {
  if (!isGeoPoint(value.location)) return false;
  if (value.verificationMethod === "USER_SELECTED_POI") {
    const selection = value.selection;
    const match = query && selection ? choiceMatch(selection, query) : undefined;
    return Boolean(
      query &&
      selection &&
      match &&
      match === selection.match &&
      selection.location.latitude === value.location.latitude &&
      selection.location.longitude === value.location.longitude &&
      (value.city == null ||
        (typeof value.city === "string" && sameCity(value.city, selection.city))) &&
      (value.region == null ||
        (typeof value.region === "string" &&
          identity(value.region) === identity(selection.province))),
    );
  }
  if (value.verificationMethod !== "POI_SEARCH")
    return (
      (value.verificationMethod == null || value.verificationMethod === "GEOCODE") &&
      nonnegative(value.reliability) &&
      value.reliability >= 7 &&
      nonnegative(value.level) &&
      value.level >= 9
    );
  const poi = value.poi;
  if (
    !poi ||
    typeof poi.id !== "string" ||
    !poi.id ||
    typeof poi.title !== "string" ||
    !poi.title ||
    typeof poi.address !== "string" ||
    !poi.address ||
    ![0, 1, 2].includes(poi.type) ||
    typeof poi.city !== "string" ||
    typeof poi.province !== "string" ||
    !poi.province ||
    typeof poi.query !== "string" ||
    typeof poi.searchCity !== "string" ||
    poi.complete !== true ||
    poi.uniqueMatches !== 1 ||
    !Number.isInteger(poi.resultCount) ||
    poi.resultCount < 1 ||
    poi.resultCount > 20 ||
    !isGeoPoint(poi.location) ||
    poi.location.latitude !== value.location.latitude ||
    poi.location.longitude !== value.location.longitude ||
    value.location.latitude < 18 ||
    value.location.latitude > 54 ||
    value.location.longitude < 73 ||
    value.location.longitude > 135 ||
    (value.city != null && (typeof value.city !== "string" || !sameCity(value.city, poi.city))) ||
    (query && poi.query !== query.address)
  )
    return false;
  const scope = searchScope(poi.query, query?.city ?? poi.searchCity);
  return Boolean(
    scope &&
    sameCity(scope.city, poi.city) &&
    sameCity(scope.city, poi.searchCity) &&
    (!scope.province || identity(scope.province) === identity(poi.province)) &&
    (!scope.district || scope.district === poi.district) &&
    !genericQuery(poi.query) &&
    poi.match === poiMatch(poi.query, poi.title, poi.address, scope),
  );
}

/** Official GET signing uses the sorted, unencoded values, followed by the server-only SK. */
export function tencentSignature(
  path: string,
  params: Record<string, string>,
  secret: string,
): string {
  const raw = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");
  return createHash("md5").update(`${path}?${raw}${secret}`).digest("hex");
}
export class TencentLbsAdapter implements LocationProvider {
  private static readonly turns = new Map<string, Promise<void>>();
  private static readonly lastStarted = new Map<string, number>();
  private static readonly choiceCaches = new WeakMap<
    typeof fetch,
    Map<string, { expiresAt: number; choices: PoiChoice[] }>
  >();
  readonly configured: boolean;
  private readonly key: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly rateIntervalMs: number;
  constructor(
    options: { key?: string; secret?: string; timeoutMs?: number; rateIntervalMs?: number } = {},
    private readonly transport: typeof fetch = fetch,
  ) {
    this.key = options.key?.trim() ?? "";
    this.secret = options.secret?.trim() ?? "";
    this.configured = Boolean(this.key);
    this.timeoutMs = Math.max(10, Math.min(options.timeoutMs ?? 900, 2000));
    // Real transport defaults to four starts per second per key/path in this process.
    // Deterministic transports can opt in to this scheduler explicitly.
    this.rateIntervalMs =
      options.rateIntervalMs === 0
        ? 0
        : Math.max(250, options.rateIntervalMs ?? (transport === fetch ? 250 : 0));
    if (options.rateIntervalMs == null && transport !== fetch) this.rateIntervalMs = 0;
  }
  private async waitForTurn(path: string, signal: AbortSignal) {
    if (!this.rateIntervalMs || signal.aborted) return;
    const key = createHash("sha256")
      .update(this.key + path)
      .digest("hex");
    const prior = TencentLbsAdapter.turns.get(key) ?? Promise.resolve();
    const turn = prior
      .catch(() => {})
      .then(async () => {
        if (signal.aborted) return;
        const delay = Math.max(
          0,
          (TencentLbsAdapter.lastStarted.get(key) ?? 0) + this.rateIntervalMs - Date.now(),
        );
        if (delay)
          await new Promise<void>((resolve) => {
            const stopped = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", stopped);
              resolve();
            };
            const timer = setTimeout(stopped, delay);
            signal.addEventListener("abort", stopped, { once: true });
          });
        if (!signal.aborted) TencentLbsAdapter.lastStarted.set(key, Date.now());
      });
    TencentLbsAdapter.turns.set(key, turn);
    await turn;
  }
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env) {
    return new TencentLbsAdapter({ key: env.TENCENT_LBS_KEY, secret: env.TENCENT_LBS_SECRET });
  }
  async cityForLocation(
    origin: GeoPoint,
    signal?: AbortSignal,
  ): Promise<MapResult<{ city: string }>> {
    if (!this.configured) return { ok: false, reason: "NOT_CONFIGURED" };
    if (!isGeoPoint(origin)) return { ok: false, reason: "INVALID_LOCATION" };
    const response = await this.request(
      "/ws/geocoder/v1/",
      {
        location: `${origin.latitude},${origin.longitude}`,
        get_poi: "0",
        output: "json",
      },
      signal,
    );
    if (!response.ok) return response;
    const city = record(record(response.value.result).address_component).city;
    if (
      typeof city !== "string" ||
      !/^[\p{Script=Han}]{2,20}$/u.test(city.trim()) ||
      coarseRegions.test(city.trim()) ||
      /(?:省|自治区)$/u.test(city.trim()) ||
      (/(?:区|县)$/u.test(city.trim()) && !/(?:地区|特别行政区)$/u.test(city.trim()))
    )
      return { ok: false, reason: "INVALID_RESPONSE" };
    return { ok: true, value: { city: city.trim() } };
  }
  async geocode(
    address: string,
    city?: string,
    signal?: AbortSignal,
  ): Promise<MapResult<GeocodedPlace>> {
    if (!this.configured) return { ok: false, reason: "NOT_CONFIGURED" };
    if (!address.trim() || address.length > 240 || (city?.length ?? 0) > 80)
      return { ok: false, reason: "AMBIGUOUS_ADDRESS" };
    const params: Record<string, string> = { address: address.trim(), output: "json", policy: "0" };
    if (city?.trim()) params.region = city.trim();
    const response = await this.request("/ws/geocoder/v1/", params, signal);
    if (!response.ok)
      return response.reason === "AMBIGUOUS_ADDRESS"
        ? this.searchPoi(address.trim(), city, signal)
        : response;
    const result = record(response.value.result),
      position = record(result.location);
    const location = { latitude: position.lat, longitude: position.lng, coordinateSystem: "GCJ02" };
    if (!isGeoPoint(location)) return { ok: false, reason: "INVALID_RESPONSE" };
    // A city/province centroid is never promoted to a precise visit destination.
    if (
      !nonnegative(result.reliability) ||
      result.reliability < 7 ||
      !nonnegative(result.level) ||
      result.level < 9
    )
      return this.searchPoi(address.trim(), city, signal);
    const components = record(result.address_components);
    const declaredScope = searchScope(address, city);
    const expectedCity = city?.trim() || declaredScope?.city;
    if (
      expectedCity &&
      typeof components.city === "string" &&
      components.city &&
      !sameCity(expectedCity, components.city)
    )
      return this.searchPoi(address.trim(), city, signal);
    return {
      ok: true,
      value: {
        location,
        reliability: result.reliability,
        level: result.level,
        verificationMethod: "GEOCODE",
        ...(typeof components.city === "string" ? { city: components.city } : {}),
        ...(typeof components.province === "string" ? { region: components.province } : {}),
      },
    };
  }
  async searchChoices(
    address: string,
    city?: string,
    signal?: AbortSignal,
  ): Promise<MapResult<PoiChoice[]>> {
    if (!this.configured) return { ok: false, reason: "NOT_CONFIGURED" };
    if (signal?.aborted) return { ok: false, reason: "TIMEOUT" };
    let cache = TencentLbsAdapter.choiceCaches.get(this.transport);
    if (!cache) {
      cache = new Map();
      TencentLbsAdapter.choiceCaches.set(this.transport, cache);
    }
    const credential = createHash("sha256")
      .update(JSON.stringify([this.key, this.secret]))
      .digest("hex");
    const cacheKey = createHash("sha256")
      .update(JSON.stringify([credential, address, city ?? ""]))
      .digest("hex");
    const now = Date.now();
    for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
    const cached = cache.get(cacheKey);
    if (cached) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return { ok: true, value: structuredClone(cached.choices) };
    }
    const result = await this.searchChoicesUncached(address, city, signal);
    if (signal?.aborted) return { ok: false, reason: "TIMEOUT" };
    if (result.ok && result.value.length) {
      cache.set(cacheKey, {
        expiresAt: Date.now() + 3 * 60000,
        choices: structuredClone(result.value),
      });
      while (cache.size > 100) cache.delete(cache.keys().next().value!);
    }
    return result;
  }
  private async searchChoicesUncached(
    address: string,
    city?: string,
    signal?: AbortSignal,
  ): Promise<MapResult<PoiChoice[]>> {
    if (signal?.aborted) return { ok: false, reason: "TIMEOUT" };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    const deadline = new Promise<MapResult<PoiChoice[]>>((resolve) => {
      stop = () => {
        abort.abort();
        resolve({ ok: false, reason: "TIMEOUT" });
      };
      timer = setTimeout(stop, 4000);
      signal?.addEventListener("abort", stop, { once: true });
    });
    const work = async (): Promise<MapResult<PoiChoice[]>> => {
      const first = await this.choicesPage(address, city, abort.signal);
      if (!first.ok) return first;
      const choices = new Map(first.value.choices.map((choice) => [choice.id, choice]));
      if (choices.size >= 6 || !first.value.clusterCities.length)
        return { ok: true, value: [...choices.values()].slice(0, 6) };
      const pages = await Promise.all(
        first.value.clusterCities
          .slice(0, 3)
          .map((city) => this.choicesPage(address, city, abort.signal)),
      );
      let failure: MapFailure | undefined;
      for (const page of pages) {
        if (!page.ok) {
          failure ??= page.reason;
          continue;
        }
        for (const choice of page.value.choices) {
          const prior = choices.get(choice.id);
          if (prior && JSON.stringify(prior) !== JSON.stringify(choice))
            return { ok: false, reason: "INVALID_RESPONSE" };
          choices.set(choice.id, choice);
        }
      }
      return !choices.size && failure
        ? { ok: false, reason: failure }
        : { ok: true, value: [...choices.values()].slice(0, 6) };
    };
    try {
      return await Promise.race([work(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      if (stop) signal?.removeEventListener("abort", stop);
      abort.abort();
    }
  }
  private async choicesPage(
    address: string,
    city?: string,
    signal?: AbortSignal,
  ): Promise<MapResult<{ choices: PoiChoice[]; clusterCities: string[] }>> {
    if (!this.configured) return { ok: false, reason: "NOT_CONFIGURED" };
    const declaredScope = searchScope(address);
    const scope = hasAdministrativeCityPrefix(address)
      ? searchScope(address, city)
      : city?.trim()
        ? searchScope("", city)
        : undefined;
    if (
      !address.trim() ||
      address.length > 240 ||
      Buffer.byteLength(address, "utf8") > 96 ||
      genericQuery(address) ||
      coarseRegions.test(identity(address)) ||
      (city?.trim() && !scope) ||
      (declaredScope && sameCity(address, declaredScope.city))
    )
      return { ok: false, reason: "AMBIGUOUS_ADDRESS" };
    const response = await this.request(
      "/ws/place/v1/search",
      {
        keyword: address.trim(),
        boundary: `region(${scope?.city ?? "全国"},0)`,
        page_size: "20",
        page_index: "1",
        output: "json",
      },
      signal,
    );
    if (!response.ok) return response;
    const count = response.value.count,
      data = response.value.data;
    if (
      !Number.isSafeInteger(count) ||
      (count as number) < 0 ||
      !Array.isArray(data) ||
      data.length > 20 ||
      data.length > (count as number)
    )
      return { ok: false, reason: "INVALID_RESPONSE" };
    const choices = new Map<string, PoiChoice>(),
      seen = new Map<string, string>();
    // Total results and city clusters never constitute evidence of uniqueness.
    for (const entry of data) {
      const row = record(entry),
        ad = record(row.ad_info),
        point = record(row.location);
      if (typeof row.id !== "string" || !row.id) continue;
      const signature = JSON.stringify([
        row.title,
        row.address,
        row.type,
        point.lat,
        point.lng,
        ad.city,
        ad.province,
        ad.district,
      ]);
      if (seen.has(row.id) && seen.get(row.id) !== signature)
        return { ok: false, reason: "INVALID_RESPONSE" };
      seen.set(row.id, signature);
      if (![0, 1, 2].includes(row.type as number)) continue;
      const choice: PoiChoice = {
        id: row.id,
        title: row.title as string,
        address: row.address as string,
        city: ad.city as string,
        province: ad.province as string,
        ...(typeof ad.district === "string" && ad.district ? { district: ad.district } : {}),
        location: {
          latitude: point.lat,
          longitude: point.lng,
          coordinateSystem: "GCJ02",
        } as GeoPoint,
        match: "EXACT_NAME",
      };
      const match = choiceMatch(choice, { address, city });
      if (!match) continue;
      choices.set(choice.id, { ...choice, match });
    }
    const clusterCities = new Map<string, string>();
    if (!scope && Array.isArray(response.value.cluster))
      for (const entry of response.value.cluster) {
        const cluster = record(entry);
        if (
          typeof cluster.title === "string" &&
          Number.isSafeInteger(cluster.count) &&
          (cluster.count as number) > 0 &&
          searchScope(address, cluster.title)
        )
          clusterCities.set(identity(cluster.title).replace(/市$/u, ""), cluster.title.trim());
      }
    return {
      ok: true,
      value: {
        choices: [...choices.values()].slice(0, 6),
        clusterCities: [...clusterCities.values()].slice(0, 3),
      },
    };
  }
  private async searchPoi(
    address: string,
    city?: string,
    signal?: AbortSignal,
  ): Promise<MapResult<GeocodedPlace>> {
    const scope = searchScope(address, city);
    if (
      !scope ||
      coarseRegions.test(identity(address)) ||
      sameCity(address, scope.city) ||
      genericQuery(address) ||
      Buffer.byteLength(address, "utf8") > 96
    )
      return { ok: false, reason: "AMBIGUOUS_ADDRESS" };
    const response = await this.request(
      "/ws/place/v1/search",
      {
        keyword: address,
        boundary: `region(${scope.city},0)`,
        page_size: "20",
        page_index: "1",
        output: "json",
      },
      signal,
    );
    if (!response.ok) return response;
    const count = response.value.count,
      data = response.value.data;
    if (!Number.isInteger(count) || (count as number) < 0 || !Array.isArray(data))
      return { ok: false, reason: "INVALID_RESPONSE" };
    if (
      (count as number) > 20 ||
      (count as number) !== data.length ||
      response.value.cluster ||
      response.value.clusters
    )
      return { ok: false, reason: "AMBIGUOUS_ADDRESS" };
    const matches = new Map<string, GeocodedPlace>(),
      seen = new Map<string, string>();
    for (const entry of data) {
      const row = record(entry),
        ad = record(row.ad_info),
        point = record(row.location);
      if (
        typeof row.id !== "string" ||
        !row.id ||
        typeof row.title !== "string" ||
        !row.title ||
        typeof row.address !== "string" ||
        ![0, 1, 2, 3, 4].includes(row.type as number)
      )
        return { ok: false, reason: "INVALID_RESPONSE" };
      const signature = JSON.stringify([
        row.title,
        row.address,
        row.type,
        point.lat,
        point.lng,
        ad.city,
        ad.province,
        ad.district,
      ]);
      if (seen.has(row.id) && seen.get(row.id) !== signature)
        return { ok: false, reason: "INVALID_RESPONSE" };
      seen.set(row.id, signature);
      if (![0, 1, 2].includes(row.type as number)) continue;
      const match = poiMatch(address, row.title, row.address, scope);
      if (!match) continue;
      const location = {
        latitude: point.lat,
        longitude: point.lng,
        coordinateSystem: "GCJ02",
      } as GeoPoint;
      const result: GeocodedPlace = {
        location,
        verificationMethod: "POI_SEARCH",
        city: typeof ad.city === "string" ? ad.city : undefined,
        region: typeof ad.province === "string" ? ad.province : undefined,
        poi: {
          id: row.id,
          title: row.title,
          address: row.address,
          type: row.type as 0 | 1 | 2,
          city: ad.city as string,
          province: ad.province as string,
          district: typeof ad.district === "string" ? ad.district : undefined,
          location,
          query: address,
          searchCity: scope.city,
          resultCount: count as number,
          complete: true,
          uniqueMatches: 1,
          match,
        },
      };
      if (!isVerifiedGeocodedPlace(result, { address, city: scope.city }))
        return { ok: false, reason: "AMBIGUOUS_ADDRESS" };
      matches.set(row.id, result);
    }
    return matches.size === 1
      ? { ok: true, value: [...matches.values()][0]! }
      : { ok: false, reason: "AMBIGUOUS_ADDRESS" };
  }
  async route(
    from: GeoPoint,
    to: GeoPoint,
    signal?: AbortSignal,
  ): Promise<MapResult<RouteEstimate>> {
    return this.routeForMode(from, to, "walking", signal);
  }
  async routeForMode(
    from: GeoPoint,
    to: GeoPoint,
    mode: RouteMode,
    signal?: AbortSignal,
    departureTime = new Date(),
    options: { avoidSubway?: boolean } = {},
  ): Promise<MapResult<RouteEstimate>> {
    if (!this.configured) return { ok: false, reason: "NOT_CONFIGURED" };
    if (!isGeoPoint(from) || !isGeoPoint(to)) return { ok: false, reason: "INVALID_LOCATION" };
    const response = await this.request(
      `/ws/direction/v1/${mode}/`,
      {
        from: `${from.latitude},${from.longitude}`,
        to: `${to.latitude},${to.longitude}`,
        output: "json",
        ...(mode === "transit"
          ? {
              policy: options.avoidSubway ? "LEAST_TIME,NO_SUBWAY" : "LEAST_TIME",
              price_unit: "1",
              driving_estimate: "0",
              departure_time: String(Math.floor(departureTime.getTime() / 1000)),
            }
          : {}),
      },
      signal,
    );
    if (!response.ok) return response;
    const routes = record(response.value.result).routes;
    const validRoutes = (Array.isArray(routes) ? routes : [])
      .map(record)
      .filter((route) => {
        if (
          !nonnegative(route.distance) ||
          !nonnegative(route.duration) ||
          route.is_driving_estimate
        )
          return false;
        if (mode !== "transit") return true;
        const steps = Array.isArray(route.steps) ? route.steps.map(record) : [];
        const publicSteps = steps.filter((step) => step.mode === "TRANSIT");
        // The provider may otherwise return walking-only or driving estimates.
        if (
          !publicSteps.length ||
          steps.some(
            (step) =>
              !["WALKING", "TRANSIT"].includes(String(step.mode)) ||
              Boolean(step.is_driving_estimate),
          )
        )
          return false;
        return publicSteps.every((step) => {
          const lines = Array.isArray(step.lines) ? step.lines.map(record) : [];
          const line = lines[0] ?? step;
          return (
            ["BUS", "SUBWAY", "RAIL"].includes(String(line.vehicle)) &&
            line.running_status === 300 &&
            nonnegative(line.duration) &&
            (!options.avoidSubway || line.vehicle !== "SUBWAY")
          );
        });
      })
      .sort((a, b) => Number(a.duration) - Number(b.duration));
    const route = validRoutes[0] ?? {};
    if (!nonnegative(route.distance) || !nonnegative(route.duration))
      return { ok: false, reason: "INVALID_RESPONSE" };
    const transitDurations: TransitDurations = {};
    if (mode === "transit")
      for (const step of (route.steps as unknown[])
        .map(record)
        .filter((step) => step.mode === "TRANSIT")) {
        const line = Array.isArray(step.lines) ? record(step.lines[0]) : step;
        const vehicle = line.vehicle as Exclude<TransitKind, "MIXED">;
        transitDurations[vehicle] =
          (transitDurations[vehicle] ?? 0) + Math.ceil(Number(line.duration) * 60);
      }
    const now = new Date();
    return {
      ok: true,
      value: {
        distanceMeters: route.distance,
        durationSeconds: Math.ceil(route.duration * 60),
        mode,
        segments: segmentsForRoute(route, mode),
        ...(mode === "transit"
          ? { transitDurations, transitKind: dominantTransitKind(transitDurations) }
          : {}),
        costMinor:
          mode === "walking"
            ? 0
            : mode === "transit" && nonnegative(route.price)
              ? Math.ceil(route.price)
              : null,
        provider: "TENCENT",
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 5 * 60000).toISOString(),
      },
    };
  }
  private async request(
    path: string,
    input: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<MapResult<Record<string, unknown>>> {
    if (signal?.aborted) return { ok: false, reason: "TIMEOUT" };
    const params: Record<string, string> = { ...input, key: this.key };
    const url = new URL(path, "https://apis.map.qq.com");
    for (const name of Object.keys(params).sort()) url.searchParams.set(name, params[name]!);
    if (this.secret) url.searchParams.set("sig", tencentSignature(path, params, this.secret));
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal?.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<MapResult<Record<string, unknown>>>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve({ ok: false, reason: "TIMEOUT" });
      }, this.timeoutMs);
    });
    try {
      const result = await Promise.race([
        deadline,
        (async (): Promise<MapResult<Record<string, unknown>>> => {
          await this.waitForTurn(path, abort.signal);
          if (abort.signal.aborted) return { ok: false, reason: "TIMEOUT" };
          const response = await this.transport(url, {
            signal: abort.signal,
            redirect: "error",
            headers: { "x-legacy-url-decode": "no" },
          });
          if (!response.ok) return { ok: false, reason: "PROVIDER_UNAVAILABLE" };
          if (Number(response.headers.get("content-length") ?? 0) > 1048576)
            return { ok: false, reason: "INVALID_RESPONSE" };
          const text = await response.text();
          if (text.length > 1048576) return { ok: false, reason: "INVALID_RESPONSE" };
          const body = record(JSON.parse(text));
          if (body.status === 120) return { ok: false, reason: "RATE_LIMITED" };
          if (body.status === 121) return { ok: false, reason: "QUOTA_EXCEEDED" };
          // Missing-city geocoding can be recovered only with an exact city-scoped POI.
          if (
            [347, 348].includes(body.status as number) &&
            path === "/ws/geocoder/v1/" &&
            typeof input.address === "string"
          )
            return { ok: false, reason: "AMBIGUOUS_ADDRESS" };
          if (body.status === 326) return { ok: false, reason: "ROUTE_TOO_CLOSE" };
          if ([327, 328, 329, 335, 344, 377, 378, 379, 384].includes(body.status as number))
            return { ok: false, reason: "NO_ROUTE" };
          if (body.status === 373) return { ok: false, reason: "ROUTE_TOO_LONG" };
          if (body.status === 374) return { ok: false, reason: "INVALID_LOCATION" };
          if (body.status === 500) return { ok: false, reason: "TIMEOUT" };
          if (typeof body.status === "number" && body.status >= 500 && body.status < 600)
            return { ok: false, reason: "PROVIDER_UNAVAILABLE" };
          if (body.status !== 0) return { ok: false, reason: "PROVIDER_REJECTED" };
          return { ok: true, value: body };
        })(),
      ]);
      return result;
    } catch {
      // Never surface URLs, provider message strings or credentials in diagnostics.
      return { ok: false, reason: abort.signal.aborted ? "TIMEOUT" : "PROVIDER_UNAVAILABLE" };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }
}
