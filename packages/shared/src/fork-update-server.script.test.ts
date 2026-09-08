// @effect-diagnostics nodeBuiltinImport:off - The test shells out to bash against a temp HOME.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.resolve(
  NodeURL.fileURLToPath(new URL("../../../scripts/fork-update-server.sh", import.meta.url)),
);

function runPrint(
  home: string,
  args: ReadonlyArray<string>,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      APPIMAGE: "",
      T3CODE_FORK_APPIMAGE: "",
      T3CODE_FORK_SCAN_PROC: "0",
      ...extraEnv,
    },
  });
}

function printAppImage(home: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const result = runPrint(home, ["--print-appimage"], extraEnv);
  if (result.status !== 0) {
    throw new Error(result.stderr || `print-appimage exited ${String(result.status)}`);
  }
  return result.stdout.trim();
}

describe("fork-update-server AppImage discovery", () => {
  it("finds a T3 AppImage from a desktop entry", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-desktop-"));
    const appimage = NodePath.join(home, "Applications", "T3-Code-0.0.38-x86_64.AppImage");
    const applications = NodePath.join(home, ".local", "share", "applications");
    NodeFS.mkdirSync(NodePath.dirname(appimage), { recursive: true });
    NodeFS.mkdirSync(applications, { recursive: true });
    NodeFS.writeFileSync(appimage, "#!/bin/sh\n");
    NodeFS.chmodSync(appimage, 0o755);
    NodeFS.writeFileSync(
      NodePath.join(applications, "t3.desktop"),
      [
        "[Desktop Entry]",
        "Name=T3 Code (Alpha)",
        `Exec=${appimage} %U`,
        "Type=Application",
        "",
      ].join("\n"),
    );
    expect(printAppImage(home)).toBe(NodeFS.realpathSync(appimage));
  });

  it("finds a hashed AppImageLauncher file in ~/Applications without a desktop entry", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-apps-"));
    const appimage = NodePath.join(
      home,
      "Applications",
      "T3-Code-Consolidated-0.0.38-x86_64_abc.AppImage",
    );
    NodeFS.mkdirSync(NodePath.dirname(appimage), { recursive: true });
    NodeFS.writeFileSync(appimage, "#!/bin/sh\n");
    NodeFS.chmodSync(appimage, 0o755);
    expect(printAppImage(home)).toBe(NodeFS.realpathSync(appimage));
  });

  it("does not abort when some /proc environ files are unreadable", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-empty-"));
    const result = runPrint(home, ["--print-install"], { T3CODE_FORK_SCAN_PROC: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/Permission denied/u);
    expect(result.stdout).toMatch(/^kind=/u);
  });

  it("treats t3code.service as a server install when no AppImage exists", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-service-"));
    const unit = NodePath.join(home, ".config", "systemd", "user", "t3code.service");
    NodeFS.mkdirSync(NodePath.dirname(unit), { recursive: true });
    NodeFS.writeFileSync(unit, "[Service]\nExecStart=/usr/bin/node /tmp/t3/dist/bin.mjs\n");
    const result = runPrint(home, ["--print-install"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kind=server");
    expect(result.stdout).toContain("unit=t3code.service");
    expect(result.stdout).toContain(`unit-file=${unit}`);
  });

  it("pins a server-only install into the boot-service runtime without an AppImage", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-runtime-"));
    const clone = NodePath.join(home, "clone");
    const t3Home = NodePath.join(home, ".t3");
    const unit = NodePath.join(home, ".config", "systemd", "user", "t3code.service");
    const dist = NodePath.join(clone, "apps", "server", "dist");
    NodeFS.mkdirSync(NodePath.dirname(unit), { recursive: true });
    NodeFS.mkdirSync(dist, { recursive: true });
    NodeFS.writeFileSync(
      unit,
      [
        "[Service]",
        `Environment=T3CODE_HOME=${t3Home}`,
        "ExecStart=/usr/bin/node /tmp/launcher.mjs",
        "",
      ].join("\n"),
    );
    NodeFS.writeFileSync(
      NodePath.join(clone, "apps", "server", "package.json"),
      JSON.stringify({
        name: "t3",
        version: "0.0.38",
        type: "module",
        bin: { t3: "./dist/bin.mjs" },
      }),
    );
    NodeFS.writeFileSync(NodePath.join(dist, "bin.mjs"), "export {};\n");
    NodeFS.writeFileSync(NodePath.join(dist, "service-launcher.mjs"), "export {};\n");
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const result = runPrint(home, [sha, "--no-restart"], {
      T3CODE_FORK_CLONE: clone,
      T3CODE_FORK_SKIP_FETCH: "1",
      T3CODE_HOME: t3Home,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `update exited ${String(result.status)}`);
    }
    expect(result.stdout).toContain("kind=server");
    expect(result.stdout).toContain("version=0.0.38+fork.abcdef012345");
    expect(result.stdout).not.toMatch(/dropin=/u);
    const runtime = NodePath.join(t3Home, "runtime", "versions", "0.0.38+fork.abcdef012345");
    expect(NodeFS.existsSync(NodePath.join(runtime, "node_modules", "t3", "dist", "bin.mjs"))).toBe(
      true,
    );
    expect(
      NodeFS.existsSync(
        NodePath.join(runtime, "node_modules", "t3", "dist", "service-launcher.mjs"),
      ),
    ).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(t3Home, "runtime", "service-state.json"))).toBe(false);
  });

  it("does not invent an AppImage when only a server could exist", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-none-"));
    const result = runPrint(home, ["--print-install"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("kind=none");
    const appimage = runPrint(home, ["--print-appimage"]);
    expect(appimage.status).toBe(1);
    expect(appimage.stderr).toMatch(/no T3 Code AppImage/u);
  });
});
