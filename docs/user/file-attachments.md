# File attachments

Drag files from your computer onto the message composer to attach them to a message. You can also
paste files supplied by the clipboard. T3 Code accepts images and arbitrary file types, with up to
8 attachments per message and a 10 MB limit for each non-image file. Oversized images may be
compressed automatically.

The file is uploaded to the environment that owns the thread. This works the same way when the
client is connected over a local network, a relay, or T3 Connect: the agent receives a path to the
persisted file on that environment. Image attachments are additionally sent through the provider's
image-input support when available.

Attached files appear in the conversation as downloadable file chips. Removing a thread also
removes attachments that are no longer referenced by that thread.
