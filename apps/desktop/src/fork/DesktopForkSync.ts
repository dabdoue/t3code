// @effect-diagnostics nodeBuiltinImport:off - Resolves T3CODE_FORK_CHECKOUT against the host filesystem.
import * as NodePath from "node:path";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type {
  DesktopForkInstallResult,
  DesktopForkPushHeadResult,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import {
  forkServerUpdateCommand,
  isForkUpdateScriptSource,
  normalizeForkRevision,
} from "@t3tools/shared/forkRevision";
import {
  collectProcessOutput,
  getLastNonEmptyOutputLine,
  runSshCommand,
} from "@t3tools/ssh/command";

const LOCAL_PUSH_TIMEOUT_MS = 120_000;
const REMOTE_INSTALL_TIMEOUT_MS = 45 * 60 * 1000;
const LOG_TAIL_CHARS = 4_000;

export class DesktopForkSyncError extends Schema.TaggedErrorClass<DesktopForkSyncError>()(
  "DesktopForkSyncError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export function resolveForkCheckoutPath(
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<string, DesktopForkSyncError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const configured = env.T3CODE_FORK_CHECKOUT?.trim() ?? "";
    if (configured.length === 0) {
      return yield* new DesktopForkSyncError({
        reason:
          "Set T3CODE_FORK_CHECKOUT to your dabdoue/t3code checkout (the directory with a `fork` git remote).",
      });
    }
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const checkout = NodePath.isAbsolute(configured) ? configured : NodePath.resolve(configured);
    const scriptPath = path.join(checkout, "scripts", "fork-push-head.sh");
    if (!(yield* fileSystem.exists(scriptPath).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new DesktopForkSyncError({
        reason: `T3CODE_FORK_CHECKOUT is missing scripts/fork-push-head.sh: ${checkout}`,
      });
    }
    return checkout;
  });
}

export function buildRemoteForkInstallCommand(sha: string): string {
  const command = forkServerUpdateCommand(sha);
  if (command === null) {
    throw new Error(`Invalid git SHA: ${sha}`);
  }
  return command;
}

function localForkUpdateScriptCandidates(env: NodeJS.ProcessEnv): string[] {
  const configuredScript = env.T3CODE_FORK_UPDATE_SCRIPT?.trim() ?? "";
  const checkout = env.T3CODE_FORK_CHECKOUT?.trim() ?? "";
  return [
    configuredScript,
    checkout.length > 0 ? NodePath.join(checkout, "scripts", "fork-update-server.sh") : "",
  ].filter((candidate) => candidate.length > 0);
}

export const readLocalForkUpdateScript = Effect.fn("desktop.forkSync.readLocalUpdater")(function* (
  env: NodeJS.ProcessEnv = process.env,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of localForkUpdateScriptCandidates(env)) {
    const absolute = NodePath.isAbsolute(candidate) ? candidate : NodePath.resolve(candidate);
    if (!(yield* fileSystem.exists(absolute).pipe(Effect.orElseSucceed(() => false)))) {
      continue;
    }
    const contents = yield* fileSystem
      .readFileString(absolute)
      .pipe(Effect.orElseSucceed(() => ""));
    if (isForkUpdateScriptSource(contents)) {
      return contents;
    }
  }
  return null;
});

function tailOutput(output: string): string {
  if (output.length <= LOG_TAIL_CHARS) {
    return output.trim();
  }
  return output.slice(-LOG_TAIL_CHARS).trim();
}

const runLocalCommand = Effect.fn("desktop.forkSync.runLocalCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scopedWith((commandScope) =>
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(command, [...args], {
            cwd,
            stdin: "ignore",
            extendEnv: true,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, commandScope),
          Effect.mapError(
            (cause) =>
              new DesktopForkSyncError({
                reason: cause instanceof Error ? cause.message : `Failed to spawn ${command}.`,
              }),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectProcessOutput(child.stdout),
          collectProcessOutput(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopForkSyncError({
              reason: cause instanceof Error ? cause.message : `Failed to run ${command}.`,
            }),
        ),
      );
      return { stdout, stderr, exitCode };
    }),
  ).pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap((result) =>
      Option.match(result, {
        onSome: Effect.succeed,
        onNone: () =>
          new DesktopForkSyncError({
            reason: `${command} timed out after ${timeoutMs}ms.`,
          }),
      }),
    ),
  );
});

export const pushForkHead = Effect.fn("desktop.forkSync.pushHead")(function* () {
  const checkout = yield* resolveForkCheckoutPath();
  const path = yield* Path.Path;
  const scriptPath = path.join(checkout, "scripts", "fork-push-head.sh");
  const { stdout, stderr, exitCode } = yield* runLocalCommand(
    "bash",
    [scriptPath],
    checkout,
    LOCAL_PUSH_TIMEOUT_MS,
  );
  if (exitCode !== 0) {
    return yield* new DesktopForkSyncError({
      reason: tailOutput(stderr) || tailOutput(stdout) || `fork-push-head.sh exited ${exitCode}.`,
    });
  }
  const line = getLastNonEmptyOutputLine(stdout);
  const sha = line?.startsWith("sha=") ? normalizeForkRevision(line.slice(4)) : null;
  if (sha === null) {
    return yield* new DesktopForkSyncError({
      reason: "fork-push-head.sh did not print sha=<git-sha>.",
    });
  }
  return { sha } satisfies DesktopForkPushHeadResult;
});

export const installForkAppImage = Effect.fn("desktop.forkSync.install")(function* (input: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly sha: string;
}) {
  const sha = normalizeForkRevision(input.sha);
  if (sha === null) {
    return yield* new DesktopForkSyncError({ reason: `Invalid git SHA: ${input.sha}` });
  }
  const localScript = yield* readLocalForkUpdateScript();
  const result = yield* runSshCommand(input.target, {
    ...(localScript === null
      ? { remoteCommandArgs: ["bash", "-lc", buildRemoteForkInstallCommand(sha)] }
      : { remoteCommandArgs: ["bash", "-s", "--", sha], stdin: localScript }),
    timeoutMs: REMOTE_INSTALL_TIMEOUT_MS,
    preHostArgs: ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120"],
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopForkSyncError({
          reason: cause.message,
        }),
    ),
  );
  return {
    sha,
    logTail: tailOutput(`${result.stdout}\n${result.stderr}`),
  } satisfies DesktopForkInstallResult;
});
