import { describe, expect, it } from "vite-plus/test";

import { buildRemoteForkInstallCommand, resolveDesktopForkSshTarget } from "./DesktopForkSync.ts";

describe("buildRemoteForkInstallCommand", () => {
  it("fetches the updater independently of the SHA being installed", () => {
    const command = buildRemoteForkInstallCommand("abcdef0123456789abcdef0123456789abcdef01");
    expect(command).toContain("SHA='abcdef0123456789abcdef0123456789abcdef01'");
    expect(command).toContain('exec bash "$script" "$SHA"');
    expect(command).toContain("fork-update-server.sh");
    expect(command).toContain("raw.githubusercontent.com/dabdoue/t3code");
    expect(command).not.toContain("checkout --force --detach");
    expect(command).not.toContain("T3CODE_FORK_APPIMAGE=");
    expect(command).not.toContain("pkill");
    expect(command).not.toContain("~/.t3/userdata");
  });
});

describe("resolveDesktopForkSshTarget", () => {
  const lab = {
    alias: "88",
    hostname: "132.239.222.55",
    username: "dabdoue",
    port: 22,
  };
  const other = {
    alias: "other",
    hostname: "other.example.com",
    username: "dabdoue",
    port: 22,
  };

  it("keeps an explicit target", () => {
    expect(
      resolveDesktopForkSshTarget({
        target: lab,
        label: "other server",
        activeTargets: [other],
      }),
    ).toEqual(lab);
  });

  it("uses the only live SSH session when the catalog did not pass a target", () => {
    expect(
      resolveDesktopForkSshTarget({
        label: "88 server",
        activeTargets: [lab],
      }),
    ).toEqual(lab);
  });

  it("picks the live session whose host matches the server label", () => {
    expect(
      resolveDesktopForkSshTarget({
        label: "88 server",
        activeTargets: [other, lab],
      }),
    ).toEqual(lab);
  });

  it("does not guess among several live sessions with no matching label", () => {
    expect(
      resolveDesktopForkSshTarget({
        label: "mystery server",
        activeTargets: [lab, other],
      }),
    ).toBeNull();
  });
});
