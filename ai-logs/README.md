# AI logs

Every AI session used for this submission, exported unedited from Claude Code (JSONL, one event per line).
This README is the only file here written by us; the transcripts are as the tool saved them.

| File | What it is |
|---|---|
| `01-claude-code-main-session.jsonl` | Main Claude Code session: preparation, planning (PRD), building, testing, reviews, bonus |
| `02-claude-code-fork-session.jsonl` | A fork of the main session used to ask for plain-language explanations of the task |
| `03-subagent-gap-review-1.jsonl` | Read-only review agent started from the main session: found 12 gaps (all fixed) |
| `04-subagent-full-review-2.jsonl` | Second read-only review agent: regression check of the fixes, level-4 rule table |

The fork also contains a copy of review agent 1; it is byte-identical to file 03, so it is included once.

## How AI was used (summary)

- **Plan before code.** Read the brief, PIGEON.md, REFERENCE and the checker/simulator source first, then wrote
  `PRD.md` (HLD, LLD, build order by score) and `AGENTS.md` (commit cadence, reliability and code-style rules).
- **Build in boxes, check after each.** Phase A (webhook + grader) -> `npm run check`; B (outbox, pacing, claim)
  -> 24/24; C (OIDC, tenant guard, WebSocket) -> level 5 15/15; full check 75/75 before any polish.
- **Verify, don't trust.** Every fix was exercised against the running server or simulators (curl / scripts),
  and the provided check was re-run after each batch (75/75 every time).
- **Independent reviews.** Two read-only review agents audited the code against the contract; their findings
  were checked, fixed and covered by tests (claim races, crash on reset upgrade, login CSRF, level-4 answers).
- **Rejected / corrected AI output.** Examples visible in the logs: an outbox design with two writes was
  replaced by a single document; a wrong test expectation (billing timeline) was corrected after reading the
  simulator; a webhook overwrite bug in billing was caught by our own self-test; a port-cleanup command that
  stopped Docker Desktop was found, owned and replaced with `scripts/stop-dev.sh`.
- **Own tests on top of the check:** `npm --prefix scaffold/server test` (unit), `scripts/e2e-selftest.mjs`
  (workflows), `scripts/billing-selftest.mjs` (bonus).
