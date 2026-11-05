import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const QuotaResponse = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({
    limits: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        unit: Schema.optionalKey(Schema.Number),
        number: Schema.optionalKey(Schema.Number),
        percentage: Schema.optionalKey(Schema.Finite),
        nextResetTime: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
      }),
    ),
  }),
});

export function isZaiClaudeEnvironment(environment: NodeJS.ProcessEnv): boolean {
  try {
    const url = new URL(environment.ANTHROPIC_BASE_URL ?? "");
    return (
      url.origin === "https://api.z.ai" && url.pathname.replace(/\/+$/, "") === "/api/anthropic"
    );
  } catch {
    return false;
  }
}

/** The GLM Claude instance spends a Z.AI subscription, independently of its local Claude login. */
export const withZaiCodingPlanUsageLimits = Effect.fn("withZaiCodingPlanUsageLimits")(function* (
  snapshot: ServerProviderDraft,
  environment: NodeJS.ProcessEnv,
) {
  if (!snapshot.enabled || !snapshot.installed || !isZaiClaudeEnvironment(environment)) {
    return snapshot;
  }
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unavailable = () =>
    makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Z.AI could not read GLM Coding Plan usage.",
    });
  const apiKey = environment.ANTHROPIC_AUTH_TOKEN?.trim() || environment.ANTHROPIC_API_KEY?.trim();
  const usageLimits = apiKey
    ? yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.get("https://api.z.ai/api/monitor/usage/quota/limit").pipe(
            HttpClientRequest.setHeader("Authorization", apiKey),
          ),
        );
        const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(QuotaResponse)),
        );
        const windows: ServerProviderUsageWindow[] = [];
        for (const limit of body.data.limits) {
          // TIME_LIMIT is the separate MCP tool allowance, not model quota.
          if (
            (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT") ||
            limit.percentage === undefined
          ) {
            continue;
          }
          const weekly = limit.unit === 6 && limit.number === 1;
          if (!weekly && !(limit.unit === 3 && limit.number === 5)) continue;
          const reset = limit.nextResetTime ? DateTime.make(limit.nextResetTime) : Option.none();
          windows.push({
            // Distinct ids keep GLM out of the Anthropic subscription pool.
            id: weekly ? "zai_seven_day" : "zai_five_hour",
            kind: weekly ? "weekly" : "session",
            label: weekly ? "GLM · Weekly" : "GLM · 5 hours",
            windowDurationMins: weekly ? 7 * 24 * 60 : 5 * 60,
            usedPercent: clampPercent(limit.percentage),
            ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
          });
        }
        if (windows.length === 0) return unavailable();
        const crypto = yield* Crypto.Crypto;
        const credentialFingerprint = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(`zai-coding-plan\0${apiKey}`))
          .pipe(Effect.map(Hex.encode), Effect.orDie);
        return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint };
      }).pipe(Effect.timeout("5 seconds"), Effect.orElseSucceed(unavailable))
    : unavailable();

  return {
    ...snapshot,
    // The SDK can report the local Anthropic email/workspace even with a
    // custom base URL. Only the Z.AI credential identifies this quota.
    auth: { status: snapshot.auth.status, type: "apiKey", label: "GLM Coding Plan" },
    usageLimits,
  };
});
