# Checkpoint 3: packaged recorder, controls and installer

Date: 25 November 2026, UTC.
Status: passed for the recorder service, controls and installer on a Coder test VM.
Not passed: the native mod check. The OpenCode guard passed on 27 November.

## Bottom line

The installer, recorder service, preview, restore, reconcile and uninstall work
against a real `hc 0.1.21` default core on the test VM `michael-workspace`.
Two defects that would have broken a live installation are fixed:
capture rejected every real herdr-app layout, and a failed gateway left a
terminal with no shell.

## Fixed in this checkpoint

- `ee9c8f6`: herdr-app 0.1 gives each tab's root split the tab's own id.
  `validateLayout` treated that as a duplicate, so every live capture failed.
  The fix accepts only a root that reuses its own tab's id.
  The live WSL layout (7 tabs) now validates; a read-only capture of the live
  WSL core found 5 exact Claude sessions across two Claude profiles and 1 tuicr review.
- `8a3998d`: the core shell now runs `/bin/sh native-shell.sh NODE native-shell.js ... -- SHELL`.
  If the pinned Node executable is gone, for example after a mise upgrade,
  the launcher opens the wrapped shell directly.
  A gateway error, for example an unreadable configuration, also opens the
  wrapped shell. Before, both cases closed the terminal with exit code 1.
- `8a3998d`: `native-install.js uninstall --prefix DIR` restores each changed file
  from the installation record. It changes nothing if any file differs from
  what was installed.

## Checks

| Check | Where | Result |
|---|---|---|
| `npm test` | WSL and test VM | 59 pass |
| `npm run test:integration` | test VM | 7 pass |
| `npm run test:guard` | test VM | Pass on 27 November after the OpenCode database was moved aside; failed before, see below |
| Install plan, apply, activate | test VM | Pass |
| Uninstall after real install | test VM | Pass; core shell restored to `fish`, service removed, snapshots kept |
| New terminal through installed launcher | test VM | Pass; process is `fish` |
| Native mod check (`herdr-app check`) | — | Not run |

## Not passed

- OpenCode guard: the VM had OpenCode 1.18.34 from August.
  Upgrading it to 2.4.1 started a migration of a 17.5 GB database on a
  throttled disk. The OpenCode service then hung in uninterruptible disk wait.
  OpenCode uses one service per user on a fixed port (49374), so an isolated
  data directory does not isolate the test. The guard code is unchanged and
  still lacks acceptance proof.
- Native mod check and visual inspection need the Windows app.

## Findings for installation

- The installer pins absolute versioned paths, such as
  `mise/installs/node/24.16.0/bin/node`, in the core shell and the service unit.
  The launcher makes a missing Node safe for terminals. The recorder service
  fails visibly instead; reinstall after a Node removal.
- Coder SSH sessions do not set `XDG_RUNTIME_DIR`. Set it to `/run/user/$(id -u)`
  before `systemctl --user` or the installer.
- The test VM's fish configuration replaced every interactive shell with
  `tmux`. The recorder then reported shells as `unsupported`. coder-giant does
  not have this file; the VM copy was renamed to
  `~/.config/fish/conf.d/zz-tmux-autostart.fish.herdr-test-disabled`.
