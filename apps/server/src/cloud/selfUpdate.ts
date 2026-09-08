import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { forkServerUpdateCommand, normalizeForkRevision } from "@t3tools/shared/forkRevision";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  PinnedRuntimeInstallError,
  PinnedRuntimePreflightBlockedError,
} from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const PREFLIGHT_TIMEOUT = Duration.seconds(30);
const FORK_UPDATE_TIMEOUT = Duration.minutes(45);
const FORK_RESTART_HANDOFF_TIMEOUT = Duration.seconds(5);

function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function installedAppImageFromOutput(output: string): string | null {
  const match = /(?:^|\n)installed=(.+)\n?/.exec(output);
  const value = match?.[1]?.trim() ?? "";
  return value.startsWith("/") ? value : null;
}

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (stage: ServerSelfUpdateProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commitDesktopUpdate: (
      requestId: string,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const execPath = yield* HostProcessExecutablePath;
  const hostPlatform = yield* HostProcessPlatform;
  const inFlight = yield* Ref.make(false);

  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (input, reportProgress = () => Effect.void) {
    const forkRevision = normalizeForkRevision(input.targetVersion);
    if (forkRevision !== null) {
      if (hostPlatform !== "linux") {
        return yield* failWith("Fork server updates are only supported on Linux.");
      }
      if (yield* Ref.getAndSet(inFlight, true)) {
        return yield* failWith("A server update is already in progress.");
      }
      return yield* Effect.gen(function* () {
        yield* reportProgress("downloading");
        const command = forkServerUpdateCommand(forkRevision, { restart: false });
        if (command === null) {
          return yield* failWith(`'${input.targetVersion}' is not a git SHA.`);
        }
        const result = yield* runner
          .run({
            command: "bash",
            args: ["-lc", command],
            timeout: FORK_UPDATE_TIMEOUT,
            outputMode: "truncate",
            maxOutputBytes: 512 * 1024,
          })
          .pipe(Effect.mapError((cause) => failWith("Could not update this fork server.", cause)));
        if (result.timedOut) {
          return yield* failWith("Fork server update timed out.");
        }
        if (result.code !== 0) {
          const detail = (result.stderr.trim() || result.stdout.trim()).slice(-2000);
          return yield* failWith(
            detail.length > 0
              ? `Could not update this fork server.\n${detail}`
              : `Could not update this fork server (exit ${String(result.code)}).`,
          );
        }
        yield* reportProgress("installing");
        const appimage =
          installedAppImageFromOutput(`${result.stdout}\n${result.stderr}`) ??
          process.env.T3CODE_FORK_APPIMAGE?.trim() ??
          process.env.APPIMAGE?.trim() ??
          "";
        const clone =
          process.env.T3CODE_FORK_CLONE?.trim() || `${process.env.HOME ?? ""}/src/t3code-fork`;
        const script = `${clone}/scripts/fork-update-server.sh`;
        const restartCommand = [
          "set -euo pipefail",
          appimage.length > 0 ? `export T3CODE_FORK_APPIMAGE=${posixSingleQuote(appimage)}` : "",
          "sleep 2",
          `exec bash ${posixSingleQuote(script)} --restart-only`,
        ]
          .filter((line) => line.length > 0)
          .join("\n");
        yield* runner
          .run({
            command: "bash",
            args: [
              "-lc",
              `nohup bash -lc ${posixSingleQuote(restartCommand)} >/tmp/t3-fork-restart.log 2>&1 & disown`,
            ],
            timeout: FORK_RESTART_HANDOFF_TIMEOUT,
          })
          .pipe(Effect.ignore);
        yield* Effect.logInfo("Fork server update prepared; restarting into the new revision.", {
          forkRevision,
          appimage: appimage.length > 0 ? appimage : undefined,
        });
        return {
          targetVersion: forkRevision,
          method:
            capability === "desktop-managed" ? ("desktop-app" as const) : ("boot-service" as const),
        };
      }).pipe(Effect.onError(() => Ref.set(inFlight, false)));
    }

    if (capability === "desktop-managed") {
      // input.targetVersion is meaningless here: the desktop app's own
      // update feed decides what it downloads, and the result carries what
      // it actually got.
      if (desktopAppUpdate.available) {
        return yield* desktopAppUpdate.run(reportProgress);
      }
      return yield* failWith(
        "This server is managed by the T3 Code desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      return yield* failWith(
        "Remote updates require the T3 Code background service. Run `t3 service install` on the server machine.",
      );
    }

    const targetVersion = input.targetVersion.trim();
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }

    return yield* Effect.gen(function* () {
      yield* reportProgress("downloading");
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir: serverConfig.baseDir,
        version: targetVersion,
        fs,
        path,
        runner,
        validate: (runtime) =>
          runner
            .run({
              command: execPath,
              args: [
                runtime.entryPath,
                "__service-preflight",
                "--database-path",
                serverConfig.dbPath,
                "--launcher-protocol",
                String(SERVICE_LAUNCHER_PROTOCOL),
              ],
              timeout: PREFLIGHT_TIMEOUT,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PinnedRuntimeInstallError({
                    step: "running the staged service preflight",
                    cause,
                  }),
              ),
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  void,
                  PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
                > => {
                  if (result.code !== 0) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "running the staged service preflight",
                        exitCode: Number(result.code),
                        stdoutLength: result.stdout.length,
                        stderrLength: result.stderr.length,
                      }),
                    );
                  }
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(result.stdout.trim());
                  } catch (cause) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "decoding the staged service preflight",
                        cause,
                      }),
                    );
                  }
                  const preflight = decodeServicePreflightResult(parsed);
                  if (preflight === undefined || preflight.version !== targetVersion) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "verifying the staged service preflight",
                      }),
                    );
                  }
                  return preflight.status === "ready"
                    ? Effect.void
                    : Effect.fail(
                        new PinnedRuntimePreflightBlockedError({
                          version: targetVersion,
                          reason: preflight.reason,
                        }),
                      );
                },
              ),
            ),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PinnedRuntimePreflightBlockedError"
            ? failWith(error.reason, error)
            : failWith(`Could not prepare t3@${targetVersion}.`, error),
        ),
      );

      yield* reportProgress("installing");
      const updateId = yield* launcher
        .requestUpdate({ targetVersion, dbPath: serverConfig.dbPath })
        .pipe(
          Effect.mapError((error) =>
            failWith(
              error._tag === "ServiceLauncherRejectedError"
                ? error.reason
                : "Could not ask the service launcher to activate the prepared update.",
              error,
            ),
          ),
        );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId,
        targetVersion,
        runtimePath: paths.entryPath,
      });
      return { targetVersion, method: "boot-service" as const, updateId };
    }).pipe(Effect.onError(() => Ref.set(inFlight, false)));
  });

  return ServerSelfUpdate.of({
    update,
    commitDesktopUpdate: (requestId) => desktopAppUpdate.commit(requestId),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
