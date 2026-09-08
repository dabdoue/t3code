/**
 * Selection and pace maths for the provider limits view, shared by web and
 * mobile so both agree on which providers show, what "ahead of pace" means,
 * and how a reset is phrased.
 *
 * @module usageLimits
 */
import {
  type EnvironmentId,
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Providers that belong on the Limits view: enabled, installed, and either
 * already reporting subscription usage or the same driver as one that does.
 * A remote Codex/Cursor/Claude with no `usageLimits` yet still joins the
 * union once any connected environment has probed that driver.
 */
export function providersWithLimits(
  providers: readonly ServerProvider[],
  capableDrivers?: ReadonlySet<ServerProvider["driver"]>,
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      (provider.usageLimits !== undefined || Boolean(capableDrivers?.has(provider.driver))),
  );
}

function capableLimitsDrivers(
  presentations: ReadonlyMap<EnvironmentId, LimitsPresentation>,
): ReadonlySet<ServerProvider["driver"]> {
  const drivers = new Set<ServerProvider["driver"]>();
  for (const presentation of presentations.values()) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (
        provider.enabled &&
        provider.installed &&
        isProviderAvailable(provider) &&
        provider.usageLimits !== undefined
      ) {
        drivers.add(provider.driver);
      }
    }
  }
  return drivers;
}

export interface LimitsAccountPresence {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

/**
 * One subscription on the Limits view. The same driver and signed-in email
 * across machines share a row; unidentified accounts stay per instance.
 */
export interface LimitsAccount {
  readonly key: string;
  /** Environment that owns the preferred snapshot, used to redeem reset credits. */
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly presence: readonly LimitsAccountPresence[];
  /** Machine names when more than one environment is connected. */
  readonly presenceLabel: string | null;
}

type LimitsPresentation = {
  readonly entry: { readonly target: { readonly label: string } };
  readonly serverConfig: { readonly providers?: readonly ServerProvider[] | undefined } | null;
};

/**
 * Union of provider snapshots across connected environments. Provider
 * snapshots come from the config stream every client already holds, so
 * opening the view costs no extra request.
 */
export function collectLimitsAccounts(
  presentations: ReadonlyMap<EnvironmentId, LimitsPresentation>,
): readonly LimitsAccount[] {
  type Draft = {
    readonly key: string;
    environmentId: EnvironmentId;
    provider: ServerProvider;
    readonly presence: LimitsAccountPresence[];
  };
  const byKey = new Map<string, Draft>();
  const order: string[] = [];
  const capableDrivers = capableLimitsDrivers(presentations);

  for (const [environmentId, presentation] of presentations) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(
      presentation.serverConfig?.providers ?? [],
      capableDrivers,
    )) {
      const key =
        accountKey(provider.driver, provider.auth.email) ??
        `${environmentId}:${provider.instanceId}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          key,
          environmentId,
          provider,
          presence: [{ environmentId, environmentLabel }],
        });
        order.push(key);
        continue;
      }
      const preferred = preferProvider(existing.provider, provider);
      if (preferred !== existing.provider) {
        existing.provider = preferred;
        existing.environmentId = environmentId;
      }
      if (!existing.presence.some((item) => item.environmentId === environmentId)) {
        existing.presence.push({ environmentId, environmentLabel });
      }
    }
  }

  const labelEnvironments = presentations.size > 1;

  return order.flatMap((key) => {
    const draft = byKey.get(key);
    if (draft === undefined) return [];
    return [
      {
        key: draft.key,
        environmentId: draft.environmentId,
        provider: draft.provider,
        presence: draft.presence,
        presenceLabel: formatPresenceLabel(draft.presence, labelEnvironments),
      },
    ];
  });
}

function usableLimits(limits: ServerProvider["usageLimits"]): boolean {
  return Boolean(limits && limits.windows.length > 0 && limits.unavailable === undefined);
}

function limitsCheckedAt(limits: ServerProvider["usageLimits"]): number {
  return Date.parse(limits?.checkedAt ?? "") || 0;
}

/** Prefer a usable snapshot, then one with more reset credits, then the freshest check. */
function preferProvider(left: ServerProvider, right: ServerProvider): ServerProvider {
  const leftUsable = usableLimits(left.usageLimits);
  const rightUsable = usableLimits(right.usageLimits);
  if (leftUsable !== rightUsable) return leftUsable ? left : right;
  const leftCredits = left.usageLimits?.resetCredits?.availableCount ?? -1;
  const rightCredits = right.usageLimits?.resetCredits?.availableCount ?? -1;
  if (leftCredits !== rightCredits) return leftCredits > rightCredits ? left : right;
  return limitsCheckedAt(right.usageLimits) > limitsCheckedAt(left.usageLimits) ? right : left;
}

function formatPresenceLabel(
  presence: readonly LimitsAccountPresence[],
  labelEnvironments: boolean,
): string | null {
  if (!labelEnvironments && presence.length < 2) return null;
  return presence.map((item) => item.environmentLabel).join(" · ");
}

/**
 * Every usage-limit source across connected environments, keyed so two
 * environments pointing at the same hub still get their own rows. The label
 * carries the environment only when more than one environment has sources.
 * A native provider with usable limits takes precedence over the same account
 * in a source, even when it belongs to another connected environment.
 */
export function collectLimitSources(
  presentations: ReadonlyMap<
    EnvironmentId,
    {
      readonly entry: { readonly target: { readonly label: string } };
      readonly serverConfig: {
        readonly providers?: readonly ServerProvider[] | undefined;
        readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
      } | null;
    }
  >,
): ReadonlyArray<
  UsageLimitSourceSnapshot & {
    readonly key: string;
    readonly environmentId: EnvironmentId;
    readonly hiddenAccountCount: number;
  }
> {
  const nativeAccounts = new Set<string>();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const key = accountKey(provider.driver, provider.auth.email);
      if (
        key !== null &&
        provider.usageLimits?.windows.length &&
        !provider.usageLimits.unavailable
      ) {
        nativeAccounts.add(key);
      }
    }
  }
  const perEnvironment: Array<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly sources: UsageLimitSourceSnapshots;
  }> = [];
  for (const [environmentId, presentation] of presentations) {
    const sources = presentation.serverConfig?.usageLimitSources ?? [];
    if (sources.length === 0) continue;
    perEnvironment.push({
      environmentId,
      environmentLabel: presentation.entry.target.label,
      sources,
    });
  }
  const labelEnvironment = perEnvironment.length > 1;
  return perEnvironment.flatMap(({ environmentId, environmentLabel, sources }) =>
    sources.map((source) => {
      const accounts = source.accounts.filter((account) => {
        const key = accountKey(account.driver, account.email);
        return key === null || !nativeAccounts.has(key);
      });
      return {
        ...source,
        accounts,
        hiddenAccountCount: source.accounts.length - accounts.length,
        environmentId,
        key: `${environmentId}:${source.id}`,
        label: labelEnvironment ? `${environmentLabel} · ${source.label}` : source.label,
      };
    }),
  );
}

/** True when there are bars to draw: a notice means the row has no quota data. */
export function hasLimitsData(limits: ServerProviderUsageLimits | undefined): boolean {
  return limitsNotice(limits) === null;
}

export function partitionByLimitsData<T>(
  items: readonly T[],
  limitsOf: (item: T) => ServerProviderUsageLimits | undefined,
): { readonly withLimits: readonly T[]; readonly withoutLimits: readonly T[] } {
  const withLimits: T[] = [];
  const withoutLimits: T[] = [];
  for (const item of items) {
    (hasLimitsData(limitsOf(item)) ? withLimits : withoutLimits).push(item);
  }
  return { withLimits, withoutLimits };
}

function accountKey(driver: ServerProvider["driver"], email: string | undefined): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  return normalizedEmail ? `${driver}:${normalizedEmail}` : null;
}

/** The instance's configured name, else the driver's, else its raw kind. */
export function providerLimitsLabel(
  provider: ServerProvider,
  driverLabel: (driver: ServerProvider["driver"]) => string | undefined,
): string {
  return provider.displayName?.trim() || driverLabel(provider.driver) || String(provider.driver);
}

/** The one-line status under a provider heading when there are no bars to draw. */
export function limitsNotice(limits: ServerProviderUsageLimits | undefined): string | null {
  if (limits === undefined) {
    return "This machine has not reported subscription windows.";
  }
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** Elapsed share of the window, 0..1, or null when its length or reset is unknown. */
export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

/**
 * Usage against the clock. The bar is the whole window, so the elapsed share
 * is also where even spending would have put the fill; within five points of
 * it counts as on pace.
 */
export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `resets in 2h 13m`, or null when the window has no reset. */
export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  return resetsAt <= now ? "resets now" : `resets in ${formatDuration(resetsAt - now)}`;
}
