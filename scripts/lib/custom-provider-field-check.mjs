// Shared classifier for an already-parsed agent-config object (card 11c6cab4 round 3, RedHat
// comment 32213): "the customProvider key is present but not a usable non-empty string" (a
// number, object, array, or empty/whitespace-only string). Both scripts/needs-fleet-oauth.mjs and
// scripts/watchdog-provider-env.mjs need this exact predicate but cannot call the path-based
// isAgentCustomProviderFieldUnusable()/readAgentCustomProvider() pair in src/web/agent-config.ts
// (both scripts are fixture-tested against a temp directory distinct from the real agents/ tree
// that agentDir(name) resolves against) -- this module is the one shared place for the predicate
// itself, so the two scripts at least do not retype the condition a third time between them.
export function isCustomProviderFieldUnusable(config) {
  if (!('customProvider' in config)) return false
  const value = config.customProvider
  return !(typeof value === 'string' && value.trim())
}
