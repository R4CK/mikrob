/**
 * Card 7c9be2d8 (MT F6 / MT-06): backfill existing 'done' kanban cards into the knowledge graph.
 *
 *   pnpm exec tsx scripts/kg-backfill.ts                   # one batch, size = KG_BACKFILL_BATCH
 *   pnpm exec tsx scripts/kg-backfill.ts --limit 100        # calibration pass (MODULTERV section 0)
 *   pnpm exec tsx scripts/kg-backfill.ts --db /tmp/x.db --kg-db /tmp/x-kg.db
 *
 * PASS --db/--kg-db, OR RUN IT FROM THE MAIN CHECKOUT -- same trap as kanban-relations-backfill.ts:
 * without --db the main DB path comes from STORE_DIR of THIS checkout.
 *
 * Processes ONE batch per invocation (up to the limit) and stops. Run it again for the rest --
 * repeated invocation is the "kötegelve" (batched) half of the card; capture is local-LLM-only
 * (MODULTERV section 5) and never falls back online when the GPU gate holds, so a run that
 * reports haltedOnGpuHold just needs retrying later, not a different model.
 *
 * All the work is in src/kg/backfill-cli.ts's runBackfillCli() -- it lives there, not here, so a
 * test can drive it with its collaborators mocked; a top-level script cannot be imported and
 * re-run per test case (same reasoning as src/claude-plan-rotate-check-run.ts).
 */
import { runBackfillCli, defaultBackfillCliDeps } from '../src/kg/backfill-cli.js'

runBackfillCli(process.argv.slice(2), defaultBackfillCliDeps())
