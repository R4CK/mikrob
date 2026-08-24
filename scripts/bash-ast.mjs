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

// Over this many bytes we decline rather than parse. Measured: 1 MB of words parses in 1.35 s and
// 100 000 heredocs (3 MB) in 2.79 s -- survivable, but a PreToolUse hook runs on every single Bash
// call and its registration allows 10 s total. Real agent commands are orders of magnitude under
// this, so the cap costs nothing legitimate and bounds the worst case to a few ms.
const MAX_INPUT_BYTES = 131072

// Resolved once per process. `undefined` = not tried yet, `null` = unavailable (and we stay
// unavailable rather than retrying a failing require on every call).
let parserCache

// The dependency is OPTIONAL BY DESIGN. marveen does not ship tree-sitter today, and adding it
// touches package-lock.json, which no agent may stage. Until an operator installs it in the main
// clone, every call here returns null and self-pace-gate.mjs behaves exactly as it does now --
// so landing this file changes nothing until someone deliberately enables it.
// SELF_PACE_AST_MODULE_PATH points at an alternative install (used by the test suite).
function getParser() {
  if (parserCache !== undefined) return parserCache
  try {
    const base = process.env.SELF_PACE_AST_MODULE_PATH
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

// A heredoc attached to a pipeline or an AND/OR list belongs to that list's LAST simple command:
// in `true | curl -d @- <<'J'` and `[[ -f x ]] && curl -d @- <<'J'` the body is curl's, not the
// head's. Taking the first command here was a real bug in the prototype, caught by the battery.
function lastCommand(node) {
  if (!node) return null
  if (node.type === 'command') return node
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
  if (src.length > MAX_INPUT_BYTES) return null
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
      spans.set(opIdx, owner.startIndex)
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
