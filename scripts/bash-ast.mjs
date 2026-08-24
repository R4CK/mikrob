// A NARROW bash boundary recogniser built on tree-sitter-bash (card f16b3165).
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// It answers exactly ONE question: "which simple command owns this heredoc?" -- the question
// `stripHeredocDataPayloads` in self-pace-gate.mjs currently answers with a hand-written walker
// that tracks quoting, parenthesis frames, case-statement state and reserved words, and that
// produced a new bypass class on seven consecutive review rounds (A-F, X1-X6, N1-N6, S1-S6,
// R1-R2, B1-B6, K1). It does NOT replace the ownership CHECKS themselves: CURL_LEADING_RX,
// CURL_STDIN_DATA_RX and the git-message trio stay exactly where they are and keep deciding
// whether the owning command is an exempt data sink. Only the span those checks run over is
// computed here. That is the whole point -- a smaller blast radius and a narrower rollback than
// swapping the guard out (plan-grilling change 2, comment 15683).
//
// WHY tree-sitter-bash (rule 10 due diligence, measured -- card comment 15687)
// MIT, tree-sitter org, no GitHub advisory in either the npm or the pip ecosystem, prebuilt
// binaries so no compiler is needed. On a 20-case grammar battery it named the correct owning
// command 20/20 with `bash -n` as ground truth, including all six forms the hand-written walker
// had never covered: (( )), select, [[ ]], coproc, function f(), extglob. Where the grammar and
// my own test cases disagreed, `bash -n` said the grammar was right all three times.
//
// TWO MEASURED CONSTRAINTS THAT SHAPE THIS FILE
//
//  1. THE TREE WALK MUST BE ITERATIVE. tree-sitter's PARSER is not the DoS surface -- it handled
//     50 000 levels of `$( )` nesting in 58 ms and scales linearly. A naive RECURSIVE walk over
//     the resulting tree throws `RangeError: Maximum call stack size exceeded` somewhere around
//     2000-5000 levels. In a fail-open hook that RangeError is a silent bypass, which is strictly
//     worse than the bug being fixed. The first prototype of this file had exactly that flaw.
//
//  2. UNDECIDABLE MUST BE REPRESENTABLE. Every failure path returns null rather than a guess:
//     the dependency is absent, the input is over the size cap, the parse contains an ERROR or
//     MISSING node, or anything throws. null means "I have no opinion", and the caller keeps the
//     existing hand-written answer. A recogniser that invents a span when it cannot parse would
//     hand an attacker the shape to aim for.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Over this size we decline rather than parse. Measured: 1 MB of words parses in 1.35 s and
// 100 000 heredocs (3 MB) in 2.79 s -- survivable, but a PreToolUse hook runs on every single Bash
// call and its registration allows 10 s total. Real agent commands are orders of magnitude under
// this, so the cap costs nothing legitimate and bounds the worst case to a few ms.
//
// Named for UTF-16 units, which is what `String.length` counts, because that is what it measures
// (Cybersec F-5). The old name said BYTES and a non-ASCII command can be up to three times its
// length in UTF-8, so the effective cap was tighter than the name promised -- conservative, never a
// bypass, but a name that lies is how the next reader gets it wrong.
const MAX_INPUT_UNITS = 131072

// Resolved once per process. `undefined` = not tried yet, `null` = unavailable (and we stay
// unavailable rather than retrying a failing require on every call).
let parserCache

// The dependency is OPTIONAL BY DESIGN. marveen does not ship tree-sitter today, and adding it
// touches package-lock.json, which no agent may stage. Until an operator installs it in the main
// clone, every call here returns null and self-pace-gate.mjs behaves exactly as it does now --
// so landing this file changes nothing until someone deliberately enables it.
//
// SELF_PACE_AST_MODULE_PATH points at an alternative install, and it is HONOURED ONLY UNDER TEST
// (Cybersec F-4). It makes the guard `require` code from an operator-supplied path, i.e. run
// foreign code inside the guard process. Anyone who can set the hook's environment could already
// disable the hook outright, so this was never privilege escalation -- but a switch that exists
// purely so the suite can arm itself should not be reachable in the configuration that actually
// guards the fleet. Under production it is ignored and resolution falls back to a normal require.
function underTest() {
  return process.env.VITEST !== undefined || process.env.NODE_ENV === 'test'
}

function getParser() {
  if (parserCache !== undefined) return parserCache
  try {
    const base = underTest() ? process.env.SELF_PACE_AST_MODULE_PATH : undefined
    const resolve = base ? createRequire(`${base.replace(/\/$/, '')}/noop.cjs`) : require
    const Parser = resolve('tree-sitter')
    const Bash = resolve('tree-sitter-bash')
    const p = new Parser()
    p.setLanguage(Bash)
    parserCache = p
  } catch {
    parserCache = null
  }
  return parserCache
}

// Depth-first, EXPLICIT STACK, never recursion -- see constraint 1 above.
function eachNode(root, visit) {
  const stack = [root]
  while (stack.length) {
    const n = stack.pop()
    if (visit(n) === false) return false
    const kids = n.children
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k])
  }
  return true
}

// Node types whose LAST element really is the one the heredoc belongs to. A heredoc on a pipeline
// or an AND/OR list feeds that list's final simple command: in `true | curl -d @- <<'J'` and
// `[[ -f x ]] && curl -d @- <<'J'` the body is curl's, not the head's.
//
// EVERYTHING ELSE IS DELIBERATELY NOT HERE, and this is the fix for a real bypass I shipped
// (Cybersec F-1 on card f16b3165, 14 shapes measured flipping DENY -> ALLOW, four of them proven
// by execution). When a heredoc is redirected ONTO A COMPOUND construct --
// `{ python3 -; curl -d @- ...; } <<'J'`, and the same for ( ), if, case, for, ((;;)), while,
// until, select and a function body -- bash gives that body as stdin to EVERY command in the
// group, not to the last one. Descending to the syntactically last `command` therefore names an
// exempt data sink as the owner while an INTERPRETER earlier in the group executes the very same
// text. Returning null instead leaves no entry in the map, which the caller's existing contract
// treats as "not an exempt payload" -- the body gets scanned. Fail-closed, and it costs nothing
// legitimate: a genuine `curl -d @-` INSIDE such a construct carries its own heredoc and is
// reached as a plain `command`, not through this descent.
//
// `negated_command` has to stay in the list: `! curl -d @- <<'J'` is still curl's heredoc, and
// dropping it turns the shipped negation case red. Measured, not assumed.
//
// WHY MY OWN BATTERY MISSED IT, worth keeping: it put the heredoc INSIDE each construct
// (`{ curl -d @- <<'J' ... J }`), where the owner genuinely IS curl and the answer was right. The
// attack surface is the mirror image -- the heredoc redirected onto the construct. The battery
// measured a real property, just not the one under attack. Enumerating the shapes from the
// grammar's own `redirected_statement.body` subtype list (18 of them, 4 list-like) is what makes
// the difference; enumerating from my own patch is what produced the gap.
const LIST_LIKE_BODY = new Set(['pipeline', 'list', 'negated_command'])

function lastCommand(node) {
  if (!node) return null
  if (node.type === 'command') return node
  if (!LIST_LIKE_BODY.has(node.type)) return null
  const kids = node.children
  for (let k = kids.length - 1; k >= 0; k--) {
    const found = lastCommand(kids[k])
    if (found) return found
  }
  return null
}

function ownerOf(node) {
  for (let n = node; n; n = n.parent) {
    if (n.type === 'redirected_statement') return lastCommand(n.childForFieldName('body'))
    if (n.type === 'command') return n
  }
  return null
}

// Keywords bash treats as a PREFIX to a command, which tree-sitter folds into the command node as
// its `command_name` with the real binary demoted to an argument -- `coproc curl ...` parses with
// command_name `coproc` and `curl` as a plain word, and `time -p curl ...` likewise.
//
// The span must start at the REAL binary, or the ownership checks see `coproc curl` / `time -p curl`
// and reject a legitimate payload. The hand-written walker already skips these (its
// CMD_PREFIX_KEYWORD_RX lists `time`), so without this the two paths disagree and enabling the AST
// would introduce two false positives that `off` mode does not have -- measured, on the `coproc` and
// `time -p` controls in self-pace-nested-command-context.test.ts.
//
// DIRECTION CHECK, because moving a span start FORWARD grants more exemption and that is the
// direction that can open a hole: the ownership checks still run on whatever follows, so
// `coproc python3 - <<'J'` yields the span `python3 -`, fails the leading-binary test, and is denied
// exactly as before. Only the prefix is skipped, never the binary.
const PREFIX_KEYWORDS = new Set(['time', 'coproc'])

function commandStart(cmd) {
  const kids = cmd.children
  const name = kids[0]
  if (!name || !PREFIX_KEYWORDS.has(name.text)) return cmd.startIndex
  // Past the keyword, and past any options belonging to it (`time -p`).
  for (let k = 1; k < kids.length; k++) {
    const t = kids[k].text
    if (t.startsWith('-') || t.startsWith('+')) continue
    return kids[k].startIndex
  }
  return cmd.startIndex
}

/**
 * Map every heredoc redirect in `command` to the START INDEX of the simple command that owns it.
 *
 * INDICES, NOT RECONSTRUCTED TEXT -- this is the whole narrowing. The caller already computes the
 * span as `src.slice(boundary, i)`; all this replaces is `boundary`. The first version returned a
 * span rebuilt by joining the owner node's child texts, and it was measurably wrong: in
 * `git commit -F - <<'EOF'` tree-sitter-bash puts the `command` node at [0,13] ("git commit -F")
 * and the heredoc_redirect at [16,33], leaving the bare `-` at index 14 in NO node at all. Joining
 * children silently dropped it, GIT_STDIN_MSG_RX stopped matching, and three legitimate
 * `git commit -F -` payloads flipped to DENY. Slicing the original source from the owner's start
 * index cannot lose a token the grammar declines to represent, and it keeps this module's output
 * in the same units the existing checks already speak.
 *
 * @param {string} command raw shell text
 * @returns {Map<number,number>|null} key = byte index of the `<<` token, value = byte index where
 *   the owning simple command starts. null when no opinion can be formed -- see constraint 2. An
 *   EMPTY map is a real answer ("no heredocs here"), not an absence of one.
 */
export function heredocOwnerSpans(command) {
  const src = String(command ?? '')
  if (src.length > MAX_INPUT_UNITS) return null
  const parser = getParser()
  if (!parser) return null
  try {
    const tree = parser.parse(src)
    // A parse error means the grammar and bash may disagree about this input, so we decline
    // instead of measuring a span off a tree we do not trust.
    const clean = eachNode(tree.rootNode, (n) => !(n.type === 'ERROR' || n.isMissing))
    if (!clean) return null
    const spans = new Map()
    eachNode(tree.rootNode, (n) => {
      if (n.type !== 'heredoc_redirect') return
      const start = n.children.find((c) => c.type === 'heredoc_start')
      if (!start) return
      // `<<` / `<<-` sits immediately before the tag; the walker's index is at the `<<`.
      const opIdx = src.lastIndexOf('<<', start.startIndex)
      if (opIdx === -1) return
      const owner = ownerOf(n)
      if (!owner) return
      spans.set(opIdx, commandStart(owner))
    })
    return spans
  } catch {
    return null
  }
}

/** True when the AST recogniser is actually usable in this process (dependency present). */
export function astAvailable() {
  return getParser() !== null
}
