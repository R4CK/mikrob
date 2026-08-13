---
name: e2e-rbac-hierarchical-testing
description: Thorough live e2e testing of a project driven by RBAC-hierarchical user stories. Use when running end-to-end tests on any project: extract the real RBAC table, build test entities top-down (highest-privilege role first, e.g. CEO registers the company, then managers, then crew-leads, down to the lowest), write >=5 user stories per function/flow, and test each positive (authorized succeeds) AND negative (unauthorized server-side fail-closed) with reproducible evidence via the Playwright MCP. Triggers: "e2e test", "test this project live", "RBAC test", "user flow test", "teszteld le a projektet", "élő teszt".
---
# E2E RBAC-hierarchical live testing

## Mikor használd
- Egy projekt élő, böngészős e2e tesztelése (nem unit, nem statikus kódolvasás).
- Amikor bizonyítani kell, hogy MINDEN funkció + MINDEN user flow MINDEN RBAC-szinten működik (pozitív) és fail-closed (negatív).
- QA gate előtt: az itt gyűjtött bizonyíték a QA sign-offjának alapja (T Eszter NEM gate-tag, a bizonyítékait a QA gate használja).

## Eljárás

### 1. RBAC-tábla kinyerése (MikroB-vel közösen)
- Kérd el / derítsd ki a projekt VALÓS szerep-enumját (nem fejből): pl. superadmin, CEO/owner, manager, crew-lead, worker, inspector, anon.
- MikroB-vel egyeztesd: melyik szerep mit tehet (authz-mátrix), és mi a szervezeti hierarchia.

### 2. Teszt-entitások felépítése FENTRŐL LEFELÉ (hierarchikus)
- A LEGTÖBB jogosultságú szereptől indulj. Céges kontextusban: a **CEO regisztrálja a céget MINDEN adatával** (e nélkül nincs mit tesztelni lejjebb).
- Majd a CEO felveszi a **vezetőket/menedzsereket**; a menedzser a **csoportvezetőket**; lefelé minden szükséges szerepet a legkisebbig.
- Minden alsóbb szint kontextusát a fentebbi szint hozza létre (valósághű teszt-adat).

### 3. User story-k (funkciónként/flow-nként MINIMUM 5)
Sablon (angolul dokumentálva):
```
Story: <cím>
Role: <pontos RBAC szerep>
Goal: <mit akar elérni>
Acceptance:
  - <ellenőrizhető feltétel>
Positive: <jogosult szerep végigviszi -> siker + bizonyíték>
Negative: <jogosulatlan szerep -> szerver-oldali fail-closed (401/403) + bizonyíték>
```
Ha nincs elég story, MikroB-vel megírjátok a hiányzókat a valós funkció + RBAC alapján (nem kitalálva).

### 4. Végigjátszás a Playwright MCP-vel (valós Chromium)
- `mcp__playwright__browser_navigate` a projekt URL-jére; `browser_snapshot` az accessibility-fához; `browser_click`/`browser_type`/`browser_fill_form` az interakcióhoz; `browser_take_screenshot` a bizonyítékhoz; `browser_network_requests` a szerver-válaszokhoz.
- **Login-automatizálás / credential ELŐTT szólj MikroB-nak** (flotta-szabály 7).
- POZITÍV: a jogosult szerep végigviszi -> screenshot + tiszta network + console.
- NEGATÍV (fail-closed): a jogosulatlan szerepnél NEM elég a UI-blokk. Kerüld meg a UI-t (közvetlen API-hívás / URL-manipuláció) és bizonyítsd, hogy a SZERVER 401/403-mal elutasít. Vertikális ÉS horizontális eszkaláció (más tenant/user adata) TILTOTT -> teszteld.

### 5. Bizonyíték + jelentés
- Minden story-hoz: repro lépések + screenshot + network trace (kiemelten a negatív eseteknél a 401/403).
- Rendezett artifact (projekt / story / szerep azonosítóval).
- Az eredményt REVIEW-kommentbe + a QA gate-nek átadva (a QA a te bizonyítékodra épít).
- Néma kihagyás TILOS: amit nem teszteltél, külön listázd ("NEM tesztelt / miért").

## Buktatók
- **A UI-elrejtés NEM biztonság.** Ha csak a gomb szürke, de a szerver átengedi a közvetlen kérést, az KRITIKUS HIBA -> mindig a szerver-választ nézd.
- **Sorrend számít.** Ha nem a CEO-val kezdesz, nincs cég/adat amin az alsóbb szerepeket tesztelni -> a hierarchikus setup nem opcionális.
- **Zöld unit != működik.** A puszta zöld teszt nem bizonyíték (lásd a magic-link 151/151-zöld eset, ami 2 MAJOR hibát rejtett). Valós végigjátszás kell.
- **Aszinkron állapotok.** Várd meg a betöltést (`browser_wait_for`), ne vonj le következtetést villanásnyi állapotból.
- **Saját munka.** SOHA nem a saját munkádat teszteled.

## Ellenőrzés (Definition of Tested)
- Minden RBAC-szinten lefutott a pozitív ÉS negatív teszt.
- A negatív esetek szerver-oldali fail-closed viselkedése bizonyított (401/403 network-nyommal).
- Minden megállapításhoz reprodukálható bizonyíték.
- Funkciónként >=5 teljesülő, tesztelt user story.
- Az artifact-ok rendezetten elmentve, a QA gate számára átadva.
