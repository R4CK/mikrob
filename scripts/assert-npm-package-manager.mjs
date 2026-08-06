#!/usr/bin/env node
// package.json `preinstall` guard: this repo is an npm project, and ONLY an npm project.
//
// WHY THIS EXISTS (card 0b0e6e24). On 2026-07-31 a `pnpm install` was run in this repo -- almost
// certainly a stray command meant for a pnpm project elsewhere on this machine. pnpm took over
// node_modules (moving the npm packages aside into node_modules/.ignored) and, because pnpm blocks
// dependency build scripts by default, better-sqlite3's native binding was never compiled. The next
// service restart died with "Could not locate the bindings file" and CRASH-LOOPED ~10 times before it
// was patched by hand. Nothing else about the repo was ever converted: package-lock.json is the
// committed lockfile, and update.sh / install-*.sh / recovery-prev-version.sh all drive `npm ci`,
// `npm audit`, `npm rebuild better-sqlite3 --build-from-source` and `npm run build`.
//
// So the failure mode is not "we half-migrated" -- it is "a foreign package manager can silently
// replace the dependency tree of a live service". This makes that loud instead of silent.
//
// FAIL-OPEN ON DETECTION, deliberately. It refuses only on a POSITIVE pnpm/yarn signal; an unknown or
// absent `npm_config_user_agent` is allowed through. The guard's job is to stop a stray pnpm run, and
// an over-eager guard here would be far worse than the thing it guards: a false positive would block
// `npm ci` inside update.sh and leave the service unable to install its own dependencies.

const agent = process.env.npm_config_user_agent ?? ''
const foreign = /^(pnpm|yarn)\//.exec(agent)

if (foreign !== null) {
  const name = foreign[1]
  console.error(
    [
      '',
      `  REFUSING TO INSTALL: this repo is an npm project, but the install is running under ${name}.`,
      '',
      `  ${name} would replace node_modules with its own layout and (for pnpm) skip the native build`,
      '  script for better-sqlite3, leaving the service with no bindings file. That exact mistake',
      '  crash-looped this install on 2026-07-31 (card 0b0e6e24).',
      '',
      '  Use npm:      npm ci',
      '  Updating?     ./update.sh   (runs npm ci + the native rebuild + the build)',
      '',
      '  If you are in the wrong directory -- likely, if you meant to run pnpm -- cd to the pnpm',
      '  project you intended and run it there.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}
