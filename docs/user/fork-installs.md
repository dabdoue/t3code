# Update this fork's server on another Linux machine

This is for the dabdoue/t3code fork, not the official T3 update. Official **Update** still
installs stock T3 from npm or GitHub Releases. Use the fork **Update** button when two fork
machines share the same version number but run different git commits.

Linux only. macOS and Windows are not supported here.

## Update from the app

When this client and that Linux server disagree on fork git SHA, T3 Code shows two separate
actions:

- **Update to mainline** — official T3 from npm or GitHub Releases, including restoring a fork
  server back to stock `t3` at this client's version
- **Update fork** — this fork at this client's git SHA

They appear:

- above the message box in the current conversation
- **Settings** → **Connections**, beside the connection

The official button stays available even when the version numbers already match, so a fork server
can go back to mainline without waiting for a semver bump.

Select the button. T3 Code uses the connection you already have. Servers that know how to install
this fork do it over the same WebSocket path as official **Update**. Older Linux servers are updated
over an SSH session from this desktop app — the one already open to that machine, or any saved SSH
connection whose host matches. That machine installs this fork at this client's git SHA and
restarts. Finish agent work first. Saved threads and `~/.t3/userdata` are left alone. T3 Connect
sign-in stays enabled; the new build uses the same public cloud identifiers as official T3.

If that automatic update fails, **Copy update command** appears. Paste it in a terminal on the
server machine. It works from any directory and finds the existing T3 install itself.

## Manual command

```bash
bash -lc '…'
```

The copied command fetches this SHA from GitHub and downloads the updater separately — the commit
you are installing does not need to contain that script. It clones into `$HOME/src/t3code-fork`
(override with `T3CODE_FORK_CLONE`) and then updates whatever T3 already runs on that machine:

- **Desktop AppImage** — replace that file and relaunch it. Discovery uses `$APPIMAGE`, a T3 Code
  desktop entry, `~/Applications`, then a running AppImage process. Set `T3CODE_FORK_APPIMAGE` only
  if it lives somewhere those checks miss.
- **Server only** — no AppImage is required. If `t3code.service` is installed (the same
  background service official **Update** uses), the updater builds the `t3` CLI from that SHA.
  Node and npm are enough; Vite+ (`vp`) is installed automatically if it is missing. The updater
  pins the CLI under `$T3CODE_HOME/runtime/versions` the way `t3 service update` does, then restarts
  the service. The stable launcher stays in place; the script does not rewrite `ExecStart` or
  install a desktop app. A host with only a running `t3 serve` / `t3` process and no unit gets
  that process replaced. Point the service back at official `t3` later with
  `npx t3@… service update`.

The command never writes live T3 state under `~/.t3/userdata`.

## Scripts

From a checkout of this fork:

```bash
./scripts/fork-push-head.sh
./scripts/fork-update-server.sh <sha>
```

`fork-push-head.sh` pushes a clean working tree to the `fork` git remote. The in-app button does
not require that: it installs the SHA this client was built from, which must already be on GitHub.

`fork-update-server.sh` fetches that SHA and updates the existing install. On an AppImage host it
rebuilds the desktop app. On a server-only host it rebuilds the `t3` CLI, installs that build as a
pinned runtime (same layout as official `t3 service update`), and restarts `t3code.service`. Pass
`--no-restart` to skip the restart.

See [Keeping T3 Code in Sync](./updating.md) for official updates.
