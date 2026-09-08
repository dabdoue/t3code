// @effect-diagnostics nodeBuiltinImport:off - The test shells out to git and bash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  FORK_UPDATE_SCRIPT_MARKER,
  FORK_UPDATE_SCRIPT_REFS,
  forkRevisionsDiffer,
  forkRevisionsMatch,
  forkServerUpdateCommand,
  forkUpdateScriptLookupRefs,
  isForkUpdateScriptSource,
  manualForkServerUpdateCommand,
  normalizeForkRevision,
  readForkRevisionFromEnv,
} from "./forkRevision.ts";

describe("forkRevision", () => {
  it("accepts short and full git SHAs", () => {
    expect(normalizeForkRevision("Abcdef0")).toBe("abcdef0");
    expect(normalizeForkRevision("  0123456789abcdef0123456789abcdef01234567  ")).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(normalizeForkRevision("not-a-sha")).toBeNull();
    expect(normalizeForkRevision("abc")).toBeNull();
  });

  it("reads T3CODE_FORK_REVISION from env", () => {
    expect(readForkRevisionFromEnv({ T3CODE_FORK_REVISION: "abcdef0" })).toBe("abcdef0");
    expect(readForkRevisionFromEnv({})).toBeNull();
  });

  it("treats a short SHA as the same revision as its full form", () => {
    expect(forkRevisionsMatch("abcdef0123456789", "abcdef0123456789deadbeef")).toBe(true);
    expect(forkRevisionsMatch("abcdef0", "bbcdef0")).toBe(false);
  });

  it("only reports skew when this client is a fork build", () => {
    expect(forkRevisionsDiffer(null, "abcdef0")).toBe(false);
    expect(forkRevisionsDiffer("abcdef0", null)).toBe(true);
    expect(forkRevisionsDiffer("abcdef0", "abcdef0")).toBe(false);
    expect(forkRevisionsDiffer("abcdef0", "fedcba9")).toBe(true);
  });

  it("builds a cwd-independent update command that fetches the updater separately", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const scriptRevision = "fedcba9876543210fedcba9876543210fedcba98";
    const command = forkServerUpdateCommand(sha, { scriptRevision });
    expect(command).toContain(`SHA='${sha}'`);
    expect(command).toContain("raw.githubusercontent.com/dabdoue/t3code");
    expect(command).toContain(scriptRevision);
    expect(command).toContain("feat/claude-code-custom-effort-context");
    expect(command).toContain(`show "FETCH_HEAD:scripts/fork-update-server.sh"`);
    expect(command).toContain(`show "HEAD:scripts/fork-update-server.sh"`);
    expect(command).toContain('exec bash "$script" "$SHA"');
    expect(command).not.toContain("checkout --force --detach");
    expect(command).not.toContain('exec bash "$SCRIPT"');
    expect(command).not.toContain("T3CODE_FORK_APPIMAGE=");
    expect(command).not.toContain("pkill");
    expect(command).not.toContain("~/.t3/userdata");
    expect(forkServerUpdateCommand(sha, { restart: false })).toContain("--no-restart");
    const manual = manualForkServerUpdateCommand(sha);
    expect(manual).toMatch(/^bash -lc '/);
    expect(manual).toContain(sha);
    expect(forkServerUpdateCommand("not-a-sha")).toBeNull();
    expect(isForkUpdateScriptSource("resolve_appimage\nT3CODE_FORK_CLONE")).toBe(true);
    expect(forkUpdateScriptLookupRefs(sha, scriptRevision)[0]).toBe(scriptRevision);
    expect(forkUpdateScriptLookupRefs(sha)).toEqual([...FORK_UPDATE_SCRIPT_REFS, sha]);
    NodeChildProcess.execFileSync("bash", ["-n", "-c", command ?? ""], { encoding: "utf8" });
  });

  it("finds the updater even when the SHA to install does not contain it", () => {
    const root = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-fork-update-"));
    const remote = NodePath.join(root, "remote.git");
    const clone = NodePath.join(root, "clone");
    const marker = NodePath.join(root, "ran");
    NodeFs.mkdirSync(remote);
    const git = (cwd: string, ...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      });
    git(remote, "init", "-b", "main");
    git(remote, "config", "user.email", "test@example.com");
    git(remote, "config", "user.name", "test");
    NodeFs.writeFileSync(NodePath.join(remote, "README"), "old\n");
    git(remote, "add", "README");
    git(remote, "commit", "-m", "old");
    const oldSha = git(remote, "rev-parse", "HEAD").trim();
    NodeFs.mkdirSync(NodePath.join(remote, "scripts"));
    NodeFs.writeFileSync(
      NodePath.join(remote, "scripts", "fork-update-server.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `echo ${FORK_UPDATE_SCRIPT_MARKER}`,
        `printf '%s\\n' "$1" > ${JSON.stringify(marker)}`,
      ].join("\n"),
    );
    git(remote, "add", "scripts/fork-update-server.sh");
    git(remote, "commit", "-m", "updater");
    git(remote, "branch", "feat/claude-code-custom-effort-context");
    const command = forkServerUpdateCommand(oldSha);
    expect(command).not.toBeNull();
    NodeChildProcess.execFileSync("bash", ["-lc", command ?? ""], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        T3CODE_FORK_CLONE: clone,
        T3CODE_FORK_REPO_URL: remote,
        T3CODE_FORK_SCRIPT_BASE_URL: "http://127.0.0.1:1",
        HOME: root,
      },
    });
    expect(NodeFs.readFileSync(marker, "utf8").trim()).toBe(oldSha.toLowerCase());
  });
});
