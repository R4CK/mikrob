// Explicit email allowlist (card 3d04350b: "KIZAROLAG Peti Google-fiokja ferhet hozza"). Case-
// and whitespace-insensitive because Google account emails are case-insensitive in practice and
// a config typo (trailing space, stray capital) must not silently lock the owner out or, worse,
// silently widen access.
export function isAllowedEmail(email: string | undefined | null, allowlist: readonly string[]): boolean {
  if (!email) return false
  const normalized = email.trim().toLowerCase()
  if (!normalized) return false
  return allowlist.some((allowed) => allowed.trim().toLowerCase() === normalized)
}
