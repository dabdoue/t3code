import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  cursorAuthFileCandidates,
  cursorSessionCookieFromAccessToken,
  cursorUsageSummaryToLimits,
  probeCursorUsageLimits,
  resetCursorUsageLimitsCacheForTests,
} from "./cursorUsageLimits.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const checkedAt = "2026-09-05T18:00:00.000Z";
const billingCycleStart = "2026-08-21T00:00:00.000Z";
const billingCycleEnd = "2026-09-21T00:00:00.000Z";
const monthMins = 31 * 24 * 60;

function accessTokenWithSub(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.sig`;
}

const usageSummary = {
  billingCycleStart,
  billingCycleEnd,
  individualUsage: {
    plan: { autoPercentUsed: 12.4, apiPercentUsed: 81 },
    onDemand: { enabled: false, limit: 100, used: 10 },
  },
};

afterEach(() => {
  resetCursorUsageLimitsCacheForTests();
});

describe("cursorUsageSummaryToLimits", () => {
  it("maps the two included monthly pools onto Limits windows", () => {
    expect(cursorUsageSummaryToLimits({ summary: usageSummary, checkedAt })).toEqual({
      checkedAt,
      windows: [
        {
          id: "monthly_api",
          kind: "monthly",
          label: "Other Models",
          usedPercent: 81,
          windowDurationMins: monthMins,
          resetsAt: billingCycleEnd,
        },
        {
          id: "monthly_auto",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 12.4,
          windowDurationMins: monthMins,
          resetsAt: billingCycleEnd,
        },
      ],
    });
  });

  it("falls back to the selected-display percent when the plan object is missing", () => {
    expect(
      cursorUsageSummaryToLimits({
        checkedAt,
        summary: {
          billingCycleStart,
          billingCycleEnd,
          autoModelSelectedDisplayMessage: "You've used 7% of your included Auto usage",
          namedModelSelectedDisplayMessage: "You've used 100% of your included API usage",
        },
      }).windows,
    ).toEqual([
      {
        id: "monthly_api",
        kind: "monthly",
        label: "Other Models",
        usedPercent: 100,
        windowDurationMins: monthMins,
        resetsAt: billingCycleEnd,
      },
      {
        id: "monthly_auto",
        kind: "monthly",
        label: "Cursor Models",
        usedPercent: 7,
        windowDurationMins: monthMins,
        resetsAt: billingCycleEnd,
      },
    ]);
  });

  it("adds on-demand only when it is enabled with a numeric limit", () => {
    expect(
      cursorUsageSummaryToLimits({
        checkedAt,
        summary: {
          ...usageSummary,
          individualUsage: {
            plan: { autoPercentUsed: 0, apiPercentUsed: 0 },
            onDemand: { enabled: true, limit: 40, used: 10 },
          },
        },
      }).windows.map((window) => ({ id: window.id, usedPercent: window.usedPercent })),
    ).toEqual([
      { id: "monthly_api", usedPercent: 0 },
      { id: "monthly_auto", usedPercent: 0 },
      { id: "monthly_on_demand", usedPercent: 25 },
    ]);
    expect(
      cursorUsageSummaryToLimits({
        checkedAt,
        summary: usageSummary,
      }).windows.some((window) => window.id === "monthly_on_demand"),
    ).toBe(false);
  });

  it("treats a response with no recognised pools as unsupported", () => {
    expect(cursorUsageSummaryToLimits({ summary: { isUnlimited: true }, checkedAt })).toEqual({
      checkedAt,
      windows: [],
      unavailable: {
        reason: "unsupported",
        message: "This Cursor plan does not report included usage.",
      },
    });
    expect(
      cursorUsageSummaryToLimits({ summary: { extraField: 1 }, checkedAt }).unavailable,
    ).toEqual({
      reason: "unsupported",
      message: "Cursor did not report included usage for this account.",
    });
    expect(cursorUsageSummaryToLimits({ summary: null, checkedAt }).unavailable?.reason).toBe(
      "probeFailed",
    );
  });
});

describe("cursorSessionCookieFromAccessToken", () => {
  it("takes the user id from the last pipe in sub", () => {
    const token = accessTokenWithSub("auth0|user_01ABC");
    expect(cursorSessionCookieFromAccessToken(token)).toBe(`user_01ABC%3A%3A${token}`);
    expect(cursorSessionCookieFromAccessToken(accessTokenWithSub("user_01ABC"))).toBe(
      `user_01ABC%3A%3A${accessTokenWithSub("user_01ABC")}`,
    );
    expect(cursorSessionCookieFromAccessToken("not-a-jwt")).toBeUndefined();
  });
});

describe("cursorAuthFileCandidates", () => {
  it("prefers XDG, then ~/.config/cursor, then ~/.cursor", () => {
    expect(cursorAuthFileCandidates((...parts) => parts.join("/"), "/home/me", "/xdg")).toEqual([
      "/xdg/cursor/auth.json",
      "/home/me/.config/cursor/auth.json",
      "/home/me/.cursor/auth.json",
    ]);
  });
});

describe("probeCursorUsageLimits", () => {
  const runProbe = (
    effect: Effect.Effect<
      ReturnType<typeof cursorUsageSummaryToLimits>,
      never,
      FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
    >,
    httpClient: HttpClient.HttpClient,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, Layer.succeed(HttpClient.HttpClient, httpClient)),
        ),
      ),
    );

  it("reads CLI auth and maps the dashboard usage-summary", async () => {
    const token = accessTokenWithSub("auth0|user_01ABC");
    const { home, configHome } = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-usage-home-",
        });
        const configHome = path.join(home, ".config");
        yield* fileSystem.makeDirectory(path.join(configHome, "cursor"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configHome, "cursor", "auth.json"),
          encodeUnknownJson({ accessToken: token }),
        );
        return { home, configHome };
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    const cookies: string[] = [];
    const httpClient = HttpClient.make((request) => {
      cookies.push(request.headers.cookie ?? "");
      expect(request.url).toBe("https://cursor.com/api/usage-summary");
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(usageSummary)));
    });

    const first = await runProbe(
      probeCursorUsageLimits({ checkedAt, home, configHome }),
      httpClient,
    );
    const cached = await runProbe(
      probeCursorUsageLimits({ checkedAt: "2026-09-05T18:01:00.000Z", home, configHome }),
      HttpClient.make(() => Effect.die("usage-summary should be cached")),
    );

    expect(first).toEqual(cursorUsageSummaryToLimits({ summary: usageSummary, checkedAt }));
    expect(cached).toEqual(first);
    expect(cookies).toEqual([`WorkosCursorSessionToken=user_01ABC%3A%3A${token}`]);
  });

  it("does not fail the probe when Cursor is logged out or the dashboard refuses", async () => {
    const missing = await runProbe(
      probeCursorUsageLimits({
        checkedAt,
        home: "/no-such-cursor-home",
        configHome: "/no-such-cursor-config",
      }),
      HttpClient.make(() => Effect.die("should not fetch without credentials")),
    );
    expect(missing).toMatchObject({
      unavailable: {
        reason: "probeFailed",
        message: "Could not find Cursor login credentials. Run `agent login` and try again.",
      },
    });

    const token = accessTokenWithSub("auth0|user_01ABC");
    const { home, configHome } = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-usage-401-",
        });
        const configHome = path.join(home, ".config");
        yield* fileSystem.makeDirectory(path.join(configHome, "cursor"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configHome, "cursor", "auth.json"),
          encodeUnknownJson({ accessToken: token }),
        );
        return { home, configHome };
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    const refused = await runProbe(
      probeCursorUsageLimits({ checkedAt, home, configHome }),
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("nope", { status: 401 }))),
      ),
    );
    expect(refused).toMatchObject({
      unavailable: {
        reason: "probeFailed",
        message: "Cursor refused the usage request. Run `agent login` and try again.",
      },
    });
  });
});
