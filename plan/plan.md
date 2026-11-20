# Native Herdr recovery

Started: 19 November 2026.
Status: checkpoint 2 passed real Linux core-loss acceptance; awaiting checkpoint review.
Repository: [Delphos-Labs/herdr-resurrect](https://github.com/Delphos-Labs/herdr-resurrect).
Branch: `feat/herdr-core-resurrect`.

## Navigation

See [the working map](README.md), [checkpoint status](checkpoint-index.md)
and [source evidence](prior-art.md).

## Problem and goal

Michael is replacing tmux with Herdr. The old tmux setup shows the required
workloads: multiple Claude and OpenCode conversations, named work sessions,
review tools, `btop` and GitHub dashboards. Recreating a shell is not enough.
After a machine restart, he needs the correct conversations and tools back in
the correct Herdr tabs.

The virtual machine is the primary recovery target. It starts and stops on a
schedule, and the desktop may disconnect before it stops. The desktop also
needs durable recovery after shutdown, much like reopening a browser session.
Saving must continue without a connected desktop or an open Herdr window.

Current Herdr keeps terminals alive when its window closes. After terminal loss,
it can recreate shells and its saved layout, but does not relaunch the original
programs. The upstream `ntindle/herdr-resurrect` plugin targets a different
Herdr interface and lacks an OpenCode resolver.

The Delphos tmux fork is different: it already tracks Claude and OpenCode
conversation IDs and constructs commands to reopen those conversations.
Michael reports using that recovery successfully. Port that capability into
native Herdr; do not replace it with directory-based guesses or fresh sessions.

## Thesis

A native mod with a plugin-owned recorder on each host can capture durable
snapshots and restore supported programs without modifying Herdr itself.
It can reuse exact per-process conversation mappings from the Delphos tmux fork
without requiring tmux. Recording must outlive client disconnections and
application closure. Isolated recovery tests must prove this before installation.

The evidence and current limitations are recorded in [prior-art.md](prior-art.md).

## Agreed boundaries

- Inputs: native Herdr spaces, tabs, pane trees, folders and supported programs.
- Outputs: durable snapshots, a preview and explicit manual restore actions.
- Machines: Windows Herdr, Debian under Windows Subsystem for Linux and Coder.
- Priority: scheduled virtual-machine stops first, then desktop shutdown recovery.
- Agents: Claude and OpenCode, including several conversations in one directory.
- Tools: `tuicr`, `btop`, `gh dash` and `gh-dash`. Identify any additional tools
  before adding them to the restore allowlist.
- Handoffs: keep recovery state on the workload host, independent of the viewing
  client. Reattach existing work rather than duplicate it when changing clients.
- Packaging: a forked native Herdr mod with bundled host recorders, not a Herdr fork.
- No tmux dependency, state capture, launch or recovery. Its fork is prior art only.
- No automatic restore initially. No replay of original prompts or task scripts.
- No arbitrary command replay. Unknown programs receive an explicit skip reason.

Success means reopening exact conversations and supported tools with no duplicate
live agents. It does not mean resuming an interrupted tool call or restoring
unsaved text inside a running program. A disconnected or closed client must not
stop the host from saving recovery state.

## Proposed implementation

Keep the upstream repository and its license. Add a native mod package with
Save, Snapshots, Preview and Restore controls. Adapt reusable storage and
command-selection code instead of retaining the incompatible host API.

### Continuous recording on each host

Install the recorder as part of the plugin, not as a task owned by the current
terminal or a timer owned by the Herdr window. Each workload host reads its own
core state, inspects its processes and writes snapshots to its persistent user
data directory. Use the host's supported background-service mechanism; verify
that it starts again after reboot and survives client logout.

The proposed recording interval is one minute. Show the last successful save,
snapshot age and recorder health per host. A failed capture must be visible and
must leave the previous good snapshot intact. A shutdown save is useful but
best-effort; periodic durable saves must carry recovery after abrupt power loss.
The possible loss window is time since the last successful capture.

Do not store the only recoverable copy in a temporary directory, a runtime
directory, desktop memory or the remote connection. Persist exact conversation
IDs while agents are running; their transient process trackers may disappear
when the host reboots.

After reboot, recovery shells are not a new desired workspace. Preserve the
last recoverable workload until reconciliation or an explicit user decision.
Automatic recording must not replace useful pre-stop state with empty shells.
Keep ordinary intentional closes distinct from loss and disconnection.

### Exact agent identity

Bundled helpers resolve exact conversation IDs from per-process mappings,
following the Delphos tracker and tool-native records. Snapshot records
distinguish an exact match, an unsupported program and an unresolved identity.
Never select a conversation merely because its directory matches.

Capture each machine's tab-root trees through the core document interface.
This interface returns opaque documents, so reading the tree does not yet prove
that rewriting it is safe. Checkpoint 1 must establish a compatible, tested
restoration path. If exact reconstruction needs undocumented writes, isolate
that version-specific adapter and reject incompatible schemas.

A proposed snapshot contains a format version, capture time, stable host identity,
capture boot identity, space and tab identities, pane layout, working directories
and restore records. Each restore record identifies the supported program,
exact conversation ID when applicable, evidence source and original terminal
identity. Distinguish persistent host identity from process and core identities
that can change after restart.

### Client handoffs

Desktop and mobile access should find the same host-owned recovery state and
live conversations. Changing clients must not start new agents or transfer
ownership of recording to the new client.

Validate the available mobile connection path before claiming mobile integration.
This plan does not assume Herdr has a mobile client. A new mobile application,
cross-host transcript migration and a new cloud-sync service are not proposed.
If the available clients cannot share this state, report that gap explicitly.

### Guarded restoration

Preview and restore share one plan. Before each restore action, check live
terminal identity and foreground processes again. Leave existing agents alone.
Only replace a confirmed recovery shell or create a missing pane. Refuse stale,
ambiguous or changed targets with a visible reason.

`tuicr`, `btop` and dashboard restoration use a narrow allowlist. For tuicr,
record the review scope, document or comparison and its persisted review
identity. Reopen that review with saved annotations, not a fresh review of
whatever file happens to occupy the directory. Detect missing sources or
changed content and report them without deleting saved comments.

Do not restart generic `python3`, shell supervisors or old task wrappers.
If an agent sits behind a wrapper, recover its proved conversation rather
than replay the wrapper's task.

Save versioned snapshots atomically with bounded retention. An offline machine
must not overwrite its last good snapshot with an empty one. Separate current
capture results from retained, unavailable-machine records.

The local snapshot is the recovery source even when another host is offline.
Client caches may improve access, but they do not replace host-local persistence.
This does not protect against deletion of the host's persistent disk or agent
conversation store; any separate backup requirement must be explicit.

## Choices already made

A compatible forked mod is preferred over a standalone command-line companion
or a Herdr source fork. This follows Michael's explicit preference and keeps
recovery controls inside Herdr. Its host recorders are plugin infrastructure,
not a replacement user interface.

Window-owned timers are insufficient. Host-owned recording is required for
scheduled VM shutdowns, disconnections and desktop closure.

Exact identity takes priority over restoring every pane. An unresolved identity
produces a skipped action, never a guess or a new conversation presented as
the old one.

## Proposed checks

Upstream has no test command or discovered test suite. Add:

- `npm test`: Node tests for identity, snapshots, command construction and plans.
- `npm run test:integration`: isolated core recovery tests with synthetic
  programs and conversation fixtures; never stop the live core.
- Recorder lifecycle tests: client disconnect and app closure do not stop
  captures; a fresh boot cannot erase the last recoverable workload.
- Native `herdr-app check` for the mod, with side effects disabled during checks.
- An isolated visual check of snapshot, preview and restore results.

Michael approved the plan and these checks. Run applicable checks at each
checkpoint. Require all checks before installing the plugin.
Ask Michael before commits.

## Assumptions to test

- Tool interface: per-process Claude and OpenCode mappings remain usable without
  tmux. Confirmed in Linux fixtures using the new OpenCode tracker and Claude's
  native record shape. Actual terminal-plugin loading remains a checkpoint-3 check.
- Tool interface: the core document contains sufficient layout data for safe,
  exact recovery. Core storage and version checks passed in checkpoint 1.
  Visual acceptance by the app remains a later integration check.
- Tool interface: machine identity survives ordinary reconnects and can detect
  a replaced host. Validate in checkpoints 1 and 3.
- Tool interface: a plugin-installed recorder can read host-local core documents
  and run independently of clients. Confirmed for a detached Linux recorder.
  Linux service packaging and Windows host-service behavior remain unverified.
- Tool interface: saved tuicr scope and identity reopen the same review and
  annotations; changed source content is detected. Validate in checkpoints 1 and 3.
- Performance: one process inventory per machine per capture is enough. Test
  100 synthetic panes and require bounded work, with no per-pane full scan.
- Handoff: a supported mobile access path can use the same host-owned state.
  Validate the existing client path in checkpoint 1; do not invent one.
- Prior art: upstream storage and process helpers can be reused without
  retaining its old host protocol. Verify during implementation.
- Recovery: preserve each pane's last known identity through partial loss, not
  only whole-host empty state. Checkpoint 1 tests cover this requirement.

## Checkpoints

### 1. Prove host-owned capture, exact identity and layout recovery [complete: Linux feasibility]

[Results](checkpoint_1_results.md): 22 unit tests and two isolated-core
integration tests passed. Native app visuals and Windows service behavior remain
later gates.

Scope: prove client-independent durable capture, exact identities and layout
round trips in isolation.

Verification: two same-directory sessions keep distinct exact IDs; missing or
stale IDs are refused; capture and reconstruction preserve a nested weighted
tree in an isolated core. Captures continue after the client exits; persisted
records survive a simulated host restart and loss of transient tracker files.
Confirm host-service support and establish the mobile handoff boundary.
Preserve unrelated current state.

Checks: relevant unit tests and isolated integration tests from the proposed checks.
Done when all these cases pass and the viable integration boundary is recorded.
Results: `checkpoint_1_results.md`.

### 2. Prove real-agent recovery before more interface work [complete]

[Results](checkpoint_2_results.md): real Claude and two same-directory OpenCode
conversations returned with their original content. Real tuicr, btop and gh-dash
also returned. Repeating restoration started zero programs.

Michael approved this checkpoint order after reviewing the limits of fixture tests.
Implement the smallest guarded restore path and test actual Claude and OpenCode
terminals. Seed distinguishable conversations, including two in one directory.
Verify their histories after restoring into an isolated core, not just their
command-line arguments. A repeated restore must start no duplicate agents.

The client must be absent during a subsequent successful capture. Then stop
only the test core and restore only test programs. This is not an actual VM
restart; scheduled-stop and desktop-restart testing remain checkpoint 4.

Checks: unit tests, isolated-core tests and a separately invoked real-agent
acceptance test. Record missing credentials or failed checks as failures, not
passing skips. Include tuicr and the supported tools in acceptance as their
restore adapters become available.

Done when real conversation recovery is demonstrated, or a concrete external
blocker is recorded without claiming success.
Results: `checkpoint_2_results.md`.

### 3. Package host recorders and native controls; finish tool recovery

Scope: add the native mod, plugin-owned host recorders and durable snapshot selection.

Verification: snapshots survive interrupted writes; unavailable machines retain
last good data; preview launches nothing; missing runtime or access shows a
visible error. Recorders restart with the host, not the desktop connection.
Fresh-boot shells cannot overwrite the last recoverable workload.
Mod checks must launch no helpers or install services.
Implement explicit boot reconciliation to resume saving after verified recovery.
Reject missing OpenCode sessions before launch; do not let `-s` create a fresh
conversation that appears to be a successful restore.

Checks: unit tests, capture integration tests and native mod check.
Done when the native controls and safe capture pass those checks.
Results: `checkpoint_3_results.md`.

#### Guarded restoration requirements

Scope: implement exact Claude and OpenCode recovery and allowlisted tool replay,
including persisted tuicr reviews.

Verification: commands contain exact IDs but no saved prompt; busy or replaced
targets are skipped; repeated restoration creates no duplicate agents; tools
return to their saved directory; unsupported wrappers are not executed.
Tuicr reopens the saved review with its annotations.
Client handoffs reattach live agents without restoring duplicate processes.

Checks: unit tests, isolated restore integration tests and native mod check.
Done when all supported restore cases and refusal cases pass.
Real-agent proof starts in checkpoint 2. The packaged plugin and remaining
tool adapters must meet these requirements before checkpoint 3 completes.

### 4. Verify recovery and install the mod

Scope: test controlled loss in isolation, then install the verified plugin.

Verification: nested layouts, same-directory agents, unavailable machines,
stale snapshots and interrupted restores produce the documented result.
Capture continues without the desktop connection. Test scheduled-stop and
abrupt-stop recovery separately, including desktop restart and recorder startup
before the Herdr window opens. Prove that fresh empty state cannot erase recovery.
Save and preview against live state are read-only; live restore requires
Michael's explicit action.

Checks: all proposed checks and visual inspection.
Done when checks pass and Michael approves installation after seeing the results.
Results: `checkpoint_4_results.md`.

## Remaining questions

The first checkpoint must settle exact split-layout reconstruction, portable
agent identity tracking, host-owned recorder lifecycle and supported app-version
bounds. If those fail, stop and propose a narrower scope before building the
remaining plugin.

Validate the proposed one-minute interval and choose a retention limit during
checkpoint 2. Keep them small configuration values, not a scheduling framework.
Verify that Coder's persistent disk survives its scheduled stops.
Determine which existing mobile client can attach to these same workloads.
