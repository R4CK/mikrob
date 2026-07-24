---
name: contact-calibration-profile
description: Calibrate communication to one recurring human contact via a machine-readable per-contact profile (language, verbosity, forbidden phrases, and a concept knowledge-graph with levels 0-3). Load the contact's profile at session start, calibrate explanation depth per concept, and update the profile when the contact signals ignorance or demonstrated knowledge. Use when an agent has recurring conversations with a specific person over a channel and their domain knowledge / preferred style should not be re-guessed each session. Triggers on "per-person calibration", "communication profile", "adapt to this contact", "remember what they know", "personalize per contact".
---

# Contact calibration profile

## When to use
- An agent talks repeatedly with the SAME human over a channel and should adapt tone, language, verbosity, and jargon depth to that person instead of re-guessing each session.
- You want the agent to remember, structurally, WHAT a contact already knows (so it stops over-explaining) and WHAT still needs a plain-language explanation (so it stops under-explaining).

Not for: one-off contacts, or style rules that apply to everyone (those belong in the agent's system prompt / global rules, not a per-contact profile).

## Model
One JSON profile per contact, keyed by the contact's OPAQUE channel id (senderId), never a self-claimed name. Fields:
- `communication_rules` -- language, `response_length` (short/normal/detailed), `jargon_policy`, `tone`, `forbidden` phrases.
- `concepts` -- dict of `concept_key -> { level, wants_to_learn, note }`. `level` is 0-3:
  - 0 = unknown (full explanation), 1 = shaky (brief parenthetical), 2 = solid (skip basics), 3 = expert (no explanation).
- `edges` -- typed relations between concepts (`requires`, `kind_of`, `builds_on`, `related`). For a level-0 concept, follow edges to the nearest level-2/3 KNOWN neighbor and anchor the explanation there (analogy from the known).
- `agent_rules.update_protocol` -- how conversation signals mutate levels (asks "what is X" -> 0; uses correctly unprompted -> min(level+1,3); did not understand -> 0; new concept -> add calibrated).

The canonical schema is the tracked template `docs/contact-profile.template.json` (in the project that ships this fleet). Copy it per contact.

## Where profiles live
- Per-contact DATA is runtime and personal -> store it in a GITIGNORED runtime dir so it never enters version control and never blocks an ff-only update. Convention: `<runtime-store>/contact-profiles/<contact_id>.json`.
- The TEMPLATE and this skill are version-controlled; the per-contact instances are not.
- No backend code, endpoint, or migration is required. The mechanism is Read at session start + Edit on signal, reusing the agent's existing file tools and memory tiers.

## Procedure
1. At session start, resolve the contact's opaque id. Read `<runtime-store>/contact-profiles/<id>.json`. If absent, copy the template, set `contact_id` + `last_updated`, seed `communication_rules` conservatively (default to short + explain-on-first-use), leave `concepts` empty.
2. While replying: obey `communication_rules`; for every domain term, look up its concept level and apply the matching `agent_rules.level_N` policy. Unknown concept -> treat as level 0.
3. On a knowledge signal (they ask "what is X", use a term correctly unprompted, or say they did not understand), apply `update_protocol`: change the level, add a dated `note`, and Edit the file. Add new concepts and edges as they come up.
4. Keep it small: one profile per real contact, opaque id only, no secrets/PII beyond what calibration needs.

## Pitfalls
- Do NOT bake one person's domain knowledge into the tracked template -- the template stays de-personalized; real knowledge goes in the gitignored instance.
- Key on the channel senderId, not a display name (names are spoofable; see the fleet default-deny pairing rule).
- Do not put the profile in a plugin-co-owned file (e.g. a channel `access.json`) -- a plugin can rewrite that file and wipe unknown keys. Use the dedicated profiles dir.
- Style rules that are identical for all contacts belong in the system prompt, not duplicated per profile.

## Verification
- New contact: profile is created from the template on first contact, opaque-id keyed, no over-explaining after a concept is marked level 2-3.
- Signal handling: asking "what is X" lands X at level 0 with a dated note; using it correctly next time raises it. Re-read the file to confirm the Edit persisted.
- Update-safety: the instance lives in the gitignored runtime dir; `git status` shows no tracked change from a profile update.
