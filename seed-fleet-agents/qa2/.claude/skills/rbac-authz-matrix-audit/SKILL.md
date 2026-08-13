---
name: rbac-authz-matrix-audit
description: Systematic RBAC authorization matrix audit for a role. Use when auditing whether a specific role (e.g. Inspector, Client) has correct positive and negative authorization paths at both action-level and HTTP-route-level. Produces a complete matrix with coverage gaps.
---
# RBAC Authz Matrix Audit

## Mikor használd
Amikor auditálni kell egy adott szerepkör (pl. Inspector, Client) teljes RBAC lefedettségét:
- Audit kártyák (`[AUDIT][A4b]` vagy hasonló)
- Release előtti RBAC review
- Új szerepkör bevezetésekor

## Eljárás

### 1. Forrásgyűjtés (párhuzamosan)
```bash
# RBAC grants: melyik action milyen role-nak adott, milyen RowScope-pal
cat packages/control-plane/src/rbac.ts | grep -A30 'Inspector\|Client'

# Route policies: melyik route melyik action-t és shell-t vár
cat apps/api/src/route-policy.ts | grep -B2 -A5 'Action\.'

# HTTP-layer tesztek: route-level pozitív/negatív tesztek
cat apps/api/src/route-policy.test.ts

# Action-level tesztek: authz-per-role security suite
cat packages/control-plane/src/authz-per-role.security.test.ts
```

### 2. Pozitív útvonal mátrix (mit SZABAD elérni)
RBAC grants-ből (rbac.ts) listázd ki minden allowed action-t + RowScope-ot az adott role-ra. Minden action-hoz keress ROUTE_POLICIES-ban megfelelő HTTP route-ot. Ellenőrzési forrás:
- authz-per-role.security.test.ts L3 (row-scope per role+action)
- route-policy.test.ts `allowed(role, method, path)` hívások

### 3. Negatív útvonal mátrix (mit TILOS elérni)
Az L1 denied-list (authz-per-role L1) + shell separation tesztek alapján. Ellenőrizd:
- authz-per-role.security.test.ts L1 (denied actions lista per role)
- route-policy.test.ts `forbidden(role, method, path)` + shell separation describe blokk
- Client esetén: `EVERY portal route resolves to RowScope.Own` inventory teszt

### 4. Gap analízis
Minden pozitív útvonalnál jelöld:
- `TESTED_HTTP`: route-policy.test.ts-ben explicit `allowed()` hívás van
- `TESTED_ACTION`: authz-per-role L3-ban van assert
- `TESTED_INDIRECT`: route-inventory teszt fedi (pl. Client portal routes)
- `MISSING`: sem HTTP, sem action szinten nincs pozitív assert

### 5. Verdikt
- **PASS**: ha a core authz logika helyes (grants, shell separation, row-scope) és a gap-ek csak LOW (teszt-coverage, nem tényleges lyuk)
- **FAIL**: ha grant hiányzik, shell separation lyukas, vagy RowScope rossz

## Output formátum

```
### Inspector pozitív útvonalak
| Route | Action | RowScope | Tesztelt | Hol |
|-------|--------|----------|----------|-----|
| GET /inspections | InspectionsRead | Own | YES | route-policy.test.ts:253 |
| GET /reports | ReportsRead | All | NO | (nincs teszt) |

### Gap-ek (LOW -- teszt-lefedettség)
FINDING-1 [LOW]: Inspector GET /reports pozitív út nincs tesztelve
- ReportsRead grant: rbac.ts-ben megvan
- Route: route-policy.ts:322, manager shell
- Hiányzik: authorizeScoped(ctx('inspector'), A.ReportsRead) === R.All
```

## Buktatók

### L3 test-name vs test-body eltérés
Az authz-per-role L3 teszt neve tartalmazhat állítást (`"All sites/reports"`), de a body csak SitesRead-et tesztelhet. **Mindig olvasd el a test body-t**, ne csak a nevét.

### Route-inventory teszt mint szisztematikus lefedés
A `route-policy.test.ts`-ben a `ROUTE_POLICIES.filter(p => p.shell === 'portal')` loop szisztematikusan lefedi az összes portal route-ot Client számára -- ez egy kártya, nem kell egyenként felsorolni.

### Inspector vs All scope
Inspector SitesRead=All (nem Assigned!) -- a Crew Assigned-et kap SitesRead-re, Inspector-nak All van (pl. minden site, nem csak hozzárendelt).

## Ellenőrzés
- Minden action-t a RBAC grants-ből lefedted a mátrixban
- Minden negatív path tesztelt (L1 + shell separation)
- L3 test body-t olvastál (nem csak nevet)
- Gap-ekre finding kártyákat nyitottál (ha MAJOR)
