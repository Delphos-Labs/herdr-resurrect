# Native Herdr port

This is an experimental native port, not an installed recovery plugin.
The live recorder and identity adapter currently support Linux, including
Debian under Windows Subsystem for Linux and the Coder host.

## Implemented

- A client for the installed core's line-based `hc connect` protocol.
- Validation and terminal remapping for saved, weighted terminal-only layouts.
- Per-process Claude and OpenCode identity validation.
- An OpenCode terminal plugin that tracks root conversations without tmux.
- Atomic, private snapshots with bounded retention and recoverable writer locks.
- A recorder that runs independently of its launching client.
- Guards against empty post-restart captures and partial agent loss.
- A guarded restore executor with canonical commands and duplicate prevention.
- Capture and restore adapters for full-file tuicr reviews, `btop` and dashboards.

The recorder does not relaunch programs. The separate restore executor is under
acceptance testing. Real Linux core-loss tests passed for Claude, OpenCode,
tuicr, btop and gh-dash; see [the results](../plan/checkpoint_2_results.md).
No service installer or Herdr mod UI is present yet.
Do not replace the installed plugin or restart live agents.

The new OpenCode tracker records process-start evidence. Old tracker files
without this evidence are refused, rather than trusted after process-ID reuse.
The recorder reads Claude's native per-process session records.

## Verification

Use Node 20 or newer and the project's installed dependencies:

```sh
npm ci
npm test
npm run test:integration
```

Integration tests need Linux, `ps` and `hc 0.1.21`. Set `HERDR_TEST_HC` to an
explicit core binary if needed. The tests create their own core session,
runtime directory, configuration and state. They never stop the live core.

Fixtures imitate agent session records and exercise the actual OpenCode
tracker against a controlled UI context. They do not launch paid agent sessions
or prove actual OpenCode plugin loading inside its terminal interface.

## Real acceptance tests

`npm run test:real` is separate from the default tests. It launches real signed-in
Claude and OpenCode terminals and makes short model requests. It uses real
tuicr, `btop` and the installed `gh dash` extension too.

It stops only its isolated cores and test programs. It does not stop the live
core, reboot the machine or install services. Test transcripts and receipts
remain under `.local/acceptance/`.

Set `HERDR_TEST_BTOP` to an existing `btop` binary. The fallback path is the
worktree-local package extracted under `.local/acceptance-tools/btop/`.
This is not a system-wide installation.

The agent test creates a private Claude profile. Explicitly authorize that
profile to trust only its generated test folder:

```sh
HERDR_ACCEPT_WORKSPACE_TRUST=1 npm run test:real
```

The profile records approval only for its generated `.local/acceptance/` path.
It does not change the real user profile or disable tool permission checks.
The test is a failure until actual post-restore histories and tool views pass.

Sign in with `CLAUDE_CONFIG_DIR` pointing at `.local/claude-auth` before the
agent test. That private profile is outside the receipts directory. The test
does not copy credentials and removes the rejected environment API key from
Claude's launch environment. Authentication is checked before model requests.
`HERDR_TEST_CLAUDE_CONFIG_DIR` may select another private profile under `.local/`.

## Manual capture

This command reads the selected core and writes only the specified state
directory. It does not install a service or change the core layout.

```sh
node bin/native-recorder.js --once \
  --state-dir /absolute/persistent/state \
  --opencode-state-dir /absolute/process-tracker/records
```

Without `--once`, the recorder captures once per minute. A terminal-launched
recorder is not a substitute for the host-service installer planned next.
The caller must choose the correct core environment. No command here restores
programs or edits Herdr's installed settings.

Native Windows process capture, service installation, desktop visual acceptance
and the native mod UI remain in later checkpoints. Full-file tuicr recovery is
implemented for testing; other review modes remain unsupported.
