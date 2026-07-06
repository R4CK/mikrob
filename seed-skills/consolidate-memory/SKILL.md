---
name: consolidate-memory
description: Reflective consolidation pass over a file-based agent memory (hot/warm/cold tiers + a MEMORY.md index) — dedupe, merge, retier, prune stale entries, and repair the index. Use periodically (e.g. from a Dream-Engine / retrospective run) or when memory has grown noisy: duplicate facts, stale hot-tier items, superseded entries, or a MEMORY.md index that has drifted from the files on disk. Trigger on "consolidate memory", "clean up memory", "memory health", "memoria-egeszseg", "dedupe memories".
---

# Consolidate Memory

A file-based memory rots the same way a codebase does: duplicates accumulate, "hot" facts go cold without being moved, superseded facts sit next to the truth, and the index drifts from what's actually on disk. This is the periodic garbage-collection pass.

## When to use
- A scheduled reflective run (Dream Engine, `/retrospective`, weekly hygiene).
- After a burst of memory writes (a long project where many hot-tier notes piled up).
- When `MEMORY.md` (the always-loaded index) no longer matches the files in the memory dir.
- NOT after every single write — this is a batch pass, not a per-note operation.

## Procedure (approval-gated: propose, then apply)
1. **Inventory.** List every memory file + read the `MEMORY.md` index. Note each file's `metadata.type`/tier (hot/warm/cold/shared for this fleet; or user/feedback/project/reference), `description`, and last-modified.
2. **Detect duplicates & overlaps.** Group files whose facts substantially overlap. Two memories asserting the same thing → MERGE into the more complete one, preserve every distinct detail and any `[[links]]`, delete the redundant file. Never lose a unique fact in a merge.
3. **Retier.** A "hot"/active-task memory whose task is DONE → move its durable lesson to cold (or the daily log) and delete the hot entry. A warm/config fact that changed → update in place. Stale-but-historical → cold/archive.
4. **Prune superseded.** A memory contradicted by a newer one, or describing a file/flag/API that no longer exists (VERIFY against current code before deleting), → delete, and fix any `[[links]]` that pointed to it.
5. **Repair the index.** Every kept file has exactly one `MEMORY.md` line (`- [Title](file.md) — hook`); every index line points to a real file; dead index lines removed; new files added. The index must match the dir 1:1.
6. **Report + gate.** Emit the proposed changes (merge X+Y→Z, retier A, delete B, index fixes) and — unless autonomy is set to auto — get approval before deleting/overwriting. Deletion is the one-way door; propose it, don't just do it.

## Buktatók
- **Merges lose facts.** The failure mode is merging two memories and silently dropping a detail only one of them had. Diff the union of facts, not the prose.
- **Don't delete on a stale claim.** A memory saying "file X does Y" may be outdated, not wrong — verify X against current code before pruning (memories are point-in-time).
- **The index is load-bearing.** `MEMORY.md` is injected every session; a broken link or a stale line there is worse than a stale file (it misleads recall). Fix the index last, after the files settle.
- **Semantic vs keyword recall:** if the store also has a vector/embedding layer, a consolidation changes what's embedded — re-run the embedding backfill after, or note it. (On this fleet, embeddings run via a user-local Ollama; see [[ollama-not-installed-keyword-only-search]].)
- **Approval-gate deletions** unless the autonomy config explicitly grants auto-prune — same discipline as the kanban-archive gate.

## Ellenőrzés
- Every kept fact survived (union-of-facts check on each merge).
- `MEMORY.md` lines == files on disk, 1:1, all links resolve.
- No hot-tier entry references a finished task; no memory contradicts a newer one.
- Proposed deletions were approved (or auto-allowed by config) and logged.
