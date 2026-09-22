import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { PiAgentSettings } from "@t3tools/contracts";

import { buildInitialPiProviderSnapshot, checkPiProviderStatus } from "./PiProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodePiSettings = Schema.decodeSync(PiAgentSettings);

describe("buildInitialPiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({ enabled: false }));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  // pi instances exist only through explicit `providerInstances` entries, so
  // unlike Grok it is on by default once added.
  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking pi CLI");
      expect(snapshot.supportsConversationRollback).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["pi-default"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/pi-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-version-" });
          const piPath = writeFakeCli({
            directory: dir,
            name: "pi",
            source: ["process.exit(2);", ""].join("\n"),
          });
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("pi CLI is installed but failed to run.");
    }),
  );

  it.effect("reports ready when the CLI answers --version", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-probe-" });
          const piPath = writeFakeCli({
            directory: dir,
            name: "pi",
            source: [
              'if (process.argv[2] === "--version") {',
              '  process.stdout.write("pi 0.86.0\\n");',
              "  process.exit(0);",
              "}",
              "process.exit(1);",
              "",
            ].join("\n"),
          });
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.86.0");
      // pi is file-configured, so there is no login state to report.
      expect(snapshot.auth).toEqual({ status: "unknown" });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["pi-default"]);
    }),
  );

  it.effect("lists settings-declared custom models after the pi default", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-custom-" });
          const piPath = writeFakeCli({
            directory: dir,
            name: "pi",
            source: ['process.stdout.write("pi 0.86.0\\n");', "process.exit(0);", ""].join("\n"),
          });
          return yield* checkPiProviderStatus(
            decodePiSettings({
              enabled: true,
              binaryPath: piPath,
              customModels: [{ slug: "vllm-qwen3", name: "Qwen3 via vLLM" }],
            }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => [model.slug, model.isCustom])).toEqual([
        ["pi-default", false],
        ["vllm-qwen3", true],
      ]);
    }),
  );
});
