import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export class ClaudeQuotaRateLimited extends Schema.TaggedError<ClaudeQuotaRateLimited>()(
  "ClaudeQuotaRateLimited",
  { retryAt: Schema.Number },
) {}

export const isClaudeQuotaRateLimited = Schema.is(ClaudeQuotaRateLimited);

export const claudeQuotaRetryAt = (retryAfter: string | undefined, now: number): number => {
  const seconds = retryAfter === undefined ? NaN : Number(retryAfter);
  const parsed = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter ?? "");
  return Number.isFinite(parsed) && parsed > now ? parsed : now + 30 * 60_000;
};

/** Refresh buttons must share quota cooldowns with background status probes. */
export const makeClaudeQuotaCache = Effect.fn("makeClaudeQuotaCache")(function* <A>() {
  const lock = yield* Semaphore.make(1);
  const entries = new Map<string, { retryAt: number; value: A | undefined }>();
  const read = Effect.fn("ClaudeQuotaCache.read")(function* <E, R>(
    key: string,
    lookup: Effect.Effect<A, E, R>,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const previous = entries.get(key);
    if (previous && now < previous.retryAt) return previous.value;
    const result = yield* Effect.result(lookup);
    const finishedAt = DateTime.toEpochMillis(yield* DateTime.now);
    const value = result._tag === "Success" ? result.success : previous?.value;
    const retryAt =
      result._tag === "Success"
        ? finishedAt + 5 * 60_000
        : isClaudeQuotaRateLimited(result.failure)
          ? result.failure.retryAt
          : finishedAt;
    entries.set(key, { retryAt, value });
    return value;
  }, lock.withPermits(1));
  return { read, invalidate: Effect.sync(() => entries.clear()).pipe(lock.withPermits(1)) };
});
