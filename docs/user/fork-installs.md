# Update this fork's server on another Linux machine

This is for the dabdoue/t3code fork, not the official T3 update. Official **Update** still
installs stock T3 from npm or GitHub Releases. Use the fork **Update** button when two fork
machines share the same version number but run different git commits.

Linux only. macOS and Windows are not supported here.

## Update from the app

When this client and that Linux server disagree on fork git SHA, T3 Code shows **Update** (or
**Update fork** next to official **Update**):

- above the message box in the current conversation
- **Settings** → **Connections**, beside the connection

Select the button. T3 Code uses the connection you already have: the same WebSocket path official
**Update** uses. That machine installs this fork at this client's git SHA and restarts. Finish
agent work first. Saved threads and `~/.t3/userdata` are left alone.

If that automatic update fails, **Copy update command** appears. Paste it in a terminal on the
server machine. It works from any directory and finds the existing T3 install itself.

## Manual command

```bash
bash -lc '…'
```

The copied command clones this SHA from GitHub into `$HOME/src/t3code-fork` (override with
`T3CODE_FORK_CLONE` if you want), then updates the T3 server already on that machine. It looks for
the running AppImage (`$APPIMAGE`), a T3 Code desktop entry, or a running T3 process. Set
`T3CODE_FORK_APPIMAGE` only if it lives somewhere those checks miss.

The command never writes live T3 state under `~/.t3/userdata`.

## Scripts

From a checkout of this fork:

```bash
./scripts/fork-push-head.sh
./scripts/fork-update-server.sh <sha>
```

`fork-push-head.sh` pushes a clean working tree to the `fork` git remote. The in-app button does
not require that: it installs the SHA this client was built from, which must already be on GitHub.

`fork-update-server.sh` fetches that SHA, builds the Linux server, replaces the running install,
stops only that process's systemd user scope, and relaunches it. Pass `--no-restart` to skip the
restart.

See [Keeping T3 Code in Sync](./updating.md) for official updates.
