import { describe, expect, it } from "vite-plus/test";

import { buildRemoteForkInstallCommand } from "./DesktopForkSync.ts";

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
