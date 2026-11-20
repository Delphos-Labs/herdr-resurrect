# Herdr recovery: working map

This directory records the native-mod port of the Delphos Herdr recovery fork.

| File | Purpose | Read when |
|---|---|---|
| [plan.md](plan.md) | Scope, design, risks and proposed checks | Approving work or starting a checkpoint |
| [checkpoint-index.md](checkpoint-index.md) | Current progress | Resuming work |
| [prior-art.md](prior-art.md) | Sources and verified compatibility limits | Checking a design claim |
| [checkpoint_1_results.md](checkpoint_1_results.md) | Linux feasibility proof and remaining limits | Reviewing checkpoint 1 or starting checkpoint 2 |
| [checkpoint_2_results.md](checkpoint_2_results.md) | Real conversation and tool recovery proof | Reviewing checkpoint 2 or starting checkpoint 3 |
| `checkpoint_N_results.md` | Findings from each completed checkpoint | Starting the next checkpoint |

Read the checkpoint index first when resuming. Then read the relevant plan
section and the preceding results file. Results files do not exist until their
checkpoint completes.

Update the plan when evidence changes its assumptions. Record the discovery in
the checkpoint results too. Completed results are append-only; append corrections
rather than rewriting the earlier finding.

Update the index after each checkpoint. Ask Michael before committing or
installing changes that start programs in his live sessions. Never test recovery
by stopping his current app, core or agents.
