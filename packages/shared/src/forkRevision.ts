const FORK_REVISION_PATTERN = /^[0-9a-f]{7,40}$/i;

export const FORK_REPO_URL = "https://github.com/dabdoue/t3code.git";
export const FORK_REPO_SLUG = "dabdoue/t3code";
export const FORK_UPDATE_SCRIPT = "scripts/fork-update-server.sh";
export const FORK_UPDATE_SCRIPT_FALLBACK = "scripts/fork-install-linux-appimage.sh";
export const FORK_UPDATE_SCRIPT_MARKER = "resolve_appimage";
export const FORK_UPDATE_SCRIPT_REFS = [
  "feat/claude-code-custom-effort-context",
  "feat/fork-remote-appimage-sync",
  "main",
] as const;

function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function uniqueNonEmpty(values: ReadonlyArray<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
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

export function isForkUpdateScriptSource(contents: string): boolean {
  return contents.includes(FORK_UPDATE_SCRIPT_MARKER);
}

/**
 * Refs that may contain the updater. The SHA being installed often predates
 * the script, so look at the client's own revision and known branches first.
 */
export function forkUpdateScriptLookupRefs(sha: string, scriptRevision?: string): string[] {
  return uniqueNonEmpty([scriptRevision, ...FORK_UPDATE_SCRIPT_REFS, sha]);
}

export interface ForkServerUpdateCommandOptions {
  readonly restart?: boolean;
  readonly scriptRevision?: string;
}

/**
 * Download the updater independently of the target SHA, then install that SHA.
 * Works from any directory. The script finds the running install itself.
 */
export function forkServerUpdateCommand(
  sha: string,
  options: ForkServerUpdateCommandOptions = {},
): string | null {
  const normalized = normalizeForkRevision(sha);
  if (normalized === null) {
    return null;
  }
  const quotedSha = posixSingleQuote(normalized);
  const restartArgs = options.restart === false ? " --no-restart" : "";
  const refs = forkUpdateScriptLookupRefs(normalized, options.scriptRevision);
  const quotedRefs = refs.map((ref) => posixSingleQuote(ref)).join(" ");
  const rawDefault = `https://raw.githubusercontent.com/${FORK_REPO_SLUG}`;
  return [
    "set -euo pipefail",
    `SHA=${quotedSha}`,
    `REPO_URL="\${T3CODE_FORK_REPO_URL:-${FORK_REPO_URL}}"`,
    `RAW_BASE="\${T3CODE_FORK_SCRIPT_BASE_URL:-${rawDefault}}"`,
    "tmpdir=$(mktemp -d)",
    `trap 'rm -rf "$tmpdir"' EXIT`,
    'script="$tmpdir/fork-update-server.sh"',
    "is_updater() {",
    `  grep -q ${posixSingleQuote(FORK_UPDATE_SCRIPT_MARKER)} "$1"`,
    "}",
    'if [[ -n "${T3CODE_FORK_UPDATE_SCRIPT:-}" && -f "$T3CODE_FORK_UPDATE_SCRIPT" ]] && is_updater "$T3CODE_FORK_UPDATE_SCRIPT"; then',
    '  cp "$T3CODE_FORK_UPDATE_SCRIPT" "$script"',
    "fi",
    "try_curl() {",
    '  local url="$1"',
    "  if ! command -v curl >/dev/null 2>&1; then",
    "    return 1",
    "  fi",
    '  if curl -fsSL --max-time 30 "$url" -o "$script.tmp" 2>/dev/null && is_updater "$script.tmp"; then',
    '    mv "$script.tmp" "$script"',
    "    return 0",
    "  fi",
    '  rm -f "$script.tmp"',
    "  return 1",
    "}",
    'if [[ ! -f "$script" ]]; then',
    `  for ref in ${quotedRefs}; do`,
    `    if try_curl "$RAW_BASE/$ref/${FORK_UPDATE_SCRIPT}"; then`,
    "      break",
    "    fi",
    "  done",
    "fi",
    'if [[ ! -f "$script" ]]; then',
    '  CLONE="${T3CODE_FORK_CLONE:-$HOME/src/t3code-fork}"',
    '  mkdir -p "$(dirname "$CLONE")"',
    '  if [[ ! -d "$CLONE/.git" ]]; then git clone "$REPO_URL" "$CLONE"; fi',
    `  if git -C "$CLONE" show "HEAD:${FORK_UPDATE_SCRIPT}" > "$script.tmp" 2>/dev/null && is_updater "$script.tmp"; then`,
    '    mv "$script.tmp" "$script"',
    "  fi",
    `  for ref in ${quotedRefs}; do`,
    '    if [[ -f "$script" ]]; then',
    "      break",
    "    fi",
    `    if git -C "$CLONE" fetch --force "$REPO_URL" "$ref" >/dev/null 2>&1 \\`,
    `      && git -C "$CLONE" show "FETCH_HEAD:${FORK_UPDATE_SCRIPT}" > "$script.tmp" 2>/dev/null \\`,
    '      && is_updater "$script.tmp"; then',
    '      mv "$script.tmp" "$script"',
    "      break",
    "    fi",
    '    rm -f "$script.tmp"',
    "  done",
    "fi",
    'if [[ ! -f "$script" ]]; then',
    '  echo "could not download scripts/fork-update-server.sh. The SHA to install does not need to contain that script. Push a revision that does, or set T3CODE_FORK_UPDATE_SCRIPT to a local copy." >&2',
    "  exit 1",
    "fi",
    'chmod u+x "$script"',
    `exec bash "$script" "$SHA"${restartArgs}`,
  ].join("\n");
}

/** Paste-anywhere command: fetch the updater, then update this machine's server. */
export function manualForkServerUpdateCommand(
  sha: string,
  options: ForkServerUpdateCommandOptions = {},
): string | null {
  const body = forkServerUpdateCommand(sha, options);
  return body === null ? null : `bash -lc ${posixSingleQuote(body)}`;
}
