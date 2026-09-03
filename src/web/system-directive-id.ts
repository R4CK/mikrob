// Const-only module on purpose. Both the SENDER (system-directive.ts, which
// pulls in agent-process/tmux) and the RECEIVING-side guard (routes/
// messages.ts, on the request path) need this one string, and they must never
// drift apart -- the guard is what makes the sender's anchor trustworthy. A
// shared const module gives them one source of truth without dragging the
// heavyweight sender module into the HTTP route's import graph.

/**
 * The reserved sender id of authenticated system-directive rows.
 * Written only by in-process callers; POST /api/messages rejects it with 403.
 */
export const SYSTEM_DIRECTIVE_SENDER = 'system'
