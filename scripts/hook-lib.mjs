// Shared PreToolUse hook plumbing: the deny-envelope and the "am I the actual
// hook entrypoint, not an import from a test" check.
//
// Card bb0ae7fa: allow()/deny()/isInvokedDirectly() used to exist three times,
// byte-identical, in email-send-gate.mjs, scripts/hooks/egress-gate.mjs and
// self-pace-gate.mjs. A drifted copy is a real security bug, not a style
// nit: if one deny-envelope silently stopped matching Claude Code's expected
// hookSpecificOutput shape, that ONE gate would fail open while the other two
// kept blocking correctly -- a partial regression that a same-behavior-everywhere
// test can no longer miss now that there is one implementation to check.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function allow() {
  process.exit(0)
}

export function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

// Run as the hook entrypoint only when invoked directly (not when imported by a
// test). realpath both sides so a symlinked install path (the hook command is
// an absolute path that may traverse a symlink, e.g. /tmp -> /private/tmp on
// macOS, or a symlinked /home on Linux) still matches -- a raw url-vs-argv
// compare would silently no-op the gate (a security bypass).
//
// `moduleUrl` must be the CALLER's `import.meta.url`, not this module's --
// each gate script checks whether ITSELF is the process entrypoint.
export function isInvokedDirectly(moduleUrl) {
  try {
    const self = realpathSync(fileURLToPath(moduleUrl))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}
