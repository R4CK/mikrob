// Guard: no store/*.sh may pass a Bearer token as a curl COMMAND-LINE argument (card edb7559f,
// Cybersec finding chain starting at 83191d8d -> b7fa5281's own token, /proc/<pid>/cmdline leak).
//
// /proc/<pid>/cmdline is world-readable, so `curl -H "Authorization: Bearer $TOK"` hands the
// dashboard (or any other) bearer token to any local user/process that can list processes. The
// sanctioned fix is a private 0600 temp header file passed as `-H @"$hdr_file"` (already the pattern
// in weekly-usage-panel-read.sh, redispatch-guard.sh, weekly-usage-probe.sh, and now the 6 files this
// card fixed). This test enumerates EVERY store/*.sh and fails on the FIRST script that regresses.
//
// MULTI-LINE AWARE ON PURPOSE: a naive per-line regex would have missed offload-dispatch.sh's POST
// call, where `curl -X POST ... \` and `-H "Authorization: Bearer $TOK" \` are on different lines --
// exactly the miss I made scanning by eye before writing this guard. The scanner below joins a curl
// invocation across backslash-continued lines before testing it, the same way bash itself does.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STORE_DIR = join(REPO_ROOT, 'store')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')
const SEED_SKILLS_DIR = join(REPO_ROOT, 'seed-skills')
const SEED_FLEET_AGENTS_DIR = join(REPO_ROOT, 'seed-fleet-agents')
const SEED_TASKS_DIR = join(REPO_ROOT, 'seed-scheduled-tasks')
const SRC_DIR = join(REPO_ROOT, 'src')

/** One curl invocation, reassembled across `\`-continued lines, with its 1-based start line. */
interface CurlInvocation {
  readonly text: string
  readonly startLine: number
}

/**
 * Split one joined chunk at every `curl` token, so a chunk holding SEVERAL commands is not judged
 * as one (card 3a042d4c).
 *
 * This matters because leaksTokenInArgv clears an invocation that contains the sanctioned `-H @`
 * anywhere in it. A seeded PreCompact hook prompt is a single JSON string -- one "line" carrying
 * three separate curl commands -- so one fixed command vouched for its two unfixed neighbours and
 * the guard went green over a live offender. Measured: reintroducing the argv shape into
 * seed-fleet-agents/qa/.claude/settings.json did not fail a single test before this split.
 */
function splitAtCurl(text: string, startLine: number): CurlInvocation[] {
  const parts = text.split(/(?=\bcurl\b)/)
  return parts.filter((p) => /\bcurl\b/.test(p)).map((p) => ({ text: p, startLine }))
}

/** Split a script into logical curl invocations (continuation lines joined), like bash would see them. */
function findCurlInvocations(source: string): CurlInvocation[] {
  const lines = source.split('\n')
  const out: CurlInvocation[] = []
  let buf: string[] = []
  let startLine = -1
  let inCurl = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!inCurl && /\bcurl\b/.test(line)) {
      inCurl = true
      startLine = i + 1
      buf = []
    }
    if (inCurl) {
      buf.push(line)
      if (!line.trimEnd().endsWith('\\')) {
        out.push(...splitAtCurl(buf.join('\n'), startLine))
        inCurl = false
      }
    }
  }
  return out
}

/**
 * True iff the invocation carries a literal `Authorization: Bearer $VAR`-shaped header (argv leak).
 *
 * The character after the `$` is where this rule keeps failing, so it is enumerated rather than
 * assumed:
 *   `$TOK`        bare variable            -- `[A-Za-z_]`
 *   `$(cat ...)`  command substitution     -- `(`; a regex anchored on `[A-Za-z_]` misses it,
 *                 which is how scripts/channels.sh and scripts/doctor.sh slipped past an earlier
 *                 draft (card b267df80)
 *   `${TOK}`      braced expansion         -- `{`; missed until card 2834e7f3's Cybered NO-GO, and
 *                 NOT hypothetical: src/web/voice-directive.ts:60 built
 *                 `-H "Authorization: Bearer ${token}"` into a command it hands an agent to run,
 *                 shipped since 7b185eb and present in dist. The guard scanned that file and
 *                 reported green over it.
 *   `` `cat ...` ``  legacy substitution   -- a backtick, added in the same pass; nothing in the
 *                 corpus uses it today, so it costs nothing and closes the spelling.
 *
 * Note this is a SHAPE rule: it catches an interpolation, not a token literal typed out in full.
 * Measured across the whole corpus, no `Bearer <20+ opaque chars>` literal exists, so that variant
 * is reported rather than guessed at here -- a rule for it would have to tell a real secret from
 * `Bearer <token>` and `Bearer %s`, and inventing that on no evidence is how guards get disabled.
 */
function leaksTokenInArgv(invocation: string): boolean {
  if (!/Authorization:\s*Bearer\s*(\$(\(|\{|[A-Za-z_])|`)/.test(invocation)) return false
  // The sanctioned form reads the header from a file (`-H @"$hdr_file"` / `-H @"$hdr"` / `-H @"$hf"`);
  // that never matches the Bearer-in-argv pattern above in the first place, but keep this as an
  // explicit second check so a future refactor that keeps BOTH forms in one invocation still trips.
  return !/-H\s+@/.test(invocation)
}

/**
 * Credential-carrying URL query parameter names. Anchored as WHOLE parameter names so
 * `?keyword=$Q` (an ordinary search query) is not mistaken for `?key=$Q`.
 */
const CREDENTIAL_QUERY_PARAMS = [
  'key',
  'api[-_]?key',
  'apikey',
  'token',
  'access[-_]?token',
  'auth[-_]?token',
  'id[-_]?token',
  'refresh[-_]?token',
  'job[-_]?token',
  'private[-_]?token',
  'auth',
  'secret',
  'client[-_]?secret',
  'password',
  'passwd',
  'pwd',
  'sig',
  'signature',
  // Card 2834e7f3 gap 3. `code` is the OAuth authorization code (we run live OAuth) and is the
  // one name with plausible lookalike noise (`?code=$COUNTRY_CODE`). Measured before adding:
  // zero occurrences of ANY `code=$...` across scripts/, store/ and src/**, so it costs nothing
  // today. If it ever turns noisy, drop this entry rather than let anyone disable the rule --
  // an over-greedy guard gets switched off, which is worse than a slightly narrow one.
  'code',
  'assertion',
  'session',
  'private[-_]?key',
  'subscription[-_]?key',
].join('|')

/**
 * True iff the invocation embeds a credential in a URL QUERY PARAMETER (`?key=$VAR`,
 * `&token=$(cat ...)`, `?api_key=${VAR}`).
 *
 * SAME LEAK CLASS as the Bearer-in-argv rule, different shape: the URL is an argv element, so
 * /proc/<pid>/cmdline exposes it to any local process. A URL credential is strictly worse than a
 * header, because it additionally lands in server access logs, proxy logs, and Referer headers.
 *
 * Card 0864de63 (Cybersec MINOR on the b267df80 gate): the concrete occurrence -- Gemini's
 * `?key=$GEMINI_KEY` -- was found and fixed BY HAND (moved to an x-goog-api-key header), but the
 * CLASS had no guard rule, so the next one would slip through the same way. There is NO sanctioned
 * escape hatch here (unlike `-H @file` for headers): a secret never belongs in a URL.
 */
function leaksTokenInUrlQuery(invocation: string): boolean {
  const re = new RegExp(`[?&](${CREDENTIAL_QUERY_PARAMS})=\\$(\\(|\\{|[A-Za-z_])`, 'i')
  return re.test(invocation)
}

/**
 * The same rule, but for a `curl -G` invocation, where curl BUILDS the query string from
 * --data/--data-urlencode instead of it appearing literally in the URL (card 2834e7f3 gap 3):
 *
 *   curl -s -G "https://x/v1" --data-urlencode "key=$K"
 *
 * The resulting request URL -- and therefore the access log, the proxy log and the Referer --
 * carries the credential exactly as if it had been written inline. (argv is NOT the exposure here:
 * --data-urlencode's value is an argv element either way. The URL-side exposure is the point.)
 * Without `-G` those same flags become a POST BODY, which is the sanctioned form, so the `-G`
 * is what makes this a finding.
 */
function leaksTokenInGetQuery(invocation: string): boolean {
  if (!/(^|\s)-G(\s|$)|(^|\s)--get(\s|$)/.test(invocation)) return false
  const re = new RegExp(`--data(?:-urlencode|-raw)?\\s+["']?(${CREDENTIAL_QUERY_PARAMS})=\\$`, 'i')
  return re.test(invocation)
}

/**
 * A secret embedded in the URL PATH rather than the query (card 2834e7f3 gap 1). The live family
 * is the Telegram Bot API, which REQUIRES the token in the path -- `https://api.telegram.org/bot<TOKEN>/...`
 * -- so "move it to a header" is not available here.
 *
 * MEASURED, not read: with the URL passed as an argv element the token is visible in
 * /proc/<pid>/cmdline (verified live against a stalling listener); with the URL supplied through a
 * curl config (`-K -` / `-K file` / `--config`) the argv reads only `curl ... -K -` and the token
 * never appears. So the sanctioned form here is the config file, exactly parallel to `-H @file`.
 *
 * The rule therefore flags a path-embedded bot token ONLY when the invocation does not read its
 * URL from a config.
 */
function leaksTokenInUrlPath(invocation: string): boolean {
  if (!/api\.telegram\.org\/bot\$\{?[A-Za-z_]/.test(invocation)) return false
  return !/(^|\s)(-K|--config)(\s|=)/.test(invocation)
}

/**
 * Gap 2 (card 2834e7f3): a URL assembled into a VARIABLE first --
 *
 *   URL="https://x/v1?key=$K"
 *   curl -s "$URL"            # the curl line alone shows only $URL
 *
 * -- is invisible to any rule that only inspects reassembled curl invocations, and building a URL
 * in a variable is completely ordinary scripting, so the next real occurrence could easily take
 * this shape. This guard is a LINT on our own scripts (it catches a developer slip, it does not
 * chase an attacker), so scanning every line rather than only curl lines is the right trade: the
 * parameter names are already anchored as whole names, which is what keeps the false-positive rate
 * at zero on the current corpus.
 */
function credentialUrlLines(source: string): Array<{ text: string; startLine: number }> {
  return source
    .split('\n')
    .map((text, i) => ({ text, startLine: i + 1 }))
    .filter((l) => leaksTokenInUrlQuery(l.text))
}

function scanDir(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.sh'))
}

/**
 * Every text file under a shipped-template tree, recursively (card 2834e7f3 gap 4 + M1).
 *
 * Cybersec's finding: the guard forbade the argv-leak SHAPE in two directories while our own
 * SHIPPED documentation TAUGHT it. A SKILL.md is not executable, which is exactly why it is worse
 * than a script -- an agent following `dream` or `handoff` copies that
 * `-H "Authorization: Bearer $(cat ...)"` line into whatever it writes next, so the guard kept
 * removing symptoms while the source of the pattern shipped to every new install untouched.
 * It stopped being theoretical when three fresh scripts on card defcc189 were written that way.
 *
 * The keep-filter is derived from the EXTENSION, not from a list of filenames. A name list
 * ("SKILL.md or *.sh") passed while `references/*.md` -- which demonstrably carries the pattern in
 * the live skill tree -- stayed invisible. A guard scope that has to be maintained by hand drifts
 * behind the threat; an extension covers the file that has not been written yet.
 *
 * The scanner is text-based, so a fenced bash block inside markdown reads the same as a script.
 */
// `.json` is in the list because the seeded PreCompact hook prompt lives in
// seed-fleet-agents/*/.claude/settings.json as a JSON STRING, and it taught the argv shape three
// times per agent -- a file class the first extension list still missed for the same reason the
// name list missed `references/*.md` (card 3a042d4c). The scanner is text-based, so an escaped
// shell snippet inside a JSON string reads like any other line.
const TEXT_FILE = /\.(md|sh|py|js|mjs|cjs|ts|json)$/

function scanTree(dir: string, base: string = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...scanTree(full, base))
    else if (TEXT_FILE.test(entry.name)) out.push(relative(base, full))
  }
  return out
}

const STORE_SCRIPTS = scanDir(STORE_DIR)
const SCRIPTS_SCRIPTS = scanDir(SCRIPTS_DIR)
const SEED_SKILL_DOCS = scanTree(SEED_SKILLS_DIR)
const SEED_AGENT_DOCS = scanTree(SEED_FLEET_AGENTS_DIR)
const SEED_TASK_DOCS = scanTree(SEED_TASKS_DIR)

/**
 * The GENERATORS (card 2834e7f3, QA/Cybered re-gate). Everything above guards COPIES; these files
 * are where the copies come from. `src/web/agent-scaffold.ts` alone emitted the argv shape into
 * seven places of every new agent's CLAUDE.md, so each fresh agent was born teaching the leak no
 * matter how many shipped templates had been cleaned. Same for the heartbeat scaffold, the
 * federation onboarding brief and the kanban dispatch instructions.
 *
 * __tests__ is excluded because this file deliberately contains synthetic offenders.
 */
const SRC_FILES = scanTree(SRC_DIR).filter((f) => /\.ts$/.test(f) && !f.startsWith('__tests__'))

describe('no shipped script, template or GENERATOR puts a Bearer token in curl argv', () => {
  it('scans a non-trivial number of scripts in both directories (the guard is not vacuously passing)', () => {
    expect(STORE_SCRIPTS.length).toBeGreaterThan(10)
    expect(SCRIPTS_SCRIPTS.length).toBeGreaterThan(3)
  })

  it('scans the shipped seed-skills templates too (gap 4: the docs taught the leak)', () => {
    expect(SEED_SKILL_DOCS.length).toBeGreaterThan(30)
    // The five templates Cybersec named must be IN the corpus, by name -- a recursive walk that
    // silently stopped at the first level would still satisfy a bare count.
    for (const skill of ['dream', 'handoff', 'retrospective', 'approval-request-handling', 'ai-fleet-project-execution']) {
      expect(SEED_SKILL_DOCS).toContain(join(skill, 'SKILL.md'))
    }
    // M1: a `references/*.md` is neither SKILL.md nor *.sh, and the live skill tree proves that
    // file class carries the pattern. The extension filter is what puts it in scope.
    expect(SEED_SKILL_DOCS.some((f) => f.includes(`references${sep}`) && f.endsWith('.md'))).toBe(true)
  })

  it('scans the seeded fleet agents and scheduled tasks (they ship the same instructions)', () => {
    expect(SEED_AGENT_DOCS.filter((f) => f.endsWith('CLAUDE.md')).length).toBeGreaterThan(5)
    expect(SEED_TASK_DOCS.filter((f) => f.endsWith('SKILL.md')).length).toBeGreaterThan(3)
  })

  it('scans the generators themselves, not only what they emit', () => {
    for (const generator of [
      join('web', 'agent-scaffold.ts'),
      join('web', 'heartbeat-agent-scaffold.ts'),
      join('web', 'federation', 'onboarding.ts'),
      join('web', 'routes', 'kanban.ts'),
    ]) {
      expect(SRC_FILES).toContain(generator)
    }
  })

  /**
   * Line numbers that sit inside a ```fenced``` block. Everything else in a .md file is prose.
   *
   * Needed for the ONE exemption below, and kept structural on purpose: a filename allowlist is the
   * exact failure mode this guard exists to prevent, so the rule is derived from the document instead
   * (card ec5173a5).
   */
  function fencedLines(source: string): Set<number> {
    const inside = new Set<number>()
    let open = false
    source.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        open = !open
        return
      }
      if (open) inside.add(i + 1)
    })
    return inside
  }

  /**
   * Is this offender a security doc TEACHING the anti-pattern rather than using it?
   *
   * seed-skills/.../leak-safe-secret-probe/SKILL.md exists to tell an agent never to put a secret on
   * argv, and it shows the forbidden shape so the reader recognises it. Rewriting that to satisfy the
   * scanner would trade real teaching value for a green tick, so the guard learns to read it instead.
   *
   * TWO conditions, both required, both derived from the text:
   *   1. the curl is NOT inside a fenced block -- a fence is what a reader copy-pastes, so a fenced
   *      command is a command no matter what the surrounding prose claims;
   *   2. the same line carries a NEGATION -- the sentence has to say not to do this.
   * Either condition alone is too weak: (1) alone would exempt any inline one-liner, and (2) alone
   * would let a fenced command through under a "never do this" heading. Both are asserted below by
   * tests that drop one condition at a time.
   */
  const NEGATION = /\bnever\b|\bdo not\b|\bdon't\b|\bnot\b|\binstead\b|\bavoid\b|\bwrong\b|\bbad\b|\bhelyett\b|\bsoha\b|\bne\b/i

  function isDocumentedAntiPattern(source: string, startLine: number): boolean {
    if (!source.includes('```')) return false // not a markdown-ish doc: no exemption at all
    if (fencedLines(source).has(startLine)) return false // condition 1
    // Condition 2 reads the enclosing PARAGRAPH, not the single line. Prose wraps: in the real file
    // the negation ("never on argv") opens the bullet on line 33 while the second forbidden example
    // sits on line 34, so a line-local check exempted one occurrence and flagged its twin. The span
    // is the contiguous run of non-blank lines around the offender -- one bullet, one sentence.
    const lines = source.split('\n')
    let from = startLine - 1
    while (from > 0 && lines[from - 1].trim() !== '') from -= 1
    let to = startLine - 1
    while (to + 1 < lines.length && lines[to + 1].trim() !== '') to += 1
    return NEGATION.test(lines.slice(from, to + 1).join(' ')) // condition 2
  }

  const shellCases: Array<{ dir: string; file: string }> = [
    // The repo's own rulebook taught the argv shape in nine places while the guard enforced the
    // opposite everywhere else -- the most-read file in the project was the last one covered.
    { dir: REPO_ROOT, file: 'CLAUDE.md' },
    ...STORE_SCRIPTS.map((file) => ({ dir: STORE_DIR, file })),
    ...SCRIPTS_SCRIPTS.map((file) => ({ dir: SCRIPTS_DIR, file })),
    ...SEED_SKILL_DOCS.map((file) => ({ dir: SEED_SKILLS_DIR, file })),
    ...SEED_AGENT_DOCS.map((file) => ({ dir: SEED_FLEET_AGENTS_DIR, file })),
    ...SEED_TASK_DOCS.map((file) => ({ dir: SEED_TASKS_DIR, file })),
  ]

  const cases: Array<{ dir: string; file: string }> = [
    ...shellCases,
    ...SRC_FILES.map((file) => ({ dir: SRC_DIR, file })),
  ]

  it.each(cases)('$file: every curl reads its auth header from a file, never argv', ({ dir, file }) => {
    const source = readFileSync(join(dir, file), 'utf8')
    const offenders = findCurlInvocations(source)
      .filter((c) => leaksTokenInArgv(c.text))
      .filter((c) => !isDocumentedAntiPattern(source, c.startLine))
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  line ${o.startLine}: ${o.text.trim().slice(0, 100)}`).join('\n')
      throw new Error(
        `${file} passes a Bearer token in curl argv (/proc/<pid>/cmdline leak) at:\n${detail}\n` +
          `Fix: 0600 temp header file + \`-H @"$hdr_file"\`, trap 'rm -f "$hdr_file"' EXIT ` +
          `(see weekly-usage-panel-read.sh or offload-dispatch.sh).`,
      )
    }
  })

  // Scans EVERY line, not just curl invocations -- a URL built into a variable first would
  // otherwise slip through (card 2834e7f3 gap 2).
  //
  // SHELL CORPORA ONLY, deliberately. The rule's premise is that the URL becomes an argv element
  // of a spawned process; in TypeScript, a template literal that builds a URL is ordinary code and
  // spawns nothing, so the premise does not transfer. Applying it there produced exactly one hit,
  // `src/web.ts`'s browser bootstrap URL, which is a considered design (printed to stderr, kept
  // out of the pino stream on purpose) and not this card's subject. It is reported to the gate
  // rather than exempted here, because a hand-kept allowlist is the failure mode this card exists
  // to fix. The three CURL-shaped rules above DO run over src/ -- those inspect a command line.
  it.each(shellCases)('$file: no line builds a URL with a credential query parameter', ({ dir, file }) => {
    const source = readFileSync(join(dir, file), 'utf8')
    const offenders = credentialUrlLines(source).filter(
      (o) => !isDocumentedAntiPattern(source, o.startLine),
    )
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  line ${o.startLine}: ${o.text.trim().slice(0, 100)}`).join('\n')
      throw new Error(
        `${file} puts a credential in a URL query parameter at:\n${detail}\n` +
          `The URL is an argv element (/proc/<pid>/cmdline) AND lands in access/proxy logs and Referer. ` +
          `Fix: send it as a header instead (e.g. Gemini's \`?key=$K\` became \`x-goog-api-key\`), ` +
          `read from a 0600 temp file with \`-H @"$hdr_file"\` when the header itself is the secret.`,
      )
    }
  })

  it.each(cases)('$file: no curl -G builds a credential into the query string', ({ dir, file }) => {
    const source = readFileSync(join(dir, file), 'utf8')
    const offenders = findCurlInvocations(source).filter((c) => leaksTokenInGetQuery(c.text))
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  line ${o.startLine}: ${o.text.trim().slice(0, 100)}`).join('\n')
      throw new Error(
        `${file} uses \`curl -G\` with a credential in --data*, which curl appends to the QUERY STRING at:\n${detail}\n` +
          `Fix: drop -G so the same flags become a POST body, or move the credential to a header.`,
      )
    }
  })

  it.each(cases)('$file: a path-embedded bot token is read from a curl config, not argv', ({ dir, file }) => {
    const source = readFileSync(join(dir, file), 'utf8')
    const offenders = findCurlInvocations(source).filter((c) => leaksTokenInUrlPath(c.text))
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  line ${o.startLine}: ${o.text.trim().slice(0, 100)}`).join('\n')
      throw new Error(
        `${file} passes a Telegram bot token in the URL PATH as a curl argument at:\n${detail}\n` +
          `The Bot API requires the token in the path, so it cannot move to a header. Fix: feed the URL ` +
          `through a curl config instead, so it never becomes an argv element:\n` +
          `  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\\n' "$token" | curl -sS -K - --data-urlencode ...`,
      )
    }
  })
})

describe('the scanner itself catches what a naive single-line regex would miss', () => {
  it('flags a Bearer header split onto a CONTINUATION line (the offload-dispatch.sh miss)', () => {
    const script = [
      '#!/usr/bin/env bash',
      'curl -s -X POST "$DASH/api/x" -H "Content-Type: application/json" \\',
      '  -H "Authorization: Bearer $TOK" \\',
      "  -d '{}'",
    ].join('\n')
    const offenders = findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))
    expect(offenders).toHaveLength(1)
    expect(offenders[0]?.startLine).toBe(2) // the curl starts on line 2, not the header line
  })

  it('flags a Bearer header via COMMAND SUBSTITUTION, not just a bare variable (the channels.sh/doctor.sh miss)', () => {
    // $(cat "...") is not a bare `$VAR` -- a regex anchored on `\$[A-Za-z_]` doesn't match the `(`
    // and silently passes this, exactly what happened to an earlier draft of this guard.
    const script = [
      '#!/usr/bin/env bash',
      'curl -s -H "Authorization: Bearer $(cat "store/.dashboard-token")" "$DASH/api/x"',
    ].join('\n')
    const offenders = findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))
    expect(offenders).toHaveLength(1)
  })

  // One "line" can hold several commands -- a seeded PreCompact prompt is a single JSON string
  // with three curls in it. Without splitting at each `curl`, the fixed command's `-H @-` cleared
  // the whole chunk and vouched for its leaking neighbour, and the guard reported green over a
  // live offender.
  it('judges each curl separately when one line carries several commands', () => {
    const oneLine =
      `printf 'Authorization: Bearer %s\\n' "$(cat tok)" | curl -H @- -s http://x/a` +
      ` && curl -s http://x/b -H "Authorization: Bearer $(cat tok)"`
    const offenders = findCurlInvocations(oneLine).filter((c) => leaksTokenInArgv(c.text))
    expect(offenders).toHaveLength(1)
    expect(offenders[0]?.text).toContain('http://x/b')
  })

  it('does not double-count a single command that spans continuation lines', () => {
    const script = [
      '#!/usr/bin/env bash',
      'curl -s -X POST "$DASH/api/x" \\',
      '  -H "Authorization: Bearer $TOK" \\',
      "  -d '{}'",
    ].join('\n')
    expect(findCurlInvocations(script)).toHaveLength(1)
  })

  // A SKILL.md is prose with fenced bash, so the scanner must read it the same way it reads a
  // script -- otherwise gap 4 reopens the moment someone documents the old shape again.
  it('flags the argv shape inside a markdown fenced block, the way it appears in a SKILL.md', () => {
    const doc = [
      '## Memória mentés',
      '```bash',
      'curl -s -X POST http://localhost:3420/api/memories \\',
      '  -H "Content-Type: application/json" \\',
      '  -H "Authorization: Bearer $(cat store/.dashboard-token)" \\',
      "  -d '{\"content\":\"x\"}'",
      '```',
    ].join('\n')
    expect(findCurlInvocations(doc).filter((c) => leaksTokenInArgv(c.text))).toHaveLength(1)
  })

  // The form the five templates were converted TO. curl reads the header from a config on stdin,
  // so the token is never an argv element -- measured live against /proc/<pid>/cmdline: the `-H`
  // form showed the canary token, this one showed only `curl -s -K -`.
  it('does NOT flag the curl-config form the templates now teach', () => {
    const doc = [
      '```bash',
      `printf 'header = "Authorization: Bearer %s"\\n' "$(cat store/.dashboard-token)" \\`,
      '| curl -s -K - -X POST http://localhost:3420/api/memories \\',
      '  -H "Content-Type: application/json" \\',
      "  -d '{\"content\":\"x\"}'",
      '```',
    ].join('\n')
    expect(findCurlInvocations(doc).filter((c) => leaksTokenInArgv(c.text))).toEqual([])
  })

  // The braced expansion `${TOK}` is the spelling this rule was blind to until card 2834e7f3, and
  // it was NOT a hypothetical: src/web/voice-directive.ts built a curl carrying
  // `-H "Authorization: Bearer ${token}"` -- with the token's VALUE, not a shell reference -- into
  // a command handed to an agent to run. Shipped since 7b185eb, present in dist, and the guard
  // scanned that very file and reported green. Both directions are pinned below, because a rule
  // widened until it flags the sanctioned form too is a rule someone switches off.
  it('flags a BRACED expansion, the shape a TS template literal produces', () => {
    const script = ['#!/usr/bin/env bash', 'curl -s -H "Authorization: Bearer ${token}" "$DASH/api/x"'].join('\n')
    expect(findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))).toHaveLength(1)
  })

  it('flags a braced expansion with a default, and a legacy backtick substitution', () => {
    const braced = 'curl -s -H "Authorization: Bearer ${TOK:-fallback}" "$DASH/api/x"'
    const backtick = 'curl -s -H "Authorization: Bearer `cat store/.dashboard-token`" "$DASH/api/x"'
    expect(findCurlInvocations(braced).filter((c) => leaksTokenInArgv(c.text))).toHaveLength(1)
    expect(findCurlInvocations(backtick).filter((c) => leaksTokenInArgv(c.text))).toHaveLength(1)
  })

  it('does NOT flag a braced expansion that is read from a header FILE', () => {
    const script = [
      '#!/usr/bin/env bash',
      'printf \'Authorization: Bearer %s\\n\' "${TOK}" > "$hdr"',
      'curl -s -H @"$hdr" "$DASH/api/x" -d @-',
    ].join('\n')
    expect(findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))).toEqual([])
  })

  it('does NOT flag the sanctioned @headerfile pattern', () => {
    const script = [
      '#!/usr/bin/env bash',
      'hdr_file="$(mktemp)"; chmod 600 "$hdr_file"',
      "printf 'Authorization: Bearer %s\\n' \"$TOK\" > \"$hdr_file\"",
      'curl -s -H @"$hdr_file" "$DASH/api/x"',
    ].join('\n')
    expect(findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))).toEqual([])
  })

  it('does NOT flag a curl with no Authorization header at all', () => {
    const script = '#!/usr/bin/env bash\ncurl -s "http://example.com"\n'
    expect(findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))).toEqual([])
  })

  it('does NOT flag a MENTION of the pattern inside a comment or doc string (not a real curl call)', () => {
    // The guard only inspects lines that actually contain `curl`; a comment describing the bug class
    // without the word "curl" on the same joined invocation is data, not code.
    const script = '#!/usr/bin/env bash\n# never write Authorization: Bearer $TOK on a command line\necho hi\n'
    expect(findCurlInvocations(script)).toEqual([])
  })
})

// Card 0864de63: the URL-query rule. No store/ or scripts/ file carries this shape today (the one
// real occurrence, Gemini's `?key=$GEMINI_KEY`, was hand-fixed on the b267df80 gate), so the
// per-file assertions above pass vacuously for THIS rule. These synthetic cases are what makes the
// rule non-vacuous: they prove it fires on the class and does not fire on lookalikes.
describe('the URL-query credential rule (card 0864de63)', () => {
  function scan(lines: string[]): CurlInvocation[] {
    return findCurlInvocations(lines.join('\n')).filter((c) => leaksTokenInUrlQuery(c.text))
  }

  it('flags the exact shape that was hand-fixed: Gemini `?key=$VAR`', () => {
    const hits = scan([
      '#!/usr/bin/env bash',
      'curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_KEY"',
    ])
    expect(hits).toHaveLength(1)
    expect(hits[0]?.startLine).toBe(2)
  })

  it.each([
    ['bare variable', 'curl -s "https://api.example/v1?token=$TOK"'],
    ['command substitution', 'curl -s "https://api.example/v1?key=$(cat store/.k)"'],
    ['braced variable', 'curl -s "https://api.example/v1?api_key=${API_KEY}"'],
    ['second query param (&)', 'curl -s "https://api.example/v1?page=1&access_token=$TOK"'],
    ['hyphenated name', 'curl -s "https://api.example/v1?api-key=$K"'],
    ['uppercase param', 'curl -s "https://api.example/v1?TOKEN=$T"'],
    ['client secret', 'curl -s "https://api.example/oauth?client_secret=$CS"'],
    ['signature', 'curl -s "https://api.example/v1?signature=$SIG"'],
  ])('flags a credential in a URL query: %s', (_label, line) => {
    expect(scan(['#!/usr/bin/env bash', line])).toHaveLength(1)
  })

  it('flags a credential URL split across a CONTINUATION line', () => {
    const hits = scan([
      '#!/usr/bin/env bash',
      'curl -s -X POST \\',
      '  "https://api.example/v1?key=$K" \\',
      "  -d '{}'",
    ])
    expect(hits).toHaveLength(1)
    expect(hits[0]?.startLine).toBe(2)
  })

  it('does NOT flag `keyword` -- an ordinary search param that merely CONTAINS "key"', () => {
    // A substring match would make this rule unusable; the param name is anchored whole.
    expect(scan(['#!/usr/bin/env bash', 'curl -s "https://api.example/search?keyword=$Q"'])).toEqual([])
  })

  it('does NOT flag other non-credential params that contain a credential substring', () => {
    expect(scan(['#!/usr/bin/env bash', 'curl -s "https://api.example/x?tokenize=$N&keyboard=$B&authors=$A"'])).toEqual([])
  })

  it('does NOT flag the sanctioned fix: the credential moved into a header', () => {
    expect(scan([
      '#!/usr/bin/env bash',
      'hdr="$(mktemp)"; chmod 600 "$hdr"',
      'printf \'x-goog-api-key: %s\\n\' "$GEMINI_KEY" > "$hdr"',
      'curl -s -H @"$hdr" "https://generativelanguage.googleapis.com/v1beta/models"',
    ])).toEqual([])
  })

  it('does NOT flag a URL with no credential param at all', () => {
    expect(scan(['#!/usr/bin/env bash', 'curl -s "https://api.example/v1?page=2&limit=50"'])).toEqual([])
  })

  it.each([
    ['OAuth authorization code', 'curl -s "https://idp.example/token?code=$AUTH_CODE"'],
    ['RFC 7523 JWT assertion', 'curl -s "https://idp.example/token?assertion=$JWT"'],
    ['session id', 'curl -s "https://api.example/v1?session=$SID"'],
    ['private key', 'curl -s "https://api.example/v1?private_key=$PK"'],
    ['Azure APIM subscription key', 'curl -s "https://api.example/v1?subscription-key=$SK"'],
    ['GitLab job token', 'curl -s "https://gitlab.example/api?job_token=$JT"'],
    ['GitLab private token', 'curl -s "https://gitlab.example/api?private_token=$PT"'],
  ])('flags the parameter names added by card 2834e7f3: %s', (_label, line) => {
    expect(scan(['#!/usr/bin/env bash', line])).toHaveLength(1)
  })

  it('does NOT flag `?country_code=` / `?postcode=` -- the lookalikes `code` could have cost us', () => {
    // `code` is the one added name with plausible noise. Whole-name anchoring keeps these clean.
    expect(scan(['#!/usr/bin/env bash', 'curl -s "https://api.example/x?country_code=$C&postcode=$P"'])).toEqual([])
  })

  it('is INDEPENDENT of the Bearer rule -- a URL leak with a correct @headerfile is still caught', () => {
    // The two rules cover different shapes; passing one must not excuse the other.
    const lines = [
      '#!/usr/bin/env bash',
      'curl -s -H @"$hdr" "https://api.example/v1?key=$K"',
    ]
    expect(scan(lines)).toHaveLength(1)
    expect(findCurlInvocations(lines.join('\n')).filter((c) => leaksTokenInArgv(c.text))).toEqual([])
  })
})

// Card 2834e7f3, gap 2: a URL assembled into a VARIABLE first is invisible to any rule that only
// inspects reassembled curl invocations -- and building a URL in a variable is ordinary scripting,
// so the next real occurrence could easily take this shape.
describe('URL built into a variable first (card 2834e7f3 gap 2)', () => {
  it('the OLD curl-only scan MISSES it (this is the gap, stated as a fact)', () => {
    const script = ['#!/usr/bin/env bash', 'URL="https://api.example/v1?key=$K"', 'curl -s "$URL"'].join('\n')
    // The curl line alone contains only `$URL`; nothing credential-shaped is visible there.
    expect(findCurlInvocations(script).filter((c) => leaksTokenInUrlQuery(c.text))).toEqual([])
  })

  it('the whole-file scan CATCHES it', () => {
    const script = ['#!/usr/bin/env bash', 'URL="https://api.example/v1?key=$K"', 'curl -s "$URL"'].join('\n')
    const hits = credentialUrlLines(script)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.startLine).toBe(2) // the assignment line, where the credential actually is
  })

  it.each([
    ['single-quoted assignment', "BASE='https://api.example/v1?token=$T'"],
    ['appended later', 'URL="$BASE?api_key=$K"'],
    ['a local in a function', '  local u="https://api.example/x?secret=$S"'],
    ['printf into a variable', 'u=$(printf "https://api.example/x?password=$P")'],
  ])('catches a credential URL on a non-curl line: %s', (_label, line) => {
    expect(credentialUrlLines(['#!/usr/bin/env bash', line].join('\n'))).toHaveLength(1)
  })

  it('does NOT flag an ordinary URL variable with no credential', () => {
    expect(credentialUrlLines('#!/usr/bin/env bash\nURL="https://api.example/v1?page=1&limit=50"\n')).toEqual([])
  })

  it('does NOT flag the `keyword` lookalike on a non-curl line either', () => {
    expect(credentialUrlLines('#!/usr/bin/env bash\nQ="https://api.example/search?keyword=$W"\n')).toEqual([])
  })
})

// Card 2834e7f3, gap 3 (second half): `curl -G` makes curl BUILD the query string, so a credential
// passed via --data-urlencode ends up in the request URL, the access log and the Referer.
describe('curl -G builds the credential into the query string (card 2834e7f3 gap 3)', () => {
  function scanG(lines: string[]) {
    return findCurlInvocations(lines.join('\n')).filter((c) => leaksTokenInGetQuery(c.text))
  }

  it('flags -G with a credential in --data-urlencode', () => {
    expect(scanG(['#!/usr/bin/env bash', 'curl -s -G "https://api.example/v1" --data-urlencode "key=$K"'])).toHaveLength(1)
  })

  it('flags the long form --get as well', () => {
    expect(scanG(['#!/usr/bin/env bash', 'curl -s --get "https://api.example/v1" --data-urlencode "token=$T"'])).toHaveLength(1)
  })

  it('flags it across a continuation line', () => {
    expect(scanG([
      '#!/usr/bin/env bash',
      'curl -s -G "https://api.example/v1" \\',
      '  --data-urlencode "api_key=$K"',
    ])).toHaveLength(1)
  })

  it('does NOT flag the SAME flags without -G -- that is a POST body, the sanctioned form', () => {
    // This is the exact shape every fixed Telegram caller now uses; flagging it would be a
    // false positive on our own remediation.
    expect(scanG(['#!/usr/bin/env bash', 'curl -s -X POST -K - --data-urlencode "text=$MSG"'])).toEqual([])
  })

  it('does NOT flag -G with only non-credential parameters', () => {
    expect(scanG(['#!/usr/bin/env bash', 'curl -s -G "https://api.example/v1" --data-urlencode "q=$Q"'])).toEqual([])
  })
})

// Card 2834e7f3, gap 1: the Telegram Bot API REQUIRES the token in the URL path, so "move it to a
// header" does not exist here. MEASURED against a live stalling listener: with the URL as an argv
// element the token is visible in /proc/<pid>/cmdline; with `-K` it is not.
describe('path-embedded bot token (card 2834e7f3 gap 1)', () => {
  function scanP(lines: string[]) {
    return findCurlInvocations(lines.join('\n')).filter((c) => leaksTokenInUrlPath(c.text))
  }

  it.each([
    ['bare variable', 'curl -s "https://api.telegram.org/bot$TOKEN/sendMessage"'],
    ['braced variable', 'curl -s "https://api.telegram.org/bot${token}/sendMessage"'],
    ['with -X POST', 'curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage"'],
  ])('flags a path token passed as an argument: %s', (_label, line) => {
    expect(scanP(['#!/usr/bin/env bash', line])).toHaveLength(1)
  })

  it('does NOT flag the sanctioned config form (`-K -`), which is what the 9 scripts now use', () => {
    expect(scanP([
      '#!/usr/bin/env bash',
      'printf \'url = "https://api.telegram.org/bot%s/sendMessage"\\n\' "$token" \\',
      '  | curl -sS --max-time 15 -K - \\',
      '    --data-urlencode "text=${msg}"',
    ])).toEqual([])
  })

  it('does NOT flag a Telegram URL with no variable in the path (a literal doc example)', () => {
    expect(scanP(['#!/usr/bin/env bash', 'curl -s "https://api.telegram.org/bot123456/getMe"'])).toEqual([])
  })
})
