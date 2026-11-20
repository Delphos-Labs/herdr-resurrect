# Checkpoint 2: real recovery proof

Date: 20 November 2026, UTC.
Status: passed for isolated Linux core loss. Host shutdown recovery is not yet proved.

## Bottom line

Real Claude, two real OpenCode conversations, tuicr, btop and gh-dash returned
after their isolated core stopped. The agents recalled their original test codes.
Tuicr displayed its saved annotation. Repeating restoration started no duplicate
programs.

This proves more than recording IDs or reconstructing command lines. It does
not prove service startup after a VM reboot, desktop layout rendering or Windows
host recovery. No recovery plugin is installed in the live app.

## What was built

- A restore preview and executor for the current core adapter.
- Canonical agent resume commands, never original task prompts.
- Preservation of live terminals and unrelated spaces.
- Version-checked layout updates, cleanup after conflicts and orphan-process recovery.
- Allowlisted btop and gh-dash restoration.
- Full-file tuicr review capture with source fingerprint and persisted session identity.
- Explicit real-agent and real-tool acceptance tests, separate from default tests.

The executor reports process starts as unverified. The acceptance test supplies
the independent verification through observed identities and actual content.

## Carried forward

Checkpoint 1 proved Linux recording and core-document storage using stand-ins.
Michael asked how that proved the product worked. It did not. He approved moving
real recovery ahead of further interface work.

## Observed proof

Command:

```sh
HERDR_ACCEPT_WORKSPACE_TRUST=1 npm run test:real
```

Both acceptance tests passed. Total runtime was about 35 seconds.

### Agent recovery

Receipt: `.local/acceptance/b5a37e1f-5586-4547-a857-0ed414343f93/receipt.json`.
Snapshot: `.local/acceptance/b5a37e1f-5586-4547-a857-0ed414343f93/snapshots/last.json`.

The test created distinguishable conversations in the same directory.
Each agent first returned its own random verification code.

The recorder then saved all three identities. Its snapshot advanced with the
viewing client disconnected. The test stopped only its isolated core, started
that core again and restored three new terminal processes.

Each resumed agent was asked for the earlier code without supplying the code
again. Each returned its own original code. The test checked the visible terminal
content and that the original prompt appeared only once in the conversation.

A repeated restore started zero programs. Exactly three test terminals remained live.

An independent check of the retained receipt and final snapshot also confirmed:

- The three observed conversation IDs match the original IDs.
- All three terminal IDs changed after the stop.
- The final identities are fresh observations, not retained stale records.

The acceptance test now includes that explicit post-restore identity comparison
as a permanent assertion too.

### Tool recovery

Receipt: `.local/acceptance/716ca025-5b28-4b84-9795-20d796f69736/receipt.json`.
Snapshot: `.local/acceptance/716ca025-5b28-4b84-9795-20d796f69736/snapshots/last.json`.

The test opened real programs, saved their state, stopped its isolated core
and restored them. It verified:

- Tuicr reopened the same review and displayed the saved annotation.
- Btop displayed CPU and memory metrics.
- Gh-dash loaded the saved section from its unchanged configuration.
- A repeated restore started zero programs.

The test linked the existing gh-dash extension into isolated extension discovery.
Btop came from a worktree-local extracted Debian package. No global tool
installation or user review was modified.

## What the real tests caught

The initial tuicr fixture was wrong. The installed tool identifies a full-file
review through `diff_source: file`; `base_commit` holds a target-path hash.
The adapter and regression fixtures now follow the real producer.

Raw terminal output does not necessarily contain literal spaces. Cursor movement
can position words instead. Readiness checks use a read-only output stream;
final assertions inspect the core's parsed screen.

Claude startup needed explicit workspace and credential decisions. Michael
approved trust only for generated test folders and signed in to a dedicated
test profile. The test does not copy credentials into snapshots or receipts.
The rejected environment API key remains rejected and is cleared only from
Claude's test launch environment.

Automating Claude's trust screen proved unreliable and was removed from the
acceptance path. Production recovery must not automatically approve trust or
other permission questions.

## Verification summary

- `npm test`: 33 tests passed.
- `npm run test:integration`: four tests passed.
- `npm run test:real` with scoped test trust: two real acceptance tests passed.
- `git diff --check`: passed.
- Retained receipt/snapshot identity comparison: passed.

The additional explicit post-restore identity assertion uses the same retained
data independently checked above. The paid acceptance run is not claimed as
covering source changes made after it finished.

## Remaining gates

Checkpoint 3 must package recording as a host service and add the native controls.
It must also finish boot reconciliation before the recorder can resume normal
saving after a real host restart. The current new-boot guard preserves old work;
it does not yet implement a complete reconciliation workflow.

OpenCode can create a new session when an unknown identifier is supplied.
Before installation, add a strict session-existence preflight and a missing-session
acceptance case. The passing test used existing sessions; it does not establish
that refusal behavior.

Native app layout rendering, interrupted restore coverage, Windows service
lifecycle and scheduled VM stop/start remain later checks. Mobile clients exist,
but their compatibility with this setup is still untested.

No live core or existing agent was stopped. No commit, push or live plugin
installation occurred.

## Server-restart addendum

The harness server restarted during an additional acceptance repeat. That
repeat is interrupted, not a newly passing or failing test. The completed
full acceptance results above remain valid and were not rerun.

The interrupted agent run reached and passed the new explicit post-restore
identity assertion before cancellation:
`.local/acceptance/808f2f7d-3540-4baf-a081-d7296345bbb6/receipt.json`.
Its retained observations match all three original conversation IDs.
Its final recall and duplicate checks were not completed in this repeat.

The tool test in that repeat completed successfully:
`.local/acceptance/9b099086-81cf-4c09-b918-daee8df0fa1c/receipt.json`.

After resuming, ownership checks identified the interrupted run's recorder and
private core. Their core identity and three live terminal IDs matched the
saved test records. Only that recorder and private core were stopped.
The receipt records the interruption and completed cleanup.
