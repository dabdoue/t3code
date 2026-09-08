#!/usr/bin/env bash
set -euo pipefail

# Fetch a SHA of dabdoue/t3code and update the T3 install already running on
# this machine. Linux only. Works from any directory. Never writes
# ~/.t3/userdata. Never pkill.
#
# An AppImage is only required when this machine actually runs the desktop
# app. Headless hosts running `t3 service` / `t3 serve` update that server
# the same way official `t3 service update` does: clone, build the t3 CLI,
# pin it under $T3CODE_HOME/runtime/versions, then restart t3code.service.
# The launcher stays in place. No AppImage is installed or required.

usage() {
  echo "usage: $0 <sha> [--no-restart|--restart-only]" >&2
  echo "optional env: T3CODE_FORK_APPIMAGE (absolute AppImage path, if auto-detect fails)" >&2
  echo "              T3CODE_HOME (boot-service data dir; default: unit file or \$HOME/.t3)" >&2
  echo "              T3CODE_FORK_CLONE (default: \$HOME/src/t3code-fork)" >&2
  echo "              T3CODE_FORK_REPO_URL (default: https://github.com/dabdoue/t3code.git)" >&2
  echo "              T3CODE_FORK_DESKTOP_ENTRY (absolute .desktop path)" >&2
  exit 2
}

sha=""
restart=1
restart_only=0
print_appimage=0
print_install=0
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
    --print-appimage)
      print_appimage=1
      shift
      ;;
    --print-install)
      print_install=1
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

if [[ "$restart_only" -eq 0 && "$print_appimage" -eq 0 && "$print_install" -eq 0 ]]; then
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

BOOT_SERVICE_UNIT="t3code.service"
SERVICE_LAUNCHER_PROTOCOL=2
STABLE_UPDATER="/tmp/t3-fork-update-server.sh"

persist_updater() {
  local source="${BASH_SOURCE[0]:-}"
  if [[ -n "$source" && -f "$source" && "$source" != "$STABLE_UPDATER" ]]; then
    cp "$source" "$STABLE_UPDATER"
    chmod u+x "$STABLE_UPDATER" 2>/dev/null || true
    echo "updater=$STABLE_UPDATER"
  fi
}

prepend_path_if_dir() {
  if [[ -d "$1" ]]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

# Non-interactive SSH has no nvm/fnm/.bashrc PATH. Same search as official
# remote `t3` launches: well-known bins, then version managers.
ensure_node_path() {
  if command -v node >/dev/null 2>&1; then
    return 0
  fi
  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"
  if command -v node >/dev/null 2>&1; then
    return 0
  fi

  if [[ -z "${VOLTA_HOME:-}" ]]; then
    VOLTA_HOME="$HOME/.volta"
  fi
  export VOLTA_HOME
  prepend_path_if_dir "$VOLTA_HOME/bin"

  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [[ ! -x "$HOME/.asdf/shims/node" && -s "$HOME/.asdf/asdf.sh" ]]; then
    # shellcheck disable=SC1090
    . "$HOME/.asdf/asdf.sh"
  fi

  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    eval "$(mise activate bash)" >/dev/null 2>&1 || true
  fi

  if [[ -z "${FNM_DIR:-}" ]]; then
    FNM_DIR="$HOME/.local/share/fnm"
  fi
  export FNM_DIR
  prepend_path_if_dir "$FNM_DIR"
  prepend_path_if_dir "$HOME/.fnm"
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)" >/dev/null 2>&1 || true
  fi

  if [[ -z "${NVM_DIR:-}" ]]; then
    NVM_DIR="$HOME/.nvm"
  fi
  export NVM_DIR
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    local nvm_node=""
    nvm_node="$(
      set +euo pipefail
      # shellcheck disable=SC1090
      . "$NVM_DIR/nvm.sh"
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
      command -v node
    )" || true
    if [[ -n "$nvm_node" && -x "$nvm_node" ]]; then
      PATH="$(dirname "$nvm_node"):$PATH"
      export PATH
    fi
  fi
  if ! command -v node >/dev/null 2>&1 && [[ -d "$NVM_DIR/versions/node" ]]; then
    local bin
    for bin in "$NVM_DIR"/versions/node/*/bin; do
      if [[ -x "$bin/node" ]]; then
        PATH="$bin:$PATH"
        export PATH
      fi
    done
  fi
  command -v node >/dev/null 2>&1
}

# Official `t3 service update` only needs npm. Fork builds need Vite+ (`vp`).
# Non-interactive SSH often has Node/npm (after ensure_node_path) but no global
# `vp`. Install it under $T3CODE_HOME/runtime/fork-tools, not userdata.
ensure_vp() {
  if command -v vp >/dev/null 2>&1; then
    return 0
  fi
  local node_bin=""
  node_bin="$(command -v node 2>/dev/null || true)"
  if [[ -n "$node_bin" ]]; then
    prepend_path_if_dir "$(dirname "$node_bin")"
  fi
  prepend_path_if_dir "$HOME/.local/bin"
  if [[ -n "${clone:-}" ]]; then
    prepend_path_if_dir "$clone/node_modules/.bin"
  fi
  if command -v vp >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to install Vite+ (vp) on this machine" >&2
    return 1
  fi

  local tools=""
  tools="$(resolve_t3code_home)/runtime/fork-tools"
  refuse_userdata "$tools" "fork-tools"
  mkdir -p "$tools"
  prepend_path_if_dir "$tools/bin"
  prepend_path_if_dir "$tools/node_modules/.bin"
  if command -v vp >/dev/null 2>&1; then
    return 0
  fi

  echo "installing Vite+ (vp) with npm into $tools"
  npm install --prefix "$tools" --no-fund --no-audit vite-plus
  prepend_path_if_dir "$tools/bin"
  prepend_path_if_dir "$tools/node_modules/.bin"
  if command -v vp >/dev/null 2>&1; then
    return 0
  fi
  if command -v npx >/dev/null 2>&1; then
    mkdir -p "$tools/bin"
    cat >"$tools/bin/vp" <<'EOF'
#!/bin/bash
exec npx --yes vite-plus "$@"
EOF
    chmod +x "$tools/bin/vp"
    prepend_path_if_dir "$tools/bin"
  fi
  command -v vp >/dev/null 2>&1
}

boot_service_unit_file() {
  printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${BOOT_SERVICE_UNIT}"
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

desktop_entry_dirs() {
  printf '%s\n' \
    "$HOME/.local/share/applications" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/applications" \
    "/usr/share/applications"
}

resolve_from_desktop_entries() {
  local dir candidate exec_line path
  while IFS= read -r dir; do
    [[ -d "$dir" ]] || continue
    for candidate in "$dir"/*.desktop; do
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
  done < <(desktop_entry_dirs)
  return 1
}

# Same-uid processes can still EACCES /proc/PID/environ when dumpable=0.
# Never open those files with a shell redirection: `set -e` aborts the updater.
read_proc_strings() {
  dd if="$1" bs=65536 count=16 2>/dev/null | tr '\0' '\n' || true
}

maybe_appimage_path() {
  local path="$1"
  local base resolved
  [[ "$path" == /*.AppImage || "$path" == /*.appimage ]] || return 1
  base="$(basename "$path")"
  is_t3_appimage_name "$base" || return 1
  resolved="$(readlink -f "$path" 2>/dev/null || printf '%s\n' "$path")"
  printf '%s\n' "$resolved"
}

resolve_from_well_known_paths() {
  local dir path newest="" newest_mtime=0 mtime
  for dir in "$HOME/Applications" "$HOME/.local/bin" "$HOME/bin"; do
    [[ -d "$dir" ]] || continue
    for path in "$dir"/*.AppImage "$dir"/*.appimage; do
      [[ -f "$path" ]] || continue
      if maybe_appimage_path "$path" >/dev/null; then
        mtime="$(stat -c %Y "$path" 2>/dev/null || echo 0)"
        if [[ -z "$newest" || "$mtime" -gt "$newest_mtime" ]]; then
          newest="$path"
          newest_mtime="$mtime"
        fi
      fi
    done
  done
  [[ -n "$newest" ]] || return 1
  maybe_appimage_path "$newest"
}

scan_proc() {
  [[ "${T3CODE_FORK_SCAN_PROC:-1}" != "0" ]]
}

resolve_from_running_appimage() {
  local cmdfile pid arg value
  scan_proc || return 1
  for cmdfile in /proc/[0-9]*/cmdline; do
    [[ -e "$cmdfile" ]] || continue
    pid="${cmdfile#/proc/}"
    pid="${pid%/cmdline}"
    while IFS= read -r arg; do
      [[ -n "$arg" ]] || continue
      if maybe_appimage_path "$arg" >/dev/null; then
        maybe_appimage_path "$arg"
        return 0
      fi
    done < <(read_proc_strings "$cmdfile")
    value="$(read_proc_strings "/proc/$pid/environ" | sed -n 's/^APPIMAGE=//p' | head -n1 || true)"
    if [[ -n "$value" ]] && maybe_appimage_path "$value" >/dev/null; then
      maybe_appimage_path "$value"
      return 0
    fi
  done
  return 1
}

is_t3_server_arg() {
  local arg="$1"
  case "$arg" in
    */t3/dist/bin.mjs | */apps/server/src/bin.ts | */apps/server/dist/bin.mjs | */.bin/t3 | */bin/t3)
      return 0
      ;;
    t3 | t3@*)
      return 0
      ;;
  esac
  return 1
}

resolve_from_boot_service() {
  local unit_file
  unit_file="$(boot_service_unit_file)"
  [[ -f "$unit_file" ]] || return 1
  printf '%s\n' "$unit_file"
}

resolve_from_running_server() {
  local cmdfile arg
  scan_proc || return 1
  for cmdfile in /proc/[0-9]*/cmdline; do
    [[ -e "$cmdfile" ]] || continue
    while IFS= read -r arg; do
      [[ -n "$arg" ]] || continue
      if is_t3_server_arg "$arg"; then
        printf '%s\n' "$arg"
        return 0
      fi
    done < <(read_proc_strings "$cmdfile")
  done
  return 1
}

# Marker name is part of the updater identity (clients grep for it).
resolve_appimage() {
  local configured="${T3CODE_FORK_APPIMAGE:-${APPIMAGE:-}}"
  local found=""
  if [[ -n "$configured" ]]; then
    found="$configured"
  elif found="$(resolve_from_desktop_entries)"; then
    :
  elif found="$(resolve_from_well_known_paths)"; then
    :
  elif found="$(resolve_from_running_appimage)"; then
    :
  else
    return 1
  fi
  if [[ "$found" != /* ]]; then
    echo "AppImage path must be absolute: $found" >&2
    exit 1
  fi
  refuse_userdata "$found" "the AppImage"
  printf '%s\n' "$found"
}

install_kind=""
appimage=""
server_unit_file=""
server_entry=""
t3code_home=""
fork_runtime_dir=""
fork_runtime_version_value=""

read_unit_t3code_home() {
  local unit_file="$1"
  local line value
  [[ -f "$unit_file" ]] || return 1
  while IFS= read -r line; do
    case "$line" in
      Environment=T3CODE_HOME=*)
        value="${line#Environment=T3CODE_HOME=}"
        value="${value#\"}"
        value="${value%\"}"
        if [[ "$value" == /* ]]; then
          printf '%s\n' "$value"
          return 0
        fi
        ;;
    esac
  done <"$unit_file"
  return 1
}

resolve_t3code_home() {
  local home=""
  if [[ -n "${T3CODE_HOME:-}" && "${T3CODE_HOME}" == /* ]]; then
    home="$T3CODE_HOME"
  elif home="$(read_unit_t3code_home "${server_unit_file:-$(boot_service_unit_file)}")"; then
    :
  else
    home="$HOME/.t3"
  fi
  refuse_userdata "$home" "T3CODE_HOME"
  printf '%s\n' "$home"
}

fork_runtime_version() {
  local pkg="$clone/apps/server/package.json"
  local pkg_version short
  [[ -f "$pkg" ]] || {
    echo "missing $pkg" >&2
    exit 1
  }
  pkg_version="$(node -p 'require(process.argv[1]).version' "$pkg")"
  short="$(printf '%s' "${sha:-$(git -C "$clone" rev-parse HEAD)}" | tr '[:upper:]' '[:lower:]')"
  short="${short:0:12}"
  printf '%s\n' "${pkg_version}+fork.${short}"
}

stage_fork_runtime() {
  local version t3_home staging dest
  version="$(fork_runtime_version)"
  t3_home="$(resolve_t3code_home)"
  server_entry="$clone/apps/server/dist/bin.mjs"
  [[ -f "$server_entry" && -f "$clone/apps/server/dist/service-launcher.mjs" ]] || {
    echo "server build did not produce dist/bin.mjs and dist/service-launcher.mjs" >&2
    exit 1
  }
  mkdir -p "$t3_home/runtime/versions"
  staging="$(mktemp -d "$t3_home/runtime/versions/.staging-fork-XXXXXX")"
  mkdir -p "$staging/node_modules/t3"
  cp -a "$clone/apps/server/dist" "$staging/node_modules/t3/dist"
  node -e '
    const fs = require("node:fs");
    const src = process.argv[1];
    const dest = process.argv[2];
    const version = process.argv[3];
    const pkg = JSON.parse(fs.readFileSync(src, "utf8"));
    fs.writeFileSync(
      dest,
      `${JSON.stringify(
        {
          name: pkg.name,
          version,
          type: pkg.type || "module",
          bin: pkg.bin,
        },
        null,
        2,
      )}\n`,
    );
  ' "$clone/apps/server/package.json" "$staging/node_modules/t3/package.json" "$version"
  printf '%s\n' "$version" >"$staging/.install-complete"
  dest="$t3_home/runtime/versions/$version"
  rm -rf "$dest"
  mv "$staging" "$dest"
  fork_runtime_dir="$dest"
  fork_runtime_version_value="$version"
  t3code_home="$t3_home"
  echo "kind=server"
  echo "version=$version"
  echo "runtime=$dest"
  echo "entry=$dest/node_modules/t3/dist/bin.mjs"
}

commit_boot_service() {
  local t3_home version launcher_src launcher_dest state_path unit_file dropin
  t3_home="${t3code_home:-$(resolve_t3code_home)}"
  version="${fork_runtime_version_value:-$(fork_runtime_version)}"
  fork_runtime_dir="${fork_runtime_dir:-$t3_home/runtime/versions/$version}"
  launcher_src="$fork_runtime_dir/node_modules/t3/dist/service-launcher.mjs"
  launcher_dest="$t3_home/runtime/service-launcher.mjs"
  state_path="$t3_home/runtime/service-state.json"
  unit_file="${server_unit_file:-$(boot_service_unit_file)}"
  [[ -f "$launcher_src" ]] || {
    echo "missing $launcher_src; run the updater without --restart-only first" >&2
    exit 1
  }
  [[ -f "$unit_file" ]] || return 1

  dropin="$unit_file.d/fork.conf"
  if [[ -f "$dropin" ]]; then
    rm -f "$dropin"
    echo "removed-dropin=$dropin"
  fi

  echo "stopping=$BOOT_SERVICE_UNIT"
  systemctl --user stop "$BOOT_SERVICE_UNIT" || true
  mkdir -p "$(dirname "$launcher_dest")"
  cp -a "$launcher_src" "$launcher_dest"
  cat >"$state_path" <<EOF
{
  "protocol": $SERVICE_LAUNCHER_PROTOCOL,
  "activeVersion": "$version"
}
EOF
  echo "state=$state_path"
  echo "launcher=$launcher_dest"
  echo "restarting=$BOOT_SERVICE_UNIT"
  systemctl --user daemon-reload
  systemctl --user restart "$BOOT_SERVICE_UNIT"
}

detect_install() {
  local found=""
  if found="$(resolve_appimage)"; then
    install_kind="appimage"
    appimage="$found"
    return
  fi
  if found="$(resolve_from_boot_service)"; then
    install_kind="server"
    server_unit_file="$found"
    return
  fi
  if found="$(resolve_from_running_server)"; then
    install_kind="server"
    return
  fi
  install_kind="none"
}

detect_install

if [[ "$print_install" -eq 1 ]]; then
  printf 'kind=%s\n' "$install_kind"
  if [[ "$install_kind" == "appimage" ]]; then
    printf 'path=%s\n' "$appimage"
  elif [[ "$install_kind" == "server" ]]; then
    printf 'unit=%s\n' "$BOOT_SERVICE_UNIT"
    if [[ -n "$server_unit_file" ]]; then
      printf 'unit-file=%s\n' "$server_unit_file"
    fi
  fi
  exit 0
fi

if [[ "$print_appimage" -eq 1 ]]; then
  if [[ "$install_kind" != "appimage" ]]; then
    echo "no T3 Code AppImage on this machine; a t3 server does not need one" >&2
    exit 1
  fi
  printf '%s\n' "$appimage"
  exit 0
fi

if [[ "$install_kind" == "none" ]]; then
  echo "could not find a T3 Code AppImage or T3 server on this machine" >&2
  echo "desktop hosts need the AppImage (or T3CODE_FORK_APPIMAGE); server hosts need t3code.service or a running t3 process" >&2
  exit 1
fi

persist_updater

clone="${T3CODE_FORK_CLONE:-$HOME/src/t3code-fork}"
if [[ "$clone" != /* ]]; then
  echo "T3CODE_FORK_CLONE must be an absolute path" >&2
  exit 1
fi
refuse_userdata "$clone" "the clone"

repo_url="${T3CODE_FORK_REPO_URL:-https://github.com/dabdoue/t3code.git}"
desktop_entry="${T3CODE_FORK_DESKTOP_ENTRY:-}"

if [[ "$restart_only" -eq 0 ]]; then
  ensure_node_path || true
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required on this machine. Install Node or a version manager (nvm, fnm, mise) that works in non-interactive SSH shells." >&2
    exit 1
  fi

  if [[ "${T3CODE_FORK_TEST_ENSURE_VP:-}" == "1" ]]; then
    ensure_vp || {
      echo "Vite+ (vp) is required to build this fork. Node/npm could not install it." >&2
      exit 1
    }
    echo "vp=$(command -v vp)"
    exit 0
  fi

  if [[ "${T3CODE_FORK_SKIP_FETCH:-}" != "1" ]]; then
    if ! command -v git >/dev/null 2>&1; then
      echo "git is required" >&2
      exit 1
    fi

    mkdir -p "$(dirname "$clone")"
    if [[ ! -d "$clone/.git" ]]; then
      git clone "$repo_url" "$clone"
    fi

    git -C "$clone" fetch --force "$repo_url" "$sha"
    git -C "$clone" checkout --force --detach FETCH_HEAD
    git -C "$clone" rev-parse --verify --quiet HEAD >/dev/null
  elif [[ ! -d "$clone" ]]; then
    echo "T3CODE_FORK_SKIP_FETCH requires an existing clone at $clone" >&2
    exit 1
  fi

  # GitHub clones have no `.env`. Copy the public T3 Connect identifiers from
  # `.env.example` so remote builds keep Clerk/relay, matching official builds.
  if [[ ! -f "$clone/.env" && -f "$clone/.env.example" ]]; then
    cp "$clone/.env.example" "$clone/.env"
  fi

  if [[ "$install_kind" == "appimage" && ! -f "$clone/scripts/build-desktop-artifact.ts" ]]; then
    echo "not a T3 Code checkout: $clone" >&2
    exit 1
  fi
  if [[ "$install_kind" == "server" && ! -f "$clone/apps/server/package.json" ]]; then
    echo "not a T3 Code checkout: $clone" >&2
    exit 1
  fi

  if [[ "${T3CODE_FORK_SKIP_FETCH:-}" != "1" ]]; then
    ensure_vp || {
      echo "Vite+ (vp) is required to build this fork. Node/npm could not install it." >&2
      exit 1
    }
    echo "vp=$(command -v vp)"
    (cd "$clone" && vp i)
  fi

  helper_dir=""
  cleanup() {
    [[ -z "$helper_dir" ]] || rm -rf "$helper_dir"
  }
  trap cleanup EXIT

  build_path="$clone/node_modules/.bin:$PATH"
  if [[ "$install_kind" == "appimage" ]] && ! command -v magick >/dev/null 2>&1 && ! command -v convert >/dev/null 2>&1; then
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

  if [[ "$install_kind" == "appimage" ]]; then
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
    echo "kind=appimage"
    echo "installed=$appimage"
    sha256sum "$appimage"
    echo "artifact=$artifact"
  else
    if [[ "${T3CODE_FORK_SKIP_FETCH:-}" != "1" ]]; then
      (
        cd "$clone/apps/server"
        PATH="$build_path" T3CODE_FORK_REVISION="$(git -C "$clone" rev-parse HEAD 2>/dev/null || printf '%s\n' "$sha")" \
          node --run build:bundle
      )
    fi
    stage_fork_runtime
    sha256sum "$clone/apps/server/dist/bin.mjs"
  fi
fi

resolve_desktop_entry() {
  if [[ -n "$desktop_entry" ]]; then
    printf '%s\n' "$desktop_entry"
    return
  fi
  local dir candidate
  while IFS= read -r dir; do
    [[ -d "$dir" ]] || continue
    for candidate in "$dir"/*.desktop; do
      [[ -f "$candidate" ]] || continue
      if grep -Fq -- "$appimage" "$candidate"; then
        printf '%s\n' "$candidate"
        return
      fi
    done
  done < <(desktop_entry_dirs)
  while IFS= read -r dir; do
    [[ -d "$dir" ]] || continue
    for candidate in "$dir"/*.desktop; do
      [[ -f "$candidate" ]] || continue
      if desktop_entry_is_t3 "$candidate"; then
        printf '%s\n' "$candidate"
        return
      fi
    done
  done < <(desktop_entry_dirs)
}

ensure_desktop_entry() {
  local existing dest
  existing="$(resolve_desktop_entry || true)"
  if [[ -n "$existing" && -f "$existing" ]]; then
    printf '%s\n' "$existing"
    return
  fi
  dest="$HOME/.local/share/applications/t3-code-fork.desktop"
  mkdir -p "$(dirname "$dest")"
  cat >"$dest" <<EOF
[Desktop Entry]
Type=Application
Name=T3 Code
Exec=$appimage
Terminal=false
StartupWMClass=t3code
EOF
  printf '%s\n' "$dest"
}

scope_runs_appimage() {
  local pid="$1"
  local value arg resolved
  resolved="$(readlink -f "$appimage" 2>/dev/null || printf '%s\n' "$appimage")"
  value="$(read_proc_strings "/proc/$pid/environ" | sed -n 's/^APPIMAGE=//p' | head -n1 || true)"
  if [[ -n "$value" && "$(readlink -f "$value" 2>/dev/null || echo "$value")" == "$resolved" ]]; then
    return 0
  fi
  while IFS= read -r arg; do
    [[ -n "$arg" ]] || continue
    if [[ "$(readlink -f "$arg" 2>/dev/null || true)" == "$resolved" ]]; then
      return 0
    fi
  done < <(read_proc_strings "/proc/$pid/cmdline")
  return 1
}

scope_runs_server() {
  local pid="$1"
  local arg
  while IFS= read -r arg; do
    [[ -n "$arg" ]] || continue
    if is_t3_server_arg "$arg"; then
      return 0
    fi
  done < <(read_proc_strings "/proc/$pid/cmdline")
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

stop_matching_scopes() {
  local matcher="$1"
  local unit pid
  matching_scopes=()
  while read -r unit _; do
    [[ "$unit" == *.scope ]] || continue
    pid="$(systemctl --user show -p MainPID --value "$unit" 2>/dev/null || true)"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    if "$matcher" "$pid"; then
      matching_scopes+=("$unit")
    fi
  done < <(systemctl --user list-units --type=scope --state=running --no-legend --plain)

  for unit in "${matching_scopes[@]}"; do
    echo "stopping=$unit"
    systemctl --user stop "$unit"
  done
}

if [[ "$restart" -eq 0 ]]; then
  exit 0
fi

ensure_node_path || true

if [[ "$install_kind" == "server" ]]; then
  if commit_boot_service; then
    exit 0
  fi
  server_entry="$clone/apps/server/dist/bin.mjs"
  [[ -f "$server_entry" ]] || {
    echo "missing $server_entry; run the updater without --restart-only first" >&2
    exit 1
  }
  stop_matching_scopes scope_runs_server
  node_path="$(command -v node)"
  node_path="$(readlink -f "$node_path")"
  resolved_sha="${sha:-$(git -C "$clone" rev-parse HEAD 2>/dev/null || true)}"
  echo "starting=t3-fork-server.service"
  systemctl --user stop t3-fork-server.service 2>/dev/null || true
  systemctl --user reset-failed t3-fork-server.service 2>/dev/null || true
  systemd-run --user --unit=t3-fork-server.service \
    --property=Restart=always --property=RestartSec=5 \
    --setenv="T3CODE_FORK_REVISION=$resolved_sha" \
    "$node_path" "$server_entry" serve
  exit 0
fi

appimage="$(readlink -f "$appimage")"
stop_matching_scopes scope_runs_appimage

load_graphical_environment
entry="$(ensure_desktop_entry)"
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
