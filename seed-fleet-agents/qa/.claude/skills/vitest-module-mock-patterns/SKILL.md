---
name: vitest-module-mock-patterns
description: Vitest ES module mock patterns for React component tests. Covers: vi.mock+importOriginal to mock specific exports while preserving others, post-mock import requirement (hoisting), fake timer vs waitFor incompatibility, fireEvent.submit to bypass overlay onClick, getByRole heading disambiguation, getAllByRole for duplicate elements. Trigger: "vi.mock importOriginal", "mock specific export", "waitFor timeout with fake timers", "multiple elements found same text", "mock api client", "overlay click cancels modal submit".
---

# Vitest ES Module Mock Patterns

## When to use
- Mocking one or more named exports of a module while keeping the rest real
- Testing a component with a real `setTimeout` delay you need to wait for
- Testing a form inside an overlay where `userEvent.click(submit)` triggers the overlay's `onClick` and cancels the dialog
- Disambiguating elements when multiple DOM nodes share the same visible text
- Testing a component that conditionally renders duplicated elements (multiple switches, multiple buttons)

---

## Pattern 1: vi.mock + importOriginal + post-mock import (the hoisting trap)

### Why this pattern
Vitest hoists `vi.mock()` calls to the top of the file at compile time. Any import that appears BEFORE `vi.mock()` in the source is still evaluated before the mock is installed — the mock never intercepts it. The solution: declare the mock first, then import the module AFTER.

### Correct pattern
```typescript
// 1. DECLARE mock first (hoisted to top by Vitest at compile time)
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,                    // keep everything real
    adminApi: {
      ...actual.adminApi,         // keep the real adminApi shape
      crewStats: {
        get: vi.fn(),
        set: vi.fn(),
      },
    },
  }
})

// 2. IMPORT the module AFTER the mock declaration
//    (even though vi.mock is physically below, it is hoisted ABOVE all imports)
import { adminApi, ApiError } from '@/api/client'

// 3. Cast the mocked functions for type-safe assertions
const mockGet = adminApi.crewStats.get as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ minGroupSize: 3 })
})
```

### Common pitfall: spreading nested real objects
When the mocked module has deeply nested objects, always spread each level:
```typescript
// WRONG — wipes all other adminApi methods not named here
return {
  ...actual,
  adminApi: { crewStats: { get: vi.fn() } }  // rest of adminApi gone
}

// CORRECT — preserve the full nested shape
return {
  ...actual,
  adminApi: {
    ...actual.adminApi,
    crewStats: { ...actual.adminApi.crewStats, get: vi.fn() }
  }
}
```

### Mocking named function exports (not nested objects)
```typescript
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(),    // replaces the named export
    clearToken: vi.fn(),
  }
})

import { getToken, clearToken, adminApi } from '@/api/client'
const mockGetToken = getToken as ReturnType<typeof vi.fn>
```

### Mocking useNavigate without a router context
```typescript
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => mockNavigate }
})
// Component can now call useNavigate() without needing MemoryRouter
```

---

## Pattern 2: useParams with MemoryRouter (when you DO need routing)

When the component calls `useParams()` to read a URL segment, wrap in `MemoryRouter + Routes + Route`:
```typescript
function renderPage(tenantId = 'tenant-1') {
  return render(
    <MemoryRouter initialEntries={[`/tenants/${tenantId}`]}>
      <Routes>
        <Route path="/tenants/:id" element={<TenantDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}
```
Do NOT mock `useParams` — MemoryRouter + Routes provides the real context and avoids the infinite-redirect loop (see `vitest-react-router-guard` skill).

---

## Pattern 3: fake timers vs waitFor incompatibility

`vi.useFakeTimers()` replaces `setTimeout` globally, including the polling `setTimeout` that `waitFor()` uses internally. Result: `waitFor()` never advances and the test times out.

**WRONG** (causes timeout):
```typescript
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('navigates after 1500ms delay', async () => {
  // ... trigger the action ...
  vi.advanceTimersByTime(1500)
  await waitFor(() => expect(mockNavigate).toHaveBeenCalled())
  // ^^ waitFor times out because its own internal setTimeout is frozen
})
```

**CORRECT** — let real time pass, raise waitFor timeout:
```typescript
// No fake timers at all
it('navigates after 1500ms delay', async () => {
  // ... trigger the action ...
  await waitFor(
    () => expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true }),
    { timeout: 2000 },  // real 1500ms delay + 500ms margin
  )
})
```

Rule of thumb: if the component's `setTimeout` delay is ≤ 2000ms, skip fake timers entirely and use `{ timeout: delay + 500 }`. Only reach for fake timers when the delay is long enough to make the test suite impractical (5s+), and even then use `act(() => vi.runAllTimers())` instead of `waitFor` after advancing.

---

## Pattern 4: fireEvent.submit to bypass overlay onClick

When a modal/dialog has:
- An outer overlay `<div onClick={onCancel}>` that closes the dialog
- An inner `<form>` with a submit button

`userEvent.click(submitBtn)` triggers pointer events that bubble up and hit the overlay's `onClick`, cancelling the dialog before the form submits.

**Fix:** bypass pointer events entirely:
```typescript
// WRONG — bubbles up, hits overlay onClick, dialog cancelled
await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))

// CORRECT — dispatches submit directly on the form, no pointer events
fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)

// Or if no role="dialog": find the form another way
fireEvent.submit(container.querySelector('form')!)
```

Also works for TOTP / StepUpModal patterns where the overlay closes on outside click:
```typescript
fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '654321' } })
fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
await waitFor(() => expect(mockApi).toHaveBeenCalledWith('654321'))
```

---

## Pattern 5: element disambiguation when text appears multiple times

### Multiple elements with the same visible text
If a page renders the same string in multiple places (heading h1 + a plain div, or a label duplicated in two sections), `getByText('foo')` throws "Found multiple elements with text 'foo'".

**Solutions by case:**

| Situation | Fix |
|-----------|-----|
| Heading (h1/h2) vs plain div | `getByRole('heading', { name: 'foo' })` |
| Button in header vs in modal | `getAllByRole('button', { name: 'X' })[last]` for modal button |
| Text embedded in longer string | `getByText(/regex/)` — partial match |
| Two "Save" buttons in DOM | `getAllByRole('button', { name: 'Save' })[0]` by DOM order |
| Asserting ANY presence | `expect(screen.getAllByText(/text/).length).toBeGreaterThanOrEqual(1)` |

### Scoped queries
Use `within()` to scope to a specific container:
```typescript
import { within } from '@testing-library/react'

const row = screen.getByRole('row', { name: /m1_warehouse/ })
const toggle = within(row).getByRole('switch')
```

### Switches by MODULE_CATALOG position
When multiple identical controls appear in a fixed order (feature flag toggles):
```typescript
// MODULE_CATALOG[0] = m1_warehouse
expect(screen.getAllByRole('switch')[0]).toHaveAttribute('aria-checked', 'true')
// MODULE_CATALOG[1] = m2_workforce
expect(screen.getAllByRole('switch')[1]).toHaveAttribute('aria-checked', 'false')
```

---

## Pattern 6: number input validation in jsdom

HTML `<input type="number">` sanitizes non-numeric strings to `""` in jsdom. If a component guards with `value !== ''`, passing `'abc'` to `fireEvent.change` will result in `value = ""` and the guard will prevent any alert.

**Use a valid-number-but-out-of-range value instead:**
```typescript
// WRONG — 'abc' becomes "" in type="number", guard fires wrong branch
fireEvent.change(input, { target: { value: 'abc' } })

// CORRECT — '0' is a valid number (passes jsdom sanitization) but fails >= 1 check
fireEvent.change(input, { target: { value: '0' } })
await waitFor(() => screen.getByRole('alert'))
```

---

## Pitfalls checklist
- `vi.mock()` below an `import` statement: Vitest hoists it but the import already evaluated. ALWAYS declare `vi.mock()` before any `import` of the mocked module.
- Fake timers + `waitFor()`: use real timers with `{ timeout: N }` for delays ≤ 2s.
- `fireEvent.submit` vs `userEvent.click` for dialogs with backdrop `onClick`.
- `getByText` vs `getByRole('heading')` when heading text appears in both heading and plain element.
- `type="number"` sanitizes non-numeric to `""` — test with an in-range-invalid number like `'0'`.
- If one test leaks `vi.useFakeTimers()`, ALL subsequent tests in that file inherit fake timers. Always pair with `afterEach(() => vi.useRealTimers())` or remove fake timers entirely.

## Verification
- [ ] `vi.mock()` declarations appear before any `import` of the mocked module in source
- [ ] Post-mock imports cast `.as ReturnType<typeof vi.fn>` for type-safe mock assertions
- [ ] No `vi.useFakeTimers()` combined with `waitFor()` in the same test
- [ ] Modal submit tests use `fireEvent.submit(form)` not `userEvent.click(button)`
- [ ] Number input validation tests use valid-number-but-invalid-range values
