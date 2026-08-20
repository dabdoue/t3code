# Editing a Message

Sometimes you realize a message was wrong only after the agent has run with it. T3 Code lets you rewrite an already-sent message and choose what should happen to the work that followed it.

On web or desktop, hover a message you sent and click the pencil icon. On mobile, long-press your message. Edit the text, pick how to resolve it, and send.

## Choosing a Resolution

### Fork as new thread

Creates a new thread that duplicates the conversation up to the message you edited, and sends your edited version there. The original thread keeps every message and every file change exactly as they were.

On Git projects the fork gets its own worktree, branched from the checkpoint taken just before the edited message ran — so the fork starts from the file state that message originally saw, and nothing in your current workspace moves.

The fork keeps the copied checkpoint history too, so its earlier turns can still be inspected or edited later.

This is the only resolution available while the agent is still working, because it does not touch the running thread. It is also the safest choice when you are not sure which direction you want.

### Rewind this thread

Restores your files to the checkpoint from just before the edited message, discards the newer turns in this thread, and sends the edited message in their place.

Nothing is lost. Before rewinding, T3 Code copies everything it is about to discard into its own archived thread, preserves the current file state in a dedicated worktree, and leaves a link to it in the thread's work log, so you can always go back and read what happened.

Rewinding needs a checkpoint for the edited message's turn. If that turn never completed — the agent was interrupted, or the provider errored out — there is no file state to restore and T3 Code will tell you so instead of guessing.

### Edit and continue

Keeps everything on disk exactly as it is and tells the agent about the edit. Two ways to do that:

- **Reset context** rolls the agent's memory back to the edited message, then sends the new version there. Your files and your visible history stay put; the agent simply no longer remembers the turns that came after.
- **Send as correction** keeps the agent's full memory and delivers the edit as a correction to apply on top of the work already done.

## What Your Agent Supports

Forking depends on the coding agent being able to branch its own conversation, and they differ:

- **Codex** and **Claude Code** fork at turn boundaries, so a fork starts with exactly the conversation up to your edit point.
- **Cursor** can copy the whole conversation when its active ACP runtime advertises session-fork support. T3 Code verifies that capability before forking. Because the copied memory includes the original message, the edited message is labeled as a correction so it is clear which version counts.
- **Grok** and **OpenCode** cannot fork conversations. Fork, rewind, and reset-context are unavailable for those threads; **Send as correction** still works and never claims that provider memory was reset.

## Finding Forks and Archives Later

Both a fork and a rewind's archive appear as their own threads in the sidebar, and the thread you edited gets a row in its work log linking straight to them. A rewind never deletes work — it moves it somewhere you can still find it.
