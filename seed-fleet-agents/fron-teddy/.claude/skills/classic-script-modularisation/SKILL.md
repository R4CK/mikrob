---
name: classic-script-modularisation
description: Rules and traps for extracting code from a monolithic app.js into separate classic <script> tags (not ES modules). Covers load order, var vs let scope, microtask ordering, fork-overlay seams, and string-contract tests.
---

# Classic-script modularisation (app.js slicing)

## Mikor használd

Bármely feladatnál, ami a projekt `web/app.js` monolitjából code kiemelést végez `web/app-<name>.js` klasszikus script tagokba, vagy az ilyen szletek gate-ellenőrzésénél.

## Alapelvek

### 1. `var` vs `let` a cross-script state-hez

Klasszikus `<script>` tagokban a top-level `let`/`const` a globális lexikális environment-ben él, de más script tagok IIFE-jeiből az assignment (`x = 'value'`) **implicit `window.x` globált hozhat létre** ahelyett, hogy a `let` bindingot módosítaná. Ezért:

- Ha egy változóra **több script tag és/vagy IIFE ír**, `var`-t használj, nem `let`-et. A `var` garantáltan a `window`-on van -- minden kódból ugyanaz a binding olvasható és írható.
- `let`/`const` csak akkor biztonságos, ha a változót **csak egyetlen script tag** deklarálja és módosítja, és más tagok csak olvassák (nem írják).

Konkrét élő hiba: `_agentsActiveView` `let`-tel volt deklarálva az `app-agents-team.js`-ben, de `app-router.js` és `app-page-switch.js` IIFE-jeiből írták. A `switchPage` a `let` bindingot (`'grid'`) olvasta, nem a `window` propertyt (`'tree'`) → tree-view routing tört.

### 2. `queueMicrotask()` és script-tag határok

A `queueMicrotask()` microtask az **aktuális script tag** kiértékelése UTÁN fut, de a **következő script tag** ELŐTT. Ha az i18n IIFE microtask-ot regisztrál, és az auth IIFE (ami `window.fetch`-et patcheli) más script tagban van, a microtask az auth patch ELŐTT fut → 401.

**Szabály**: ha egy microtask/`setTimeout(0)` a KÖVETKEZŐ IIFE eredményét várja, mindkét IIFE-nek **ugyanabban a script tagban** kell maradnia.

Konkrét eset: `app.js` i18n IIFE (L4-82) + auth IIFE (L92-291) egymásra épülnek a microtask sorrendjén keresztül. Ez a pár **NEM emelhető ki külön script tagba**.

### 3. Load order kötelező sorrend

```
lang/hu.js, lang/en.js     -- window._i18n definiálás (ELSŐ)
app-memories.js            -- loadMemAgents() (BEFORE app.js, init-time call)
app.js                     -- i18n IIFE + auth IIFE + fork-overlay seams
app-*.js (más modulok)     -- switchPage() után hívott függvények
fork-updates.js            -- fork-overlay hookjai
app-router.js              -- routeFromHash IIFE (UTOLSÓ -- DOMContentLoaded)
```

Az `app-router.js` LAST töltődik, mert a `DOMContentLoaded` az összes szinkron script után tüzel -- ekkor már minden modul definiált.

### 4. Fork-overlay seams (SOHA nem mozdíthatók)

Ezek az `app.js`-ben maradnak örökre, mert upstream merge-nél háromirányú konfliktust okoznának:

- `loadUpdates()`
- `renderUpdatesVersion()`
- `handleRepoInstallClick()`
- `runRepoInstall()`
- `runRepoInstallWithStash()`

Minden REVIEW kommentben kötelező sor: `Fork-overlay seam (app.js-ben maradt szándékosan): <lista>`

### 5. String-contract tesztek (house idiom)

Minden szelet kap egy `src/__tests__/<name>-module.test.ts` tesztet. A tesztek:

- A forrás fájlokat **stringként olvassák** (`readFileSync`)
- Rövid, formázás-álló fragmentumokra assertálnak (pl. `expect(MODULE).toContain('function routeFromHash()')`)
- Ellenőrzik, hogy az eredeti fájlból ki lett-e emelve a kód (`expect(APP_CORE).not.toContain(...)`)
- HTML load order-t is ellenőriznek: `indexOf` + `toBeGreaterThan`

Ha a kód megváltozik (pl. `let` → `var`), a string-contract tesztet is frissíteni kell!

### 6. Vizuális villogás (flash) kerülése

Ha egy widget `startX()` híváskor feltétel nélkül empty-state-et mutat, de a cached adatok már elérhetők:

```javascript
// ROSSZ: minden navigációnál villog
function startWidget() {
  setEmptyState('loading')
  poll()
}

// JÓ: csak akkor mutat loading state-et, ha nincs cached adat
function startWidget() {
  if (cachedSamples.length < 2) setEmptyState('loading')
  poll()
}
```

### 7. Custom link bekötése switchPage-re (wireCostDetailLink pattern)

Ha egy `<a href="#">` linket `switchPage()`-re kell kötni, de nem illeszkedik a generikus `.sb-link[data-page]` / `.nav-link[data-page]` szelektorokhoz, adj hozzá egy inline IIFE-t a modul végén:

```javascript
;(function wireCostDetailLink() {
  const link = document.querySelector('.ovw-cost-detail-link[data-page]')
  if (!link) return
  link.addEventListener('click', (e) => {
    e.preventDefault()
    const pageId = link.dataset.page
    if (pageId && typeof switchPage === 'function') switchPage(pageId)
  })
})()
```

Miért IIFE: a modul top-level kódja fut DOM-ready után (klasszikus script tag), az elem már létezik. Az `if (!link) return` guard megvédi a lapokat ahol az elem nem szerepel.

## Buktatók

- **`var` vs `let` scope**: cross-script state mindig `var` (lásd 1. pont)
- **Microtask/script-tag határ**: `queueMicrotask` párja maradjon ugyanabban a script tagban
- **String-contract frissítés elmarad**: ha a kód formája változik (pl. `let`→`var`), a teszt eltörik
- **Load order megsértése**: `app-memories.js` app.js ELŐTT kell (init-time `loadMemAgents()` hívás)
- **Fork-overlay seam mozgatása**: egyetlen sorát sem lehet kiemelni -- upstream merge tripwire

## Ellenőrzés

```bash
store/fleet-test.sh   # teljes suite; csak a 2 pre-existing fail elfogadható
```

Minden commit után `fork-upstream-conflict-guard.test.ts`-nek zöldnek kell lennie (ha nem, az invariánt sértettük).
