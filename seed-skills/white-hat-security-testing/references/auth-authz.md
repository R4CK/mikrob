# Authentication & Authorization attack playbook

## Authentication
- **Token forgery**: missing/weak signature verification; `alg:none`; algorithm confusion (RS256 verified as HS256 with public key as secret); accepting unsigned/expired; missing `iss`/`aud`/`exp`/`nbf` checks.
- **Token type confusion**: replaying a refresh token as an access token (and vice versa). Verify the `type`/`token_use` claim is checked BEFORE other gates so an expired-refresh-as-access reports "wrong type", not "expired".
- **Expiry boundaries**: off-by-one at `exp` (inclusive vs exclusive); clock-skew handling; long-lived tokens; expiry not re-checked on refresh.
- **Magic-link / password-reset**: single-use enforced atomically (not read-then-write — see TOCTOU); TTL short and exclusive; raw token never stored (hash only) and never logged; token confined to the link (not in subject/body/referrer/logs).
- **Disabled / offboarded user**: a globally disabled/locked/deleted user must NOT authenticate even if a sub-relationship (membership/role row) is still active. Trace every status field (user status AND membership status AND tenant status).
- **Account enumeration**: identical response + timing class for exists-vs-not-exists on login/reset/signup; rate-limit before the existence lookup so the limit isn't an oracle.
- **Session**: fixation (rotate session id on auth), missing logout/refresh-rotation, no jti/blacklist for revocation, predictable session ids.

## Authorization / multi-tenancy
- **IDOR / object-level**: every read/write scoped to the caller's tenant/owner on the SERVER; never trust an id from the request. Try fetching another tenant's/user's object id.
- **Horizontal privilege**: tenant-A's valid token used against tenant-B's host/subdomain/route → must 403. Cross-check token tenant id AND slug against the host-resolved tenant.
- **Vertical privilege / role escalation**: lower role performing a higher-role action; mass-assignment of a `role`/`isAdmin` field; client-supplied permissions trusted.
- **RBAC matrix holes**: default-deny (unknown role/action → deny); every role×action cell intentionally decided; module/feature gate enforced server-side and BEFORE the action; superadmin scope separate from tenant roles.
- **Row-scoped actions**: an action that "passes" RBAC but must still be filtered to the caller's own rows (e.g. client sees only assigned sites) — verify the data-layer filter exists, not just the authorize() call.
- **Per-(role,action) scope leak** (CleanCore A-1, real intra-tenant leak): a GLOBAL per-ACTION row-scope set (`ROW_SCOPED_ACTIONS = Set<Action>`) CANNOT express that the SAME action is blanket for one role and row-scoped for another (e.g. `sites:read` = all sites for admin/dispatcher, but assigned-only for field-worker, own-only for portal client). With a per-action set, the scoped role silently gets the BLANKET grant → a field-worker reads every tenant site, a portal customer reads other customers' data. Check: does EVERY read action have a per-ROLE scope decision, not one global flag? Fix = split the action (`x:read:all` vs `x:read:assigned` vs `x:read:own`) OR a per-(role,action) scope map. Also: a matrix that GRANTS a read (cell = R/Own/Asgn) but has NO backing RBAC action at all (the module only has write actions) is the same leak once the route is wired — every granted read needs an enforceable action.
- **Fail-closed**: missing role/claim → empty permissions, never a junk value that some `.includes()` accidentally passes.

## Probes to try
- Mint/craft a token for tenant A, hit tenant B's subdomain → expect 403.
- Disabled user + active membership redeems a link → expect rejection.
- Same email different case exhausts then resets the rate limit → expect shared counter.
- Lower-role principal calls each admin action → expect ForbiddenError on every cell.
- Request an object id you don't own → expect 404/403, not the object.
