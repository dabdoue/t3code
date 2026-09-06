/**
 * Cursor subscription usage. The dashboard's `GET /api/usage-summary` reports
 * the same two included pools the Spending page draws: Cursor Models (Auto,
 * Composer, Cursor Grok) and Other Models (named / API). Both land on the
 * shared `ServerProviderUsageLimits` windows so the Limits view treats Cursor
 * like Codex and Claude.
 *
 * Auth is the cursor-agent CLI login (`~/.config/cursor/auth.json`), which is
 * the account T3 actually runs turns on. Multiple Cursor instances share that
 * file today; they therefore share one quota snapshot, keyed by email on the
 * Limits view the same way two Codex homes with the same login would.
 *
 * @module provider/Layers/cursorUsageLimits
 */
import * as NodeOS from "node:os";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const FETCH_TIMEOUT = "5 seconds";
const SUCCESS_TTL_MS = 180_000;
const FAILURE_TTL_MS = 10 * 60_000;
const DEFAULT_MONTH_MINS = 30 * 24 * 60;

const AUTO_WINDOW = {
  id: "monthly_auto",
  kind: "monthly",
  label: "Cursor Models",
} as const satisfies Pick<ServerProviderUsageWindow, "id" | "kind" | "label">;

const API_WINDOW = {
  id: "monthly_api",
  kind: "monthly",
  label: "Other Models",
} as const satisfies Pick<ServerProviderUsageWindow, "id" | "kind" | "label">;

const ON_DEMAND_WINDOW = {
  id: "monthly_on_demand",
  kind: "other",
  label: "On-demand",
} as const satisfies Pick<ServerProviderUsageWindow, "id" | "kind" | "label">;

interface CursorUsageCacheEntry {
  readonly key: string;
  readonly expiresAt: number;
  readonly limits: ServerProviderUsageLimits;
}

let usageCache: CursorUsageCacheEntry | undefined;

export function resetCursorUsageLimitsCacheForTests(): void {
  usageCache = undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isoFromString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function windowDurationMins(start: string | undefined, end: string | undefined): number {
  if (!start || !end) return DEFAULT_MONTH_MINS;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_MONTH_MINS;
  return Math.max(1, Math.round(ms / 60_000));
}

function percentFromDisplayMessage(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const match = message.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return undefined;
  return clampPercent(Number(match[1]));
}

function makeMonthlyWindow(
  spec: Pick<ServerProviderUsageWindow, "id" | "kind" | "label">,
  usedPercent: number,
  resetsAt: string | undefined,
  durationMins: number,
): ServerProviderUsageWindow {
  return {
    ...spec,
    usedPercent: clampPercent(usedPercent),
    windowDurationMins: durationMins,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * Maps the dashboard usage-summary JSON onto Limits windows. Unknown extra
 * fields are ignored so a dashboard change that adds pools does not fail the
 * probe; a response with no recognised pools is `unsupported`.
 */
export function cursorUsageSummaryToLimits(input: {
  readonly summary: unknown;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const { summary, checkedAt } = input;
  if (typeof summary !== "object" || summary === null) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Cursor answered with an unexpected usage shape.",
    });
  }
  const record = summary as Record<string, unknown>;
  const billingCycleStart = readString(record.billingCycleStart);
  const billingCycleEnd = isoFromString(readString(record.billingCycleEnd));
  const durationMins = windowDurationMins(billingCycleStart, readString(record.billingCycleEnd));
  const individualUsage =
    typeof record.individualUsage === "object" && record.individualUsage !== null
      ? (record.individualUsage as Record<string, unknown>)
      : undefined;
  const plan =
    typeof individualUsage?.plan === "object" && individualUsage.plan !== null
      ? (individualUsage.plan as Record<string, unknown>)
      : undefined;

  const windows: ServerProviderUsageWindow[] = [];
  const autoPercent =
    readNumber(plan?.autoPercentUsed) ??
    percentFromDisplayMessage(readString(record.autoModelSelectedDisplayMessage));
  const apiPercent =
    readNumber(plan?.apiPercentUsed) ??
    percentFromDisplayMessage(readString(record.namedModelSelectedDisplayMessage));
  if (autoPercent !== undefined) {
    windows.push(makeMonthlyWindow(AUTO_WINDOW, autoPercent, billingCycleEnd, durationMins));
  }
  if (apiPercent !== undefined) {
    windows.push(makeMonthlyWindow(API_WINDOW, apiPercent, billingCycleEnd, durationMins));
  }

  const onDemand =
    typeof individualUsage?.onDemand === "object" && individualUsage.onDemand !== null
      ? (individualUsage.onDemand as Record<string, unknown>)
      : typeof (record.teamUsage as Record<string, unknown> | undefined)?.onDemand === "object"
        ? ((record.teamUsage as Record<string, unknown>).onDemand as Record<string, unknown>)
        : undefined;
  const onDemandLimit = readNumber(onDemand?.limit);
  const onDemandUsed = readNumber(onDemand?.used);
  if (onDemand?.enabled === true && onDemandLimit !== undefined && onDemandLimit > 0) {
    windows.push(
      makeMonthlyWindow(
        ON_DEMAND_WINDOW,
        onDemandUsed === undefined ? 0 : (onDemandUsed / onDemandLimit) * 100,
        billingCycleEnd,
        durationMins,
      ),
    );
  }

  if (windows.length === 0) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message:
        record.isUnlimited === true
          ? "This Cursor plan does not report included usage."
          : "Cursor did not report included usage for this account.",
    });
  }
  return makeUsageLimits({ checkedAt, windows });
}

export function cursorSessionCookieFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2 || parts[1] === undefined) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      readonly sub?: unknown;
    };
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return undefined;
    const separator = payload.sub.lastIndexOf("|");
    const userId = separator >= 0 ? payload.sub.slice(separator + 1) : payload.sub;
    if (userId.length === 0) return undefined;
    return `${userId}%3A%3A${accessToken}`;
  } catch {
    return undefined;
  }
}

function readAccessToken(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      readonly accessToken?: unknown;
      readonly access_token?: unknown;
    };
    return readString(parsed.accessToken) ?? readString(parsed.access_token);
  } catch {
    return undefined;
  }
}

export const cursorAuthFileCandidates = (
  join: (...parts: string[]) => string,
  home: string,
  configHome: string | undefined,
): string[] => {
  const candidates = [
    ...(configHome ? [join(configHome, "cursor", "auth.json")] : []),
    join(home, ".config", "cursor", "auth.json"),
    join(home, ".cursor", "auth.json"),
  ];
  return [...new Set(candidates)];
};

function cursorUsageFailureMessage(status: number | undefined): string {
  if (status === 401 || status === 403) {
    return "Cursor refused the usage request. Run `agent login` and try again.";
  }
  if (typeof status === "number") {
    return `Cursor could not read usage (HTTP ${status}).`;
  }
  return "Cursor did not answer the usage request.";
}

/**
 * Reads the CLI login and asks the dashboard for the current billing-cycle
 * pools. A success is reused for three minutes; a failure backs off for ten
 * so a 401 cannot ride every provider health tick.
 */
export const probeCursorUsageLimits = Effect.fn("probeCursorUsageLimits")(function* (input: {
  readonly checkedAt: string;
  readonly home?: string;
  readonly configHome?: string;
}) {
  const now = yield* Clock.currentTimeMillis;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = input.home ?? NodeOS.homedir();
  const configHome = input.configHome ?? process.env.XDG_CONFIG_HOME;
  const candidates = cursorAuthFileCandidates(path.join, home, configHome);

  let accessToken: string | undefined;
  let cacheKey = "missing";
  for (const candidate of candidates) {
    const raw = yield* fileSystem.readFileString(candidate).pipe(Effect.orElseSucceed(() => ""));
    const token = readAccessToken(raw);
    if (!token) continue;
    const stat = yield* fileSystem.stat(candidate).pipe(Effect.option);
    const mtimeMs = Option.match(stat, {
      onNone: () => 0,
      onSome: (info) =>
        Option.match(info.mtime, {
          onNone: () => 0,
          onSome: (mtime) => mtime.getTime(),
        }),
    });
    accessToken = token;
    cacheKey = `${candidate}:${mtimeMs}`;
    break;
  }

  const cached = usageCache;
  if (cached && cached.key === cacheKey && cached.expiresAt > now) {
    return cached.limits;
  }

  if (!accessToken) {
    const limits = makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "probeFailed",
      message: "Could not find Cursor login credentials. Run `agent login` and try again.",
    });
    usageCache = { key: cacheKey, expiresAt: now + FAILURE_TTL_MS, limits };
    return limits;
  }

  const cookie = cursorSessionCookieFromAccessToken(accessToken);
  if (!cookie) {
    const limits = makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "probeFailed",
      message: "Cursor login credentials could not be read.",
    });
    usageCache = { key: cacheKey, expiresAt: now + FAILURE_TTL_MS, limits };
    return limits;
  }

  const httpClient = yield* HttpClient.HttpClient;
  const fetched = yield* httpClient
    .get(USAGE_SUMMARY_URL, {
      headers: {
        Accept: "application/json",
        Cookie: `WorkosCursorSessionToken=${cookie}`,
        Origin: "https://cursor.com",
      },
    })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map((summary) => cursorUsageSummaryToLimits({ summary, checkedAt: input.checkedAt })),
      Effect.timeout(FETCH_TIMEOUT),
      Effect.result,
    );

  if (fetched._tag === "Failure") {
    const status =
      fetched.failure._tag === "HttpClientError" &&
      fetched.failure.reason._tag === "StatusCodeError"
        ? fetched.failure.reason.response.status
        : undefined;
    yield* Effect.logDebug("Cursor usage-summary read failed", {
      ...(typeof status === "number" ? { status } : {}),
      errorTag: fetched.failure._tag,
    });
    const limits = makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "probeFailed",
      message: cursorUsageFailureMessage(status),
    });
    usageCache = { key: cacheKey, expiresAt: now + FAILURE_TTL_MS, limits };
    return limits;
  }

  usageCache = {
    key: cacheKey,
    expiresAt: now + SUCCESS_TTL_MS,
    limits: fetched.success,
  };
  return fetched.success;
});
