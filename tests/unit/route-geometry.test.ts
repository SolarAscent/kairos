import { describe, expect, it, vi } from "vitest";
import { decodeTencentPolyline, TencentLbsAdapter, type GeoPoint } from "@life/integrations";
import { routeCheckDetailSchema, routeSegmentsSchema } from "@life/contracts";

const origin: GeoPoint = { latitude: 23.1, longitude: 113.3, coordinateSystem: "GCJ02" };
const destination: GeoPoint = { latitude: 23.105, longitude: 113.305, coordinateSystem: "GCJ02" };
const line = [23.1, 113.3, 0, 2000, 2000, 0, 0, 3000, 3000, 0];
const transitLine = (polyline: unknown, vehicle = "BUS") => ({
  vehicle,
  duration: 10,
  running_status: 300,
  polyline,
});
const reply = (routes: unknown[]) =>
  new Response(JSON.stringify({ status: 0, result: { routes } }));

describe("Tencent forward-delta route geometry", () => {
  it("decodes the official sample without mutating provider data", () => {
    const raw = [50.243916, 127.496637, -345, -1828, 19867, -26154];
    const original = [...raw];
    const points = decodeTencentPolyline(raw)!;
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ latitude: 50.243916, longitude: 127.496637 });
    expect(points[1]!.latitude).toBeCloseTo(50.243571, 8);
    expect(points[1]!.longitude).toBeCloseTo(127.494809, 8);
    expect(points[2]!.latitude).toBeCloseTo(50.263438, 8);
    expect(points[2]!.longitude).toBeCloseTo(127.468655, 8);
    expect(raw).toEqual(original);
  });
  it("retains every corner and both endpoints without thinning into a straight chord", () => {
    const points = decodeTencentPolyline(line)!;
    expect(points).toHaveLength(5);
    expect(points[1]).toEqual({ latitude: 23.1, longitude: 113.30199999999999 });
    expect(points[2]!.latitude).toBeCloseTo(23.102, 8);
    expect(points[2]!.longitude).toBeCloseTo(113.302, 8);
    expect(points[3]!.longitude).toBeCloseTo(113.305, 8);
    expect(points[4]!.latitude).toBeCloseTo(destination.latitude, 8);
    expect(points[4]!.longitude).toBeCloseTo(destination.longitude, 8);
  });
  it.each([
    { raw: undefined },
    { raw: [] },
    { raw: [23, 113] },
    { raw: [23, 113, 10] },
    { raw: [23, 113, "10", 10] },
    { raw: [23, 113, Number.NaN, 0] },
    { raw: [23, 113, 0, Number.POSITIVE_INFINITY] },
    { raw: [23, 113, 1.5, 0] },
    { raw: [91, 113, 0, 0] },
    { raw: [23, 181, 0, 0] },
    { raw: [23, 113, 68000000, 0] },
    { raw: [23, 113, 0, 68000000] },
    { raw: Array(8194).fill(0) },
  ])("rejects malformed or oversized geometry as a whole: %j", ({ raw }) => {
    expect(decodeTencentPolyline(raw)).toBeUndefined();
  });
  it("accepts the bounded maximum without dropping corners or endpoints", () => {
    const raw = [23.1, 113.3, ...Array.from({ length: 4095 }, () => [1, -1]).flat()];
    const points = decodeTencentPolyline(raw)!;
    expect(points).toHaveLength(4096);
    expect(points.at(-1)!.latitude).toBeCloseTo(23.104095, 8);
    expect(points.at(-1)!.longitude).toBeCloseTo(113.295905, 8);
  });
});

describe("geometry belongs to the exact chosen directional route", () => {
  it.each(["walking", "bicycling"] as const)(
    "reads %s geometry from the selected fastest route",
    async (mode) => {
      const fetch = vi.fn().mockResolvedValue(
        reply([
          { distance: 9000, duration: 20, polyline: [24, 114, 0, 1000] },
          { distance: 1000, duration: 10, polyline: line },
        ]),
      );
      const result = await new TencentLbsAdapter({ key: "synthetic" }, fetch).routeForMode(
        origin,
        destination,
        mode,
      );
      expect(result).toMatchObject({
        ok: true,
        value: { durationSeconds: 600, segments: [{ mode, points: decodeTencentPolyline(line) }] },
      });
    },
  );
  it("uses each real transit walking step and only the chosen first line, keeping boundaries separate", async () => {
    const firstWalk = [23.1, 113.3, 0, 500, 500, 0];
    const ride = [23.101, 113.301, 1000, 1000, 1000, 0];
    const lastWalk = [23.104, 113.304, 1000, 0, 0, 1000];
    const fetch = vi.fn().mockResolvedValue(
      reply([
        {
          distance: 6000,
          duration: 25,
          price: 200,
          polyline: [24, 114, 0, 10000],
          steps: [
            { mode: "WALKING", polyline: firstWalk, steps: [{ polyline_idx: [0, 3] }] },
            { mode: "TRANSIT", lines: [transitLine(ride), transitLine([25, 115, 0, 10000])] },
            { mode: "WALKING", polyline: lastWalk },
          ],
        },
      ]),
    );
    const result = await new TencentLbsAdapter({ key: "synthetic" }, fetch).routeForMode(
      origin,
      destination,
      "transit",
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        transitKind: "BUS",
        segments: [
          { mode: "walking", points: decodeTencentPolyline(firstWalk) },
          { mode: "transit", points: decodeTencentPolyline(ride) },
          { mode: "walking", points: decodeTencentPolyline(lastWalk) },
        ],
      },
    });
  });
  it("omits an entire malformed middle segment instead of connecting points across its gap", async () => {
    const before = [23.1, 113.3, 0, 500];
    const after = [23.104, 113.304, 1000, 1000];
    const fetch = vi.fn().mockResolvedValue(
      reply([
        {
          distance: 6000,
          duration: 25,
          price: 200,
          steps: [
            { mode: "WALKING", polyline: before },
            { mode: "TRANSIT", lines: [transitLine([23.102, 113.302, null, 10, 100, 0])] },
            { mode: "WALKING", polyline: after },
          ],
        },
      ]),
    );
    const result = await new TencentLbsAdapter({ key: "synthetic" }, fetch).routeForMode(
      origin,
      destination,
      "transit",
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        durationSeconds: 1500,
        segments: [
          { mode: "walking", points: decodeTencentPolyline(before) },
          { mode: "walking", points: decodeTencentPolyline(after) },
        ],
      },
    });
  });
  it("does not substitute alternate line geometry when the chosen line's points are missing", async () => {
    const fetch = vi.fn().mockResolvedValue(
      reply([
        {
          distance: 6000,
          duration: 25,
          price: 200,
          steps: [{ mode: "TRANSIT", lines: [transitLine(undefined), transitLine(line)] }],
        },
      ]),
    );
    const result = await new TencentLbsAdapter({ key: "synthetic" }, fetch).routeForMode(
      origin,
      destination,
      "transit",
    );
    expect(result.ok && result.value.durationSeconds).toBe(1500);
    expect(result.ok && result.value.segments).toBeUndefined();
  });
  it("keeps valid route metrics when geometry is missing and omits station-only rail geometry", async () => {
    const fetch = vi.fn().mockResolvedValue(
      reply([
        {
          distance: 6000,
          duration: 25,
          price: 200,
          steps: [{ mode: "TRANSIT", lines: [transitLine(line, "RAIL")] }],
        },
      ]),
    );
    const result = await new TencentLbsAdapter({ key: "synthetic" }, fetch).routeForMode(
      origin,
      destination,
      "transit",
    );
    expect(result).toMatchObject({
      ok: true,
      value: { durationSeconds: 1500, transitKind: "RAIL" },
    });
    expect(result.ok && result.value.segments).toBeUndefined();
  });
  it("falls back to markers for over-budget total geometry while retaining transit duration", async () => {
    const large = [23.1, 113.3, ...Array.from({ length: 2048 }, () => [1, 1]).flat()];
    const fetch = vi.fn().mockResolvedValue(
      reply([
        {
          distance: 6000,
          duration: 25,
          price: 200,
          steps: [
            { mode: "WALKING", polyline: large },
            { mode: "TRANSIT", lines: [transitLine(large)] },
          ],
        },
      ]),
    );
    const result = await new TencentLbsAdapter({ key: "synthetic" }, fetch).routeForMode(
      origin,
      destination,
      "transit",
    );
    expect(result.ok && result.value.durationSeconds).toBe(1500);
    expect(result.ok && result.value.segments).toBeUndefined();
  });
});

describe("optional map geometry contract", () => {
  it("keeps duration/detail readable when stored geometry is malformed", () => {
    const detail = routeCheckDetailSchema.parse({
      origin,
      destination,
      destinationLabel: "图书馆",
      outwardSeconds: 600,
      returnSeconds: 720,
      outwardMeters: 1000,
      returnMeters: 1100,
      departureBlocker: null,
      requiredSeconds: 1920,
      segments: [
        {
          mode: "walking",
          points: [
            { latitude: 23, longitude: 113 },
            { latitude: 200, longitude: 114 },
          ],
        },
      ],
    });
    expect(detail.outwardSeconds).toBe(600);
    expect(detail.segments).toBeUndefined();
    expect(
      routeSegmentsSchema.parse(
        Array.from({ length: 65 }, () => ({
          mode: "walking",
          points: decodeTencentPolyline(line),
        })),
      ),
    ).toBeUndefined();
  });
});
