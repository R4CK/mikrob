/**
 * Card 81593084 (MT P2 / MT-10): run the decision/finding/lesson/anti-pattern importers against
 * the live databases.
 *
 *   pnpm exec tsx scripts/kg-import-mt10.ts
 *   pnpm exec tsx scripts/kg-import-mt10.ts --db /tmp/x.db --kg-db /tmp/x-kg.db --decisions-md /tmp/DECISIONS.md
 *
 * Idempotent -- safe to run again as DECISIONS.md/cold memories/kanban_verdicts grow (see each
 * importer's own header comment for why). All the work is in src/kg/import-mt10-cli.ts's
 * runImportMt10Cli() -- it lives there, not here, so a test can drive it with its collaborators
 * mocked (same reasoning as scripts/kg-backfill.ts).
 */
import { runImportMt10Cli, defaultImportMt10CliDeps } from '../src/kg/import-mt10-cli.js'

runImportMt10Cli(process.argv.slice(2), defaultImportMt10CliDeps())
