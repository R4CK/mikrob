/**
 * Card 5ecf6133: one-time repair for the kg_anchors rows capture-pipeline.ts used to write with
 * path = kanban_comments:<id> instead of a real file (343/343 rows, measured on eed988e7).
 *
 *   pnpm exec tsx scripts/kg-anchor-path-backfill.ts --dry-run
 *   pnpm exec tsx scripts/kg-anchor-path-backfill.ts --backup /tmp/kg-anchor-backup.json
 *   pnpm exec tsx scripts/kg-anchor-path-backfill.ts --restore /tmp/kg-anchor-backup.json
 *
 * All the work is in src/kg/anchor-path-backfill-cli.ts so a test can drive it with its
 * collaborators mocked -- a top-level script cannot be imported and re-run per test case.
 */
import { runAnchorPathBackfillCli, defaultAnchorBackfillCliDeps } from '../src/kg/anchor-path-backfill-cli.js'

runAnchorPathBackfillCli(process.argv.slice(2), defaultAnchorBackfillCliDeps())
