import { describe, expect, it } from "vite-plus/test";

import { buildRemoteForkInstallCommand } from "./DesktopForkSync.ts";

describe("buildRemoteForkInstallCommand", () => {
  it("checks out the requested SHA then runs the repo install script", () => {
    const command = buildRemoteForkInstallCommand("abcdef0123456789abcdef0123456789abcdef01");
    expect(command).toContain("SHA='abcdef0123456789abcdef0123456789abcdef01'");
    expect(command).toContain('exec bash "$SCRIPT" "$SHA"');
    expect(command).toContain("fork-update-server.sh");
    expect(command).not.toContain("T3CODE_FORK_APPIMAGE=");
    expect(command).not.toContain("pkill");
    expect(command).not.toContain("~/.t3/userdata");
  });
});
