// Card 6cd61430 (Fazis fe3eff9f): extraction of typed relation edges from the structured markers
// the fleet ALREADY writes -- no new tagging burden on the building agents.
//
// PURE ON PURPOSE. Nothing here opens a database, reads a file or shells out to git. Two callers
// need the same answer and must never drift apart: the live hook (db.ts, on card/comment write) and
// the reconcile sweep (db.ts, full recompute). One module, both paths -- because two hand-written
// copies of an extraction rule diverge SILENTLY, and the divergence only shows up as edges that
// exist for cards written before a certain date.
//
// WHAT IS DELIBERATELY NOT HERE
//
// `blockedBy` -- the dispatching card names it as a fourth source. It is not one, measured: all 17
// occurrences in the corpus (3 descriptions, 14 comments) are PROSE about a DERIVED API response
// field, not a marker. Card 38788337 states its own shape: "egy szarmaztatott `blocked: boolean`
// mezo (+ opcionalisan `blockedBy: [{id,title,status}]`)". The real store is kanban_dependencies,
// a typed relation table with actual foreign keys. Copying it here would need relation_type
// 'blocks', which this table's trigger refuses BY DESIGN (card 9d7a247a): an edge written here
// would look like a blocker to a reader and block nothing, because the card-close guard reads
// kanban_dependencies. Renaming it 'depends-on' would reintroduce exactly that, one alias later.
//
// `touches-file` -- out of scope for this card and flagged rather than dropped. It needs sha ->
// file resolution, i.e. git IO, which must never run inside a comment-write path. Feasible
// (measured: 1064 of 1069 distinct Gate-SHAs resolve locally, 569 in marveen and 495 in CleanCore),
// so it belongs in its own sweep-only card with its own `source` tag.

/** One extracted edge. Mirrors the kanban_relations column order. */
export interface RelationEdge {
  readonly from_type: string
  readonly from_id: string
  readonly to_type: string
  readonly to_id: string
  readonly relation_type: string
}

/** The ONE `source` value everything this module produces is written under.
 *
 *  The schema comment floated 'backfill-v1'/'live'/'manual' as separate tags. Separate tags break
 *  the reconcile: "delete the rows this extractor no longer produces" stops being expressible as a
 *  single predicate the moment the live path and the sweep tag their rows differently. With one
 *  tag the invariant is one line -- the set of source='marker-v1' rows equals the set extracted
 *  from the corpus -- and so is the undo: DELETE FROM kanban_relations WHERE source='marker-v1',
 *  which leaves any hand-inserted row under another tag untouched. */
export const MARKER_SOURCE = 'marker-v1'

/** The relation_type vocabulary, in ONE place because a writer and a reader that disagree about
 *  the string produce an EMPTY answer rather than an error -- a query for 'gate_sha' against rows
 *  written as 'gate-sha' returns zero edges and reads exactly like "this card has no shas".
 *
 *  The two git-derived types live here too, even though kanban-relations-git.ts is what emits
 *  them. That module already takes its RelationEdge type from this one, and the reader that needs
 *  the strings (db.ts, card 69396b63) MUST NOT import it -- it shells out to git and is kept off
 *  the request path by construction (see that file's header). A shared pure vocabulary is how both
 *  sides name the same edge without db.ts reaching into the git module. */
export const REL_GATE_SHA = 'gate-sha'
export const REL_PAIR_FE = 'pair-fe'
export const REL_PAIR_BE = 'pair-be'
export const REL_CHILD_OF = 'child-of'
export const REL_TOUCHES_FILE = 'touches-file'
export const REL_RESOLVED_IN = 'resolved-in'

/** The node types those edges use, for the same reason. */
export const NODE_CARD = 'card'
export const NODE_SHA = 'sha'
export const NODE_FILE = 'file'
export const NODE_REPO = 'repo'

/** Split the `to_id` of a `file` node back into its repo and path halves -- the inverse of
 *  kanban-relations-git.ts's qualifyPath, kept here because db.ts must not import that module.
 *
 *  Only the FIRST colon separates: a path may contain one, and splitting on the last would move
 *  part of the directory into the repo name. A value with NO colon is not repo-qualified (nothing
 *  writes such a row today), and comes back with a null repo rather than a guessed one. */
export function parseQualifiedPath(fileId: string): { repo: string | null; path: string } {
  const sep = fileId.indexOf(':')
  if (sep <= 0) return { repo: null, path: fileId }
  return { repo: fileId.slice(0, sep), path: fileId.slice(sep + 1) }
}

/** Rule 4b's `Gate-SHA:` line, ANCHORED AT THE START OF A LINE.
 *
 *  Taken from store/gate-pretriage-candidates.py (GATE_SHA_LINE), not re-derived: that pattern is
 *  hardened against seven documented false-positive incidents, and a fifth hand-rolled copy of the
 *  same rule in this repo is how the sixth incident gets written. The anchor is the load-bearing
 *  part and rule 4b says why: it is what lets an agent DISCUSS the convention mid-sentence without
 *  triggering anything. Measured on the corpus: 2397 of the 2492 comments carrying the string put
 *  it at line start; the other 95 are prose ("Gate-SHA: sor lenne a REVIEW-ban", regex fragments,
 *  quoted examples) and must stay out. */
const GATE_SHA_LINE = /^[ \t]*Gate-SHA:[ \t]*((?:[0-9a-f]{7,40}[\s/,+]*)+)/gim
const SHA_TOKEN = /[0-9a-f]{7,40}/g

/** Rule 8a's pair lines. ANCHORED ON THE LABEL, NOT ON THE LINE START, and the hex token after the
 *  colon is required -- both halves measured, neither is stylistic.
 *
 *  Rule 8a says the line belongs in "a leiras ELSO nehany soraban", which reads like the same
 *  line-start anchor Gate-SHA uses. It is not: 2 of the 104 pair-carrying cards state a REAL pair
 *  mid-line, after other prose -- "Peti GO (8779c351 epic, 2026-08-20). Pair-FE: 7a1a8aec"
 *  (37e30adb) and "Fazis: bc465e33. Pair-BE: d8d55452" (17d8865f). A line-start anchor loses them.
 *
 *  A bare label anchor, though, sweeps in the cards that TALK about the convention: fe3eff9f and
 *  6cd61430 both contain "Pair-FE:/Pair-BE:, blockedBy JSON", and 3bd18e70 has "Pair-BE: a
 *  FELADAT-3 API-ra epul". Requiring a hex id IMMEDIATELY after the colon rejects all three (the
 *  next character is a slash or a Hungarian article) and, in the same stroke, the 40-plus cards
 *  whose pair value is prose meaning "none": `n/a`, `-`, `nincs (frontend-only)`, `N/A (infra
 *  refactor)`. A parser that took "the rest of the line" would have written every one of those as
 *  an edge.
 *
 *  Residual, accepted: a comment that names an example id right after the label would match. That
 *  is a far smaller class than the real pairs a line-start anchor drops, and the reconcile removes
 *  such an edge the moment the text is corrected. */
const PAIR_LINE = /\bPair-(FE|BE):[ \t]*([0-9a-f]{6,40})\b/gi

/** Every sha stated on a rule-4b Gate-SHA line, in order, deduplicated.
 *
 *  ONE deliberate difference from gate-pretriage-candidates.py, which shares the pattern above:
 *  that script resolves each line to a SINGLE sha (the last token wins) because it has to pick one
 *  commit to gate. A relation table records what was said, so every token on the line is an edge --
 *  rule 4b's own multi-commit form ("Gate-SHA: <sha>, <sha>") means the card was gated on all of
 *  them, and keeping only the last would lose the rest for good. */
export function gateShasIn(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of (text || '').matchAll(GATE_SHA_LINE)) {
    for (const token of line[1]!.matchAll(SHA_TOKEN)) {
      const sha = token[0].toLowerCase()
      if (seen.has(sha)) continue
      seen.add(sha)
      out.push(sha)
    }
  }
  return out
}

/** Edges a single comment contributes: the card was gated on each sha it states.
 *
 *  Self-edges are dropped. Card ids in this fleet are 8 hex characters and read as short shas
 *  (a documented, repeatedly measured confusion), so a comment that puts its own card id on a
 *  Gate-SHA line would otherwise write "card X was gated at commit X". */
export function commentEdges(cardId: string, content: string): RelationEdge[] {
  const edges: RelationEdge[] = []
  for (const sha of gateShasIn(content)) {
    if (sha === cardId.toLowerCase()) continue
    edges.push({
      from_type: NODE_CARD,
      from_id: cardId,
      to_type: NODE_SHA,
      to_id: sha,
      relation_type: REL_GATE_SHA,
    })
  }
  return edges
}

/** The card fields a relation can be derived from. Narrower than KanbanCard on purpose: this
 *  module must stay usable from a plain SQL row without importing the DB layer's types. */
export interface RelationSourceCard {
  readonly id: string
  readonly description?: string | null
  readonly parent_id?: string | null
}

/** Edges a single card contributes: its stated FE/BE pair, and its place in the parent tree.
 *
 *  `parent_id` is materialised even though kanban_cards already carries the column, because the
 *  point of the layer is ONE uniform way to traverse card relations -- and, unlike the `blocks`
 *  case above, no guard elsewhere reads a different table for it. The second-copy objection is
 *  real and is answered structurally rather than by discipline: the sweep is a reconcile, so a
 *  re-parented card's stale edge is deleted, not merely out-voted by a new one.
 *
 *  Direction is "as stated", not normalised: the BE card says Pair-FE and the FE card says
 *  Pair-BE, so a `pair-fe` edge means THIS card named that one as its frontend half. Collapsing
 *  both into one symmetric type would lose which side actually carries the marker -- which is the
 *  thing rule 8a's QA checklist asks about. */
export function cardEdges(card: RelationSourceCard): RelationEdge[] {
  const edges: RelationEdge[] = []
  const id = card.id
  for (const m of (card.description || '').matchAll(PAIR_LINE)) {
    const target = m[2]!.toLowerCase()
    if (target === id.toLowerCase()) continue
    edges.push({
      from_type: NODE_CARD,
      from_id: id,
      to_type: NODE_CARD,
      to_id: target,
      relation_type: m[1]!.toLowerCase() === 'fe' ? REL_PAIR_FE : REL_PAIR_BE,
    })
  }
  const parent = (card.parent_id || '').trim()
  if (parent && parent.toLowerCase() !== id.toLowerCase()) {
    edges.push({
      from_type: NODE_CARD,
      from_id: id,
      to_type: NODE_CARD,
      to_id: parent,
      relation_type: REL_CHILD_OF,
    })
  }
  return edges
}

/** The stable identity of an edge -- the five columns of the table's PRIMARY KEY, in order.
 *  Used to diff "what the corpus says" against "what the table holds" without a round-trip. */
export function edgeKey(e: RelationEdge): string {
  return [e.from_type, e.from_id, e.to_type, e.to_id, e.relation_type].join(' ')
}

/** Deduplicate by PRIMARY KEY identity, keeping the first occurrence. A card is commented on many
 *  times with the same Gate-SHA (measured: 2492 comments resolve to 1069 distinct shas), so the
 *  caller would otherwise attempt the same INSERT hundreds of times. */
export function dedupeEdges(edges: readonly RelationEdge[]): RelationEdge[] {
  const seen = new Set<string>()
  const out: RelationEdge[] = []
  for (const e of edges) {
    const k = edgeKey(e)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}
