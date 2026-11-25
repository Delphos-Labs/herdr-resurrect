# Checkpoint 4: lifecycle recovery on a Coder VM

Date: 25 November 2026, UTC.
Status: partial. Scheduled stop and core-only restart passed for shells and tools.
Not yet run: real agents after a VM stop, abrupt stop, desktop app recovery.
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
| Real Claude and OpenCode after VM stop | Not run. Claude is not signed in on the VM; OpenCode is blocked, see checkpoint 3 |
| Desktop app recovery and rendering | Not run |

## Before live installation

- Run the real-agent case after a VM stop: sign Claude in on the VM, start a
  Claude session in the test core, stop and start the VM, restore, and check
  that the conversation resumes.
- Add the cloud-init lingering line to both Coder templates.
- Run the native mod check and inspect the panel in the app.
- Keep `uninstall` as the rollback; it is tested on the VM.
