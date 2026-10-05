import type { ParsedLifeObject, StructuredLifeFacts } from "@life/contracts";

export interface CaptureReference {
  referenceTime: string;
  timezone: string;
  sourceText?: string;
}
type Calendar = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};
const partsAt = (date: Date, timezone: string): Calendar => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (key: string) => Number(parts.find((p) => p.type === key)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
};
const epoch = (p: Calendar) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
const valid = (p: Calendar) => {
  const date = new Date(epoch(p));
  return (
    p.year >= 1970 &&
    p.year <= 2200 &&
    date.getUTCFullYear() === p.year &&
    date.getUTCMonth() === p.month - 1 &&
    date.getUTCDate() === p.day &&
    p.hour >= 0 &&
    p.hour <= 23 &&
    p.minute >= 0 &&
    p.minute <= 59 &&
    p.second >= 0 &&
    p.second <= 59
  );
};
function zoned(p: Calendar, timezone: string): string | null {
  if (!valid(p)) return null;
  let guess = epoch(p);
  for (let i = 0; i < 4; i++) {
    const offset = epoch(partsAt(new Date(guess), timezone)) - guess;
    const next = epoch(p) - offset;
    if (next === guess) break;
    guess = next;
  }
  return epoch(partsAt(new Date(guess), timezone)) === epoch(p)
    ? new Date(guess).toISOString()
    : null;
}
function shift(p: Calendar, days: number): Calendar {
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return {
    ...p,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}
export interface NormalizedTime {
  exact: string | null;
  start: string | null;
  end: string | null;
  warnings: string[];
}
/** Resolve only a small explicit calendar grammar; unsupported expressions remain unknown. */
export function normalizeLifeTime(
  expression: string | null | undefined,
  context: CaptureReference,
): NormalizedTime {
  const unknown = (warning?: string): NormalizedTime => ({
    exact: null,
    start: null,
    end: null,
    warnings: warning ? [warning] : [],
  });
  if (!expression?.trim()) return unknown();
  const text = expression.trim();
  const reference = new Date(context.referenceTime);
  if (!Number.isFinite(reference.getTime())) return unknown("REFERENCE_TIME_INVALID");
  let p: Calendar;
  try {
    p = partsAt(reference, context.timezone);
  } catch {
    return unknown("TIMEZONE_INVALID");
  }
  const explicitIso = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (explicitIso) {
    const calendar = {
      year: +explicitIso[1]!,
      month: +explicitIso[2]!,
      day: +explicitIso[3]!,
      hour: +explicitIso[4]!,
      minute: +explicitIso[5]!,
      second: +(explicitIso[6] ?? 0),
    };
    const date = new Date(text);
    if (!valid(calendar) || !Number.isFinite(date.getTime())) return unknown("TIME_INVALID");
    const exact = date.toISOString();
    return { exact, start: exact, end: exact, warnings: [] };
  }
  p = { ...p, hour: 0, minute: 0, second: 0 };
  const warnings: string[] = [];
  let remainder = text.replace(/\s+/g, "");
  let hasDay = false;
  const isoDay = remainder.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(.*))?$/);
  const chineseDay = remainder.match(/^(?:(\d{4})年|(今年|明年))?(\d{1,2})月(\d{1,2})[日号]?(.*)$/);
  const relative = remainder.match(/^(今天|明天|后天|大后天|今晚|明晚)(.*)$/);
  const weekday = remainder.match(/^(本周|这周|下周|周|星期)([一二三四五六日天])(.*)$/);
  if (isoDay) {
    p = { ...p, year: +isoDay[1]!, month: +isoDay[2]!, day: +isoDay[3]! };
    remainder = isoDay[4] ?? "";
    hasDay = true;
  } else if (chineseDay) {
    p = {
      ...p,
      year: chineseDay[1] ? +chineseDay[1] : p.year + (chineseDay[2] === "明年" ? 1 : 0),
      month: +chineseDay[3]!,
      day: +chineseDay[4]!,
    };
    if (!chineseDay[1] && !chineseDay[2]) warnings.push("YEAR_FROM_CAPTURE_REFERENCE");
    remainder = chineseDay[5] ?? "";
    hasDay = true;
  } else if (relative) {
    const days: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3, 今晚: 0, 明晚: 1 };
    p = shift(p, days[relative[1]!]!);
    remainder = relative[2] ?? "";
    if (["今晚", "明晚"].includes(relative[1]!)) remainder = "晚上" + remainder;
    hasDay = true;
  } else if (weekday) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const target = "日一二三四五六".indexOf(weekday[2]!.replace("天", "日"));
    let delta = (target - day + 7) % 7;
    if (["本周", "这周", "下周"].includes(weekday[1]!))
      delta = target === 0 ? 7 - (day || 7) : target - (day || 7);
    if (weekday[1] === "下周") delta += 7;
    p = shift(p, delta);
    remainder = weekday[3] ?? "";
    hasDay = true;
  }
  if (!hasDay) return unknown("TIME_DATE_UNSPECIFIED_OR_UNSUPPORTED");
  if (!valid(p)) return unknown("TIME_INVALID");
  remainder = remainder.replace(/[零一二两三四五六七八九十]{1,3}(?=点|分)/gu, (text) =>
    String(quantityNumber(text)),
  );
  const clock = remainder.match(
    /^(早上|上午|中午|下午|晚上|夜里)?(\d{1,2})(?::(\d{2})|点(?:(\d{1,2})分?|半)?)(?::(\d{2}))?$/,
  );
  if (clock) {
    let hour = +clock[2]!;
    if (["下午", "晚上", "夜里"].includes(clock[1] ?? "") && hour < 12) hour += 12;
    if (clock[1] === "上午" && hour === 12) hour = 0;
    const minute = +(clock[3] ?? clock[4] ?? (remainder.endsWith("半") ? 30 : 0));
    const exact = zoned({ ...p, hour, minute, second: +(clock[5] ?? 0) }, context.timezone);
    return exact
      ? { exact, start: exact, end: exact, warnings }
      : unknown("TIME_INVALID_OR_DST_GAP");
  }
  const bands: Record<string, [number, number]> = {
    "": [0, 24],
    早上: [6, 12],
    上午: [6, 12],
    中午: [12, 14],
    下午: [12, 18],
    晚上: [18, 24],
    夜里: [18, 24],
  };
  const band = bands[remainder];
  if (!band) return unknown("TIME_UNSUPPORTED");
  const start = zoned({ ...p, hour: band[0] }, context.timezone);
  const end = zoned(band[1] === 24 ? shift(p, 1) : { ...p, hour: band[1] }, context.timezone);
  if (!start || !end) return unknown("TIME_INVALID_OR_DST_GAP");
  return { exact: null, start, end: new Date(new Date(end).getTime() - 1).toISOString(), warnings };
}

const evidenceText = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
function evidenceInSource(evidence: string, source: string): boolean {
  const normalized = evidenceText(source);
  const clauses = evidence
    .split(/[，,。；;\n]/u)
    .map(evidenceText)
    .filter(Boolean);
  return clauses.length > 0 && clauses.every((clause) => normalized.includes(clause));
}
function quantityNumber(text: string): number {
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (text === "半") return 0.5;
  let total = 0,
    section = 0,
    digit = 0;
  for (const char of text) {
    if (char in digits) digit = digits[char]!;
    else if (/^[0-9]$/.test(char)) digit = Number(char);
    else if (char === "万") {
      total += (section + digit) * 10000;
      section = 0;
      digit = 0;
    } else {
      const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[char];
      if (!unit) return NaN;
      section += (digit || 1) * unit;
      digit = 0;
    }
  }
  return total + section + digit;
}
/** Bounds must be present with their unit in the cited evidence, not a model label alone. */
function quantityValues(evidence: string, kind: "duration" | "money"): number[] {
  const number = "[0-9零一二两三四五六七八九十百千万半]+(?:\\.[0-9]+)?";
  const units =
    kind === "duration"
      ? "分钟|小时|秒钟|秒|天|minutes?|mins?|hours?|hrs?|seconds?|secs?"
      : "元|块钱|块|分(?!钟)|人民币|CNY|RMB";
  const regex = new RegExp(
    `(${number})(?:\\s*(?:到|至|[-~—～])\\s*(${number}))?\\s*(${units})`,
    "giu",
  );
  const values: number[] = [];
  for (const match of evidence.matchAll(regex)) {
    const unit = match[3]!.toLowerCase();
    const scale =
      kind === "money"
        ? unit === "分"
          ? 1
          : 100
        : /小时|hour|hr/.test(unit)
          ? 3600
          : /分钟|minute|min/.test(unit)
            ? 60
            : unit === "天"
              ? 86400
              : 1;
    values.push(Math.round(quantityNumber(match[1]!) * scale));
    if (match[2]) values.push(Math.round(quantityNumber(match[2]) * scale));
  }
  if (kind === "money")
    for (const match of evidence.matchAll(new RegExp(`[¥￥]\\s*(${number})`, "gu")))
      values.push(Math.round(quantityNumber(match[1]!) * 100));
  if (kind === "money" && /免费|不要钱|不收费/u.test(evidence)) values.push(0);
  return values.filter(Number.isFinite);
}

/** Recover a quoted calendar expression instead of trusting a model-computed date. */
function evidenceTimeRange(evidence: string): { start: string; end: string | null } | null {
  const day =
    "(?:今天|明天|后天|大后天|今晚|明晚|(?:本周|这周|下周|周|星期)[一二三四五六日天]|(?:(?:[0-9]{4}年|今年|明年))?[0-9]{1,2}月[0-9]{1,2}[日号]?|[0-9]{4}-[0-9]{2}-[0-9]{2})";
  const band = "(?:早上|上午|中午|下午|晚上|夜里)";
  const clock =
    "(?:[0-9零一二两三四五六七八九十]{1,3}点(?:半|[0-9零一二两三四五六七八九十]{1,3}分?)?|[0-9]{1,2}:[0-9]{2})";
  const compact = evidence.replace(/\s+/g, "");
  const match = compact.match(
    new RegExp(
      `(?<day>${day})T?(?<band>${band})?(?<clock>${clock})?(?:[到至~—～-](?<endBand>${band})?(?<endClock>${clock}))?`,
      "u",
    ),
  );
  if (!match?.groups) return null;
  const { day: date, band: period = "", clock: start = "" } = match.groups;
  let { endBand, endClock } = match.groups;
  if (start && !endClock) {
    const suffix = compact.slice((match.index ?? 0) + match[0].length);
    const ending = suffix.match(
      new RegExp(`[,，；;](?<endBand>${band})?(?<endClock>${clock})(?:结束|散会|截止|离开)`, "u"),
    );
    endClock = ending?.groups?.endClock;
    endBand = ending?.groups?.endBand;
  }
  return {
    start: date! + period + start,
    end: endClock ? date! + (endBand ?? period) + endClock : start ? null : date! + period,
  };
}

const currentMarker = /现在|目前|此刻|这会儿|当下|眼下/g;
const otherTime =
  /去年|前年|昨天|昨晚|前天|上周|上个月|前几天|以前|过去|曾经|当年|当时|那时|明天|后天|明年|下周|下个月|将来|未来|以后|计划|打算|[0-9]{4}年|[0-9]{4}-[0-9]{2}-[0-9]{2}/g;
const currentNumber = "[0-9零一二两三四五六七八九十百千万半]+(?:\\.[0-9]+)?";
const provinces =
  "北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门";
/** Conservative source grammar: comma clauses retain their preceding temporal scope. */
function sourceCurrentFacts(source: string): ParsedLifeObject["facets"][number][] {
  const result: ParsedLifeObject["facets"][number][] = [];
  const append = (
    key: string,
    evidence: string,
    facts: Omit<StructuredLifeFacts, "origin" | "evidence">,
  ) =>
    result.push({
      type: "PREFERENCE",
      key: `source_current_${key}`,
      confidence: 1,
      source: "EXTRACTED",
      data: {
        intent: "CURRENT_CONTEXT",
        description: null,
        verification: "UNVERIFIED",
        facts: { origin: "USER_STATED", evidence, ...facts },
      },
    });
  for (const sentence of source.split(/[。！？!?；;\n]/u)) {
    if (
      /如果|假如|要是|假设|比如|例如|例子|不知道|是否|有没有|能不能|说[：:]|引用|[“”"‘’']/u.test(
        sentence,
      )
    )
      continue;
    const clauses = sentence.split(/[，,]/u);
    let prefix = "";
    for (const rawClause of clauses) {
      const clause = rawClause.trim();
      prefix += (prefix ? "，" : "") + clause;
      const now = [...prefix.matchAll(currentMarker)].at(-1)?.index ?? -1;
      const nonCurrent = [...prefix.matchAll(otherTime)].at(-1)?.index ?? -1;
      const self = prefix.lastIndexOf("我"),
        other = Math.max(
          ...[...prefix.matchAll(/朋友|同事|他|她|别人|爸爸|妈妈|家人|对方/g)].map(
            (match) => match.index,
          ),
          -1,
        );
      if (
        now < 0 ||
        nonCurrent > now ||
        other > self ||
        /不是|不在|没有|没剩|不剩|并非/u.test(clause)
      )
        continue;
      const location = clause.match(
        new RegExp(
          `^(?:我(?:现在|目前|此刻|这会儿|当下|眼下)?在|(?:现在|目前|此刻|这会儿|当下|眼下)我在)(${provinces})(?:省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)?(?!省|市|路|街|巷|大道|菜馆|餐厅|饭店|酒店|广场|大厦|小区|银行)`,
          "u",
        ),
      );
      if (location && !/境外|之外|以外|附近/u.test(clause))
        append("location", clause, {
          originContext: { province: location[1]!, region: location[1]! },
        });
      const time = clause.match(
        new RegExp(
          `^(?:我)?(?:现在|目前|此刻|这会儿|当下|眼下)?(?:我)?(?:只(?:有|剩下?|能用)|仅有|剩下?|还有|有|可用)(?:了)?\\s*(${currentNumber})\\s*(分钟|小时|秒)(.*)$`,
          "u",
        ),
      );
      if (time && /^(?:(?:的)?(?:空闲|可用)(?:时间)?|时间)?$/u.test(time[3]!.trim())) {
        const seconds = Math.round(
          quantityNumber(time[1]!) * (time[2] === "小时" ? 3600 : time[2] === "分钟" ? 60 : 1),
        );
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400)
          append("duration", clause, {
            duration: {
              minSeconds: seconds,
              maxSeconds: seconds,
              role: "AVAILABLE",
              scope: "CURRENT",
            },
          });
      }
      const budget = clause.match(
        new RegExp(
          `^(?:我)?(?:现在|目前|此刻|这会儿|当下|眼下)?(?:我)?(?:只能花|最多能花|最多花|可用预算(?:为|是)?|预算(?:只有|为|是)?|只有|只剩下?)\\s*(${currentNumber})\\s*(元|块钱|块)(.*)$`,
          "u",
        ),
      );
      if (
        budget &&
        !/旅行|旅游|出游|这次|这趟/u.test(clause) &&
        !/^(?:的|后|之后|以后)/u.test(budget[3]!)
      ) {
        const minor = Math.round(quantityNumber(budget[1]!) * 100);
        if (Number.isFinite(minor) && minor >= 0 && minor <= 100000000)
          append("budget", clause, {
            money: {
              minMinor: minor,
              maxMinor: minor,
              currency: "CNY",
              role: "BUDGET",
              scope: "CURRENT",
            },
          });
      }
    }
  }
  // A later correction supersedes earlier statements of the same context field.
  return result.filter(
    (facet, index) => !result.slice(index + 1).some((other) => other.key === facet.key),
  );
}

function currentLocationSupported(
  source: string,
  place: NonNullable<StructuredLifeFacts["originContext"]>,
  deterministic: StructuredLifeFacts["originContext"],
): boolean {
  const matchesProvince = (province: string) => {
    const administrative = [place.province, place.region].filter((value): value is string =>
      Boolean(value),
    );
    return administrative.length
      ? administrative.every((value) => value.includes(province))
      : [place.city, place.name].some((value) => value?.includes(province));
  };
  if (deterministic?.province) return matchesProvince(deterministic.province);
  for (const sentence of source.split(/[。！？!?；;\n]/u)) {
    if (/如果|假如|要是|假设|比如|例如|例子|说[：:]|引用|[“”"‘’']/u.test(sentence)) continue;
    for (const match of sentence.matchAll(
      new RegExp(
        `我(?:现在|目前|此刻|这会儿|当下|眼下)?在(${provinces})(?:省|市|自治区|特别行政区)?(?!省|市|路|街|巷|大道|菜馆|餐厅|饭店|酒店|广场|大厦|小区|银行)`,
        "gu",
      ),
    )) {
      const prefix = sentence.slice(0, match.index! + match[0].length);
      const now = [...prefix.matchAll(currentMarker)].at(-1)?.index ?? -1;
      const past = [...prefix.matchAll(otherTime)].at(-1)?.index ?? -1;
      if (past > now || /朋友|同事|他|她|别人|如果|不在/u.test(prefix)) continue;
      if (matchesProvince(match[1]!)) return true;
    }
  }
  return false;
}

type ParsedFacet = ParsedLifeObject["facets"][number];
export type NormalizedFacet = ParsedFacet & {
  data: ParsedFacet["data"] & {
    normalization?: {
      referenceTime: string;
      timezone: string;
      rawTime: StructuredLifeFacts["time"];
      warnings: string[];
    };
  };
};
export function normalizeLifeFacets(
  facets: ParsedFacet[],
  context: CaptureReference,
): NormalizedFacet[] {
  const deterministic =
    context.sourceText !== undefined ? sourceCurrentFacts(context.sourceText) : [];
  const stated = (key: "duration" | "money" | "originContext") =>
    deterministic.find((facet) => facet.data.facts?.[key])?.data.facts?.[key];
  const normalized = facets.map((facet) => {
    const originalFacts = facet.data.facts;
    if (!originalFacts) return facet;
    const facts = { ...originalFacts };
    const time: NonNullable<StructuredLifeFacts["time"]> = {};
    const warnings: string[] = [];
    if (
      facts.origin === "USER_STATED" &&
      context.sourceText !== undefined &&
      !evidenceInSource(facts.evidence, context.sourceText)
    ) {
      facts.origin = "INFERRED";
      warnings.push("EVIDENCE_NOT_IN_SOURCE");
    }
    if (facts.duration) {
      const values = quantityValues(facts.evidence, "duration");
      if (
        [facts.duration.minSeconds, facts.duration.maxSeconds].some(
          (value) => value != null && !values.includes(value),
        )
      ) {
        facts.duration = undefined;
        warnings.push("DURATION_NOT_GROUNDED");
      }
    }
    if (facts.money) {
      const values = facts.money.currency === "CNY" ? quantityValues(facts.evidence, "money") : [];
      if (
        [facts.money.minMinor, facts.money.maxMinor].some(
          (value) => value != null && !values.includes(value),
        )
      ) {
        facts.money = undefined;
        warnings.push("MONEY_NOT_GROUNDED");
      }
    }
    if (context.sourceText !== undefined) {
      const currentDuration = stated("duration") as StructuredLifeFacts["duration"];
      const currentMoney = stated("money") as StructuredLifeFacts["money"];
      const tripBudget = context.sourceText.match(
        new RegExp(
          `(?:旅行|旅游|出游)(?:的|总)?预算(?:只有|为|是)?\\s*${currentNumber}\\s*(?:元|块钱|块)`,
          "u",
        ),
      )?.[0];
      const tripValues = tripBudget ? quantityValues(tripBudget, "money") : [];
      if (
        facts.money &&
        [facts.money.minMinor, facts.money.maxMinor].some((value) => value != null) &&
        [facts.money.minMinor, facts.money.maxMinor].every(
          (value) => value == null || tripValues.includes(value),
        )
      )
        facts.money = { ...facts.money, role: "BUDGET", scope: "OBJECT" };
      if (
        facts.duration?.scope === "CURRENT" &&
        facts.duration.role === "AVAILABLE" &&
        (!currentDuration ||
          (facts.duration.minSeconds != null &&
            facts.duration.minSeconds !== currentDuration.minSeconds) ||
          (facts.duration.maxSeconds != null &&
            facts.duration.maxSeconds !== currentDuration.maxSeconds))
      ) {
        facts.duration = { ...facts.duration, scope: "OBJECT" };
        warnings.push("CURRENT_DURATION_NOT_GROUNDED");
      }
      if (
        facts.money?.role === "BUDGET" &&
        facts.money.scope === "CURRENT" &&
        (!currentMoney ||
          (facts.money.minMinor != null && facts.money.minMinor !== currentMoney.minMinor) ||
          (facts.money.maxMinor != null && facts.money.maxMinor !== currentMoney.maxMinor))
      ) {
        facts.money = { ...facts.money, scope: "OBJECT" };
        warnings.push("CURRENT_BUDGET_NOT_GROUNDED");
      }
      if (
        facts.originContext &&
        !currentLocationSupported(
          context.sourceText,
          facts.originContext,
          stated("originContext") as StructuredLifeFacts["originContext"],
        )
      ) {
        facts.originContext = undefined;
        warnings.push("CURRENT_LOCATION_NOT_GROUNDED");
      }
    }
    const previous = (facet.data as NormalizedFacet["data"]).normalization?.rawTime ?? facts.time;
    const source = previous ? { ...previous } : undefined;
    if (source && context.sourceText !== undefined && facts.origin === "USER_STATED") {
      const quoted = evidenceTimeRange(facts.evidence);
      for (const key of Object.keys(source) as (keyof typeof source)[]) {
        const expression = source[key];
        if (!expression) continue;
        if (context.sourceText.includes(expression)) continue;
        if (quoted)
          source[key] = ["windowEnd", "eventEnd", "deadline"].includes(key)
            ? quoted.end
            : quoted.start;
        else if (!context.sourceText.includes(expression)) {
          source[key] = null;
          warnings.push(`${key}:TIME_NOT_GROUNDED`);
        }
      }
    }
    const take = (key: keyof typeof time, mode: "start" | "end" | "exact") => {
      if (source?.[key] == null) return;
      const normalized = normalizeLifeTime(source[key], context);
      time[key] = normalized[mode];
      warnings.push(...normalized.warnings.map((warning) => `${key}:${warning}`));
      if (mode === "exact" && !normalized.exact && normalized.start && normalized.end) {
        time.windowStart ??= normalized.start;
        time.windowEnd ??= normalized.end;
        warnings.push(`${key}:BROAD_TIME_WINDOW`);
      }
    };
    take("windowStart", "start");
    take("windowEnd", "end");
    take("deadline", "end");
    take("eventStart", "exact");
    take("eventEnd", "exact");
    if (facet.type === "EVENT" && source?.windowStart && source.windowEnd) {
      const start = normalizeLifeTime(source.windowStart, context).exact;
      const end = normalizeLifeTime(source.windowEnd, context).exact;
      if (start && end) {
        time.eventStart ??= start;
        time.eventEnd ??= end;
      }
    }
    if (
      time.windowStart &&
      time.windowEnd &&
      new Date(time.windowStart) > new Date(time.windowEnd)
    ) {
      time.windowStart = null;
      time.windowEnd = null;
      warnings.push("TIME_WINDOW_REVERSED");
    }
    if (time.eventStart && time.eventEnd && new Date(time.eventStart) > new Date(time.eventEnd)) {
      time.eventStart = null;
      time.eventEnd = null;
      warnings.push("EVENT_WINDOW_REVERSED");
    }
    return {
      ...facet,
      data: {
        ...facet.data,
        facts: { ...facts, ...(source ? { time } : {}) },
        normalization: {
          referenceTime: context.referenceTime,
          timezone: context.timezone,
          rawTime: source,
          warnings,
        },
      },
    };
  });
  for (const fallback of deterministic) {
    const fact = fallback.data.facts!;
    const equivalent = normalized.some((existing) => {
      const current = existing.data.facts;
      if (current?.origin !== "USER_STATED") return false;
      if (fact.duration)
        return (
          current.duration?.role === "AVAILABLE" &&
          current.duration.scope === "CURRENT" &&
          (current.duration.maxSeconds ?? current.duration.minSeconds) === fact.duration.maxSeconds
        );
      if (fact.money)
        return (
          current.money?.role === "BUDGET" &&
          current.money.scope === "CURRENT" &&
          (current.money.maxMinor ?? current.money.minMinor) === fact.money.maxMinor
        );
      return (
        current.originContext?.province === fact.originContext?.province ||
        current.originContext?.region === fact.originContext?.region
      );
    });
    if (
      !equivalent &&
      !normalized.some(
        (existing) => existing.type === fallback.type && existing.key === fallback.key,
      )
    )
      normalized.push(fallback);
  }
  return normalized;
}

/** USER_STATED wins even when inferred facts have a higher model confidence. */
export function buildLifeProjection(
  object: Pick<ParsedLifeObject, "facets" | "kind" | "title" | "summary" | "importance">,
  context: CaptureReference,
) {
  const facets = normalizeLifeFacets(object.facets, context);
  const ranked = [...facets]
    .filter((facet) => facet.data.facts)
    .sort(
      (a, b) =>
        (b.data.facts!.origin === "USER_STATED" ? 1 : 0) -
          (a.data.facts!.origin === "USER_STATED" ? 1 : 0) || b.confidence - a.confidence,
    );
  const actionFacts: StructuredLifeFacts | null = ranked.length
    ? { origin: ranked[0]!.data.facts!.origin, evidence: ranked[0]!.data.facts!.evidence }
    : null;
  if (actionFacts) {
    const keys = [
      "duration",
      "money",
      "time",
      "place",
      "activityKind",
      "horizon",
      "originContext",
    ] as const;
    const sameOrigin = ranked.filter((facet) => facet.data.facts!.origin === actionFacts.origin);
    for (const key of keys) {
      const value = sameOrigin.find((facet) => facet.data.facts?.[key] !== undefined)?.data.facts?.[
        key
      ];
      if (value !== undefined) Object.assign(actionFacts, { [key]: value });
    }
  }
  const explicit = (key: keyof StructuredLifeFacts) =>
    ranked.find((f) => f.data.facts?.origin === "USER_STATED" && f.data.facts[key] !== undefined)
      ?.data.facts;
  const duration = ranked.find(
      (facet) =>
        facet.data.facts?.origin === "USER_STATED" &&
        facet.data.facts.duration &&
        facet.data.facts.duration.role !== "AVAILABLE",
    )?.data.facts?.duration,
    money = ranked.find(
      (facet) =>
        facet.data.facts?.origin === "USER_STATED" &&
        facet.data.facts.money &&
        facet.data.facts.money.role !== "BUDGET",
    )?.data.facts?.money;
  const time = explicit("time")?.time,
    placeFact = explicit("place"),
    place = placeFact?.place;
  const evidenceNumbers = placeFact?.evidence.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const coordinates =
    place?.latitude != null &&
    place.longitude != null &&
    place.coordinateSystem != null &&
    evidenceNumbers.includes(place.latitude) &&
    evidenceNumbers.includes(place.longitude) &&
    placeFact!.evidence.replace(/-/g, "").toUpperCase().includes(place.coordinateSystem);
  const toDate = (value: string | null | undefined) => (value ? new Date(value) : null);
  return {
    facets,
    actionFacts,
    projectionVersion: "projection-v0.4",
    nextAt: toDate(time?.eventStart ?? time?.windowStart),
    expiresAt: toDate(time?.deadline ?? time?.eventEnd ?? time?.windowEnd),
    costMinMinor: money?.role !== "BUDGET" ? (money?.minMinor ?? null) : null,
    costMaxMinor: money?.role !== "BUDGET" ? (money?.maxMinor ?? null) : null,
    currency: money?.role !== "BUDGET" ? (money?.currency ?? null) : null,
    durationMinSeconds: duration?.role !== "AVAILABLE" ? (duration?.minSeconds ?? null) : null,
    durationMaxSeconds: duration?.role !== "AVAILABLE" ? (duration?.maxSeconds ?? null) : null,
    latitude: coordinates ? place!.latitude! : null,
    longitude: coordinates ? place!.longitude! : null,
    coordinateSystem: coordinates ? place!.coordinateSystem! : null,
    searchText: [
      object.title,
      object.summary,
      actionFacts?.place?.name,
      actionFacts?.place?.region,
      actionFacts?.place?.city,
      actionFacts?.place?.province,
    ]
      .filter(Boolean)
      .join(" "),
  };
}
