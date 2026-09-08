// @effect-diagnostics nodeBuiltinImport:off - Build-time SHA stamping runs before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export function resolveForkRevision({
  env = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly env?: NodeJS.ProcessEnv;
  readonly repoRoot?: string;
} = {}): string | undefined {
  const fromEnv = env.T3CODE_FORK_REVISION?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const sha = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}
