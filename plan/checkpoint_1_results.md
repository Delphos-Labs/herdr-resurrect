# Checkpoint 1: host-owned capture and exact identity

Date: 19 November 2026.
Status: passed for the Linux feasibility checkpoint. The full plugin is not ready.

## What was built

The native port now has core transport, strict layout validation, exact identity
readers, durable snapshots and a client-independent recorder.
The OpenCode terminal integration records root conversation changes and process
lifetime evidence. Claude uses its native per-process session mapping.
Neither path selects conversations by working directory.

See [native/README.md](../native/README.md) for the implemented interface and limits.

## Carried forward

Michael approved the revised plan: native Herdr replaces tmux completely.
Recording must continue after the viewing client leaves. The primary failure
case is a scheduled Coder stop; desktop shutdown also needs durable recovery.
The fork must eventually restore tuicr reviews and allowlisted dashboards.

## What was discovered

The installed core supports line-based JSON requests over `hc connect`.
`doc.get` and version-checked `doc.set` preserve nested layout trees and weights.
The document is still opaque to the core. This proves storage and conflict
detection, not visual acceptance by the desktop app. The app-level check remains
part of the later isolated visual gate.

Old OpenCode tracker records do not contain the process-start evidence needed
to reject process-ID reuse. The new integration adds it. Until that integration
is installed and tested with a real OpenCode terminal, those old records remain
unresolved rather than silently trusted.

Protecting only completely empty snapshots is insufficient. One lost agent
can become a shell while other agents remain live. The store now retains that
pane's last known identity and its original verification time. It separately
records the newly observed failure state.

A plain exclusive-create lock can survive a hard stop forever. The store uses
`proper-lockfile` 4.1.2 for atomic acquisition, lease refresh and stale-lock recovery.
Its documented stale interval is ten seconds; recorder retries remain visible.

Native core sockets have a short path limit. Tests use a short, owned temporary
runtime path and their own configuration. The preferred `/tmp/opencode` base was
not writable here; no permissions or live directories were changed.

## Verification

- `npm test`: 22 tests passed.
- `npm run test:integration`: two tests passed against real isolated cores.
- Same-directory fixture processes retain distinct exact conversation IDs.
- The actual new OpenCode tracker follows root-session changes under a controlled
  UI context and writes no prompt, credential or command-line fields.
- A detached recorder saves changed layout state after its launcher exits.
- That recorder also preserves the last known conversation through an isolated
  core stop and restart, after the original agent process disappears.
- Saved IDs remain readable after transient agent-record directories are deleted.
- Interrupted writes preserve the prior snapshot. Stale locks can be recovered.
- New-boot state cannot replace recoverable work. Partial loss retains per-pane state.
- A stale core-document version is refused.
- One inventory serves 100 synthetic panes.

The current code does not yet execute restore commands or install services.
No live Herdr core, tmux session or agent was stopped. Nothing was committed,
pushed or installed. Project dependencies were installed only in this worktree.

## Environment checks

The Debian and Coder user service managers are active, and user lingering is
enabled. This supports the proposed Linux user-service lifecycle, but the
plugin-owned unit has not yet been installed or tested.

The Windows host exposes `Register-ScheduledTask`. Its existence does not prove
the required task permissions, logout behavior or host-start behavior. Those
checks move into service packaging before Windows support is claimed.

No mobile Herdr client was established. Host-owned snapshots do not depend on
the viewing client. Actual mobile attachment remains a separate capability check.

## Plan updates and next step

Checkpoint 2 should package the Linux recorder as a user service first, then
add native snapshot and preview controls. Keep Windows host-service support
explicitly unverified until isolated lifecycle testing passes.

Checkpoint 3 must test loading the new tracker in OpenCode itself, not merely
the controlled context. It must implement guarded restore, the tuicr review
resolver and the tool allowlist.

## Health assessment

The core approach remains viable. The hard parts are now visible: writer
lifetime, per-pane loss and identity freshness. They required real guards,
not more UI controls.

The code is a Linux-first foundation. It deliberately refuses unknown layout
types and unproved identities. The next checkpoint must not present it as a
finished Windows recovery plugin.
