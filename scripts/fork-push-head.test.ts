// @effect-diagnostics nodeBuiltinImport:off - Exercises the git-push guard script on a temp repo.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const scriptPath = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "fork-push-head.sh",
);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeGitRepo(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-push-"));
  temporaryDirectories.push(directory);
  git(directory, ["init", "-b", "main"]);
  git(directory, ["config", "user.email", "fork-push-test@example.test"]);
  git(directory, ["config", "user.name", "Fork Push Test"]);
  NodeFS.writeFileSync(NodePath.join(directory, "README.md"), "fork\n");
  git(directory, ["add", "README.md"]);
  git(directory, ["commit", "-m", "init"]);
  return directory;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
  });
}

function runPushScript(cwd: string): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync("bash", [scriptPath], {
    cwd,
    encoding: "utf8",
  });
}

describe("fork-push-head.sh", () => {
  it("refuses a dirty worktree before pushing", () => {
    const repo = makeGitRepo();
    NodeFS.writeFileSync(NodePath.join(repo, "dirty.txt"), "nope\n");
    const result = runPushScript(repo);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("worktree is dirty");
  });

  it("refuses a checkout that has no fork remote", () => {
    const repo = makeGitRepo();
    const result = runPushScript(repo);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing git remote 'fork'");
  });

  it("pushes HEAD to the fork remote and prints sha=", () => {
    const repo = makeGitRepo();
    const bare = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-bare-"));
    temporaryDirectories.push(bare);
    git(bare, ["init", "--bare", "-b", "main"]);
    git(repo, ["remote", "add", "fork", bare]);
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const result = runPushScript(repo);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\n/u).at(-1)).toBe(`sha=${sha}`);
    expect(git(bare, ["rev-parse", "main"]).trim()).toBe(sha);
  });
});
