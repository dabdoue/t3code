# Installing a prebuilt fork runtime

Build one Linux x64 archive from the tested fork and install those same bytes on every host.
The fork's version includes a `-fork.<date>.<build>` suffix so its runtime directory is distinct
from official releases. Give each build a new version.

Use the pinned Node version in `apps/server/vite.config.ts` when building the standalone executable.
Build the web client/server, standalone executable, and resource monitor, then package them with
`scripts/build-cli-archive.ts`. Run `scripts/smoke-cli-archive.ts` against the resulting archive.
Record the source commit and archive SHA-256 before distribution.

The target host needs Linux x64, Python 3.12 or newer, and its existing user systemd service.
Copy the archive and `scripts/install-fork-runtime.py` onto the host, then stage it:

```sh
python3 install-fork-runtime.py \
  --archive t3-<version>-linux-x64.tar.gz \
  --sha256 <recorded-sha256> \
  --version <version>
```

Staging verifies the checksum and executable version and leaves the running service untouched.
Pass `--activate` to the same command when the environment is idle. It refuses activation while
runs are active or queued, snapshots the databases consistently, backs up service configuration
and settings, and calls mainline's `t3 service install`. Use `--base-dir` for a nondefault T3 home.
Backups live in `<T3 home>/runtime/fork-backups/<timestamp>`; previous runtimes remain installed.

Verify `systemctl --user is-active t3code.service`, `t3 service status` using the new runtime's
executable, and the service journal after activation. A healthy service alone does not prove
remote client reconnection; verify that separately in the client.

Read [thread migration](../user/thread-migration.md) before the first V2 launch. V2 keeps the V1
database and migrates a separate copy. Conversation transcripts carry over; live provider sessions
and some runtime history do not. Finish older active work and drain any fork-local composer queue
before switching clients. The new queue is owned by the server.

For rollback, stop only `t3code.service`, restore its backed-up unit and service-state file, run
`systemctl --user daemon-reload`, and start that exact service. Restore settings if the newer
runtime changed them. V1 still has its original database; V2 conversations created after the
upgrade stay in `statev2.sqlite` and do not synchronize back into V1. Keep both databases.

This installer does not poll for releases or expose a remote update button. Official release
updates can replace the fork; distribute future fork builds through this same verified archive
path. Build desktop artifacts with `T3CODE_DESKTOP_UPDATE_REPOSITORY` pointing at the fork's GitHub
repository so their update feed uses fork releases.
