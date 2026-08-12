import { THREAD_QUEUE_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createThreadQueueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const serialByEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    snapshots: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:thread-queue:snapshots",
      tag: THREAD_QUEUE_WS_METHODS.subscribe,
      idleTtlMs: 0,
    }),
    upsert: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-queue:upsert",
      tag: THREAD_QUEUE_WS_METHODS.upsert,
      scheduler,
      concurrency: serialByEnvironment,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-queue:remove",
      tag: THREAD_QUEUE_WS_METHODS.remove,
      scheduler,
      concurrency: serialByEnvironment,
    }),
    reorder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-queue:reorder",
      tag: THREAD_QUEUE_WS_METHODS.reorder,
      scheduler,
      concurrency: serialByEnvironment,
    }),
    promote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-queue:promote",
      tag: THREAD_QUEUE_WS_METHODS.promote,
      scheduler,
      concurrency: serialByEnvironment,
    }),
    pause: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-queue:pause",
      tag: THREAD_QUEUE_WS_METHODS.pause,
      scheduler,
      concurrency: serialByEnvironment,
    }),
    hold: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-queue:hold",
      tag: THREAD_QUEUE_WS_METHODS.hold,
      scheduler,
      concurrency: serialByEnvironment,
    }),
  };
}
