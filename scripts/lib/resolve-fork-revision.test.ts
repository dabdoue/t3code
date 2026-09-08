import { describe, expect, it } from "vite-plus/test";

import { resolveForkRevision } from "./resolve-fork-revision.ts";

describe("resolveForkRevision", () => {
  it("prefers T3CODE_FORK_REVISION over git", () => {
    expect(
      resolveForkRevision({
        env: { T3CODE_FORK_REVISION: "abcdef0" },
        repoRoot: "/tmp/does-not-exist",
      }),
    ).toBe("abcdef0");
  });
});
