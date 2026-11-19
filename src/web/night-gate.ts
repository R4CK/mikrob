// The server-side fence around a 'night' scoped device key (card 2ba008f2, elemzo plan-grilling
// on d5638d28, comment 32144, C1).
//
// Decided BEFORE any route handler runs, same chokepoint and same deny-by-default shape as
// operator-gate.ts: a 'night' scoped key may reach exactly three things -- a GET under
// /api/kanban (board/cards/comments, read-only), POSTing a comment on a card (the author and a
// marker are forced server-side, see kanban.ts's comment route), and POSTing a message (the `to`
// is restricted to mikrob, see messages.ts) -- and nothing else, including a route added later.
// Every other credential (token, session, 'full'/'operator' device key, federation) is untouched
// by this gate.

export interface GateAuth {
  kind: string
  scope?: string
}

const NIGHT_COMMENT_ROUTE_RX = /^\/api\/kanban\/[^/]+\/comments$/

/** null = let it through; otherwise the reason for a 403. */
export function nightGateDecision(auth: GateAuth, path: string, method: string): string | null {
  if (auth.kind !== 'device' || auth.scope !== 'night') return null
  if (method === 'GET' && path.startsWith('/api/kanban')) return null
  if (method === 'POST' && NIGHT_COMMENT_ROUTE_RX.test(path)) return null
  if (method === 'POST' && path === '/api/messages') return null
  return 'night credential: not in the night-scope allowlist'
}
