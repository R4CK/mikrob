## Teljes funkciólista karbantartás -- SZABÁLY (Peti 2026-08-15, KÖTELEZŐ, MINDEN projektre)

Minden git repóval rendelkező projekt README-jének "Complete feature list" (vagy honosított megfelelője) szekciója alatt legyen egy **magyar nyelvű, funkciónkénti bontású lista**, ami a következőket tartalmazza MINDEN egyes funkcióhoz:

- **User story** (magyarul, a felhasználó szemszögéből: "Mint X, szeretnék Y-t, hogy Z-t érjek el").
- **User flow** (a tényleges lépéssor, ahogy a felhasználó eléri és használja a funkciót az alkalmazásban).
- **Van-e hozzá tartozó frontend** -- explicit jelölve (`van` / `nincs` / `részleges`), a tényleges UI-ra hivatkozva (oldal/komponens), nem feltételezve.
- **Van-e hiányzó funkciója** -- explicit jelölve, ha a backend-kepesseg nincs teljesen kiszolgálva a UI-ban, vagy a flow megszakad valahol (ld. a 9. munkavégzési szabály, flow-connectivity).

**Automatikus frissítés:** minden commit után, ami új funkciót ad hozzá, meglévőt módosít, vagy elvesz, a listát UGYANABBAN a munkában (vagy a README-karbantartás szabály szerinti definition-of-done részeként) frissíteni kell -- nem különálló, elmaradható utómunka.

**RBAC-szerepenkénti bontás (Peti 2026-08-15, kiegészítés, KÜLÖN SZEKCIÓ):** a "Complete feature list" alatt, attól elkülönítve legyen egy **"Szerepkörönkénti user story és user flow"** (vagy honosított megfelelő) szekció is: minden RBAC-szerephez (amit a projekt RBAC-mátrixa definiál -- pl. superadmin, tenant-admin, member, guest, stb.) és minden funkcióhoz, amit az adott szerep elér, KÜLÖN user story + user flow, mert ugyanaz a funkció más szerepnél más jogosultsággal/más UI-úton érhető el (pl. superadmin lát mindent cross-tenant, member csak sajátot). Ahol egy szerepnek egy funkcióhoz nincs hozzáférése, azt is jelölni kell (nem hallgatni el, hogy a mátrix onnantól tiltja).

**Léptékkezelés:** ha egy projekt feature-listája nagy (pl. mopsion, 25+ alszekció, 150+ funkció), a kezdeti feltöltés önálló, dedikált munka -- Fázis/Feladat/alfeladat/lépés bontásban (1. munkavégzési szabály), szekciónként haladva. Ezután minden ÚJ/módosuló funkció a normál definition-of-done része, nem a nagy feltöltés ismétlése.

**Felelős kijelölés:** a kezdeti feltöltést és a user flow-k hitelesítését az végezze, aki a funkciókat élőben, böngészőben végig tudja járni (pl. `teszter`/T Eszter), a frontend-hiány/funkció-hiány jelölés pedig a `user-flow-menu-design` skill logikáját kövesse (wired/needs-wiring/needs-build). Gate: QA (a lista teljessége és pontossága is finding-köteles, ugyanúgy mint a README-pontosság).
