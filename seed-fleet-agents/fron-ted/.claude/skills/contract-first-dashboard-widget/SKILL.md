---
name: contract-first-dashboard-widget
description: Build a dashboard FE widget against a not-yet-landed BE endpoint. Graceful 404 fallback, all states, i18n parity, string-contract tests, Gate-SHA REVIEW.
---

# Contract-First Dashboard Widget

## When to use

When a FE card's pair-BE card is still `planned` or `in_progress` but work can start. The pattern lets FE build against the API contract before the BE exists.

## Procedure

### 1. Design the API contract (if not in the card description)

- Endpoint: `GET /api/<resource>` → `{ items: [...], total?, note? }`
- POST for mutations, DELETE for removal
- Document in the card comment so BE can align

### 2. HTML skeleton

- Add the widget element with `hidden` attribute (shown by JS only on 200)
- Use `overview-card` class pattern for overview page widgets; `card-detail-*` for modal sections
- Include `id="<widget>Body"` for dynamic content, `id="<widget>Footer"` for summary row (hidden by default)
- Add i18n keys via `data-i18n` attributes for static labels

### 3. CSS

- Define all `.widget-*` classes
- `[hidden]` overrides for every hidden-by-default element: `element[hidden] { display: none; }`
- Responsive breakpoint (@media max-width: 480px or 640px) -- Rule 13
- Use CSS custom properties (`var(--accent)`, `var(--border)`, `var(--text-muted)`) -- never hardcode

### 4. i18n

Add ALL new keys to BOTH `web/lang/hu.js` AND `web/lang/en.js` in the SAME edit. Common set:

- `<widget>.title`, `<widget>.empty`, `<widget>.error`, `<widget>.loading` (use `common.loading`)

### 5. JS fetch function

```js
async function load<Widget>() {
  const card = document.getElementById('<widgetId>')
  const body = document.getElementById('<widgetId>Body')
  if (!card || !body) return
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const r = await fetch('/api/<endpoint>', { headers: { 'Authorization': 'Bearer ' + token } })
    if (r.status === 404) { card.hidden = true; return }  // pair-BE not yet landed
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    const items = Array.isArray(d.items) ? d.items : []
    if (!items.length) {
      body.innerHTML = `<p class="<widget>-empty">${escapeHtml(t('<widget>.empty'))}</p>`
      card.hidden = false
      return
    }
    body.innerHTML = items.map(renderItem).join('')
    card.hidden = false
  } catch {
    body.innerHTML = `<p class="<widget>-error">${escapeHtml(t('<widget>.error'))}</p>`
    card.hidden = false
  }
}
```

### 6. Wire into the parent load function

```js
void load<Widget>()  // inside loadOverview() or showCardDetail() etc.
```

### 7. String-contract tests (house idiom)

One test file per widget: `src/__tests__/<widget-name>.test.ts`. Read source files as strings, assert short fragments -- no DOM/runtime.

Mandatory test coverage:

- Function defined in app.js
- Fetches correct endpoint with Authorization header
- 404 → widget hidden
- Empty array → `.empty` class rendered
- Error → `.error` class rendered
- Success → key content elements rendered
- Wired from parent load function
- HTML: element exists, `hidden` by default, key child elements
- CSS: all classes defined, `[hidden]` overrides, responsive breakpoint
- i18n: every new key in BOTH hu.js and en.js

Pitfall: `indexOf('data-page="costs"')` hits sidebar nav before the widget link. Always anchor the search on the widget element first:

```ts
const cardIdx = HTML.indexOf('id="<widgetId>"')
const cardSlice = HTML.slice(cardIdx, cardIdx + 1000)
expect(cardSlice).toContain('data-page="costs"')
```

### 8. Commit + REVIEW

```bash
git add <files>
git commit -m "feat(<area>): <widget> (card <id>)"
```

Then move card to `waiting` + REVIEW comment with `Gate-SHA: <sha>`.

## Buktatók

- Forgetting `[hidden]` CSS overrides → element stays visible via `display:block` even when `hidden` attr set
- Adding i18n keys to only one language file → i18n parity test fails
- Test anchors on sidebar/global elements (e.g. `data-page`) instead of the widget's own subtree
- The `404 → hidden` branch must also set `card.hidden = true` BEFORE returning, not just skip the rest

## Ellenőrzés

- `fleet-test.sh src/__tests__/<widget>.test.ts` → all green before committing
- Widget hidden when server returns 404 (confirm visually or in test)
- Both hu.js and en.js have all new keys
