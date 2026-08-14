# Firecrawl -- adoption decision and the one thing that blocks it (card 91c4a369)

**Capability gap being closed:** `WebFetch`/`WebSearch` cannot do JS-heavy structured scraping.

**Status: BLOCKED on an API key.** Everything that does not depend on the key is decided and written
down below; the key itself is Peti's to obtain (external account, and the paid tiers make it a
`payment`-class action, which is autonomy level 1 = locked).

## Decision: the official MCP server against the HOSTED API. No custom client, no embedded code.

| | |
|---|---|
| adopt | `firecrawl-mcp` (npm), **MIT**, `github.com/firecrawl/firecrawl-mcp-server`, 3.24.0 |
| via | `@mendable/firecrawl-js` (its dependency), **MIT**, official SDK for the hosted API |
| do NOT adopt | the `firecrawl/firecrawl` server itself -- **AGPL-3.0**, and its network clause is exactly why the card says hosted-only |

**The licence question the card raised is answered by measurement, not by assumption.** The AGPL
applies to the self-hostable server. The client packages we would actually run are MIT:

```
npm view firecrawl-mcp license          -> MIT   (3.24.0, published 2026-08-12)
npm view @mendable/firecrawl-js license -> MIT   (4.32.1)
```

So calling the hosted API through the official MIT client embeds no AGPL code and triggers no network
clause. Writing our own HTTP client would be worse on every axis (rule 10: do not rebuild what an
official, maintained, correctly-licensed client already does) and would not change the licence story.

## Key handling: the key never touches disk-resident config

The fleet already has the mechanism, so this needs no invention:

- `scripts/vault-env-wrapper.sh` resolves `vault:` references in env vars and then execs the real
  command -- the MCP server launches with the secret in its environment, and `.mcp.json` holds only
  the vault id.
- Claude Code additionally expands `${VAR}` inside an MCP server's `env`/`args`/`headers` in every
  config scope, so `"FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}"` works with a launch-time export.

Planned entry (NOT yet added to `.mcp.json` -- see "why it is not activated"):

```jsonc
"firecrawl": {
  "type": "stdio",
  "command": "/home/neon/marveen/scripts/vault-env-wrapper.sh",
  "args": ["npx", "-y", "firecrawl-mcp@3.24.0"],
  "env": { "FIRECRAWL_API_KEY": "vault:firecrawl.apiKey" }
}
```

Pin the version deliberately (`@3.24.0`), for the same reason CodeBurn is pinned: an auto-upgraded
package with network capability is unaudited code on the fleet's machine.

## Verifying it, when the key exists -- and the trap in that verification

**`✔ Connected` in `claude mcp list` is NOT proof the key works.** Measured previously on this fleet
(memory `mcp-header-env-expansion-and-connect-is-not-the-oracle`): with the variable unset, an MCP
server still reports Connected, because the remote authenticates per tool call, not at connect. The
real signal is the diagnostics warning line:

```
[Warning] [firecrawl] mcpServers.firecrawl: Missing environment variables: FIRECRAWL_API_KEY
```

So the acceptance procedure is:

1. Store the key in the vault as `firecrawl.apiKey` (never in `.mcp.json`, never in a shell history,
   never in a log line).
2. Add the entry above, restart the session.
3. A/B it: run once with the vault entry present and once with it removed. Both will say Connected;
   only the second prints the warning. **Read the warning line, not the status.**
4. Make one real scrape call against a JS-heavy page and confirm structured output -- that, not the
   handshake, is the proof the capability gap is closed.
5. Grep the resulting transcript/log for the key's literal value: it must appear nowhere.

## Why it is not activated now

Adding an MCP server whose credential is absent would put a permanently-warning, tool-call-failing
server into every agent's startup. A control that is present but broken is worse than one that is
openly missing: the next reader sees `firecrawl` in the config and believes the capability exists.
The config lands in the same change as the key, not before it.

## What Peti needs to decide

1. **Create the Firecrawl account and issue an API key** (free tier exists; the useful volume is
   paid -- a spend decision, hence level 1 / locked for the fleet).
2. Whether the key goes in the shared vault (all agents can scrape) or is scoped to one agent.

Once the key is in the vault as `firecrawl.apiKey`, the remaining work is the four lines of
`.mcp.json` above plus the acceptance run in the previous section.
