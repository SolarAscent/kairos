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
  reliability: number;
  level: number;
}
export interface RouteEstimate {
  durationSeconds: number;
  distanceMeters: number;
  mode: "walking";
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
  | "INVALID_RESPONSE";
export type MapResult<T> = { ok: true; value: T } | { ok: false; reason: MapFailure };
export interface LocationProvider {
  readonly configured: boolean;
  geocode(address: string, city?: string, signal?: AbortSignal): Promise<MapResult<GeocodedPlace>>;
  route(from: GeoPoint, to: GeoPoint, signal?: AbortSignal): Promise<MapResult<RouteEstimate>>;
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
    if (!response.ok) return response;
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
      return { ok: false, reason: "AMBIGUOUS_ADDRESS" };
    const components = record(result.address_components);
    return {
      ok: true,
      value: {
        location,
        reliability: result.reliability,
        level: result.level,
        ...(typeof components.city === "string" ? { city: components.city } : {}),
        ...(typeof components.province === "string" ? { region: components.province } : {}),
      },
    };
  }
  async route(
    from: GeoPoint,
    to: GeoPoint,
    signal?: AbortSignal,
  ): Promise<MapResult<RouteEstimate>> {
    if (!this.configured) return { ok: false, reason: "NOT_CONFIGURED" };
    if (!isGeoPoint(from) || !isGeoPoint(to)) return { ok: false, reason: "INVALID_LOCATION" };
    const response = await this.request(
      "/ws/direction/v1/walking/",
      {
        from: `${from.latitude},${from.longitude}`,
        to: `${to.latitude},${to.longitude}`,
        output: "json",
      },
      signal,
    );
    if (!response.ok) return response;
    const routes = record(response.value.result).routes;
    const route = record(Array.isArray(routes) ? routes[0] : null);
    if (!nonnegative(route.distance) || !nonnegative(route.duration))
      return { ok: false, reason: "INVALID_RESPONSE" };
    const now = new Date();
    return {
      ok: true,
      value: {
        distanceMeters: route.distance,
        durationSeconds: Math.ceil(route.duration * 60),
        mode: "walking",
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
