# Location provider boundary

`TencentLbsAdapter` reads server-only `TENCENT_LBS_KEY` and optional `TENCENT_LBS_SECRET` (for a key configured with SN verification). Neither is sent to the mini-program. Tencent credentials are configured in the staging server. On 2026-10-05, real geocoding and independently requested outward/return walking routes returned status 0; see [configuration and acceptance](../../../docs/tencent-map-setup-2026-10-05.md).

The REST adapter uses the fixed HTTPS host `apis.map.qq.com`, rejects redirects, bounds each call, and returns generic failure codes without logging URLs or provider messages. GCJ02 coordinates use latitude before longitude. Geocoding requires reliability >=7 and level >=9; a city centroid is insufficient. Walking route durations are minutes in Tencent's response and become seconds at the adapter boundary. No opening hours are inferred.

Real requests are spaced at 250 ms per process/key/path. The queue is included in the bounded timeout. This is not a distributed limiter across multiple replicas. Tencent rate/quota failures are returned as generic `RATE_LIMITED` / `QUOTA_EXCEEDED`, without leaking credentials. Clear visit destinations can be enriched asynchronously and persisted in an independent `EXTERNAL_VERIFIED` facet; coordinates remain usable only while their address/city binding matches.

`BuildDecisionContextService.enrichCandidates` considers at most five destinations, runs at most two candidate pipelines concurrently, and stops the batch after two seconds. It requests outward and return journeys independently. Both must succeed before a route is ready. Estimates retain origin, destination, observation time, and an expiry no later than either route's five-minute TTL or the origin's expiry. There is no persistent route/GPS cache.

`build` uses the server clock and the user's stored timezone. Explicit `originContext` facts supply a coarse current region for 24 hours. Current availability/budget facts require `USER_STATED`, `scope=CURRENT`, and a capture within two hours. Object/travel costs do not become the current budget. Saved HOME facts remain distinguishable from evidence of present physical location. Exact input coordinates expire within two hours of observation. Future/stale observations are rejected. Context snapshots are owner-scoped; expired snapshots and legacy precise snapshots older than 24 hours are purged during builds.

A current availability statement establishes an absolute deadline from the capture's server timestamp. The original whole-minute amount remains available for display; `calendar.effectiveAvailableMinutes` contains the actual remaining fraction after elapsed time and the next event limit. Restoring a session retains `calendar.availableUntil`; an explicit new availability answer starts a new window. Duplicate facts from one capture use its tightest limit, while a newer declaration replaces an older one. Accepting a plan does not imply that money was spent.

Scheduled events have an independent nearest-200 query, alongside the latest 500 context facts. An exact future event start caps the free interval even without an end; an unknown end never becomes an invented all-day event. Accepted action plans contribute server-authored busy windows until terminal feedback closes them.

For legacy EVENT facts stored as `windowStart`/`windowEnd`, raw captured expressions must normalize to exact instants before becoming fixed busy windows. Broad expressions such as “明天下午” and failed grounding warnings cannot create fixed meetings. Manually confirmed EVENT facts may use explicit ISO bounds directly.

Official sources checked on 2026-10-05:

- [Tencent geocoding](https://lbs.qq.com/service/webService/webServiceGuide/address/Geocoder)
- [Tencent routing](https://lbs.qq.com/service/webService/webServiceGuide/route/webServiceRoute)
- [Tencent key and GET signature rules](https://lbs.qq.com/faq/serverFaq/webServiceKey)
- [TencentLBS geocoding reference](https://github.com/TencentLBS/tencentmap-webservice-skill/blob/main/references/api-geocoder.md)
- [TencentLBS routing reference](https://github.com/TencentLBS/tencentmap-webservice-skill/blob/main/references/api-direction.md)
