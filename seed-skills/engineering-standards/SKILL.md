---
name: engineering-standards
description: The fleet's synthesized engineering standard — 10 categories covering architecture, security, infra, QA, data, resilience, secrets, observability, and code hygiene. The non-negotiable baseline for every dev agent on any production code. Use when designing, building, reviewing, or auditing any system.
---
# Engineering Standards (a flotta mérnöki alapszabálya)

Peti 50 szabályának szintézise (deduplikálva, kategóriánként). Ez a KÖTELEZŐ baseline minden production kódra. Minden dev ügynök (és MikroB CTO-ként) ezt tartja. Lásd még: `project-workflow` (csapat-folyamat), `qa-test-strategy`, `legal-compliance-review`.

## I. Architektúra és modularitás
- **SRP:** egy modul/osztály/függvény = egy feladat. Ha "és"-sel írod le, bontsd szét.
- **Interfész-alapú, laza csatolás:** modulok csak publikus, verziózott API-n beszélnek. A belső működés Black Box.
- **Dependency Injection:** külső erőforrás (DB, Mailer, Logger) sosem drótozott; inicializáláskor injektált.
- **API First:** előbb a szerződés (OpenAPI/Swagger), utána a kód.
- **Statelessness:** a backend állapotmentes; session-állapot külső tárolóban (pl. Redis).
- **Domain-Driven Design:** a kódstruktúra az üzleti domént tükrözi; a technikai rétegek szolgálják ki.
- **Event-Driven (ahol lehet):** szinkron hívás helyett message queue, leválasztás ("fire and forget").
- **CQRS (ahol indokolt):** írási (Command) és olvasási (Query) logika szétválasztva teljesítményért.

## II. Cybersecurity mindset (úgy kódolj, mintha a támadó már bent lenne)
- **Zero Trust:** alapból semmi és senki nem megbízható; minden kérés hitelesített (belső microservice is).
- **Input validation & sanitization:** minden bemenet (URL, body, header) validált típusra/hosszra/formátumra. **Whitelist** logika, ne blacklist.
- **Least privilege:** szolgáltatás/DB user csak a kritikushoz fér; írási jog csak indokoltan.
- **Secure headers & config:** HSTS, CSP, X-Frame-Options; cookie Secure + HttpOnly + SameSite.
- **Fail secure:** hibánál/összeomlásnál az alapállapot "zárt" (hozzáférés megtagadva).
- **OWASP Top 10:** aktív védelem (SQLi, XSS, Broken Auth, stb.).
- **Threat modeling (STRIDE):** tervezésnél kötelező. Minden funkciónál: "Hogyan törném fel?"
- **Honeytokens:** csali adatok; ha valaki hozzájuk nyúl -> azonnali alert.

## III. Infrastruktúra és üzemeltetés (a szerver nyáj, nem háziállat)
- **Infrastructure as Code:** nincs manuális SSH; minden Terraform/Ansible/K8s kódból.
- **Immutable infrastructure:** futó szervert nem frissítesz; új verzió fel, régi le (Blue/Green).
- **Chaos engineering:** tesztkörnyezetben szándékos hibák (hálózat, DB) az önjavítás ellenőrzésére.

## IV. Minőségbiztosítás és tesztelés (teszteletlen kód = hibás kód)
- **Teszt piramis:** sok unit, közepes integration, kevés E2E. Minden funkcióhoz unit + integration.
- **TDD:** a teszt megelőzi a funkciót; ez kényszeríti ki a tiszta architektúrát.
- **Coverage minimum 80%:** alatta a PR automatikusan elutasítva.
- **Mutációs tesztelés:** a teszteket is teszteld (bukik-e a teszt, ha hibát viszel a kódba).
- Részletek: `qa-test-strategy` skill.

## V. Adatintegritás és sebesség
- **Database migrations as code:** sémaváltozás verziózott scripttel, rollback lehetőséggel.
- **Aszinkron feldolgozás:** minden 200ms+ művelet háttérfolyamatba (background job).
- **N+1 query elkerülése:** ORM-figyelem, nincs felesleges DB-terhelés.

## VI. Működési reziliencia
- **Circuit breaker:** lassú/hibás külső rendszerről a hívó leszakad és fallback-et ad, nem torlódik.
- **Rate limiting & throttling:** minden végpont védve DoS/Brute Force ellen (kliens/IP alapú).
- **Idempotencia:** tranzakcionális végpont (pl. POST /payment) kezelje a duplikált kérést (ne vonjon kétszer).
- **Graceful shutdown:** leállításkor a futó kérések befejeződnek, DB-kapcsolatok szabályosan zárulnak.

## VII. Adatvédelem és titkok (Vault protocols)
- **No hardcoded secrets:** jelszó/API-kulcs/token SOHA nem kerül gitbe; .env vagy Vault.
- **Titkosítás:** At Rest -> PII titkosítva/hashelve a DB-ben. In Transit -> kizárólag TLS 1.2+.
- **Supply chain security:** a CI/CD automatikusan szkenneli a függőségeket (SCA, npm/pip/docker); lyukas csomaggal nincs build.
- **Adatmaszkolás:** dev/teszt környezetbe SOHA nem kerül éles PII; szintetikus adat.

## VIII. Observability (a mindent látó szem)
- **Correlation ID:** minden bejövő kérés kap X-Request-ID-t, átörökítve minden belső és microservice híváson.
- **Strukturált logolás:** gépileg olvasható JSON; mezők: timestamp, level, correlation_id, service, message.
- **Audit trail:** biztonság-kritikus események (login, adatmódosítás) megmásíthatatlan naplóban.
- **No sensitive data in logs:** jelszó/token/PII soha nem logolható.

## IX-X. Kódhigiénia, workflow és governance
- **DRY:** ne másolj; kétszer leírt logika közös függvénybe.
- **KISS:** a legegyszerűbb működő megoldás; a komplexitás a biztonság ellensége.
- **Code review / négy szem elv:** nincs direkt commit a fő ágra; minden változást más hagy jóvá. (A flottában: a készítő SOHA nem ellenőrzi a sajátját -> `project-workflow` 4. szabály.)
- **CI/CD pipeline:** minden commit után automatikus build + test + deploy; zöld pipeline a feltétel.
- **Dokumentáció:** self-documenting kód (beszédes nevek); komment a *MIÉRT*-et magyarázza; README minden repo gyökerében (telepítés, futtatás).
- **Bus factor > 1:** nincs egy emberben/ügynökben koncentrált tudás; dokumentálj.
- **Blameless post-mortem:** incidens után a folyamat hibáját javítod, nem bűnöst keresel; jelentés kötelező.

## XI. Szerver-tekintély és authorizáció-keményítés (bevált minták, RBAC-hullám 2026-07)
A II. (Zero Trust, Fail secure) konkrét, harcban tesztelt implementációs mintái. Ezek a
valós multi-tenant RBAC-enforcement munkából desztillálva; alkalmazd MINDEN authz/írás-útnál.

- **Recompute-on-write (a szerver sosem trustolja a kliens számolt értékeit):** minden
  származtatott értéket (ár, összeg, total, score, jutalék) a szerver ÚJRASZÁMOL a nyers
  bemenetből a domain-logikával, és KIZÁRÓLAG az újraszámoltat tárolja. A kliens által
  küldött "preview"/számolt mező LEGFELJEBB drift-jelzés (tamper-detektálás), SOHA nem
  authoritatív. Minta: offer-creation a `calculateBid`-ből újraszámol, a beküldött
  preview-árat eldobja. Teszt: manipulált (túl-alacsony) preview -> a tárolt ár a helyes
  újraszámolt. Lásd `injected-port-adapters`, `tenant-pure-domain`.
- **Global fail-closed guard + no-unguarded-handler invariant:** az authorizáció EGY
  globális middleware-ként fut MINDEN handler ELŐTT; ismeretlen/nem-mappelt route ->
  CATCH-ALL DENY (nem átengedés). Kösd be úgy, hogy handler ne is legyen REGISZTRÁLHATÓ
  kormányzó policy nélkül (fail-closed register) -> a "nincs unguarded handler" invariánt
  wire-time ÉS request-time is kikényszerítve. Teszt: route-inventory assertion (minden
  regisztrált handler policy-hez mappelődik) + a guard a handler előtt fut (spy: forbidden
  role -> handler SOHA nem hívódik).
- **Fail-closed default MINDEN resolver-ben:** bármely scope/role/permission-resolver a
  LEGSZŰKEBBRE esik vissza ismeretlen bemenetnél (deny / Own / legszűkebb), SOHA nem blanket.
  Default-deny allow-listák; hiányzó (role,action) bejegyzés -> least privilege, nem All.
  A "default-open" csak akkor biztonságos, ha egy MÁSIK réteg már default-DENY-olt (pl. a
  row-scope default-All csak azért ok, mert az RBAC allow-list már megtiltotta az el nem
  ért action-t). Buktató: fail-OPEN resolver (ismeretlen -> All) csendes jogosultság-szivárgás.
- **Per-(role,action) row-scope külön action-okkal:** válaszd szét a "megérintheti-e a role
  az action-t" (RBAC allow/deny) kérdést a "MELY sorok fölött" (row-scope: All/Assigned/Own)
  kérdéstől. A per-(role,action) felülírásokat ADATKÉNT kódold. A manager teljes-scope és a
  portal saját-scope olvasást KÜLÖN action-nal (pl. `OffersRead` vs `OffersReadOwn`), hogy egy
  kliens saját-scope olvasása SOHA ne tudjon a manager blanket olvasásra szélesedni. Minta:
  `SlaRead` (manager, All) vs `SlaReadOwn` (client, Own); a kliens lookup-kulcsa a saját
  id-jére KÉNYSZERÍTVE, hogy ne tudjon más subjectet enumerálni.
- **Külön identity-scope = külön authz-mátrix (SOHA ne olvaszd össze):** ha van egy MÁSODIK
  szereplő-típus a tenant-felhasználók mellett (platform-operátor / superadmin, cross-tenant),
  annak KÜLÖN default-deny authz-mátrixa legyen, NE egy "superadmin" flag/oszlop a tenant
  role-mátrixban. A cross-tenant hatalmat egy tenant-role SOHA ne örökölhesse. Minta: a
  `SuperadminRole × SuperadminAction` (SUPERADMIN_MATRIX) teljesen külön a tenant RBAC-tól; a
  reserved verb-ek (pl. `TenantManage`) egyetlen tenant-role-nak sincsenek, csak a platform-
  gate adja. Az operátor-státusz is fail-closed: egy Disabled/visszavont operátor MINDEN
  action-tól tiltva a role-check ELŐTT. Cross-tenant mutáció, amit egy tenant-scoped domain-fn
  (pl. `inviteMember`) csak tenant-context-tel enged: a platform-handler egy EXPLICIT,
  auditált szintetizált cél-tenant admin-contexten át hívja (dokumentált impersonation), nem
  bypass-szal. Minden privilegizált platform-művelet audit-trailt ír (Zero Trust).

## XII. Auth UI: forward-oracle elkerülés (2026-07-16, 650f8eca Cybersec LOW)

Az auth form SOHA ne olvasson specifikus hibajelzőket a szerver response body-jából, hogy a UI-ban különböző lockout-állapotokat jelenítsen meg (pl. `remaining_secs`, `locked`, `locked_long`, `locked_permanently`). Ez **forward oracle**: az attacker tesztelőkérésekből térképezi fel a fiók állapotát és a lockout-szintet.

**Szabályok:**
- Minden 401/4xx válasz az auth endpointon OPAQUE: a FE csak annyit tudhat, hogy "sikertelen".
- Lockout-UX KIZÁRÓLAG kliens-oldali kísérletszámlálóval (pl. `failedAttempts >= 5`), NEM szerver-body olvasásból.
- A "túl sok kísérlet" UI-t a FE saját állapota váltja ki -- a szerver lock kódjai NEM kerülnek a usernek.
- A szerver oldalon viszont LEGYEN teljes lockout-logika (az opaque 401 mögött) -- a FE csak nem mutatja meg a részleteket.
- Ha a szerver lock-kódokat küld (pl. `{ error: "locked_long", remaining_secs: 600 }`), a FE-nek NEM szabad ezt értelmezni.

**Teszt:** minden lockout-kód (locked/locked_long/locked_permanently) ugyanolyan generikus `pw_error` alerten kell megjelenni -- a konkrét kód NEM vizsgálható a UI-ban.

## Források és frissesség (kemény szabály, minden ügynöknek)
- **Csak elsődleges/hivatalos forrás:** gyártói dokumentáció, hivatalos repo/README, RFC, szabványügyi testület (ISO/W3C/IETF), jogszabály, hatósági oldal, peer-reviewed publikáció. Fórum/blog/SEO/aggregátor/AI-összefoglaló NEM forrás, hacsak a user kifejezetten nem azt kéri (és akkor is jelölöd).
- Minden lényegi állítást forrással támasztasz alá; forrás nélkül nem találsz ki adatot, inkább kimondod hogy nincs hivatalos forrás. Ütköző forrásnál jelzed az ellentmondást.
- **Frissesség:** mindig a legfrissebb verzió/dokumentáció, verziószám + dátum ellenőrizve. Deprecated megoldást nem ajánlasz aktuális helyett (ha említed, megjelölöd).
- "Nem tudom" egy valid válasz: ne hallucinálj, ne tippelj tényként; a bizonytalanságot jelezd.

## Buktatók
- Ezek baseline-ek, nem dísz. Ha eltérsz egytől, az tudatos, indokolt és dokumentált döntés legyen.
- A fleet saját kódja egy Claude Code harness -- nem minden szabály (pl. K8s/IaC) értelmezhető 1:1; alkalmazd a kontextushoz, de a security/secrets/observability/kódhigiénia szabályok mindig élnek.

## Ellenőrzés
- Új kód: nincs hardcoded secret, input validált, teszt + 80% coverage, strukturált log, README.
- Architektúra: SRP, DI, API-first, laza csatolás.
- Review: nem a készítő hagyta jóvá.
- Authz (XI.): a szerver újraszámol minden származtatott értéket (nem trust); globális guard minden handler előtt + nincs unguarded handler; minden resolver fail-closed; RBAC allow/deny külön a row-scope-tól, saját-scope külön action.
