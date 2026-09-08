// @effect-diagnostics nodeBuiltinImport:off - The test shells out to git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { resolveForkRevision } from "../../../../scripts/lib/resolve-fork-revision.ts";

describe("resolveForkRevision", () => {
  it("uses T3CODE_FORK_REVISION when git is unavailable", () => {
    expect(
      resolveForkRevision({
        env: { T3CODE_FORK_REVISION: "abcdef0" },
        repoRoot: "/tmp/does-not-exist",
      }),
    ).toBe("abcdef0");
  });

  it("prefers git HEAD over an inherited T3CODE_FORK_REVISION", () => {
    const repoRoot = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-fork-rev-"));
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      });
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    NodeFs.writeFileSync(NodePath.join(repoRoot, "README"), "stamp\n");
    git("add", "README");
    git("commit", "-m", "stamp");
    const head = git("rev-parse", "HEAD").trim();
    expect(
      resolveForkRevision({
        env: { T3CODE_FORK_REVISION: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        repoRoot,
      }),
    ).toBe(head);
  });
});
