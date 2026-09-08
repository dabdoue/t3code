const FORK_REVISION_PATTERN = /^[0-9a-f]{7,40}$/i;

export const FORK_REPO_URL = "https://github.com/dabdoue/t3code.git";
export const FORK_UPDATE_SCRIPT = "scripts/fork-update-server.sh";
export const FORK_UPDATE_SCRIPT_FALLBACK = "scripts/fork-install-linux-appimage.sh";

function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function normalizeForkRevision(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (!FORK_REVISION_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function readForkRevisionFromEnv(
  env: Record<string, string | undefined> = {},
): string | null {
  return normalizeForkRevision(env.T3CODE_FORK_REVISION);
}

export function forkRevisionsMatch(left: string, right: string): boolean {
  const overlap = Math.min(left.length, right.length);
  return overlap >= 7 && left.slice(0, overlap) === right.slice(0, overlap);
}

/** True when this client is a fork build and the connected server is not the same SHA. */
export function forkRevisionsDiffer(
  local: string | null | undefined,
  remote: string | null | undefined,
): boolean {
  const normalizedLocal = normalizeForkRevision(local);
  if (normalizedLocal === null) {
    return false;
  }
  const normalizedRemote = normalizeForkRevision(remote);
  if (normalizedRemote === null) {
    return true;
  }
  return !forkRevisionsMatch(normalizedLocal, normalizedRemote);
}

/**
 * Checkout this SHA from GitHub and run the fork server-update script.
 * Works from any directory. The script finds the running install itself.
 */
export function forkServerUpdateCommand(
  sha: string,
  options: { readonly restart?: boolean } = {},
): string | null {
  const normalized = normalizeForkRevision(sha);
  if (normalized === null) {
    return null;
  }
  const quotedSha = posixSingleQuote(normalized);
  const restartArgs = options.restart === false ? " --no-restart" : "";
  return [
    "set -euo pipefail",
    `SHA=${quotedSha}`,
    'CLONE="${T3CODE_FORK_CLONE:-$HOME/src/t3code-fork}"',
    `REPO_URL="\${T3CODE_FORK_REPO_URL:-${FORK_REPO_URL}}"`,
    'mkdir -p "$(dirname "$CLONE")"',
    'if [[ ! -d "$CLONE/.git" ]]; then git clone "$REPO_URL" "$CLONE"; fi',
    'git -C "$CLONE" fetch --force "$REPO_URL" "$SHA"',
    'git -C "$CLONE" checkout --force --detach FETCH_HEAD',
    `SCRIPT="$CLONE/${FORK_UPDATE_SCRIPT}"`,
    `if [[ ! -f "$SCRIPT" ]]; then SCRIPT="$CLONE/${FORK_UPDATE_SCRIPT_FALLBACK}"; fi`,
    `exec bash "$SCRIPT" "$SHA"${restartArgs}`,
  ].join("\n");
}

/** Paste-anywhere command: clone the SHA, then update this machine's server. */
export function manualForkServerUpdateCommand(sha: string): string | null {
  const body = forkServerUpdateCommand(sha);
  return body === null ? null : `bash -lc ${posixSingleQuote(body)}`;
}
