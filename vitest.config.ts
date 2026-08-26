import { defineConfig, configDefaults } from 'vitest/config'

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate. Keep all vitest
// defaults; only carve out the e2e directory.
//
// agents/** is gitignored, live-install-only runtime data: each role-agent's
// .claude-config symlinks into ~/.claude/external/claude-agent-sdk, so a bare
// `vitest run` on a live checkout collects the vendored SDK's example test
// suite once per agent (thousands of duplicate, unrunnable live.test.ts
// files with no DB/creds), drowning any real signal. Excluded so the suite
// stays meaningful if ever run outside the mandated worktree.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/smoke/**', 'agents/**'],
    // Hard gates, run in every worker before any test module is imported:
    //  - assert-not-live-install: refuse to run inside a live install (see that
    //    setup file's header for the 2026-07-27 incident it prevents).
    //  - assert-supported-node: refuse to run on a Node whose ABI the installed
    //    native modules were not built for, which otherwise reds out 40 files
    //    with errors that look like bugs in those files (2026-08-17).
    setupFiles: [
      './src/__tests__/setup/assert-not-live-install.ts',
      './src/__tests__/setup/assert-supported-node.ts',
    ],
  },
})
