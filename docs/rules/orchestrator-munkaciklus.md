## Orchestrátor munkaciklus: fázis -> skill (Peti 2026-10-24, Telegram 12174/12178/12181)

MikroB orchestrator és projektmenedzser. Minden érdemi kérésnél ez a sorrend; a fázis skilljét a `Skill` toollal töltsd be, ne fejből dolgozz. A lenti szabályok részletei a fájl további részében, ez a tábla a belépési pont.

| # | Fázis | Skill(ek) | Mikor |
|---|---|---|---|
| 1 | Bejövő kérés | `interview-me`, `idea-refine`, `problem-definition` | ha a cél vagy a kész állapot nem egyértelmű; nyers ötlet; probléma-megfogalmazás |
| 2 | Elemzés | `code-comprehension`, `module-spec-design`, `writing-prds`, `evaluating-trade-offs` | meglévő kód / modul / funkció / döntési helyzet; mély kódelemzés -> `codebase-auditor` vagy `elemzo` delegálás |
| 3 | Bontás, terv | `project-workflow`, `sp-writing-plans`, `scoping-cutting`, `prioritizing-roadmap` | minden nem-triviális munka: 4 szint, `parent_id`, predecessor-él, `Kész, ha:` |
| 4 | Grilling | `plan-grilling`, `grill-with-docs`, `doubt-driven-development`, `karpathy-guidelines` | MINDEN esetben, amikor szükséges (nem csak a kockázatos Fázison): az `elemzo` ügynök bevonásával, a Karpathy-elvek mentén (feltételezések, egyszerűség, ellenőrizhető cél); a `grill-with-docs` grilling közben ADR-t és GLOSSARY-t ír |
| 5 | Dispatch | `contract-first-codev`, `local-llm-offload`, `sp-dispatching-parallel-agents` | BE+FE pár; mechanikus rész helyben; párhuzamos ágak. Az üzenet a 4 blokkos formát követi, és megnevezi a kártyához illő skill(eke)t |
| 6 | Gate, zárás | `atomic-fact-gate-protocol`, `kanban-blokkolt-reconcile`, `approval-request-handling` | gate-kijelölés, `gate-closure-check.py` explicit gate-listával, Peti-jóváhagyás |
| 7 | Git, landolás | `gate-worktree-pattern`, `sp-finishing-a-development-branch`, `github-pr-rebase-merge`, `wsl-git-push-deploy-key`, `update-safety` | MikroB hozza meg a merge/PR/push döntést, ha kell (Peti 12181): `marveen-land.sh` / `mopsion-land.sh`, zárás előtt `git merge-base --is-ancestor <gate-sha> origin/develop`. Élő `update.sh`/restart továbbra is csak Peti jóváhagyásával |
| 8 | Dokumentálás | `project-decisions-log`, `documentation-and-adrs`, `domain-modeling`, `fleet-handoff`, `retrospective` | döntés -> DECISIONS.md (mindig a fájl végére); Fázis-záráskor retrospektív + mérés; projekt-fogalomtár: `domain-modeling` |
| 9 | Önkarbantartás | `context-engineering`, `consolidate-memory`, `dream`, `skill-management`, `quota-management` | rossz ügynök-kimenet, memória-konszolidáció, skill-patch, kvóta |
| 10 | Kommunikáció | `telegram-reply-fallback`, `humanize-writing` | reply tool hiánya; Petinek menő hosszabb szöveg |

**Tisztázó kérdés formája (Peti 12181):** ha egy válasz alapján a flow több irányba ágazik, kérdezz EGYESÉVEL (`interview-me`); ha a kérdések nem épülnek egymásra, mehetnek EGY CSOMAGBAN.

**Mérés:** a `skill_usage` mikrob-sorai fázisonként (store/skill-coverage-report.sh); egy fázis, aminek skillje két hétig nem töltődik be, vagy kimarad, vagy a tábla rossz -- mindkettő javítandó.
