# Recovery sources

These findings support [the recovery plan](plan.md). They describe inspected sources, not tested recovery.

| Source | Evidence | Consequence |
|---|---|---|
| [Original Herdr plugin](https://github.com/ntindle/herdr-resurrect/tree/dab5bed632ccb28b480ae1bd601b4f60a41f66f1) | Manifest requires old `herdr >= 0.7.0`; backend invokes `workspace` and `pane` commands | Keep the fork, replace its host integration |
| [Original snapshot storage](https://github.com/ntindle/herdr-resurrect/blob/dab5bed632ccb28b480ae1bd601b4f60a41f66f1/lib/snapshot.js) | Versioned snapshot files, atomic replacement and retention | Reuse storage behavior where it fits the new machine-aware model |
| [Original agent commands](https://github.com/ntindle/herdr-resurrect/blob/dab5bed632ccb28b480ae1bd601b4f60a41f66f1/lib/agents.js) | Claude resume and continue support; no OpenCode resolver | Add exact OpenCode identity; do not use generic continuation as proof of identity |
| [Original agent-store lookup](https://github.com/ntindle/herdr-resurrect/blob/dab5bed632ccb28b480ae1bd601b4f60a41f66f1/lib/agent-sessions.js) | Directory and modification-time matching | Reject this fallback when it cannot prove the conversation |
| [Delphos tmux fork](https://github.com/Delphos-Labs/tmux-assistant-resurrect) | Inspected code tracks per-process OpenCode and Claude identities and constructs exact resume commands; Michael reports successful prior recovery | Port existing identity and resume behavior without depending on or recovering tmux |
| Installed Herdr guide and `herdr.d.ts` | Native JavaScript mods, machine-aware `exec`, timers and command actions | Package recovery as a native mod with bundled helpers |
| Installed Windows `hc` and `herdr-app` | `hc 0.1.21`, app `0.1.16`; Windows core knows Debian and Coder | Coordinate through the app's machine registrations, not Debian's empty registry |
| Read-only core `doc.get` probes | Both machines expose `herdr-app` documents with spaces, tabs and tab-root trees; Coder sample includes a weight | Layout capture is possible; exact safe replay remains unproved |
| Node probes on Windows, Debian and Coder | Versions 23.11.0, 24.16.0 and 24.16.0 | Bundled Node helpers need no new runtime on these machines |
| Coder tmux inventory | `btop`, `gh dash`, shells and supervisor wrappers; live Claude and OpenCode processes | Cover actual agents and allowlisted tools; do not blindly replay wrappers |
| Coder tmux options and filesystem | Recovery hooks refer to `/home/coder/delphos_labs/tmux-assistant-resurrect`, which is absent | Existing hook configuration is not evidence that recovery currently works |
| Fork tooling | `package.json` exposes operational commands but no test command; no test suite or pre-commit configuration found | Add explicit tests before implementation |
| Michael's plan-review comments, 19 November 2026 | VM starts and stops on schedule; desktop can disconnect beforehand; desktop shutdown also needs browser-like recovery | Continuous host-owned recording is required; app-open-only timers do not meet the need |
| Michael's plan-review comments, 19 November 2026 | Add tuicr, support client handoffs and drop tmux | Preserve review identities and annotations; keep durable state independent of clients; no tmux recovery |
| [herdr-wake 0.1.1](https://github.com/Heretikio/herdr-wake/tree/09b80a8ce664d894c87ae06eed3b5560ba2621fb) | Native core recovery companion supports hc 0.1.16 and newer; agent hooks and a shell wrapper, not a desktop mod; no general tool adapters | Reuse lifecycle ideas where useful, but do not install a second recovery engine or override the user's core shell |
| [Tuicr review schema](https://github.com/Delphos-Labs/tuicr/blob/main/src/model/review.rs) and installed tuicr 0.28.0 | A full-file review has `diff_source: file`; `base_commit` is a path hash | The earlier helper-derived fixture was wrong; the native tool adapter now uses the observed discriminator |
| Real tool acceptance, `.local/acceptance/6bcaeee6-2a9b-4006-a76d-625538c43290/receipt.json` | Real tuicr annotations, btop metrics and a configured gh-dash section returned after isolated core loss; repeated restore started nothing | Tool recovery has an actual runtime proof, not only stand-in processes |
| [herdr-mobile](https://github.com/juanibiapina/herdr-mobile) and [Heeler core guide](https://docs.heeler.bybee.dev/herdr-core) | Document same-host access to existing core terminals; the exact installed version pair remains untested | Mobile handoff has existing clients to validate; do not build a new client or claim compatibility yet |

The installed Herdr guide and type declarations live at
`C:\Users\micha\.config\herdr-app\AGENTS.md` and
`C:\Users\micha\.config\herdr-app\herdr.d.ts`.

No source inspection proves that live in-flight tool calls can survive a host
restart. Recovery means reopening saved conversations and tools, not continuing
an interrupted process from its exact machine state.

The host-owned recorder, reboot ordering and mobile access path are requirements
or proposed mechanisms, not verified existing features. Their feasibility must
be established in the first checkpoint.
