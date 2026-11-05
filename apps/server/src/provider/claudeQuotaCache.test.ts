import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  ClaudeQuotaRateLimited,
  claudeQuotaRetryAt,
  makeClaudeQuotaCache,
} from "./claudeQuotaCache.ts";

describe("Claude quota cache", () => {
  it.effect("coalesces refreshes, backs off failures and isolates accounts", () =>
    Effect.gen(function* () {
      const cache = yield* makeClaudeQuotaCache<number>();
      let requests = 0;
      const success = Effect.sync(() => ++requests);
      const failed = Effect.sync(() => {
        requests++;
      }).pipe(Effect.andThen(Effect.fail(new ClaudeQuotaRateLimited({ retryAt: 35 * 60_000 }))));
      expect(
        yield* Effect.all([cache.read("one", success), cache.read("one", success)], {
          concurrency: "unbounded",
        }),
      ).toEqual([1, 1]);
      yield* TestClock.adjust("5 minutes");
      expect(yield* cache.read("one", failed)).toBe(1);
      yield* TestClock.adjust("29 minutes");
      expect(yield* cache.read("one", success)).toBe(1);
      expect(requests).toBe(2);
      expect(yield* cache.read("two", success)).toBe(3);
      yield* TestClock.adjust("1 minute");
      expect(yield* cache.read("one", success)).toBe(4);
      yield* cache.invalidate;
      expect(yield* cache.read("one", success)).toBe(5);
    }),
  );

  it("accepts Retry-After seconds and HTTP dates with a conservative fallback", () => {
    const now = Date.parse("2026-11-05T20:00:00Z");
    expect(claudeQuotaRetryAt("3600", now)).toBe(now + 3_600_000);
    expect(claudeQuotaRetryAt("Thu, 05 Nov 2026 21:00:00 GMT", now)).toBe(now + 3_600_000);
    expect(claudeQuotaRetryAt(undefined, now)).toBe(now + 1_800_000);
    expect(claudeQuotaRetryAt("invalid", now)).toBe(now + 1_800_000);
  });
});
