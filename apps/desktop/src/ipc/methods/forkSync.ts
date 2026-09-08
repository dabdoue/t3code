import {
  DesktopForkInstallInputSchema,
  DesktopForkInstallResultSchema,
  DesktopForkPushHeadResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopForkSync from "../../fork/DesktopForkSync.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const pushForkHead = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORK_PUSH_HEAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopForkPushHeadResultSchema,
  handler: Effect.fn("desktop.ipc.fork.pushHead")(function* () {
    return yield* DesktopForkSync.pushForkHead();
  }),
});

export const installForkAppImage = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORK_INSTALL_APPIMAGE_CHANNEL,
  payload: DesktopForkInstallInputSchema,
  result: DesktopForkInstallResultSchema,
  handler: Effect.fn("desktop.ipc.fork.installAppImage")(function* (input) {
    return yield* DesktopForkSync.installForkAppImage(input);
  }),
});
