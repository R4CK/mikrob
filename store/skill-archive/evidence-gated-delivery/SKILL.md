---
name: evidence-gated-delivery
description: A project-agnostic software delivery methodology distilled from a production multi-agent fleet's own hard-won practice. Use when starting or governing a software development project (solo or multi-agent), when you need a quality process that catches real defects instead of vacuous green checks, when "it's done" claims need to mean something, or when explicitly asked for a development methodology / delivery discipline / project governance model. Triggers: "set up our dev process", "how should we structure this project", "methodology", "delivery discipline", "quality gates", "definition of done".
---

# Evidence-Gated Delivery

A methodology for shipping software where "done" is a measured claim, not a report. Distilled from
a production fleet that discovered, the hard way, every failure mode a pure-discipline process has:
a magic-link auth feature that passed 151/151 tests while hiding 2 MAJOR bugs; gates that stayed
green while a guard was silently disabled; REVIEW comments that cited the wrong commit; decisions
made once and re-litigated forever because nobody wrote them down.

The core insight: **a claim of completeness is worth nothing until something independent of the
claimant has measured it.** Every rule below exists because a specific failure mode was observed
without it, and every rule is written as a structural mechanism where possible, not a plea for
discipline — discipline is forgotten under load; a mechanism is not.

## 1. Decompose before you build

Break work into a real hierarchy — phase → task → subtask → step, as deep as the work needs. A
one-line task description hides the actual decisions inside it; decomposing surfaces them before
code gets written around an unstated assumption.

For any decomposed unit that is **risky or hard to reverse** (architecture choice, auth/payment/
data-model change, anything touching a trust boundary), grill the plan before work starts, not
after: state assumptions explicitly, surface every interpretation instead of silently picking one,
name the simpler alternative if one exists, and stop and ask when something is genuinely unclear.
Skip this for trivial, well-understood work — the cost of the process must be proportional to the
risk it prevents.

## 2. Nobody verifies their own work

Every unit of completed work needs at least one independent reviewer who did not build it, and for
anything touching a trust boundary (auth, money, PII, multi-tenant scope, file upload, superadmin,
crypto, a new public/unauthenticated surface), a **security-specific** reviewer — someone whose job
is to break it, not confirm it. A green test suite the author wrote is evidence of the author's
mental model, not of the system's actual behavior; it is not sufficient on its own, ever.

Tier the reviewer count to the actual risk, not a fixed ritual: routine internal work needs one
independent functional reviewer; anything touching a trust boundary needs a second, security-
focused reviewer; high-stakes work (public write path, auth, release-adjacent) needs a third,
adversarial reviewer who actively tries to defeat the control, not just read the diff.

## 3. A reviewer must reproduce, not just read

The single highest-leverage habit in this methodology: **a reviewer who only reads the diff and the
author's explanation will believe the author's framing.** A reviewer who writes their own mutation
(revert the fix, remove the guard, flip the condition) and re-runs the suite finds out whether the
test actually constrains the behavior it claims to. Every non-trivial verdict in this methodology's
source project was won or lost on whether someone ran an independent probe instead of trusting a
report — a hard-drop rate limiter that "never fires" because the wrong event resets its counter is
invisible to a reviewer who reads the code and agrees it looks right; it is obvious to one who tries
500 wrong attempts and watches the counter stay at zero.

Concretely: reproduce the claimed defect before it's fixed (confirm the bug is real), then reproduce
the claimed fix after (confirm the specific mutation that caused the bug now fails a test). A test
that stays green under both the buggy and the fixed version measured nothing.

## 4. State the source you gated, not the source you were told about

A "done" claim and a "gated" claim must point at the exact same content. In a shared or branching
repository, the commit a reviewer looked at and the commit that eventually lands are not
guaranteed to be the same object — a rebase, a squash, a parallel merge, or a manual conflict
resolution can all change it silently. State the exact commit/hash a review or verdict covers, in a
fixed, greppable place (start of the comment, not buried mid-paragraph) — this is cheap to write
and removes an entire class of "the gate approved content that never actually shipped" defects. When
re-affirming an earlier verdict, restate the **full set** of content you have ever verified on this
unit of work, not just the newest piece — a narrower restatement reads as narrowed coverage.

## 5. Write the decision down, once, where it can be found again

Every consequential decision — an architecture choice, a scope cut, a "we're not fixing this now
and here's why," a reviewer's approval or rejection — goes into an append-only, grep-able decision
log in the project root (`DECISIONS.md`), dated, in the same unit of work that made the decision.
A decision that lives only in chat history or a comment thread gets re-asked, re-argued, and
re-decided differently every time someone forgets it happened. This is cheap and it is the single
most-skipped step under time pressure — make it part of the actual definition of done, not an
afterthought, and treat a missing entry as blocking exactly like a missing test.

## 6. Prefer a mechanism over a rule

A written rule is forgotten under load; a rule enforced by the tooling is not. Whenever a
discipline-based rule keeps getting missed (the same reviewer note appearing three times on
different units of work is the signal), stop re-stating the rule and build the check: a pre-commit
or pre-review hook that verifies the decision-log entry exists, a linter that catches the specific
mistake, a bot that blocks a status change until a condition is met. The written rule stays in force
while the mechanism is being built — a rule "in the process of becoming structural" is not yet
structural, and this stays true until the check actually runs, not merely until someone commits to
building it.

## 7. Never revert working, shipped functionality without explicit owner sign-off

Once something is built and verified working, changing or removing it requires the person who owns
the product's judgment — not the implementer's opinion that a different approach is better, and not
an incidental collision with an unrelated refactor. If a change would unavoidably touch shipped
behavior, stop, name exactly what would be affected and how, and ask before touching it. Where
feasible, put a specific list of protected surfaces behind a structural guard (a hook that blocks
edits to named files/routes without an explicit override reference) rather than relying on everyone
remembering which parts are off-limits.

## 8. Regressions in coverage are failures, not cleanup

Before touching code near an existing, working feature, know the passing test count for that area.
After the change, the same or a larger set of real, meaningful assertions must still pass. A test
that silently disappears, or one that stays green while checking nothing, is a failure regardless of
how much better the surrounding code looks — a guard test that only pins a bug in place, or an
assertion built from the same formula it's supposed to check, passes for the wrong reason and must
be treated as a finding, not a pass.

## 9. Every risky change ships behind a flag or a branch

A change with real blast radius — an untested architecture shift, a security-control redesign, a
migration — should be reversible without a code rollback: a feature flag, a parked branch, a staged
rollout. This means a bad call costs a flag flip, not an incident. State explicitly, at plan time,
whether the risky part is flagged or branched, and if not, why not — silence on this question is
itself a signal the plan wasn't grilled hard enough.

## 10. Check for an existing solution before building one

Before writing non-trivial code from scratch, look for a maintained library, official SDK, or
well-known pattern (search the ecosystem's package registry, GitHub, and the relevant Q&A sites for
prior art and known gotchas). If a suitable one exists — checked for license compatibility, recent
maintenance activity, and no known supply-chain red flags — adopt or adapt it instead of
reinventing it. If nothing suitable exists, or due diligence finds a real problem, say so briefly
and build it, but make the "we checked and here's why not" reasoning visible, not silent.

## 11. Migrations and irreversible operations need a tested undo, not just a forward path

A schema change, data migration, or other hard-to-reverse operation is not done when the forward
path works. It is done when the rollback path has also been written and actually exercised, not
just assumed to work by symmetry with the forward migration.

## 12. Keep the record of what exists current, and prove it against reality

A project's description of its own capabilities (README, feature list, changelog) drifts from the
truth quietly — an env var gets renamed, a script moves, a feature ships without its entry updated.
Treat this drift as a bug: before closing any unit of work that changes what the system does or how
it's operated, check the record against the actual current code/config, not against memory of what
it used to say. For a project with distinct user roles or access levels, keep the differences
explicit per role, not implied — the same feature is often reached differently, or not at all,
depending on who's using it.

## 13. Never wait on a human when an independent, verifiable next step exists

Once a reviewer's verdict lands, or a unit of work reaches a state with a clear, deterministic next
action, take it immediately — don't queue behind a person who has to notice and dispatch it. A
completed review that just sits there is the single most common way a working process quietly stops
moving; if the next actor and the next action are both unambiguous, self-advance.

## 14. A backend feature without its frontend is not done

Anything user-facing is not complete when the backend endpoint works — it is complete when a real
person can reach it through the actual interface and use it. Every user-facing backend change gets
a paired frontend unit of work, tracked as a pair (each side records a reference to the other, not
just a prose mention — a reference in a comment thread is not durable, a field or line in the
work-item's own description is), and the two are built **concurrently against an agreed contract**
(endpoint shape, types, states), not sequentially with the frontend guessing at the backend's shape
after the fact or bolted on as an afterthought. Skip this only for genuinely internal work with no
user-facing surface (infra, migrations, type-only refactors).

**Wire it into the actual navigation**, not just build the screen: a feature nobody can reach is
undelivered regardless of how correct its code is. And wire every step of its user flow to a real,
working destination — no decorative buttons, no dead ends, no implied-but-unconnected feature. Where
a flow step's destination doesn't exist yet, either build it or say so explicitly (needs-wiring /
needs-build) rather than leaving it silently unconnected; an unwired action is a defect the same way
an unhandled error path is.

**If the user supplied a design reference** (a mockup, a Figma/Stitch export, a screenshot, an
explicit visual spec) **that image is the source of truth**, not a paraphrase of it — build to what
it actually shows, and when something in it is ambiguous, ask rather than improvise a substitute.
Every screen ships responsive and usable at every breakpoint the product targets (mobile and desktop
both, not desktop-only with mobile deferred) — this is part of definition-of-done, not a follow-up
task, and touch targets, layout, and legibility all need to actually work at the smallest supported
width, not just avoid visibly breaking.

## 15. Every error a user can hit needs to be worth reading

A raw stack trace, an unhandled HTTP status, or a bare "something went wrong" is not an acceptable
end state for anything a real user can trigger. Every user-reachable error path needs a message that
says what happened and what to do next, in the product's actual language (from a translation
mechanism, not hardcoded), and it needs to actually appear in the interface at the point of failure
— inline at the field, a toast, or a dedicated error state with a real recovery action — not just in
a log a developer might read later. Balance this against leaking internals: the user gets something
specific enough to act on; the stack trace, the internal identifier, and anything that would let one
user probe for another's data stay server-side, in the log, not in the response.

## 16. Know the blast radius before you touch shared code, and who owns what you ship

Before editing a file used by many other modules (a shared type, a core utility, a widely-imported
component), find out who actually calls it first — a dependency-graph or "find usages" pass before
the edit, not a red test suite after it. And once a feature ships and is verified working, record
who built it and which unit of work shipped it, in one durable, visible place — so a future change
request knows whom to ask before touching it, without needing to reconstruct the history by hand.

Items 17-19 below are built from three ideas in the loki-mode skill (github.com/asklokesh/loki-mode,
BSL 1.1, reviewed at commit 2b8f4b58) — own wording and own examples throughout, not its text. Per
this fleet's internal-use approval for that skill (card 21d5a84c), this is for strictly-internal
fleet use; moving it into mopsion, a customer deliverable, or any external release needs a fresh,
case-by-case legal sign-off first, the same as the skill it's drawn from.

## 17. Separate verified facts from AI judgment, in a reproducible receipt

A "done"/gate verdict comment mixes two different kinds of claim: a FACT ("the test command exited
0", "the diff touches these 4 files", "this guard is present at line N") and a JUDGMENT ("this looks
correct", "I believe this handles the edge case"). Collapsing them into one paragraph lets confident
wording stand in for verification. State facts and judgment in two visibly separate groups — a short
deterministic-fact block (command run, exit code, file/line, a diff or commit identity) followed by
the assessment that interprets them — so a reader (or a later re-check) can re-derive the fact block
from the live repo without re-trusting the author's framing. Where a mechanism already records this
instead of prose (a committed Gate-SHA line, an atomic-fact table — see atomic-fact-gate-protocol),
prefer the mechanism; this item generalizes the practice to any review or status report, not only
the formal gate pool's.

## 18. Reserve evaluation cases the builder never saw

A test suite the implementer wrote (and iterated against) measures whether the implementation
satisfies the tests the implementer thought of — not whether it's actually correct; this is exactly
how the magic-link feature referenced above shipped 151/151 green while hiding 2 MAJOR bugs. For
anything gated by a test/eval set, where practical, keep a subset of cases the implementer does not
see or tune against until gate time — written by the reviewer, by a spec that predates the
implementation, or sampled from real failures the implementer wasn't shown. A pass on only the
implementer's own known set is weaker evidence than a pass that includes at least one held-out case;
for an LLM/AI feature's eval set specifically, see ai-evals for the full golden-set + rubric
methodology.

## 19. A failing step should change its approach, not just repeat it

A retry that reruns the exact same action after a failure mostly reproduces the same failure (and
burns the same cost again). Structure recovery as: capture what failed and why, then change
something about the approach before retrying — not just resubmit it unchanged. After a small number
of failed attempts with the same approach, switch to a simpler or different one, or escalate the
step itself to the owning role-agent, to MikroB, or to a human, rather than continuing to loop; once
it keeps failing, stop and surface it rather than silently dropping it. Never resolve a failing check
or test by loosening what it verifies — simplify the approach being attempted, not the bar it has to
clear. The fleet already applies this instance-by-instance (a local-model draft falls back to the
online path after its attempt ceiling — today 2, store/offload-dispatch.sh — not a fixed universal
number; a quota-exhausted path defers rather than retrying blind) — treat it as a general principle
for any multi-attempt automated step, not a one-off per mechanism.

## When this is overkill

All nineteen items scale with risk and reversibility. A one-file bug fix in a hobby project doesn't
need a decomposed plan, three reviewers, and a flagged rollout — apply judgment. The discipline this
methodology defends is real: catching a hidden regression before it ships, at the cost of one
independent mutation test, is worth far more than the ritual of running one. Apply it where the cost
of being wrong is high, and use plain engineering judgment everywhere else.
