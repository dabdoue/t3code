// @effect-diagnostics globalTimers:off -- Quit cannot hang on Effect Clock; Node timers bound backend shutdown and force-exit.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

// Matches the backend stop budget used by update-install, plus a small buffer
// so a hung child cannot cancel the user's quit.
const BACKEND_SHUTDOWN_WAIT = Duration.seconds(8);
const FORCE_EXIT_AFTER_QUIT = Duration.seconds(3);

export class DesktopLifecycleRelaunchError extends Schema.TaggedErrorClass<DesktopLifecycleRelaunchError>()(
  "DesktopLifecycleRelaunchError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop relaunch failed for reason "${this.reason}".`;
  }
}

export type DesktopLifecycleRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

type DesktopLifecycleRegistrationServices =
  | DesktopLifecycleRuntimeServices
  | DesktopAssets.DesktopAssets
  | ElectronTray.ElectronTray
  | ElectronWindow.ElectronWindow;

/**
 * @effect-expect-leaking DesktopAssets | DesktopEnvironment | DesktopShutdown | DesktopState | DesktopWindow | ElectronApp | ElectronTheme | ElectronTray | ElectronWindow
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly relaunch: (
      reason: string,
    ) => Effect.Effect<void, never, DesktopLifecycleRuntimeServices>;
    readonly register: Effect.Effect<
      void,
      never,
      Scope.Scope | DesktopLifecycleRegistrationServices
    >;
  }
>()("@t3tools/desktop/app/DesktopLifecycle") {}

const {
  logInfo: logLifecycleInfo,
  logWarning: logLifecycleWarning,
  logError: logLifecycleError,
} = makeComponentLogger("desktop-lifecycle");

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

const requestDesktopShutdownAndWait = Effect.fn("desktop.lifecycle.requestShutdownAndWait")(
  function* (
    afterBoundsFlush: Effect.Effect<void> = Effect.void,
  ): Effect.fn.Return<void, never, DesktopShutdown.DesktopShutdown | DesktopWindow.DesktopWindow> {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.flushMainWindowBounds;
    yield* afterBoundsFlush;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  },
);

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  allowQuit: () => boolean,
  markQuitAllowed: () => void,
): void {
  if (allowQuit()) {
    void runEffect(
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        yield* logLifecycleInfo("before-quit received");
      }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
    );
    return;
  }

  event.preventDefault();
  const shutdown = runEffect(
    Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* Ref.set(state.quitting, true);
      yield* logLifecycleInfo("before-quit received");
      yield* requestDesktopShutdownAndWait(
        electronWindow.destroyAll.pipe(
          Effect.catchCause((cause) =>
            logLifecycleError("failed to destroy windows before shutdown", { cause }),
          ),
        ),
      );
    }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
  );
  const timeout = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), Duration.toMillis(BACKEND_SHUTDOWN_WAIT));
    timer.unref?.();
  });
  void Promise.race([
    shutdown.then(
      () => "done" as const,
      () => "done" as const,
    ),
    timeout,
  ]).then((result) => {
    if (result === "timeout") {
      void runEffect(logLifecycleWarning("backend shutdown timed out; continuing quit"));
    }
    markQuitAllowed();
    void runEffect(
      Effect.gen(function* () {
        const electronApp = yield* ElectronApp.ElectronApp;
        yield* electronApp.quit;
      }).pipe(Effect.withSpan("desktop.lifecycle.quitAfterShutdown")),
    );
    if (result !== "timeout") return;
    const exitTimer = setTimeout(() => {
      void runEffect(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* logLifecycleWarning("quit did not exit in time; forcing exit");
          yield* electronApp.exit(0);
        }).pipe(Effect.withSpan("desktop.lifecycle.forceExitAfterQuit")),
      );
    }, Duration.toMillis(FORCE_EXIT_AFTER_QUIT));
    exitTimer.unref?.();
  });
}

function quitFromSignal(
  signal: "SIGINT" | "SIGTERM",
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
): void {
  void runEffect(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const electronApp = yield* ElectronApp.ElectronApp;
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* logLifecycleInfo("process signal received", { signal });
      yield* electronApp.quit;
    }).pipe(Effect.withSpan("desktop.lifecycle.processSignal")),
  );
}

export const make = DesktopLifecycle.of({
  relaunch: Effect.fn("desktop.lifecycle.relaunch")(function* (reason) {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    yield* logLifecycleInfo("desktop relaunch requested", { reason });
    yield* Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* Ref.set(state.quitting, true);
      yield* requestDesktopShutdownAndWait();
      if (environment.isDevelopment) {
        yield* electronApp.exit(75);
        return;
      }
      yield* electronApp.relaunch({
        execPath: process.execPath,
        args: process.argv.slice(1),
      });
      yield* electronApp.exit(0);
    }).pipe(
      Effect.catchCause((cause) => {
        const error = new DesktopLifecycleRelaunchError({ reason, cause });
        return logLifecycleError(error.message, { error });
      }),
      Effect.forkDetach,
      Effect.asVoid,
    );
  }),
  register: Effect.gen(function* () {
    const desktopAssets = yield* DesktopAssets.DesktopAssets;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const electronTray = yield* ElectronTray.ElectronTray;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    const context = yield* Effect.context<DesktopLifecycleRegistrationServices>();
    const runEffect = Effect.runPromiseWith(context);
    let quitAllowed = false;
    let updaterQuitAllowed = false;

    const revealHostWindow = Effect.gen(function* () {
      if (yield* Ref.get(state.quitting)) return;
      yield* desktopWindow.activate;
    }).pipe(Effect.withSpan("desktop.lifecycle.revealHostWindow"));
    const showLinuxTray = Effect.gen(function* () {
      if (environment.platform !== "linux") return;
      if (yield* Ref.get(state.quitting)) return;
      const iconPath = Option.getOrUndefined((yield* desktopAssets.iconPaths).png);
      if (iconPath === undefined) {
        yield* logLifecycleWarning("linux tray skipped because no png icon was found");
        return;
      }
      yield* electronTray
        .replace({
          iconPath,
          tooltip: environment.displayName,
          template: [
            {
              label: "Show window",
              click: () => {
                void runEffect(revealHostWindow);
              },
            },
            { type: "separator" },
            {
              label: "Quit",
              click: () => {
                void runEffect(electronApp.quit);
              },
            },
          ],
          onClick: () => {
            void runEffect(revealHostWindow);
          },
        })
        .pipe(
          Effect.catchCause((cause) => logLifecycleError("failed to show linux tray", { cause })),
        );
    }).pipe(Effect.withSpan("desktop.lifecycle.showLinuxTray"));

    yield* electronTheme.onUpdated(() => {
      void runEffect(
        desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
      );
    });
    yield* electronApp.onBeforeQuitForUpdate(() => {
      // Electron's updater owns the remaining quit/install/relaunch sequence.
      // Cancelling the following app "before-quit" event breaks that sequence,
      // most visibly on macOS where the native updater performs the relaunch.
      updaterQuitAllowed = true;
      // This event is synchronous and the updater's quit proceeds as soon as
      // the listener returns, so a forked destroyAll would race the quit
      // and windows could still be open when the process exits (visible on
      // macOS). Destroy them inline.
      Effect.runSyncWith(context)(
        electronWindow.destroyAll.pipe(
          Effect.andThen(logLifecycleInfo("allowing updater-controlled quit")),
          Effect.catchCause((cause) =>
            logLifecycleError("failed to destroy windows before updater quit", { cause }),
          ),
          Effect.withSpan("desktop.lifecycle.beforeQuitForUpdate"),
        ),
      );
    });
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      handleBeforeQuit(
        event,
        runEffect,
        () => quitAllowed || updaterQuitAllowed,
        () => {
          quitAllowed = true;
        },
      );
    });
    yield* electronApp.on("activate", () => {
      void runEffect(revealHostWindow.pipe(Effect.withSpan("desktop.lifecycle.activate")));
    });
    yield* electronApp.on("second-instance", () => {
      void runEffect(revealHostWindow.pipe(Effect.withSpan("desktop.lifecycle.secondInstance")));
    });
    yield* electronApp.on("window-all-closed", () => {
      void runEffect(
        logLifecycleInfo("all windows closed; desktop backend remains active").pipe(
          Effect.withSpan("desktop.lifecycle.windowAllClosed"),
        ),
      );
    });
    yield* showLinuxTray;

    if (environment.platform !== "win32") {
      yield* addScopedListener(process, "SIGINT", () => {
        quitFromSignal("SIGINT", runEffect);
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runEffect);
      });
    }
  }).pipe(Effect.withSpan("desktop.lifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
