#!/usr/bin/env bash
set -euo pipefail

# Fetch a SHA of dabdoue/t3code and update the T3 server already running on
# this machine. Linux only. Works from any directory. Never writes
# ~/.t3/userdata. Never pkill.
#
# Finds the install automatically: $T3CODE_FORK_APPIMAGE, then $APPIMAGE
# (set when T3 itself is running this), then a T3 Code desktop entry, then a
# running AppImage process. Optional overrides still work.

usage() {
  echo "usage: $0 <sha> [--no-restart|--restart-only]" >&2
  echo "optional env: T3CODE_FORK_APPIMAGE (absolute AppImage path, if auto-detect fails)" >&2
  echo "              T3CODE_FORK_CLONE (default: \$HOME/src/t3code-fork)" >&2
  echo "              T3CODE_FORK_REPO_URL (default: https://github.com/dabdoue/t3code.git)" >&2
  echo "              T3CODE_FORK_DESKTOP_ENTRY (absolute .desktop path)" >&2
  exit 2
}

sha=""
restart=1
restart_only=0
while (($#)); do
  case "$1" in
    --no-restart)
      restart=0
      shift
      ;;
    --restart-only)
      restart_only=1
      restart=1
      shift
      ;;
    -h | --help)
      usage
      ;;
    -*)
      usage
      ;;
    *)
      if [[ -n "$sha" ]]; then
        usage
      fi
      sha="$1"
      shift
      ;;
  esac
done

if [[ "$restart_only" -eq 0 ]]; then
  [[ -n "$sha" ]] || usage
  if [[ ! "$sha" =~ ^[0-9A-Fa-f]{7,40}$ ]]; then
    echo "invalid git sha: $sha" >&2
    exit 1
  fi
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Linux server updates only" >&2
  exit 1
fi

refuse_userdata() {
  local path="$1"
  local label="$2"
  case "$path" in
    */.t3/userdata | */.t3/userdata/*)
      echo "refusing to use $label under ~/.t3/userdata" >&2
      exit 1
      ;;
  esac
}

is_t3_appimage_name() {
  local base="$1"
  [[ "$base" == T3-Code*.AppImage || "$base" == T3*Code*.AppImage || "$base" == *t3-code*.AppImage || "$base" == *t3code*.AppImage ]]
}

extract_appimage_from_exec() {
  local line="$1"
  line="${line#Exec=}"
  local match
  if [[ "$line" =~ \"([^\"]+\.AppImage)\" ]]; then
    match="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ (^|[[:space:]])([^[:space:]]+\.AppImage) ]]; then
    match="${BASH_REMATCH[2]}"
  else
    return 1
  fi
  printf '%s\n' "$match"
}

desktop_entry_is_t3() {
  local file="$1"
  grep -qiE '^Name=.*T3 Code' "$file" || grep -qiE '^Name=.*T3Code' "$file"
}

resolve_from_desktop_entries() {
  local candidate exec_line path
  for candidate in "$HOME/.local/share/applications/"*.desktop; do
    [[ -f "$candidate" ]] || continue
    exec_line="$(grep -E '^Exec=' "$candidate" | head -n1 || true)"
    [[ -n "$exec_line" ]] || continue
    path="$(extract_appimage_from_exec "$exec_line" || true)"
    [[ -n "$path" ]] || continue
    if [[ "$path" != /* ]]; then
      continue
    fi
    if desktop_entry_is_t3 "$candidate" || is_t3_appimage_name "$(basename "$path")"; then
      printf '%s\n' "$path"
      return 0
    fi
  done
  return 1
}

resolve_from_running_processes() {
  local envfile value base resolved
  for envfile in /proc/[0-9]*/environ; do
    [[ -r "$envfile" ]] || continue
    value="$(tr '\0' '\n' <"$envfile" 2>/dev/null | sed -n 's/^APPIMAGE=//p' | head -n1 || true)"
    [[ -n "$value" && "$value" == /* ]] || continue
    base="$(basename "$value")"
    if is_t3_appimage_name "$base"; then
      resolved="$(readlink -f "$value" 2>/dev/null || printf '%s\n' "$value")"
      printf '%s\n' "$resolved"
      return 0
    fi
  done
  return 1
}

resolve_appimage() {
  local configured="${T3CODE_FORK_APPIMAGE:-${APPIMAGE:-}}"
  local found=""
  if [[ -n "$configured" ]]; then
    found="$configured"
  elif found="$(resolve_from_desktop_entries)"; then
    :
  elif found="$(resolve_from_running_processes)"; then
    :
  else
    echo "could not find the T3 Code AppImage on this machine; set T3CODE_FORK_APPIMAGE if it lives somewhere unusual" >&2
    exit 1
  fi
  if [[ "$found" != /* ]]; then
    echo "AppImage path must be absolute: $found" >&2
    exit 1
  fi
  refuse_userdata "$found" "the AppImage"
  printf '%s\n' "$found"
}

appimage="$(resolve_appimage)"

clone="${T3CODE_FORK_CLONE:-$HOME/src/t3code-fork}"
if [[ "$clone" != /* ]]; then
  echo "T3CODE_FORK_CLONE must be an absolute path" >&2
  exit 1
fi
refuse_userdata "$clone" "the clone"

repo_url="${T3CODE_FORK_REPO_URL:-https://github.com/dabdoue/t3code.git}"
desktop_entry="${T3CODE_FORK_DESKTOP_ENTRY:-}"

if [[ "$restart_only" -eq 0 ]]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required" >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required on this machine" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$clone")"
  if [[ ! -d "$clone/.git" ]]; then
    git clone "$repo_url" "$clone"
  fi

  git -C "$clone" fetch --force "$repo_url" "$sha"
  git -C "$clone" checkout --force --detach FETCH_HEAD
  git -C "$clone" rev-parse --verify --quiet HEAD >/dev/null

  if [[ ! -f "$clone/scripts/build-desktop-artifact.ts" ]]; then
    echo "not a T3 Code checkout: $clone" >&2
    exit 1
  fi

  if [[ ! -x "$clone/node_modules/.bin/vp" ]]; then
    if command -v vp >/dev/null 2>&1; then
      (cd "$clone" && vp i)
    else
      echo "missing Vite+ (vp); install it, then run: (cd $clone && vp i)" >&2
      exit 1
    fi
  fi

  helper_dir=""
  cleanup() {
    [[ -z "$helper_dir" ]] || rm -rf "$helper_dir"
  }
  trap cleanup EXIT

  build_path="$clone/node_modules/.bin:$PATH"
  if ! command -v magick >/dev/null 2>&1 && ! command -v convert >/dev/null 2>&1; then
    command -v ffmpeg >/dev/null 2>&1 || {
      echo "ImageMagick is unavailable and ffmpeg fallback was not found" >&2
      exit 1
    }
    helper_dir="$(mktemp -d -t t3code-appimage-tools.XXXXXX)"
    cat >"$helper_dir/magick" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 4 || "$2" != "-resize" || ! "$3" =~ ^[0-9]+x[0-9]+$ ]]; then
  echo "unsupported magick compatibility invocation" >&2
  exit 2
fi
width="${3%x*}"
height="${3#*x}"
exec ffmpeg -loglevel error -y -i "$1" -vf "scale=${width}:${height}:flags=lanczos" "$4"
EOF
    chmod 755 "$helper_dir/magick"
    build_path="$helper_dir:$build_path"
  fi

  (
    cd "$clone"
    PATH="$build_path" T3CODE_FORK_REVISION="$(git rev-parse HEAD)" \
      node scripts/build-desktop-artifact.ts \
      --platform linux --target AppImage --arch x64
  )

  artifact="$(find "$clone/release" -maxdepth 1 -type f -name 'T3-Code-*-x86_64.AppImage' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
  [[ -n "$artifact" && -x "$artifact" ]] || {
    echo "build did not produce an executable AppImage" >&2
    exit 1
  }
  file "$artifact"
  sha256sum "$artifact"

  installed_dir="$(dirname "$appimage")"
  installed_name="$(basename "$appimage")"
  mkdir -p "$installed_dir"
  if [[ -e "$appimage" ]]; then
    backup="/tmp/${installed_name}.previous.$(date +%Y%m%d-%H%M%S)"
    cp -p "$appimage" "$backup"
    echo "backup=$backup"
  fi
  staged="$appimage.new"
  install -m 755 "$artifact" "$staged"
  mv -f "$staged" "$appimage"
  cmp -s "$artifact" "$appimage"
  echo "installed=$appimage"
  sha256sum "$appimage"
  echo "artifact=$artifact"
fi

resolve_desktop_entry() {
  if [[ -n "$desktop_entry" ]]; then
    printf '%s\n' "$desktop_entry"
    return
  fi
  local candidate
  for candidate in "$HOME/.local/share/applications/"*.desktop; do
    [[ -f "$candidate" ]] || continue
    if grep -Fq -- "$appimage" "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  for candidate in "$HOME/.local/share/applications/"*.desktop; do
    [[ -f "$candidate" ]] || continue
    if desktop_entry_is_t3 "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
}

scope_runs_appimage() {
  local pid="$1"
  local envfile="/proc/$pid/environ"
  local value arg resolved
  resolved="$(readlink -f "$appimage" 2>/dev/null || printf '%s\n' "$appimage")"
  if [[ -r "$envfile" ]]; then
    value="$(tr '\0' '\n' <"$envfile" | sed -n 's/^APPIMAGE=//p' | head -n1 || true)"
    if [[ -n "$value" && "$(readlink -f "$value" 2>/dev/null || echo "$value")" == "$resolved" ]]; then
      return 0
    fi
  fi
  if [[ -r "/proc/$pid/cmdline" ]]; then
    while IFS= read -r arg; do
      [[ -n "$arg" ]] || continue
      if [[ "$(readlink -f "$arg" 2>/dev/null || true)" == "$resolved" ]]; then
        return 0
      fi
    done < <(tr '\0' '\n' <"/proc/$pid/cmdline")
  fi
  return 1
}

load_graphical_environment() {
  local line
  while IFS= read -r line; do
    case "$line" in
      DISPLAY=* | WAYLAND_DISPLAY=* | XAUTHORITY=* | DBUS_SESSION_BUS_ADDRESS=* | XDG_RUNTIME_DIR=*)
        export "$line"
        ;;
    esac
  done < <(systemctl --user show-environment 2>/dev/null || true)
}

if [[ "$restart" -eq 0 ]]; then
  exit 0
fi

appimage="$(readlink -f "$appimage")"
matching_scopes=()
unit=""
pid=""
while read -r unit _; do
  [[ "$unit" == *.scope ]] || continue
  pid="$(systemctl --user show -p MainPID --value "$unit" 2>/dev/null || true)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
  if scope_runs_appimage "$pid"; then
    matching_scopes+=("$unit")
  fi
done < <(systemctl --user list-units --type=scope --state=running --no-legend --plain)

for unit in "${matching_scopes[@]}"; do
  echo "stopping=$unit"
  systemctl --user stop "$unit"
done

load_graphical_environment
entry="$(resolve_desktop_entry || true)"
if [[ -z "$entry" || ! -f "$entry" ]]; then
  echo "updated the server but could not find a desktop entry that launches it; start it from your existing launcher" >&2
  exit 1
fi
echo "desktop-entry=$entry"

if command -v gtk-launch >/dev/null 2>&1; then
  gtk-launch "$(basename "$entry" .desktop)"
elif command -v gio >/dev/null 2>&1; then
  gio launch "$entry"
else
  echo "updated the server but could not relaunch $entry (install gtk-launch or gio)" >&2
  exit 1
fi
