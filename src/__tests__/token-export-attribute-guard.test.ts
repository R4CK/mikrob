// Card 2d4c7943 (613a8142 RedHat INFO follow-up): local-llm-rag.sh already closed the TOKEN
// export-attribute leak (613a8142 F1, `declare +x TOKEN` right after `TOKEN="$(cat ...)"`) --
// RedHat flagged that FIVE other store/ scripts load a dashboard token the same way and spawn a
// child process (curl/python3) afterward, without measuring whether the same inheritance class
// applies. All five do spawn children after the assignment, so the same fix was applied to each.
// This is a structural source check (the line immediately following the TOKEN assignment), the
// same technique the sibling scaffold-guard tests use -- it reads the one line whose presence IS
// the property under test, independent of which real caller does or doesn't export TOKEN today.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_DIR = join(__dirname, '..', '..', 'store')
const REPO_ROOT = join(__dirname, '..', '..')

const SCRIPTS = [
  'local-llm-rag.sh',
  'card-build-route.sh',
  'self-advance-pickup.sh',
  'decompose-type-stop.sh',
  'card-build-route-24h-measure.sh',
  'kanban-snapshot.sh',
  'idle-shutdown-check.sh',
]

function checkGuard(absPath: string, label: string, varName: string): void {
  const src = readFileSync(absPath, 'utf-8')
  // Quotes around `$(cat ...)` vary by script (`TOKEN="$(cat x)"` vs `TOKEN=$(cat x)`), so the
  // assignment match tolerates either, anchored on the variable name actually used.
  const assignRx = new RegExp(`^[ \\t]*${varName}="?\\$\\(cat .*$`, 'm')
  const assignMatch = src.match(assignRx)
  expect(assignMatch, `${label}: no ${varName}=$(cat ...) assignment found`).not.toBeNull()
  const assignIdx = assignMatch!.index!
  const assignLineEnd = src.indexOf('\n', assignIdx)
  // card-build-route.sh indents this assignment inside an `if` block -- the guard follows on
  // the next NON-COMMENT statement line, skipping the explanatory comment lines in between.
  const after = src.slice(assignLineEnd + 1, assignLineEnd + 1 + 600)
  const nextStatementLine = after
    .split('\n')
    .find((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
  expect(nextStatementLine?.trim(), `${label}: next statement after ${varName} assignment is not the export-attribute guard`).toBe(`declare +x ${varName}`)
}

describe('TOKEN export-attribute guard present right after loading the dashboard token (card 2d4c7943)', () => {
  for (const script of SCRIPTS) {
    it(`${script} drops the export attribute immediately after assigning TOKEN from the token file`, () => {
      checkGuard(join(STORE_DIR, script), script, 'TOKEN')
    })
  }
})

// Card 03d48dab (WhiteHat2 CYBERSEC GO N1 LOW, e912f7db follow-up): the same inheritance class
// also applies to scripts/ -- these spawn curl/mktemp/python3 children after loading the token
// from a file, same as the store/ scripts above. Measured on scripts/agent-msg.sh: an exported
// caller TOKEN survived the reassignment and reached the curl/python3 children's environment.
// store/sync-agent-templates.sh was also named in the N1 finding, but on inspection it never
// assigns a TOKEN/DASHBOARD_TOKEN variable itself (every "TOKEN=" occurrence in that file is
// either a comment or a heredoc test fixture for its own unrelated argv-leak scanner) -- there is
// no assignment to pin, so it is intentionally left out here, not silently dropped.
// scripts/pre-pr-review.sh was replaced wholesale (card 647e0b6f, upstream #1965 security
// hardening) with a version that never assigns DASHBOARD_TOKEN to a shell variable at all: the
// token file is read straight into a 0600 header file by write_header() (a python3 -I heredoc),
// so there is no shell variable whose export attribute could leak to a spawned child's
// environment in the first place -- the leak class this guard checks for cannot occur by
// construction. Same reasoning as the sync-agent-templates.sh carve-out above: no assignment
// to pin, so it is intentionally left out here, not silently dropped.
describe('TOKEN/DASHBOARD_TOKEN export-attribute guard present in scripts/ (card 03d48dab)', () => {
  const SCRIPTS_SCRIPTS_DIR: Array<{ file: string; varName: string }> = [
    { file: 'agent-msg.sh', varName: 'TOKEN' },
    { file: 'fleet-safe-start.sh', varName: 'TOKEN' },
    { file: 'watchdog.sh', varName: 'TOKEN' },
  ]
  for (const { file, varName } of SCRIPTS_SCRIPTS_DIR) {
    it(`scripts/${file} drops the export attribute immediately after assigning ${varName} from the token file`, () => {
      checkGuard(join(REPO_ROOT, 'scripts', file), `scripts/${file}`, varName)
    })
  }
})

// Card 02b5e13b (WhiteHat F1 follow-up on 647e0b6f, komment 22586): the carve-out comment above
// for pre-pr-review.sh asserts "no assignment to pin" -- true on today's source (verified: zero
// occurrences of the literal "DASHBOARD_TOKEN" anywhere in the file; the token travels only as a
// FILE PATH into write_header(), which reads it inside a python3 -I heredoc, never through a
// shell variable). But an absent assignment pattern is not itself pinned by anything above, so a
// mutant reintroducing `export DASHBOARD_TOKEN=...` (making the value inheritable by every
// curl/python3 child pre-pr-review.sh spawns afterward) survived the full suite unnoticed
// (measured by WhiteHat: 54/54 green). This test pins the ABSENCE, and -- if the absence is ever
// broken -- requires the same immediate `declare +x DASHBOARD_TOKEN` guard the checkGuard() cases
// above use, rather than silently allowing any reintroduction.
describe('pre-pr-review.sh never lets DASHBOARD_TOKEN become an exportable shell variable (card 02b5e13b)', () => {
  it('scripts/pre-pr-review.sh has no DASHBOARD_TOKEN shell-variable assignment without an immediate export-attribute guard', () => {
    const absPath = join(REPO_ROOT, 'scripts', 'pre-pr-review.sh')
    const src = readFileSync(absPath, 'utf-8')
    const assignRx = /^[ \t]*(export\s+)?DASHBOARD_TOKEN=.*$/m
    const match = src.match(assignRx)
    if (match === null) {
      // Current, intended shape: the token never becomes a shell variable at all, so there is
      // nothing for the export-attribute guard to apply to.
      return
    }
    const assignLineEnd = src.indexOf('\n', match.index!)
    const after = src.slice(assignLineEnd + 1, assignLineEnd + 1 + 600)
    const nextStatementLine = after
      .split('\n')
      .find((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
    expect(
      nextStatementLine?.trim(),
      'scripts/pre-pr-review.sh: DASHBOARD_TOKEN was assigned to a shell variable without the ' +
        'export-attribute guard (`declare +x DASHBOARD_TOKEN`) immediately after it -- this is ' +
        'exactly the leak class card 02b5e13b/647e0b6f F1 found a surviving mutant for.'
    ).toBe('declare +x DASHBOARD_TOKEN')
  })

  // Card d5342cf9 (N1 follow-up, WhiteHat komment 23050): the above pin is on the VARIABLE NAME
  // only. WhiteHat measured that mutants using other names (TOKEN=, declare -x, read -r) survive
  // with 11/11 green. The invariant below is NOT shape-independent (card f3f91f5c F1 corrects the
  // earlier overclaim) -- it is a DENY-LIST of the specific file-read-into-shell-variable shapes
  // enumerated in TOKEN_FILE_LEAK_PATTERNS. $TOKEN_FILE must never appear inside one of those
  // shapes; a shape not in the table is not checked.
  //
  // REMAINING KNOWN GAP (card f3f91f5c F1, RedHat follow-up on aab26b61): the table below does not
  // cover every way a shell can read a file's contents into a variable. Measured-missing shapes:
  // sed (`TOKEN=$(sed -n 1p "$TOKEN_FILE")`), awk, cut, grep (`TOKEN=$(grep . "$TOKEN_FILE")`),
  // base64, xxd, a `while read; do ...; done < "$TOKEN_FILE"` loop, `exec 3< "$TOKEN_FILE"` paired
  // with `read line <&3` (the fd-redirect form WITHOUT the `-u` flag -- read-dash-u below only
  // catches the `read -u 3` form), a literal hardcoded path combined with `$(<path)` fast-read, and
  // a literal hardcoded path combined with `head`. None of these are pinned by a test today; a
  // future pre-pr-review.sh change using one of them would leak the token value unnoticed by this
  // guard. Closing them is out of scope for this card (see card text); this comment exists so the
  // gap is documented next to the test instead of implied by an inaccurate "shape-independent"
  // claim.
  //
  // Card aab26b61 (RedHat 25290, d5342cf9 follow-up): the two L2 findings on this N1 check --
  // (1) only 2 of 12 real shapes that read a file's contents into a shell variable were covered
  // (brace-wrapped `${TOKEN_FILE}`, `$(<f)`, backticks, mapfile, nested command substitution,
  // head, tr, a literal hardcoded path bypassing the variable entirely, python, and an `exec`+
  // `read -u` fd-redirect pair were all unmatched); (2) the NON-VACUITY test below used to carry
  // its OWN inline copies of catSubstRx/readRedirectRx, so a mutant that broke the LIVE regexes
  // (the ones actually applied to pre-pr-review.sh) would leave NON-VACUITY green, since it never
  // re-exercised the live pattern -- RedHat measured this at 14/14 green with the live regexes
  // dead. Fix: a single, module-scope pattern TABLE is now the only copy, used by BOTH the real
  // check below and NON-VACUITY, so a mutant that weakens any pattern turns BOTH red together.
  //
  // Card f3f91f5c F2/F3 (RedHat follow-up on aab26b61):
  // F2: backtick-cat used `[^`]*`, which matches a newline -- two UNRELATED backtick-quoted shapes
  // on different lines (e.g. two `alias` definitions, one containing the word "cat" and a later,
  // unrelated one containing "$TOKEN_FILE") got bridged into a single false-positive match because
  // nothing stopped the scan at a line boundary. Fixed to `[^`\n]*`, bounding the match to one line
  // (reproduced and verified below in the 'false-positive fixtures' describe block).
  // F3: python used `\bpython3?\b[^\n]*${VARREF}`, which fires on ANY line containing both words --
  // including the ALLOWED form this very file (scripts/pre-pr-review.sh write_header(), see the
  // module docstring above) relies on: `python3 -I - "$TOKEN_FILE" <<'PY'`, where the token file
  // path is passed as argv to a python3 heredoc that writes straight to a 0600 file, never through
  // a shell variable. The actual leak shape is the token's VALUE being captured into a shell
  // variable via a `$(python3 ...)` command substitution OR a backtick capture, so the pattern is
  // scoped to that capture structure (matching the same anchoring cat-substitution/backtick-cat
  // already use), rather than to `$(...)` alone.
  //
  // Card f3f91f5c CYBERSEC NO-GO 26194 (RedHat, Gate-SHA ba69563aa): the first F3 fix anchored on
  // `\$\([^)]*\bpython3?\b[^)]*${VARREF}`, but `[^)]*` stops at the FIRST `)`, so any `)` between
  // `python3` and the token path hides the leak -- e.g. the common argv idiom
  // `$(python3 -c 'import sys;print(open(sys.argv[1]).read())' "$TOKEN_FILE")` has a `)` right
  // after `sys.argv[1]).read())`, long before `$TOKEN_FILE`, so `[^)]*` never reaches it. It also
  // only matched `$(...)`, missing the equivalent backtick-capture form. Fixed to anchor on either
  // opener and scan the whole LINE (not just up to the next `)`), matching the backtick-cat
  // pattern's own line-bound `[^\n]*` style instead of a paren-bound one (reproduced below).
  const VARREF = '\\$\\{?TOKEN_FILE\\}?'
  const TOKEN_FILE_LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
    { name: 'cat-substitution', re: new RegExp(`\\$\\(cat\\b[^)]*${VARREF}`) },
    { name: 'read-redirect', re: new RegExp(`\\bread\\b[^;\\n]*<[^;\\n]*${VARREF}`) },
    { name: 'dollar-paren-lt ($(<f) fast read)', re: new RegExp(`\\$\\(<[^)]*${VARREF}`) },
    { name: 'backtick-cat', re: new RegExp('`[^`\\n]*cat\\b[^`\\n]*' + VARREF + '[^`\\n]*`') },
    { name: 'mapfile', re: new RegExp(`\\bmapfile\\b[^;\\n]*<[^;\\n]*${VARREF}`) },
    { name: 'nested-paren', re: new RegExp(`\\$\\([^()]*\\$\\(cat\\b[^)]*${VARREF}[^)]*\\)[^()]*\\)`) },
    { name: 'head', re: new RegExp(`\\bhead\\b[^;\\n]*${VARREF}`) },
    { name: 'tr', re: new RegExp(`\\btr\\b[^;\\n]*${VARREF}`) },
    { name: 'literal-path', re: /\$\(cat\b[^)]*store\/\.dashboard-token/ },
    { name: 'python', re: new RegExp(`(?:\\$\\(|\`)[^\\n]*\\bpython3?\\b[^\\n]*${VARREF}`) },
    { name: 'read-dash-u', re: new RegExp(`\\bexec\\b[^\\n]*<[^\\n]*${VARREF}[\\s\\S]{0,80}?\\bread\\b[^\\n]*-u\\b`) },
  ]

  // F2/F3 false-positive fixtures (card f3f91f5c Kesz-ha #2): prove the two narrowed patterns no
  // longer flag the specific safe shapes that used to trip them, while still catching the real
  // mutants (checked by the NON-VACUITY suite below).
  describe('false-positive fixtures (card f3f91f5c F2/F3)', () => {
    it('F2: two unrelated backtick-quoted shapes on different lines do not bridge into a false match', () => {
      const fixture = [
        'alias one=`ls -la cat-food.txt',
        'some unrelated line in between',
        'alias two=$TOKEN_FILE thing`',
      ].join('\n')
      const entry = TOKEN_FILE_LEAK_PATTERNS.find((p) => p.name === 'backtick-cat')!
      expect(entry.re.test(fixture)).toBe(false)
    })

    it('F3: the allowed python3 -I argv form (no $(...) capture) is not flagged', () => {
      const fixture = 'python3 -I - "$TOKEN_FILE" <<\'PY\''
      const entry = TOKEN_FILE_LEAK_PATTERNS.find((p) => p.name === 'python')!
      expect(entry.re.test(fixture)).toBe(false)
    })

    it('F3: scripts/pre-pr-review.sh itself (the real allowed python3 -I form) stays green', () => {
      const absPath = join(REPO_ROOT, 'scripts', 'pre-pr-review.sh')
      const src = readFileSync(absPath, 'utf-8')
      const entry = TOKEN_FILE_LEAK_PATTERNS.find((p) => p.name === 'python')!
      expect(src.match(entry.re)).toBeNull()
    })
  })

  it('N1 shape-independent: $TOKEN_FILE never used in any file-read-into-shell-variable shape, regardless of variable name (card d5342cf9, aab26b61)', () => {
    const absPath = join(REPO_ROOT, 'scripts', 'pre-pr-review.sh')
    const src = readFileSync(absPath, 'utf-8')
    for (const { name, re } of TOKEN_FILE_LEAK_PATTERNS) {
      expect(src.match(re),
        `N1 (${name}): $TOKEN_FILE appears in a shape that moves the token value into a shell ` +
        'variable, inheritable by curl/python3 children'
      ).toBeNull()
    }
  })

  // NON-VACUITY: prove every pattern in the shared table actually fires on a real mutant for its
  // shape. Uses the SAME TOKEN_FILE_LEAK_PATTERNS table as the real check above (card aab26b61
  // L2) -- no separate copy, so weakening a live pattern turns this red too.
  const NON_VACUITY_MUTANTS: Array<{ pattern: string; mutant: string }> = [
    // Pre-existing mutants (WhiteHat 23050 B/C/D/E), now checked against the shared table.
    { pattern: 'cat-substitution', mutant: 'TOKEN="$(cat "$TOKEN_FILE")"' },
    { pattern: 'cat-substitution', mutant: 'declare -x DASHBOARD_TOKEN="$(cat "$TOKEN_FILE")"' },
    { pattern: 'read-redirect', mutant: 'read -r DASHBOARD_TOKEN < "$TOKEN_FILE"' },
    { pattern: 'cat-substitution', mutant: 'SECRET=$(cat "$TOKEN_FILE")' },
    // The 10 shapes RedHat 25290 found uncovered (card aab26b61 L1).
    { pattern: 'cat-substitution', mutant: 'TOKEN="$(cat "${TOKEN_FILE}")"' }, // braces
    { pattern: 'dollar-paren-lt ($(<f) fast read)', mutant: 'TOKEN=$(<"$TOKEN_FILE")' },
    { pattern: 'backtick-cat', mutant: 'TOKEN=`cat "$TOKEN_FILE"`' },
    { pattern: 'mapfile', mutant: 'mapfile -t LINES < "$TOKEN_FILE"' },
    { pattern: 'nested-paren', mutant: 'TOKEN=$(echo $(cat "$TOKEN_FILE"))' },
    { pattern: 'head', mutant: 'TOKEN=$(head -n1 "$TOKEN_FILE")' },
    { pattern: 'tr', mutant: "TOKEN=$(tr -d '\\n' < \"$TOKEN_FILE\")" },
    { pattern: 'literal-path', mutant: 'TOKEN=$(cat "$INSTALL_DIR/store/.dashboard-token")' },
    { pattern: 'python', mutant: "TOKEN=$(python3 -c \"print(open('$TOKEN_FILE').read())\")" },
    { pattern: 'read-dash-u', mutant: 'exec 3< "$TOKEN_FILE"\nread -u 3 TOKEN' },
    // Card f3f91f5c F4 (RedHat follow-up on aab26b61): each pattern above had exactly ONE mutant,
    // so a narrowed regex that coincidentally still matches that single literal text (while no
    // longer matching other real-world variants of the same shape) would survive unnoticed. A
    // second, differently-shaped mutant per pattern (brace-wrapped $TOKEN_FILE, different flags/
    // quoting) closes that gap -- a narrowing that breaks either one now goes red.
    { pattern: 'read-redirect', mutant: 'read -r -d "" TOKEN < "${TOKEN_FILE}"' },
    { pattern: 'dollar-paren-lt ($(<f) fast read)', mutant: 'TOKEN=$(<"${TOKEN_FILE}")' },
    { pattern: 'backtick-cat', mutant: 'TOKEN=`cat "${TOKEN_FILE}"`' },
    { pattern: 'mapfile', mutant: 'mapfile -t -d "" LINES < "${TOKEN_FILE}"' },
    { pattern: 'nested-paren', mutant: 'TOKEN=$(printf %s "$(cat "${TOKEN_FILE}")")' },
    { pattern: 'head', mutant: 'TOKEN=$(head -c 200 "${TOKEN_FILE}")' },
    { pattern: 'tr', mutant: 'TOKEN=$(tr -d " " < "${TOKEN_FILE}")' },
    { pattern: 'literal-path', mutant: 'TOKEN=$(cat   "$INSTALL_DIR"/store/.dashboard-token)' },
    {
      pattern: 'python',
      mutant: 'TOKEN=$(python3 -c "data = open(\\"${TOKEN_FILE}\\").read(); print(data)")',
    },
    { pattern: 'read-dash-u', mutant: 'exec 4< "${TOKEN_FILE}"\nread -u 4 -r TOKEN' },
    // Card f3f91f5c CYBERSEC NO-GO 26194: the argv idiom and backtick-capture leak shapes the
    // first F3 fix's `[^)]*` (stops at the first `)`) and `$(...)`-only anchor missed.
    {
      pattern: 'python',
      mutant: 'TOKEN=$(python3 -c \'import sys;print(open(sys.argv[1]).read())\' "$TOKEN_FILE")',
    },
    { pattern: 'python', mutant: 'TOKEN=`python3 -c \'...(...)...\' "$TOKEN_FILE"`' },
  ]
  for (const { pattern, mutant } of NON_VACUITY_MUTANTS) {
    it(`NON-VACUITY (${pattern}): shared pattern table catches mutant "${mutant.replace(/\n/g, '\\n')}"`, () => {
      const entry = TOKEN_FILE_LEAK_PATTERNS.find((p) => p.name === pattern)
      expect(entry, `no pattern named '${pattern}' in TOKEN_FILE_LEAK_PATTERNS`).toBeDefined()
      expect(entry!.re.test(mutant), `pattern '${pattern}' did not match mutant`).toBe(true)
    })
  }

  // Dead-regex detection: if every pattern in the table is neutralized (never matches anything),
  // every NON-VACUITY case above goes red together with the real N1 check -- this is the
  // structural property card aab26b61 Kesz-ha #2 asks for (measured in the REVIEW comment by
  // temporarily replacing TOKEN_FILE_LEAK_PATTERNS with a never-matching table and re-running
  // this file, then reverting).
})

// Card d5342cf9 (N2 follow-up, WhiteHat komment 23050): the existing fork-anchor watches
// package-lock.json for parse5 (expect: present, since card 2337e4b0 adopted it). But the
// PACKAGE.JSON decision is a separate slot -- adding parse5 to package.json devDependencies
// while leaving the lockfile untouched (not running npm ci) survives 89/89 green.
// This test pins the package.json decision directly so the invariant holds without npm ci.
describe('package.json parse5 devDependency decision pinned (card d5342cf9 N2)', () => {
  it('package.json lists parse5 in devDependencies (adopted in card 2337e4b0; lock-anchor alone is insufficient)', () => {
    const pkgPath = join(REPO_ROOT, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>
    const dev = pkg['devDependencies'] as Record<string, string> | undefined
    expect(dev, 'package.json has no devDependencies section').toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(dev, 'parse5'),
      'parse5 is missing from package.json devDependencies -- this reverses the card 2337e4b0 ' +
      'adoption decision; if intentional, update this test AND the lock-anchor in ' +
      'src/fork-upstream/acknowledged-conflicts.ts together'
    ).toBe(true)
  })
})
