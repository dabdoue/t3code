import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { vi } from "vite-plus/test";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

function makeElectronAppLayer(
  appListeners: Map<string, (...args: readonly unknown[]) => void>,
  quit: Effect.Effect<void> = Effect.void,
  exit: Effect.Effect<void> = Effect.void,
) {
  const registerListener = (eventName: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appListeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appListeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    quit,
    exit: () => exit,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: (listener) => registerListener("before-quit-for-update", listener),
    on: (eventName, listener) =>
      registerListener(eventName, listener as unknown as (...args: readonly unknown[]) => void),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

const desktopAssetsLayer = Layer.succeed(DesktopAssets.DesktopAssets, {
  iconPaths: Effect.succeed({
    ico: Option.none(),
    icns: Option.none(),
    png: Option.some("/tmp/t3-icon.png"),
  }),
  resolveResourcePath: () => Effect.succeed(Option.none()),
});

function makeElectronTrayLayer(calls: { replace: number; destroy: number }) {
  return Layer.succeed(ElectronTray.ElectronTray, {
    replace: () =>
      Effect.sync(() => {
        calls.replace += 1;
      }),
    destroy: Effect.sync(() => {
      calls.destroy += 1;
    }),
  });
}

function makeElectronWindowLayer(destroyAll: Effect.Effect<void> = Effect.void) {
  return Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.die("unexpected main window read"),
    currentMainOrFirst: Effect.die("unexpected current window read"),
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });
}

function makeDesktopWindowLayer(
  input: {
    readonly activate?: Effect.Effect<void>;
    readonly flushMainWindowBounds?: Effect.Effect<void>;
  } = {},
) {
  return Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: input.activate ?? Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: input.flushMainWindowBounds ?? Effect.void,
    dispatchMenuAction: () => Effect.void,
    zoomMain: () => Effect.void,
    syncAppearance: Effect.void,
  });
}

function makeEnvironmentLayer(platform: NodeJS.Platform) {
  return Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    platform,
    isDevelopment: false,
    displayName: "T3 Code",
  } as DesktopEnvironment.DesktopEnvironment["Service"]);
}

function makeLifecycleLayer(input: {
  readonly appListeners: Map<string, (...args: readonly unknown[]) => void>;
  readonly platform?: NodeJS.Platform;
  readonly quit?: Effect.Effect<void>;
  readonly exit?: Effect.Effect<void>;
  readonly destroyAll?: Effect.Effect<void>;
  readonly activate?: Effect.Effect<void>;
  readonly flushMainWindowBounds?: Effect.Effect<void>;
  readonly shutdown?: Layer.Layer<DesktopShutdown.DesktopShutdown>;
  readonly trayCalls?: { replace: number; destroy: number };
}) {
  return DesktopLifecycle.layer.pipe(
    Layer.provideMerge(
      makeElectronAppLayer(
        input.appListeners,
        input.quit ?? Effect.void,
        input.exit ?? Effect.void,
      ),
    ),
    Layer.provideMerge(electronThemeLayer),
    Layer.provideMerge(makeElectronTrayLayer(input.trayCalls ?? { replace: 0, destroy: 0 })),
    Layer.provideMerge(desktopAssetsLayer),
    Layer.provideMerge(makeElectronWindowLayer(input.destroyAll)),
    Layer.provideMerge(
      makeDesktopWindowLayer({
        ...(input.activate === undefined ? {} : { activate: input.activate }),
        ...(input.flushMainWindowBounds === undefined
          ? {}
          : { flushMainWindowBounds: input.flushMainWindowBounds }),
      }),
    ),
    Layer.provideMerge(makeEnvironmentLayer(input.platform ?? "darwin")),
    Layer.provideMerge(input.shutdown ?? DesktopShutdown.layer),
    Layer.provideMerge(DesktopState.layer),
  );
}

describe("DesktopLifecycle", () => {
  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      // The fork keeps the backend alive when every window closes (the server
      // outlives the UI), so window-all-closed must never reach app.quit.
      const quit = vi.fn();
      let windowsDestroyed = false;
      const layer = makeLifecycleLayer({
        appListeners,
        platform,
        quit: Effect.sync(quit),
        destroyAll: Effect.sync(() => {
          windowsDestroyed = true;
        }),
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("window-all-closed")?.();
          yield* Effect.yieldNow;
          assert.equal(
            quit.mock.calls.length,
            0,
            "closing every window must keep the backend alive",
          );

          appListeners.get("before-quit-for-update")?.();
          yield* Effect.yieldNow;

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );
          assert.isTrue(windowsDestroyed);

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    });
  }

  it.effect("destroys windows before waiting for backend shutdown", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const shutdownRequested = yield* Deferred.make<void>();
      const allowShutdown = yield* Deferred.make<void>();
      const quitRequested = yield* Deferred.make<void>();
      const events: string[] = [];

      const quit = Effect.sync(() => {
        events.push("quit");
      }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined)), Effect.asVoid);
      const destroyAll = Effect.sync(() => {
        events.push("destroy");
      });
      const flushMainWindowBounds = Effect.sync(() => {
        events.push("flush");
      });

      const shutdown = Layer.succeed(DesktopShutdown.DesktopShutdown, {
        request: Effect.sync(() => {
          events.push("request");
        }).pipe(Effect.andThen(Deferred.succeed(shutdownRequested, undefined)), Effect.asVoid),
        awaitRequest: Deferred.await(shutdownRequested),
        markComplete: Deferred.succeed(allowShutdown, undefined).pipe(Effect.asVoid),
        awaitComplete: Deferred.await(allowShutdown),
        isComplete: Deferred.isDone(allowShutdown),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          const event = { preventDefault: () => undefined } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          yield* Deferred.await(shutdownRequested);
          const eventsBeforeCleanup = [...events];
          yield* Deferred.succeed(allowShutdown, undefined);
          yield* Deferred.await(quitRequested);

          assert.deepEqual(eventsBeforeCleanup, ["flush", "destroy", "request"]);
          assert.deepEqual(events, ["flush", "destroy", "request", "quit"]);
        }),
      ).pipe(
        Effect.provide(
          makeLifecycleLayer({
            appListeners,
            quit,
            destroyAll,
            flushMainWindowBounds,
            shutdown,
          }),
        ),
      );
    }),
  );

  it.effect("ignores app activation while quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
      const activate = Effect.sync(() => {
        activationCount += 1;
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);

          appListeners.get("activate")?.();
          yield* Effect.yieldNow;

          assert.equal(activationCount, 0);
        }),
      ).pipe(Effect.provide(makeLifecycleLayer({ appListeners, activate })));
    }),
  );

  it.effect("recreates the window when a second instance launches after the UI closed", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
      const activate = Effect.sync(() => {
        activationCount += 1;
      });
      const trayCalls = { replace: 0, destroy: 0 };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("second-instance")?.();
          yield* Effect.yieldNow;

          assert.equal(activationCount, 1);
          assert.equal(trayCalls.destroy, 1);
        }),
      ).pipe(
        Effect.provide(
          makeLifecycleLayer({
            appListeners,
            platform: "linux",
            activate,
            trayCalls,
          }),
        ),
      );
    }),
  );

  it.effect("shows a linux tray after every window closes and hides it when a window returns", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const trayCalls = { replace: 0, destroy: 0 };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("window-all-closed")?.();
          yield* Effect.yieldNow;
          assert.equal(trayCalls.replace, 1);

          appListeners.get("browser-window-created")?.();
          yield* Effect.yieldNow;
          assert.equal(trayCalls.destroy, 1);
        }),
      ).pipe(
        Effect.provide(
          makeLifecycleLayer({
            appListeners,
            platform: "linux",
            trayCalls,
          }),
        ),
      );
    }),
  );

  it.effect("does not show a background tray on macOS after every window closes", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const trayCalls = { replace: 0, destroy: 0 };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("window-all-closed")?.();
          yield* Effect.yieldNow;
          assert.equal(trayCalls.replace, 0);
        }),
      ).pipe(
        Effect.provide(
          makeLifecycleLayer({
            appListeners,
            platform: "darwin",
            trayCalls,
          }),
        ),
      );
    }),
  );
});
