// Generic robots.txt parser + path-allow check, per RFC 9309. Deliberately site-agnostic --
// no ingatlan.com-specific assumptions, since we could not fetch and inspect the real
// robots.txt (blocked: ingatlan.com is not on the egress allowlist, see README "Blokkolt").

export interface RobotsRule {
  path: string
  allow: boolean
}

export type RobotsGroups = Map<string, RobotsRule[]>

export function parseRobotsTxt(content: string): RobotsGroups {
  const groups: RobotsGroups = new Map()
  let currentAgents: string[] = []
  let groupClosed = false

  for (const raw of content.split('\n')) {
    const line = raw.split('#')[0].trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()

    if (key === 'user-agent') {
      const agent = value.toLowerCase()
      if (groupClosed) {
        currentAgents = [agent]
        groupClosed = false
      } else {
        currentAgents.push(agent)
      }
      if (!groups.has(agent)) groups.set(agent, [])
    } else if (key === 'allow' || key === 'disallow') {
      groupClosed = true
      if (currentAgents.length === 0 || value === '') continue // no group yet, or a no-op empty Disallow
      const rule: RobotsRule = { path: value, allow: key === 'allow' }
      for (const agent of currentAgents) groups.get(agent)!.push(rule)
    } else {
      groupClosed = true // crawl-delay, sitemap, etc. -- not used for allow/disallow
    }
  }
  return groups
}

function selectGroup(groups: RobotsGroups, userAgent: string): RobotsRule[] {
  const ua = userAgent.toLowerCase()
  return groups.get(ua) ?? groups.get('*') ?? []
}

// '*' matches any sequence, a trailing '$' anchors the end of the path (RFC 9309 special chars).
function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path)
}

// Longest matching rule wins; if the longest-matching allow and disallow rules tie in
// length, allow wins (RFC 9309 3.2.1). No matching rule at all -> allowed.
export function isPathAllowed(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null
  for (const rule of rules) {
    if (!matchesPattern(rule.path, path)) continue
    if (!best || rule.path.length > best.path.length) {
      best = rule
    } else if (rule.path.length === best.path.length && rule.allow && !best.allow) {
      best = rule
    }
  }
  return best ? best.allow : true
}

export function isAllowedByRobots(robotsTxtContent: string, userAgent: string, path: string): boolean {
  const groups = parseRobotsTxt(robotsTxtContent)
  return isPathAllowed(selectGroup(groups, userAgent), path)
}
