import { describe, expect, it } from "vite-plus/test";

import {
  forkRevisionsDiffer,
  forkRevisionsMatch,
  forkServerUpdateCommand,
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

  it("builds a cwd-independent update command that auto-detects the install", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const command = forkServerUpdateCommand(sha);
    expect(command).toContain(`SHA='${sha}'`);
    expect(command).toContain('CLONE="${T3CODE_FORK_CLONE:-$HOME/src/t3code-fork}"');
    expect(command).toContain('exec bash "$SCRIPT" "$SHA"');
    expect(command).not.toContain("T3CODE_FORK_APPIMAGE=");
    expect(command).not.toContain("pkill");
    expect(command).not.toContain("~/.t3/userdata");
    expect(forkServerUpdateCommand(sha, { restart: false })).toContain("--no-restart");
    const manual = manualForkServerUpdateCommand(sha);
    expect(manual).toMatch(/^bash -lc '/);
    expect(manual).toContain(sha);
    expect(forkServerUpdateCommand("not-a-sha")).toBeNull();
  });
});
