import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export interface ElectronTrayReplaceInput {
  readonly iconPath: string;
  readonly tooltip: string;
  readonly template: readonly Electron.MenuItemConstructorOptions[];
  readonly onClick: () => void;
}

export class ElectronTrayCreateError extends Schema.TaggedErrorClass<ElectronTrayCreateError>()(
  "ElectronTrayCreateError",
  {
    iconPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create the desktop tray icon from ${this.iconPath}.`;
  }
}

export class ElectronTray extends Context.Service<
  ElectronTray,
  {
    readonly replace: (
      input: ElectronTrayReplaceInput,
    ) => Effect.Effect<void, ElectronTrayCreateError>;
    readonly destroy: Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronTray") {}

export const make = Effect.gen(function* () {
  let tray: Electron.Tray | null = null;
  let clickListener: (() => void) | undefined;

  const destroy = Effect.sync(() => {
    if (tray === null) {
      return;
    }
    if (clickListener !== undefined) {
      tray.removeListener("click", clickListener);
      clickListener = undefined;
    }
    tray.destroy();
    tray = null;
  });

  yield* Effect.addFinalizer(() => destroy);

  return ElectronTray.of({
    destroy,
    replace: (input) =>
      destroy.pipe(
        Effect.andThen(
          Effect.try({
            try: () => {
              const created = new Electron.Tray(input.iconPath);
              created.setToolTip(input.tooltip);
              created.setContextMenu(Electron.Menu.buildFromTemplate([...input.template]));
              clickListener = input.onClick;
              created.on("click", clickListener);
              tray = created;
            },
            catch: (cause) =>
              new ElectronTrayCreateError({
                iconPath: input.iconPath,
                cause,
              }),
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(ElectronTray, make);
