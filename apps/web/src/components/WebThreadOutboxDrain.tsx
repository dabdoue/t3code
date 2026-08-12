import { CommandId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveThreadMetadataUpdateForNextTurn } from "./ChatView.logic";
import {
  advanceWebThreadOutboxDeliveryGate,
  makeWebThreadOutboxDeliveryGate,
  shouldPauseWebThreadOutboxDelivery,
  webThreadOutboxDeliveryGateBlocksMessage,
  type WebThreadOutboxDeliveryGate,
} from "./WebThreadOutboxDrain.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useEnvironments } from "../state/environments";
import { useThreadShells } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  beginWebThreadOutboxDispatch,
  finishWebThreadOutboxDispatch,
  shouldDrainWebThreadOutbox,
  useWebThreadOutboxStore,
} from "../webThreadOutbox";

function settingsCommandId(commandId: CommandId, setting: string): CommandId {
  return CommandId.make(`${commandId}:${setting}`);
}

export function WebThreadOutboxDrain() {
  const queuesByThreadKey = useWebThreadOutboxStore((state) => state.queuesByThreadKey);
  const pausedMessageIds = useWebThreadOutboxStore((state) => state.pausedMessageIds);
  const heldThreadKeys = useWebThreadOutboxStore((state) => state.heldThreadKeys);
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [drainTick, setDrainTick] = useState(0);
  const deliveryGatesRef = useRef(new Map<string, WebThreadOutboxDeliveryGate>());

  useEffect(() => {
    let changed = false;
    for (const thread of threads) {
      const threadKey = `${thread.environmentId}:${thread.id}`;
      const gate = deliveryGatesRef.current.get(threadKey);
      if (!gate) continue;
      const advanced = advanceWebThreadOutboxDeliveryGate(gate, thread.session?.status ?? null);
      if (advanced === null) {
        deliveryGatesRef.current.delete(threadKey);
        changed = true;
      } else if (advanced !== gate) {
        deliveryGatesRef.current.set(threadKey, advanced);
        changed = true;
      }
    }
    if (changed) setDrainTick((current) => current + 1);
  }, [threads]);

  const nextDelivery = useMemo(() => {
    const threadByKey = new Map<string, (typeof threads)[number]>(
      threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread] as const),
    );
    const environmentById = new Map(
      environments.map((environment) => [environment.environmentId, environment] as const),
    );
    const heads = Object.values(queuesByThreadKey)
      .flatMap((queue) => (queue[0] ? [queue[0]] : []))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    for (const message of heads) {
      const threadKey = `${message.environmentId}:${message.threadId}`;
      const thread = threadByKey.get(threadKey);
      if (!thread) continue;
      if (
        webThreadOutboxDeliveryGateBlocksMessage(
          deliveryGatesRef.current.get(threadKey) ?? null,
          message.activeTurnMessageBehavior,
        )
      ) {
        continue;
      }
      const environment = environmentById.get(message.environmentId);
      if (
        shouldDrainWebThreadOutbox({
          sessionStatus: thread.session?.status ?? null,
          environmentConnected: environment?.connection.phase === "connected",
          paused: Boolean(pausedMessageIds[message.messageId]),
          held: Boolean(heldThreadKeys[threadKey]),
          activeTurnMessageBehavior: message.activeTurnMessageBehavior,
        })
      ) {
        return { message, thread };
      }
    }
    return null;
  }, [drainTick, environments, heldThreadKeys, pausedMessageIds, queuesByThreadKey, threads]);

  useEffect(() => {
    if (!nextDelivery || !beginWebThreadOutboxDispatch(nextDelivery.message.messageId)) {
      return;
    }
    const { message, thread } = nextDelivery;
    const threadKey = `${message.environmentId}:${message.threadId}`;
    const existingGate = deliveryGatesRef.current.get(threadKey);
    const createdGate = existingGate === undefined;
    if (createdGate) {
      deliveryGatesRef.current.set(
        threadKey,
        makeWebThreadOutboxDeliveryGate(message.messageId, thread.session?.status ?? null),
      );
    }

    const releaseCreatedGate = () => {
      if (!createdGate) return;
      const gate = deliveryGatesRef.current.get(threadKey);
      if (gate?.messageId === message.messageId) deliveryGatesRef.current.delete(threadKey);
    };

    const deliver = async () => {
      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: thread.modelSelection,
        nextModelSelection: message.modelSelection,
        currentBranch: thread.branch,
      });
      if (metadataUpdate) {
        const result = await updateThreadMetadata({
          environmentId: message.environmentId,
          input: {
            commandId: settingsCommandId(message.commandId, "model-selection"),
            threadId: message.threadId,
            ...metadataUpdate,
          },
        });
        if (result._tag === "Failure") return result;
      }

      if (message.runtimeMode !== thread.runtimeMode) {
        const result = await setThreadRuntimeMode({
          environmentId: message.environmentId,
          input: {
            commandId: settingsCommandId(message.commandId, "runtime-mode"),
            threadId: message.threadId,
            runtimeMode: message.runtimeMode,
            createdAt: message.createdAt,
          },
        });
        if (result._tag === "Failure") return result;
      }

      if (message.interactionMode !== thread.interactionMode) {
        const result = await setThreadInteractionMode({
          environmentId: message.environmentId,
          input: {
            commandId: settingsCommandId(message.commandId, "interaction-mode"),
            threadId: message.threadId,
            interactionMode: message.interactionMode,
            createdAt: message.createdAt,
          },
        });
        if (result._tag === "Failure") return result;
      }

      const freshThread = appAtomRegistry
        .get(environmentThreadShells.threadShellsAtom)
        .find(
          (candidate) =>
            candidate.environmentId === message.environmentId && candidate.id === message.threadId,
        );
      const freshEnvironment = appAtomRegistry.get(
        environmentPresentations.presentationAtom(message.environmentId),
      );
      if (
        !freshThread ||
        !shouldDrainWebThreadOutbox({
          sessionStatus: freshThread.session?.status ?? null,
          environmentConnected: freshEnvironment?.connection.phase === "connected",
          paused: Boolean(useWebThreadOutboxStore.getState().pausedMessageIds[message.messageId]),
          held: Boolean(useWebThreadOutboxStore.getState().heldThreadKeys[threadKey]),
          activeTurnMessageBehavior: message.activeTurnMessageBehavior,
        })
      ) {
        return { _tag: "Deferred" as const };
      }

      return startThreadTurn({
        environmentId: message.environmentId,
        input: {
          commandId: message.commandId,
          threadId: message.threadId,
          message: {
            messageId: message.messageId,
            role: "user",
            text: message.text,
            attachments: message.attachments,
          },
          modelSelection: message.modelSelection,
          titleSeed: thread.title,
          runtimeMode: message.runtimeMode,
          interactionMode: message.interactionMode,
          createdAt: message.createdAt,
        },
      });
    };

    void deliver()
      .then((result) => {
        if (result._tag === "Deferred") {
          releaseCreatedGate();
          return;
        }
        if (result._tag === "Failure") {
          releaseCreatedGate();
          if (!shouldPauseWebThreadOutboxDelivery(result)) return;
          useWebThreadOutboxStore.getState().pause(message.messageId);
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Queued delivery paused",
              description: "Open the thread and retry when the connection is ready.",
            }),
          );
          return;
        }
        useWebThreadOutboxStore.getState().remove(message);
      })
      .catch((error: unknown) => {
        releaseCreatedGate();
        console.error("[THREAD-OUTBOX] Queued delivery failed unexpectedly.", error);
        useWebThreadOutboxStore.getState().pause(message.messageId);
      })
      .finally(() => {
        finishWebThreadOutboxDispatch(message.messageId);
        setDrainTick((current) => current + 1);
      });
  }, [
    nextDelivery,
    setThreadInteractionMode,
    setThreadRuntimeMode,
    startThreadTurn,
    updateThreadMetadata,
  ]);

  return null;
}
