import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const {
  buildFromTemplateMock,
  destroyMock,
  onMock,
  removeListenerMock,
  setContextMenuMock,
  setToolTipMock,
} = vi.hoisted(() => ({
  buildFromTemplateMock: vi.fn((template: ReadonlyArray<unknown>) => template),
  destroyMock: vi.fn(),
  onMock: vi.fn(),
  removeListenerMock: vi.fn(),
  setContextMenuMock: vi.fn(),
  setToolTipMock: vi.fn(),
}));

vi.mock("electron", () => {
  class Tray {
    destroy = destroyMock;
    on = onMock;
    removeListener = removeListenerMock;
    setContextMenu = setContextMenuMock;
    setToolTip = setToolTipMock;
  }

  return {
    Menu: {
      buildFromTemplate: buildFromTemplateMock,
    },
    Tray,
  };
});

import * as ElectronTray from "./ElectronTray.ts";

describe("ElectronTray", () => {
  beforeEach(() => {
    buildFromTemplateMock.mockClear();
    destroyMock.mockClear();
    onMock.mockClear();
    removeListenerMock.mockClear();
    setContextMenuMock.mockClear();
    setToolTipMock.mockClear();
  });

  it.effect("creates a tray icon and replaces it by destroying the previous one", () =>
    Effect.gen(function* () {
      const tray = yield* ElectronTray.ElectronTray;
      const firstClick = vi.fn();
      const secondClick = vi.fn();

      yield* tray.replace({
        iconPath: "/tmp/icon.png",
        tooltip: "T3 Code",
        template: [{ label: "Open" }],
        onClick: firstClick,
      });

      assert.equal(setToolTipMock.mock.calls.length, 1);
      assert.deepEqual(setToolTipMock.mock.calls[0], ["T3 Code"]);
      assert.equal(onMock.mock.calls.length, 1);
      assert.equal(onMock.mock.calls[0]?.[0], "click");

      yield* tray.replace({
        iconPath: "/tmp/icon.png",
        tooltip: "T3 Code",
        template: [{ label: "Quit" }],
        onClick: secondClick,
      });

      assert.equal(destroyMock.mock.calls.length, 1);
      assert.equal(removeListenerMock.mock.calls.length, 1);
      assert.equal(onMock.mock.calls.length, 2);

      yield* tray.destroy;
      assert.equal(destroyMock.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronTray.layer), Effect.scoped),
  );

  it.effect("preserves tray creation failures", () =>
    Effect.gen(function* () {
      const cause = new Error("no status notifier");
      vi.mocked(setToolTipMock).mockImplementationOnce(() => {
        throw cause;
      });
      const tray = yield* ElectronTray.ElectronTray;
      const error = yield* tray
        .replace({
          iconPath: "/tmp/missing.png",
          tooltip: "T3 Code",
          template: [],
          onClick: () => undefined,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronTray.ElectronTrayCreateError);
      assert.equal(error.iconPath, "/tmp/missing.png");
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(ElectronTray.layer), Effect.scoped),
  );
});
