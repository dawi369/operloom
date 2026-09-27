# Main-branch fixes before Polymancer

Planned against `2bb9ec0` on 2026-09-26. Status below tracks implementation and verification. Read each plan's drift check and STOP conditions before editing. Existing `plans/` is an archived release-plan set and must remain untouched.

| Order | Plan                                                                                 | Priority | Effort | Status                           |
| ----- | ------------------------------------------------------------------------------------ | -------- | ------ | -------------------------------- |
| 1     | [Make runtime freshness truthful and recoverable](001-runtime-freshness-recovery.md) | P1       | S      | DONE                             |
| 2     | [Present runs and artifacts progressively](002-progressive-run-results.md)           | P1       | M      | DONE — local browser gate passed |
| 3     | [Add a bounded pack outcome gate](003-pack-outcome-gate.md)                          | P2       | M      | DONE                             |

Plans 1 and 2 are the pre-Polymancer product gate. Plan 3 is the developer-quality gate; it may proceed independently after the first two, but it must not introduce hosted tracing or a prompt corpus. Update this index when each plan lands.

Do not put Polymancer-specific market logic, credentials, mutation capability, or hosted LangSmith integration into main as part of these plans. A Polymancer fork/branch can then supply its own pack behavior and domain renderer and return reusable workbench changes through reviewed PRs.
