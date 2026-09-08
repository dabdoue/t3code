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
  if (entry.target._tag !== "SshConnectionTarget") {
    return null;
  }
  if (Option.isNone(entry.profile) || entry.profile.value._tag !== "SshConnectionProfile") {
    return null;
  }
  return entry.profile.value.target;
}

export function forkInstallFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Could not update this fork server.";
}
