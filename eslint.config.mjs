// Card 466e411b: the repo had tsc + 384 test files but no static-analysis linter, so a whole
// class of bug (floating promise, `==` vs `===`, unused import, etc.) went unchecked. This is
// deliberately a SMALL, high-signal rule set, not `recommendedTypeChecked` -- turning on the full
// recommended set on a 121k-line repo on day one produces thousands of warnings nobody will ever
// triage. Start narrow, widen later in a separate, gateable change once this baseline is green.
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'web/**', 'agents/**', '.claude/**', 'graphify-out/**', '.code-review-graph/**'],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // RedHat N1, f3dd0c65 delta-gate (card e94fea8e): commit 7b4e903ec raised this rule's
      // baseline 185 -> 197 purely for `(..._a: unknown[]) => ...`-style vitest-mock args that
      // are deliberately unused (the convention this codebase already uses to mark "ignored on
      // purpose") -- a ratchet loosening, not a real regression. argsIgnorePattern restores the
      // convention's intent instead of permanently inflating the bound for it.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unsafe-argument': 'error',
    },
  },
)
