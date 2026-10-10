---
name: guarded-write-endpoint-token-email
description: Wire a multi-tenant lifecycle domain (invite / role-change / suspend, or any create-with-secret) to a fail-closed guarded WRITE endpoint that issues a hash-only, single-use, bound token and delivers a locale-aware, branded transactional email. Use when adding a POST/PATCH/DELETE that mints a capability token (invite, password-reset, verification, share-link) and emails it, on a framework-agnostic API with a central route-policy + guardRoute layer and a pure domain package. Companion to guarded-rowscoped-read-endpoint (the read side). Triggers: "invite endpoint", "wire the invite/PTO/worker-write endpoint", "issue an invite token + email it", "password-reset link", "verification email", "single-use token endpoint".
---
# Guarded write endpoint with a bound single-use token + transactional email

## When to use
A user-facing WRITE that (a) mutates a tenant lifecycle entity AND/OR (b) mints a
secret capability the recipient redeems later via an emailed link:
- invite a member / worker (create INVITED membership + invite token + email)
- password-reset, email-verification, share-link, magic-link-style flows
- role-change / suspend / revoke (mutation only, no token)

Preconditions this skill assumes (verify first):
- a declarative `route-policy` table mapping `(method, path) -> {shell, action}` and a
  `guardRoute(ctx, method, path)` the router runs BEFORE every handler;
- a fail-closed `register()` that refuses to bind a handler to an un-policied route;
- a PURE domain package that already owns the lifecycle (state machine + RBAC +
  tenant-scope). If it doesn't, build that FIRST with `tenant-pure-domain`.
- a central error->HTTP-status mapper keyed on `err.name`.

## Procedure

### 1. Read before writing (grounding, ~6 files)
- the domain module you are wiring (confirm it exposes the lifecycle fns + the token
  entity + a TTL constant + the binding-claims interface);
- the READ handler for the same entity (mirror its store/opaque-404/pagination shape);
- `route-policy` + the guarded router (see what's already policied vs registered);
- a sibling token flow already in the repo (e.g. magic-link): its crypto seam
  (`generateRawToken` + `hashToken`), its email composer, and its transport adapter;
- the FE api client for this feature -> the EXACT request/response contract to honor
  (path, body fields, return shape). Align BE to that contract, or note the FE-align
  follow-up (never weaken a hardened BE to match a looser FE).
- the error->status mapper.

### 2. Migration (if the token is persisted) -- RLS tenant table
Mirror the repo's newest RLS migration, NOT the platform/global one:
- columns = the domain token entity 1:1, INCLUDING the binding claims
  (recipient-email, tenant_id, role, target-row-id) so the token is not an unbound
  bearer credential;
- `token_hash TEXT NOT NULL UNIQUE` -- SHA-256 only, raw token NEVER stored;
- closed enums `CHECK`-constrained; partial index on the LIVE rows
  (`WHERE accepted_at IS NULL AND revoked_at IS NULL`);
- `ENABLE` + `FORCE ROW LEVEL SECURITY`, one symmetric `FOR ALL` policy on the
  `NULLIF(current_setting('app.tenant_id',true),'')::uuid` GUC;
- `GRANT SELECT, INSERT, UPDATE` (NO DELETE -- burn/revoke via UPDATE, retained).
Run the RLS-migration-placement guard test after.

### 3. Token issuance -- raw/hash split BY SHAPE (not convention)
```ts
export function issueInviteToken(bound, crypto, now): { rawToken; record } {
  const rawToken = crypto.generateRawToken()          // CSPRNG, 256-bit, base64url
  return { rawToken, record: {                         // record has NO rawToken field
    tokenHash: crypto.hashToken(rawToken),             // sha256 hex
    ...bound,                                           // email/tenant/role/targetId
    expiresAt: new Date(now.getTime() + TTL_SECONDS*1000),
    acceptedAt: null, revokedAt: null,
  }}
}
```
A caller that persists `record` physically cannot write the raw secret. Reuse the
repo's existing crypto seam -- do not hand-roll randomness/hashing.

### 4. Transactional email composer -- REUSE the sibling email seams
Model on the existing (magic-link) composer; import and reuse its
`Translator` / `Mailer` / `ComposedEmail` / `BrandingContext` types so ONE transport
adapter serves both. Invariants:
- raw token appears ONLY inside the action URL inside html/text body -- never in
  subject/to/from/locale;
- recipient validated with the canonical `isValidEmail` (rejects CRLF/NUL/BIDI ->
  no SMTP-header injection);
- tenant-controlled branding routed through the shared color/URL validators; logo
  only from an allowlisted host; a custom action-host validated (reject USERINFO
  account-takeover) else fall back to the branded subdomain;
- HTML-escape all interpolated branding/copy (defense in depth);
- i18n keys added to ALL configured locales (full parity), same namespace/style as
  the sibling email keys.

### 5. The handlers (app layer, injected ports)
Ports, all fail-closed in-memory by default (PG/real-mailer deferred): a write store
(`upsert`, async), a token store (`insert`), a directory (find-or-create the global
user by email, OPAQUE -- identical return whether found or created), a notifier.

`inviteHttp` order matters:
1. `authorize(ctx, ManageAction)` FIRST -- no side effects (no user provisioning) on
   a forbidden call, even though the route guard already checked (defense-in-depth);
2. validate body (email + enum), normalize email;
3. directory.findOrCreateByEmail (opaque);
4. reject a duplicate LIVE row (409);
5. domain lifecycle fn -> new entity (tenantId from ctx, NEVER body);
6. issue token; **persist token THEN entity (durable-before-send)**;
7. deliver email; a delivery failure is **non-fatal** (entity is durable) -- log it
   server-side WITHOUT the token/recipient, still return success.

`updateHttp` / `deleteHttp`: authorize -> load by (ctx.tenantId, id) [null -> opaque
404] -> domain fn with the full roster (last-admin / illegal-transition guards) ->
upsert. Return a small `{ ok: true }`.

### 6. Wire + policy + error map (the shared files -- TIGHT commit)
- route-policy: add the mutating rows (`action` = the Manage action). A 2-segment
  `/x/:id` never matches 3-segment sub-routes; distinct methods never clash.
- guarded router: register the handlers with the fail-closed in-memory defaults;
  share the RW store instance with the READ routes so a new row is visible to GET.
- error mapper: add rows -- invalid-body/domain-validation -> 400, last-admin /
  duplicate / illegal-transition -> 409; mark the ACTIONABLE ones safe-to-surface
  (message names the field/rule, leaks no secret/enumeration).

### 7. Tests (non-vacuous)
Handlers: positive persist + tenant-from-ctx; duplicate -> 409; opaque-404 for
absent/foreign; last-admin blocked; forbidden role (no side effects); **raw-token
confinement** (notifier gets raw, store record has ONLY hash); **durable-before-send**
(notifier throws -> still persists + returns). Composer: drive the REAL locale
catalogs through a `{name}`-only interpolator (faithful AND doubles as an i18n-parity
check); token-confinement per locale; invalid recipient; custom-host fallback;
html-escape.

## Buktatók (gotchas hit in practice)
- **Naive fake translator leaks the token into every key.** A test translator that
  dumps ALL params into every string will put the action-URL into the subject and
  FAIL the confinement assertion. Use a `{name}`-only interpolator over the REAL
  catalog (the subject string has no `{actionUrl}` placeholder) -- faithful + a free
  parity check.
- **Durable-before-send or you get a live link with no row** (and, if you send first
  then persist and the persist fails, an un-backed token). Persist, THEN email.
- **Email-governance hooks false-positive on `curl` bodies containing "email".** A
  fleet Bash guard can block a kanban-comment `curl` whose JSON body mentions email.
  Put the comment/body in a scratch FILE and `curl --data-binary @file` so the trigger
  words are off the command line.
- **Shared checkout:** `git add` ONLY your explicit paths (never `-A`); other agents'
  uncommitted edits (and transiently-broken files) live in the same tree. Verify your
  commit's `--stat` contains only your hunks; ping the co-owner of shared route/policy
  files for merge order.
- **A concurrent agent's broken file can transiently red the whole-project tsc.**
  Re-run; confirm the errors are outside your files (`grep -v yourfiles`) before
  diagnosing your own code.
- **Directory find-or-create must be OPAQUE:** identical return whether the global
  user existed or was created, else an authenticated admin can enumerate accounts.
- **Do not invent undefined product scope.** If part of the card (e.g. "availability")
  has no FE contract and no domain, it's a product decision -- hand it back with a
  crisp question, don't build a domain on a guess.

## Ellenőrzés (verify)
- `tsc --noEmit` clean on both packages (vitest does NOT type-check);
- new handler + composer tests green; the guard/route-inventory/error-status/i18n
  suites still green; the RLS-migration-placement guard green;
- grep your new files for NUL bytes if the tree is on a `/mnt/*` mount;
- the FE contract is honored (or the FE-align follow-up is explicitly filed);
- raw token appears in NO log and in NO persisted field (grep).
