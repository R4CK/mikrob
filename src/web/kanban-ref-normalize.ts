// Rewrites `#<hex8>` kanban-card references inside inter-agent messages and
// kanban comments to the human-facing `#<seq> (<hex8>)` form before the content
// is persisted. The CLAUDE.md rule "hivatkozz #seq-vel, ne UUID-vel" is agent
// guidance; this is the code-side enforcement so the dashboard never shows
// the bare hex form even if a sub-agent forgets the convention.
//
// WHY THE HEX STAYS ALONGSIDE THE SEQ (card 8d5f2ec4). This rewrite has two
// audiences and they need different things. Peti reads the dashboard and wants
// `#1840`. An AGENT reading the same string has no use for it at all: every
// handle it has on a card is the hex -- `/api/kanban/<hex>` is the only address
// the API takes -- and a bare `#1840` is indistinguishable from a comment id,
// which is exactly how it misled two agents on 2026-09-13. Measured: the local
// draft for card `504ec76f` arrived as "Draft erkezett a #1751 kartyara", and
// 1751 IS a real `kanban_comments.id` -- a three-day-old CYBERSEC GO on an
// unrelated, already-closed card. MikroB hit the same shape (#1716 -> a stale
// card). Both of us went looking for the wrong thing.
//
// So the fix is not to stop normalising -- the dashboard rule is sound -- but to
// stop DESTROYING the only token the recipient can act on. `#<seq> (<hex8>)` is
// the shape this file already documented as the explicit-disambiguation pattern
// below, and it round-trips: `#1840` is digits-only and `(48b2ab7c)` has no `#`,
// so a second pass changes nothing.
//
// The matcher is intentionally narrow: only an 8-char `[a-f0-9]` token
// directly behind a `#` and on a word boundary, lookup-gated against
// kanban_cards. A non-match (random hex, GitHub PR `#308`, etc.) passes
// through untouched. The explicit-disambiguation pattern `#31 (cb5080e5)`
// keeps the seq intact (`#31` doesn't match the hex regex) and the bare
// `(cb5080e5)` in parens lacks the `#` prefix so it also passes through.

const HEX8_REF_RE = /#([a-f0-9]{8})\b/gi

export type SeqLookup = (idPrefix: string) => number | null

export function normalizeKanbanRefs(content: string, lookup: SeqLookup): string {
  if (!content || content.indexOf('#') === -1) return content
  return content.replace(HEX8_REF_RE, (match, hex: string) => {
    const canonical = hex.toLowerCase()
    const seq = lookup(canonical)
    if (seq == null) return match
    return `#${seq} (${canonical})`
  })
}
