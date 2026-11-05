import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveUsageLimitsAfterProbe } from "@t3tools/provider-core/server/usageLimits";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";
import { withZaiCodingPlanUsageLimits } from "./zaiUsageLimits.ts";

const checkedAt = "2026-11-05T10:00:00.000Z";
const resetTime = 1793912339177;
const glmEnvironment = {
  ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_AUTH_TOKEN: "glm-test-key",
};
const claudeSnapshot: ServerProviderDraft = {
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: {
    status: "authenticated",
    email: "local-claude@example.com",
    workspaceId: "anthropic-workspace",
    type: "max",
    label: "Claude Max Subscription",
  },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt,
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 80 }],
    resetCredits: { availableCount: 2 },
  },
};

const quotaClient = (limits: ReadonlyArray<unknown>) =>
  HttpClient.make((request) => {
    assert.equal(request.url, "https://api.z.ai/api/monitor/usage/quota/limit");
    assert.equal(request.headers.authorization, "glm-test-key");
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json({ success: true, data: { limits } })),
    );
  });

describe("GLM Coding Plan usage for Claude instances", () => {
  it.effect("maps the live token-quota shape without inventing a weekly window", () =>
    Effect.gen(function* () {
      const provider = yield* withZaiCodingPlanUsageLimits(claudeSnapshot, glmEnvironment).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          quotaClient([
            { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 53 },
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 40,
              nextResetTime: resetTime,
            },
          ]),
        ),
      );
      assert.deepStrictEqual(provider.usageLimits?.windows, [
        {
          id: "zai_five_hour",
          kind: "session",
          label: "GLM · 5 hours",
          windowDurationMins: 300,
          usedPercent: 40,
          resetsAt: "2026-11-05T20:58:59.177Z",
        },
      ]);
      assert.deepStrictEqual(provider.auth, {
        status: "authenticated",
        type: "apiKey",
        label: "GLM Coding Plan",
      });
      assert.isUndefined(provider.usageLimits?.resetCredits);
      assert.match(provider.usageLimits!.credentialFingerprint!, /^[0-9a-f]{64}$/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads credit-based five-hour and weekly limits and preserves missing reset times",
    () =>
      Effect.gen(function* () {
        const provider = yield* withZaiCodingPlanUsageLimits(claudeSnapshot, glmEnvironment).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            quotaClient([
              { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 125, nextResetTime: null },
              { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 0 },
            ]),
          ),
        );
        assert.deepStrictEqual(provider.usageLimits?.windows, [
          {
            id: "zai_five_hour",
            kind: "session",
            label: "GLM · 5 hours",
            windowDurationMins: 300,
            usedPercent: 0,
          },
          {
            id: "zai_seven_day",
            kind: "weekly",
            label: "GLM · Weekly",
            windowDurationMins: 10080,
            usedPercent: 100,
          },
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps GLM separate from Anthropic and counts a shared GLM credential once", () =>
    Effect.gen(function* () {
      const glm = yield* withZaiCodingPlanUsageLimits(claudeSnapshot, glmEnvironment).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          quotaClient([{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40 }]),
        ),
      );
      const stamp = (instanceId: string) =>
        withInstanceIdentity({
          instanceId: ProviderInstanceId.make(instanceId),
          driverKind: ProviderDriverKind.make("claudeAgent"),
          displayName: instanceId,
          accentColor: undefined,
          continuationGroupKey: "claude:home:test",
        });
      const accounts = collectLimitAccounts(
        new Map([
          [
            EnvironmentId.make("local"),
            {
              entry: { target: { label: "Local" } },
              serverConfig: {
                providers: [stamp("claude")(claudeSnapshot), stamp("GLM")(glm), stamp("GLM2")(glm)],
              },
            },
          ],
        ]),
      );
      assert.equal(accounts.length, 2);
      const pools = collectLimitPools(accounts, 0);
      assert.equal(pools.length, 1);
      assert.deepStrictEqual(
        pools[0]!.windows.map((window) => [window.id, window.remainingPercent]),
        [
          ["five_hour", 20],
          ["zai_five_hour", 60],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves ordinary, proxied, disabled, and missing Claude installs unchanged", () =>
    Effect.gen(function* () {
      for (const [snapshot, environment] of [
        [claudeSnapshot, {}],
        [
          claudeSnapshot,
          { ...glmEnvironment, ANTHROPIC_BASE_URL: "https://proxy.example/api/anthropic" },
        ],
        [
          claudeSnapshot,
          { ...glmEnvironment, ANTHROPIC_BASE_URL: "https://api.z.ai.example/api/anthropic" },
        ],
        [{ ...claudeSnapshot, enabled: false }, glmEnvironment],
        [{ ...claudeSnapshot, installed: false }, glmEnvironment],
      ] as const) {
        const provider = yield* withZaiCodingPlanUsageLimits(snapshot, environment);
        assert.strictEqual(provider, snapshot);
      }
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected quota read")),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("reports failed or malformed quota reads and retains the last GLM reading", () =>
    Effect.gen(function* () {
      for (const response of [
        Response.json({}, { status: 401 }),
        Response.json({ success: false, data: { limits: [] } }),
        Response.json({ success: true, data: { limits: [] } }),
        Response.json({
          success: true,
          data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: "bad" }] },
        }),
      ]) {
        const provider = yield* withZaiCodingPlanUsageLimits(claudeSnapshot, glmEnvironment).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, response)),
            ),
          ),
        );
        assert.equal(provider.usageLimits?.unavailable?.reason, "probeFailed");
        assert.deepStrictEqual(provider.usageLimits?.windows, []);
        assert.isUndefined(provider.auth.email);
        const previous = {
          checkedAt,
          windows: [
            { id: "zai_five_hour", kind: "session" as const, label: "GLM", usedPercent: 40 },
          ],
        };
        assert.strictEqual(
          resolveUsageLimitsAfterProbe({ published: previous, probed: provider.usageLimits }),
          previous,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing key without making a quota request", () =>
    Effect.gen(function* () {
      const provider = yield* withZaiCodingPlanUsageLimits(claudeSnapshot, {
        ANTHROPIC_BASE_URL: glmEnvironment.ANTHROPIC_BASE_URL,
      });
      assert.equal(provider.usageLimits?.unavailable?.reason, "probeFailed");
      assert.isUndefined(provider.auth.email);
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected quota read")),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
});
