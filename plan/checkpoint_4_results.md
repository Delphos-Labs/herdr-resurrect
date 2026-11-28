# Checkpoint 4: lifecycle recovery on a Coder VM

Date: 25 November 2026, UTC.
Status: partial. Scheduled stop and core-only restart passed for shells, tools,
a real Claude conversation and a real OpenCode session. Not yet run: abrupt
stop, desktop app recovery.
Live installation has not started and needs Michael's approval.

## Test host

Coder workspace `michael-workspace`, template `az-d16s-ubnt24`, `hc 0.1.21`,
Node 24.16.0, user lingering enabled. The workload was built in the default core
in herdr-app's shape: tab `work` with two shells in a split, tab `dash` with `gh dash`.

## Coder stop and start

Coder stop destroys the VM; only the `home` managed disk persists
(`count = start_count` in `delphos/terraform/coder-templates/az-d16s*`).
After start, the root filesystem was a fresh image and the journal held one boot.
Start took 71 s; SSH became usable after 34 minutes.

Observed boot sequence:

1. cloud-init ran `su - coder`, which opened a login session at 21:59:23.
2. That session started `user@1000`, which started the enabled recorder.
3. The recorder's `hc` connection started a new core and herdr-core re-created
   `/var/lib/systemd/linger/coder` at 21:59:25.
4. The `su` session closed 2 ms before the core service started.

Recovery after boot depends on that 2-second window. Without the recorder,
nothing starts a core at boot and lingering is not restored. The durable fix is
`loginctl enable-linger ${username}` in the template's cloud-init `runcmd`.

## Results

| Case | Result |
|---|---|
| Recorder after boot | Started; saving held at `recovery-pending`, so the empty core did not overwrite the snapshot |
| Preview | Planned 2 shell launches in saved directories and `gh dash`; launched nothing |
| Restore with ticket | Started 3; layout split, tab names and root-id shape restored |
| Repeat preview | All `keep-live`; no duplicates |
| Reconcile | Verified; next save at the following interval |
| Interrupted write | The Coder stop left one `.tmp` snapshot file; all 27 saved snapshots parsed |
| Stop only `hc-serve` | Programs kept running under `hc-hold` (start 22:21:50, new server 22:24:24); preview all `keep-live` |
| Abrupt stop | Not run. Both attempts ended locally with `Terminated` before reaching the VM |
| Real Claude after VM stop | Pass after the profile fix below (27 November). The resumed session showed its history and answered with the saved marker in the same transcript |
| Real OpenCode after VM stop | Pass for resumption (27 November): restore ran `opencode -s <id>` for the saved session, which showed its saved prompt. The VM's OpenCode provider sign-in is stale (HTTP 401), so no model reply was possible before or after |
| Both agents after one more VM stop | Pass: a fifth boot restored 5 programs; Claude answered the marker again, OpenCode reopened its session |
| Desktop app recovery and rendering | Not run |

## Real Claude after VM stop

A Claude session was started by typing `claude` into a normal core shell in
`~/herdr-test/agent`, and given a marker. The recorder saved it as `exact`
(PID and process start). The VM then went through three stop and start cycles:
one requested, two from the 14-hour autostop. The snapshot stayed held at
`recovery-pending` across all of them, including after an unreconciled restore.

The first two restores launched `claude --resume <id>` correctly, but Claude
showed the folder trust dialog, whose default is "No, exit".
Cause: capture recorded the fallback `~/.claude` as the profile when the
process had no `CLAUDE_CONFIG_DIR`, and restore always set the variable.
Claude reads `~/.claude.json` while the variable is unset and
`$CLAUDE_CONFIG_DIR/.claude.json` once it is set, even to `~/.claude`.
Every restored default-profile session therefore started with an empty
configuration: no trust, no onboarding, no project state.

Fix: capture records `profileExplicit`. Restore and the shell gateway set the
variable only when the original process set it; otherwise restore launches
through `env -u CLAUDE_CONFIG_DIR`, because `terminal.run` cannot unset a
variable from the core's environment. Older snapshots treat only the default
directory as unset. After the fix the restored process had no
`CLAUDE_CONFIG_DIR`, and the marker question received a new reply
(assistant replies 2 to 3) containing the marker.

## Real OpenCode after VM stop

The VM's OpenCode database was moved aside to
`~/.local/share/opencode-db-aside-20261127`, which ended the stuck migration.
OpenCode 2.4.1 then started and `npm run test:guard` passed (see checkpoint 3).
OpenCode was started by typing `opencode` into a core shell, and given a
marker prompt. The tracker plugin wrote its record, and after reconcile the
recorder saved the session as `exact`. After a Coder stop and start, restore
launched `opencode -s ses_de18d271bffeT542b9k5jHpKB2` and the screen showed
the saved prompt with the marker. Two old personal OpenCode plugins on the VM
fail to load under 2.4; the Herdr tracker is unaffected.

A test-script defect also surfaced: the script reused a restored pane's id
for a new pane. The recorder refused the duplicate and reported
`Missing or duplicate layout identity.` in `status` until it was corrected.

## Before live installation

- Optional: repeat the OpenCode case with a model reply after signing the VM's
  OpenCode provider in again.
- Add the cloud-init lingering line to both Coder templates.
- Run the native mod check and inspect the panel in the app.
- Keep `uninstall` as the rollback; it is tested on the VM.
