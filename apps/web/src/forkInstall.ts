import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useSyncExternalStore } from "react";

export type ForkInstallState =
  | { readonly status: "idle" }
  | { readonly status: "updating" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "succeeded"; readonly sha: string };

const IDLE_STATE: ForkInstallState = { status: "idle" };
const states = new Map<EnvironmentId, ForkInstallState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getForkInstallState(environmentId: EnvironmentId): ForkInstallState {
  return states.get(environmentId) ?? IDLE_STATE;
}

export function setForkInstallState(environmentId: EnvironmentId, state: ForkInstallState): void {
  if (state.status === "idle") {
    states.delete(environmentId);
  } else {
    states.set(environmentId, state);
  }
  emit();
}

export function useForkInstallState(environmentId: EnvironmentId | null): ForkInstallState {
  return useSyncExternalStore(
    (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },
    () => (environmentId === null ? IDLE_STATE : getForkInstallState(environmentId)),
  );
}

export function sshTargetFromCatalogEntry(
  entry: ConnectionCatalogEntry,
): DesktopSshEnvironmentTarget | null {
  if (Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile") {
    return entry.profile.value.target;
  }
  return null;
}

function normalizeSshHint(hint: string): string {
  return hint
    .trim()
    .toLowerCase()
    .replace(/\s+server$/u, "");
}

export function sshTargetMatchesHint(target: DesktopSshEnvironmentTarget, hint: string): boolean {
  const normalizedHint = normalizeSshHint(hint);
  if (normalizedHint.length === 0) {
    return false;
  }
  const candidates = [
    target.alias,
    target.hostname,
    target.username ?? "",
    target.username ? `${target.username}@${target.alias}` : "",
    target.username ? `${target.username}@${target.hostname}` : "",
  ]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return candidates.some(
    (candidate) =>
      normalizedHint === candidate ||
      normalizedHint.includes(candidate) ||
      candidate.includes(normalizedHint),
  );
}

export function resolveForkSshTarget(
  preferred: ConnectionCatalogEntry | null,
  catalog: ReadonlyArray<ConnectionCatalogEntry>,
  hint?: string,
): DesktopSshEnvironmentTarget | null {
  const direct = preferred === null ? null : sshTargetFromCatalogEntry(preferred);
  if (direct !== null) {
    return direct;
  }
  const known = catalog
    .map((entry) => sshTargetFromCatalogEntry(entry))
    .filter((target): target is DesktopSshEnvironmentTarget => target !== null);
  const unique = uniqueSshTargets(known);
  if (hint !== undefined && hint.trim().length > 0) {
    const matches = unique.filter((target) => sshTargetMatchesHint(target, hint));
    if (matches.length === 1) {
      return matches[0] ?? null;
    }
  }
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

function uniqueSshTargets(
  targets: ReadonlyArray<DesktopSshEnvironmentTarget>,
): DesktopSshEnvironmentTarget[] {
  const seen = new Set<string>();
  const unique: DesktopSshEnvironmentTarget[] = [];
  for (const target of targets) {
    const key = `${target.alias}\0${target.hostname}\0${target.username ?? ""}\0${target.port ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

export function forkInstallFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Could not update this fork server.";
}
