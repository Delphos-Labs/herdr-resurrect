# Recovery checkpoints

This is the status index for [the plan](plan.md). See [README.md](README.md) for navigation.

| Checkpoint | Scope | Status | Key finding | Results |
|---|---|---|---|---|
| 1 | Prove host-owned capture, exact identity and layout recovery | Complete | Linux recorder survives launcher exit and isolated core restart; exact IDs and weighted layout data persist | [Results](checkpoint_1_results.md) |
| 2 | Prove real-agent recovery before more interface work | Complete | Real conversations recalled original codes after core loss; tools restored and repeat launches were zero | [Results](checkpoint_2_results.md) |
| 3 | Package services and native controls; finish tool recovery | Passed except OpenCode guard and mod check | Live layouts failed validation and a failed gateway left no shell; both fixed. Uninstall added and tested | [Results](checkpoint_3_results.md) |
| 4 | Verify scheduled-stop, abrupt-stop and desktop recovery; install | Partial | Coder stop and `hc-serve` restart recover shells and tools; boot recovery relies on a cloud-init race for lingering | [Results](checkpoint_4_results.md) |

Michael approved the revised plan and checks. This is non-SOC work; no Linear issue is required.
Checkpoint 2 proves real Linux program recovery after isolated core loss.
Native UI acceptance and operating-system lifecycle checks remain later gates.
Michael approved continuing with service and interface packaging. Live installation remains gated.
