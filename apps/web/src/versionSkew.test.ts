import { EnvironmentId } from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Pinned so the direction cases below read as fixed versions instead of
// arithmetic on whatever version this checkout happens to be at.
const branding = vi.hoisted(() => ({
  APP_VERSION: "0.0.34",
  APP_FORK_REVISION: null as string | null,
}));
vi.mock("./branding", () => branding);

import { APP_VERSION } from "./branding";
import {
  buildForkMismatchDismissalKey,
  buildVersionMismatchDismissalKey,
  dismissServerUpdateFailure,
  dismissVersionMismatch,
  isServerUpdateFailureDismissed,
  isVersionMismatchDismissed,
  resolveForkRevisionMismatch,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  serverUpdateGuidance,
  shortForkRevision,
  supportsDesktopAppUpdate,
  supportsForkServerUpdate,
  shouldOfferMainlineServerUpdate,
  mainlineServerUpdateTargetVersion,
  mainlineServerUpdateLabel,
  forkServerUpdateLabel,
  manualForkInstallCommand,
} from "./versionSkew";

const MISMATCH_HINT =
  "Version mismatch. Try syncing the client and server to the same T3 Code version.";

describe("versionSkew", () => {
  beforeEach(() => {
    branding.APP_VERSION = "0.0.34";
    branding.APP_FORK_REVISION = null;
  });

  it("dismisses only the current failed attempt without clearing its retry state", () => {
    const failure = {
      status: "failed",
      stage: "downloading",
      fromVersion: "0.0.33",
      targetVersion: "0.0.34",
      message: "Download failed.",
    } as const satisfies ServerUpdateState;
    const retryFailure = { ...failure };
    const otherEnvironmentFailure = { ...failure };

    dismissServerUpdateFailure(failure);

    expect(isServerUpdateFailureDismissed(failure)).toBe(true);
    expect(failure.status).toBe("failed");
    expect(failure.message).toBe("Download failed.");
    expect(isServerUpdateFailureDismissed(retryFailure)).toBe(false);
    expect(isServerUpdateFailureDismissed(otherEnvironmentFailure)).toBe(false);
  });

  it("does not dismiss an update that is still running", () => {
    const running = {
      status: "running",
      stage: "resuming",
      fromVersion: "0.0.33",
      targetVersion: "0.0.34",
    } as const satisfies ServerUpdateState;

    dismissServerUpdateFailure(running);

    expect(isServerUpdateFailureDismissed(running)).toBe(false);
  });

  it("does not warn when versions match", () => {
    expect(resolveVersionMismatch(APP_VERSION)).toBeNull();
  });

  it("returns a mismatch when the server is behind the client", () => {
    expect(resolveVersionMismatch("0.0.33")).toEqual({
      clientVersion: "0.0.34",
      serverVersion: "0.0.33",
      hint: MISMATCH_HINT,
    });
  });

  it("does not warn when the server is ahead of the client", () => {
    expect(resolveVersionMismatch("0.0.35")).toBeNull();
    expect(resolveVersionMismatch("9.9.9")).toBeNull();
  });

  it("does not warn when a nightly and a stable build share a core version", () => {
    expect(resolveVersionMismatch("0.0.34-nightly.20260818.1124")).toBeNull();

    branding.APP_VERSION = "0.0.34-nightly.20260818.1124";
    expect(resolveVersionMismatch("0.0.34")).toBeNull();
  });

  it.each(["0.0.34-nightly.20260823.1124", "0.0.34-nightly.20260824.1124"])(
    "warns when nightly server %s is behind a nightly client on the same release",
    (serverVersion) => {
      branding.APP_VERSION = "0.0.34-nightly.20260824.1125";

      expect(resolveVersionMismatch(serverVersion)).toEqual({
        clientVersion: "0.0.34-nightly.20260824.1125",
        serverVersion,
        hint: MISMATCH_HINT,
      });
    },
  );

  it("does not warn when a nightly server is ahead on the same release", () => {
    branding.APP_VERSION = "0.0.34-nightly.20260824.1125";

    expect(resolveVersionMismatch("0.0.34-nightly.20260824.1126")).toBeNull();
  });

  it("treats a nightly server built past the client as ahead, not skew", () => {
    expect(resolveVersionMismatch("0.0.35-nightly.20260818.1124")).toBeNull();
  });

  it("still warns when a nightly client outruns the server by a release", () => {
    branding.APP_VERSION = "0.0.35-nightly.20260818.1124";

    expect(resolveVersionMismatch("0.0.34")).toEqual({
      clientVersion: "0.0.35-nightly.20260818.1124",
      serverVersion: "0.0.34",
      hint: MISMATCH_HINT,
    });
  });

  it("falls back to string inequality when a version is not semver", () => {
    expect(resolveVersionMismatch("dev")).toEqual({
      clientVersion: "0.0.34",
      serverVersion: "dev",
      hint: MISMATCH_HINT,
    });

    branding.APP_VERSION = "dev";
    expect(resolveVersionMismatch("dev")).toBeNull();
    expect(resolveVersionMismatch("0.0.34")).toMatchObject({ serverVersion: "0.0.34" });
  });

  it("reads the server version from config descriptors", () => {
    expect(
      resolveServerConfigVersionMismatch({
        environment: {
          environmentId: EnvironmentId.make("environment-1"),
          label: "Remote",
          platform: {
            os: "darwin",
            arch: "arm64",
          },
          serverVersion: "0.0.33",
          capabilities: {
            repositoryIdentity: true,
          },
        },
      }),
    ).toMatchObject({
      serverVersion: "0.0.33",
    });
  });

  it("keys dismissals by environment, client version, and server version", () => {
    const environmentId = EnvironmentId.make("environment-dismissal");
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
    });

    expect(key).toBe(`${environmentId}:${APP_VERSION}:9.9.9`);
    expect(isVersionMismatchDismissed(key)).toBe(false);

    dismissVersionMismatch(key);

    expect(isVersionMismatchDismissed(key)).toBe(true);
    expect(
      isVersionMismatchDismissed(
        buildVersionMismatchDismissalKey(environmentId, {
          clientVersion: APP_VERSION,
          serverVersion: "9.9.10",
        }),
      ),
    ).toBe(false);
  });

  it("reads desktop-managed update capabilities from config descriptors", () => {
    expect(
      resolveServerSelfUpdateCapability({
        environment: {
          environmentId: EnvironmentId.make("environment-desktop"),
          label: "Desktop",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "9.9.9",
          capabilities: {
            repositoryIdentity: true,
            serverSelfUpdate: "desktop-managed",
          },
        },
      }),
    ).toBe("desktop-managed");
    expect(resolveServerSelfUpdateCapability(null)).toBeNull();
  });

  it("detects remote desktop-app update support from config descriptors", () => {
    const descriptor = (desktopAppUpdate?: boolean) => ({
      environment: {
        environmentId: EnvironmentId.make("environment-desktop"),
        label: "Desktop",
        platform: { os: "darwin", arch: "arm64" } as const,
        serverVersion: "9.9.9",
        capabilities: {
          repositoryIdentity: true,
          serverSelfUpdate: "desktop-managed" as const,
          ...(desktopAppUpdate === undefined ? {} : { desktopAppUpdate }),
        },
      },
    });

    expect(supportsDesktopAppUpdate(descriptor(true))).toBe(true);
    expect(supportsDesktopAppUpdate(descriptor(false))).toBe(false);
    expect(supportsDesktopAppUpdate(descriptor())).toBe(false);
    expect(supportsDesktopAppUpdate(null)).toBe(false);
  });

  it("matches version-drift guidance to the advertised update path", () => {
    expect(serverUpdateGuidance("respawn")).toBe("Update to stay in sync");
    expect(serverUpdateGuidance("desktop-managed")).toBe("Update the desktop app");
  });

  it("does not offer a fork install when this client is not a fork build", () => {
    expect(
      resolveForkRevisionMismatch({
        environment: {
          environmentId: EnvironmentId.make("environment-linux"),
          label: "Remote",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.38",
          capabilities: { repositoryIdentity: true },
        },
      }),
    ).toBeNull();
  });

  it("offers a fork install when Linux fork SHAs differ, including an unstamped remote", () => {
    branding.APP_FORK_REVISION = "abcdef0123456789abcdef0123456789abcdef01";
    const linux = (forkRevision?: string) => ({
      environment: {
        environmentId: EnvironmentId.make("environment-linux"),
        label: "Remote",
        platform: { os: "linux" as const, arch: "x64" as const },
        serverVersion: "0.0.38",
        ...(forkRevision === undefined ? {} : { forkRevision }),
        capabilities: { repositoryIdentity: true },
      },
    });

    expect(resolveForkRevisionMismatch(linux())).toEqual({
      clientRevision: "abcdef0123456789abcdef0123456789abcdef01",
      serverRevision: null,
    });
    expect(resolveForkRevisionMismatch(linux("fedcba9876543210fedcba9876543210fedcba98"))).toEqual({
      clientRevision: "abcdef0123456789abcdef0123456789abcdef01",
      serverRevision: "fedcba9876543210fedcba9876543210fedcba98",
    });
    expect(
      resolveForkRevisionMismatch(linux("abcdef0123456789abcdef0123456789abcdef01")),
    ).toBeNull();
    expect(shortForkRevision("abcdef0123456789abcdef0123456789abcdef01")).toBe("abcdef0");
    expect(
      buildForkMismatchDismissalKey(EnvironmentId.make("environment-linux"), {
        clientRevision: "abcdef0123456789abcdef0123456789abcdef01",
        serverRevision: null,
      }),
    ).toBe("environment-linux:fork:abcdef0123456789abcdef0123456789abcdef01:none");
  });

  it("does not offer a fork update for macOS remotes", () => {
    branding.APP_FORK_REVISION = "abcdef0123456789abcdef0123456789abcdef01";
    expect(
      resolveForkRevisionMismatch({
        environment: {
          environmentId: EnvironmentId.make("environment-mac"),
          label: "Mac",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.38",
          forkRevision: "fedcba9876543210fedcba9876543210fedcba98",
          capabilities: { repositoryIdentity: true },
        },
      }),
    ).toBeNull();
  });

  it("reads fork server-update support from config descriptors", () => {
    expect(
      supportsForkServerUpdate({
        environment: {
          environmentId: EnvironmentId.make("environment-linux"),
          label: "Remote",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.38",
          capabilities: { repositoryIdentity: true, forkServerUpdate: true },
        },
      }),
    ).toBe(true);
    expect(supportsForkServerUpdate(null)).toBe(false);
  });

  it("keeps official Update available to restore or upgrade mainline next to a fork update", () => {
    branding.APP_VERSION = "0.0.38";
    branding.APP_FORK_REVISION = "abcdef0123456789abcdef0123456789abcdef01";
    const forkServer = {
      environment: {
        environmentId: EnvironmentId.make("environment-linux"),
        label: "Remote",
        platform: { os: "linux" as const, arch: "x64" as const },
        serverVersion: "0.0.38",
        forkRevision: "fedcba9876543210fedcba9876543210fedcba98",
        capabilities: { repositoryIdentity: true },
      },
    };
    expect(shouldOfferMainlineServerUpdate(forkServer)).toBe(true);
    expect(
      shouldOfferMainlineServerUpdate({
        environment: {
          environmentId: EnvironmentId.make("environment-linux"),
          label: "Remote",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.38",
          capabilities: { repositoryIdentity: true },
        },
      }),
    ).toBe(false);
    expect(mainlineServerUpdateTargetVersion(forkServer)).toBe("0.0.38");
    expect(mainlineServerUpdateLabel({ offerFork: true, failed: false })).toBe(
      "Update to mainline",
    );
    expect(forkServerUpdateLabel({ offerMainline: true, failed: false })).toBe("Update fork");
    expect(mainlineServerUpdateLabel({ offerFork: false, failed: false })).toBe("Update");
    expect(forkServerUpdateLabel({ offerMainline: false, failed: true })).toBe("Retry");
  });

  it("copies a cwd-independent fork update command", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const command = manualForkInstallCommand(sha);
    expect(command.startsWith("bash -lc ")).toBe(true);
    expect(command).toContain(sha);
    expect(command).not.toContain("T3CODE_FORK_APPIMAGE=");
    expect(command).not.toContain("./scripts/");
    expect(command).toContain("raw.githubusercontent.com/dabdoue/t3code");
    expect(command).not.toContain("checkout --force --detach");
  });
});
