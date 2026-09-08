import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ComponentProps } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { forkInstallFailureMessage, setForkInstallState, useForkInstallState } from "~/forkInstall";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { FORK_MISMATCH_HINT, manualForkInstallCommand, shortForkRevision } from "~/versionSkew";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const pendingForkUpdateEnvironmentIds = new Set<EnvironmentId>();

function canInstallViaDesktopSsh(sshTarget: DesktopSshEnvironmentTarget | null): boolean {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  return sshTarget !== null && typeof bridge?.installForkAppImage === "function";
}

export function ForkInstallProgress({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const state = useForkInstallState(environmentId);
  if (state.status === "idle" || state.status === "succeeded") {
    return null;
  }
  if (state.status === "failed") {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-destructive" role="alert">
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate">{state.message}</span>} />
          <TooltipPopup side="top" className="max-w-80">
            {state.message}
          </TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium text-foreground">
      <span
        className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-foreground"
        aria-hidden="true"
      />
      <span>Updating…</span>
    </div>
  );
}

function CopyForkUpdateCommandButton({
  serverLabel,
  command,
  variant,
}: {
  readonly serverLabel: string;
  readonly command: string;
  readonly variant: ComponentProps<typeof Button>["variant"];
}) {
  const { copyToClipboard } = useCopyToClipboard<{ command: string }>({
    target: "fork update command",
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Update command copied",
        description: `Run that command on ${serverLabel}. It works from any directory.`,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy update command",
        description: error.message,
      });
    },
  });

  return (
    <Button size="xs" variant={variant} onClick={() => void copyToClipboard(command, { command })}>
      Copy update command
    </Button>
  );
}

export function ForkInstallAction({
  environmentId,
  serverLabel,
  sshTarget,
  targetRevision,
  forkServerUpdate,
  selfUpdate,
  label = "Update",
  variant = "outline",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly sshTarget: DesktopSshEnvironmentTarget | null;
  readonly targetRevision: string;
  readonly forkServerUpdate: boolean;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly label?: string;
  readonly variant?: ComponentProps<typeof Button>["variant"];
}) {
  const installState = useForkInstallState(environmentId);
  const installing = installState.status === "updating";
  const command = manualForkInstallCommand(targetRevision);
  const updateServer = useAtomCommand(serverEnvironment.updateServer, {
    reportFailure: false,
  });
  const canUseRpc = forkServerUpdate || (selfUpdate !== null && selfUpdate !== "desktop-managed");

  const handleUpdate = async () => {
    if (installing || pendingForkUpdateEnvironmentIds.has(environmentId)) {
      return;
    }
    const confirmed =
      (await requestConfirmDialog(
        `Update the T3 Code server on ${serverLabel}? It will restart on that machine.`,
      )) ?? true;
    if (!confirmed) {
      return;
    }
    pendingForkUpdateEnvironmentIds.add(environmentId);
    setForkInstallState(environmentId, { status: "updating" });
    toastManager.add({
      type: "info",
      title: `Updating ${serverLabel}`,
      description: "Installing this fork build over the existing connection.",
    });
    try {
      let lastError: unknown = undefined;
      if (canUseRpc) {
        const result = await updateServer({
          environmentId,
          input: { targetVersion: targetRevision },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            setForkInstallState(environmentId, { status: "idle" });
            return;
          }
          lastError = squashAtomCommandFailure(result);
        } else {
          setForkInstallState(environmentId, { status: "succeeded", sha: targetRevision });
          toastManager.add({
            type: "success",
            title: `${serverLabel} updated`,
            description: `Reconnected on ${shortForkRevision(targetRevision)}.`,
          });
          return;
        }
      }

      const bridge = window.desktopBridge;
      if (canInstallViaDesktopSsh(sshTarget) && sshTarget && bridge?.installForkAppImage) {
        await bridge.installForkAppImage({ target: sshTarget, sha: targetRevision });
        setForkInstallState(environmentId, { status: "succeeded", sha: targetRevision });
        toastManager.add({
          type: "success",
          title: `${serverLabel} updated`,
          description: `Now running ${shortForkRevision(targetRevision)}.`,
        });
        return;
      }

      throw (
        lastError ??
        new Error(
          "This server cannot update itself to a fork build. Copy the command and run it on that machine.",
        )
      );
    } catch (error) {
      const message = forkInstallFailureMessage(error);
      setForkInstallState(environmentId, { status: "failed", message });
      toastManager.add({
        type: "error",
        title: `Could not update ${serverLabel}`,
        description: message,
      });
    } finally {
      pendingForkUpdateEnvironmentIds.delete(environmentId);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant={variant}
              disabled={installing}
              onClick={() => void handleUpdate()}
            >
              {installState.status === "failed" ? "Retry" : label}
            </Button>
          }
        />
        <TooltipPopup side="top" className="max-w-80">
          {FORK_MISMATCH_HINT}
        </TooltipPopup>
      </Tooltip>
      {installState.status === "failed" ? (
        <CopyForkUpdateCommandButton
          serverLabel={serverLabel}
          command={command}
          variant={variant}
        />
      ) : null}
    </span>
  );
}
