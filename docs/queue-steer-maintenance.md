# Queue-first messages and shared queue maintenance

This fork keeps queue-first active-turn messaging as two reviewable commits:

1. `68b92e365` adds the queue/steer UI, one-at-a-time delivery, stop holds, editing, reordering,
   and local persistence for compatibility with older servers.
2. The next commit on `agent/shared-queued-messages` adds the authenticated, server-authoritative
   queue used by every client connected to the same T3 server.

To carry the feature onto a newer upstream release, rebase the branch onto that release. If the
base has moved too far for a clean rebase, cherry-pick the two commits in order. Resolve contract
changes first, then server/client runtime changes, and finally the web UI.

## Compatibility contract

- New servers advertise `environment.capabilities.sharedThreadQueue`.
- New clients use the server queue only when that capability is true.
- Old servers continue using the per-message local-storage outbox.
- On first connection to a capable server, a client uploads its old local entries before replacing
  them with the server snapshot.
- Queue mutations are serialized on the server and persisted in `thread-queue.json` under the
  server state directory.
- Every client subscribes to the same revisioned snapshot stream.
- The queued message's stable orchestration command ID makes simultaneous drain attempts
  idempotent; only one turn is created.
- Stopping a turn holds normal queued messages. An explicit Steer may pass the hold, while a fresh
  composer send leaves the held queue intact.
- Auto-send next is the inverse of that hold. It starts off after Stop and after a process restart
  that still has leftover queue items. Turning it on releases the hold so the next queued message
  sends when the parent thread finishes. Live Claude subagents do not gate this drain.
- Claude steer while subagents are live uses SDK `priority: "next"` plus a real prompt `uuid`, so
  the parent turn is not aborted and in-flight Agent tool calls keep running. Stop still calls
  `stopTask`.

## Upgrade checks

Run these after rebasing or resolving conflicts:

```bash
pnpm exec vp run typecheck
pnpm exec vp test run \
  apps/server/src/threadQueue.test.ts \
  apps/server/src/serverRuntimeStartup.test.ts \
  apps/server/src/provider/Layers/ClaudeAdapter.test.ts \
  apps/web/src/webThreadOutbox.test.ts \
  apps/web/src/components/WebThreadOutboxDrain.logic.test.ts \
  apps/web/src/components/ChatView.logic.test.ts \
  apps/web/src/components/chat/QueuedWebThreadMessages.test.tsx \
  apps/mobile/src/state/thread-outbox.test.ts
```

The focused tests protect persistence and snapshot fan-out, queue ordering, single-item delivery
gates, stop/hold behavior, the auto-send toggle, startup holding of leftover queues, Claude
steer-with-live-tasks, edit reinsertion, and drag reordering. A failure after an
upstream update should identify which layer of the queue contract changed.
