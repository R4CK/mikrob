---
name: component-driven-dev
description: A full Feature Lifecycle Management protocol for building UI with a component-driven mindset and integrating frontend with backend using a Mock-Driven, API-First methodology. Use this skill whenever Peti mentions building a UI feature, a component, a design system, a reusable widget, a page, a screen, a frontend-backend integration, an API contract, mocking an endpoint, wiring the frontend to the backend, "component-driven", "API-first", "mock-first", "feature lifecycle", "end-to-end feature", "építs egy komponenst/feature-t", "kösd össze a frontendet a backenddel", or wants to design, plan, build, and ship a feature from contract to component to integration.
---

# Component-Driven Dev

## Purpose
This skill drives a complete Feature Lifecycle: it turns a feature idea into an agreed API contract, a mock server, isolated UI components, and finally a live frontend-backend integration. It exists so the frontend never waits on the backend — both are built in parallel against one shared contract, and components are composed bottom-up (atoms → molecules → pages). The result is predictable delivery, testable UI in isolation, and integration that "just works" because both sides met at the same contract.

## When to use
- Peti asks to build any UI feature, component, widget, page, or screen.
- A feature needs both frontend and backend and they should be built in parallel.
- Peti mentions "API-first", "mock-first", "contract", "component-driven", or "feature lifecycle".
- Frontend is blocked waiting on a backend endpoint that does not exist yet.
- Peti wants a design system, reusable component, or a component composed from smaller parts.
- Any request phrased as "építsük meg a feature-t", "kösd rá az API-ra", "mockold az endpointot".

## Instructions
Follow the lifecycle in order. Do not skip the contract.

1. **Define the contract (API-First).** Extract the data the UI needs. Write the endpoint spec first: method, path, request shape, response shape, error shapes, status codes. Represent it as a typed schema (TypeScript types/interfaces or an OpenAPI-style block). Confirm the contract with Peti before coding.
2. **Create the mock (Mock-Driven).** Build a mock that returns contract-shaped data, including loading, empty, and error variants. Use a mock server / handler (e.g. MSW) or a typed fixture module. Frontend now develops against this mock, not the real backend.
3. **Decompose into components.** Break the UI into a component tree: atoms (button, input) → molecules (form row, card) → organisms (list, panel) → page. Identify which components are reusable vs feature-specific.
4. **Build components in isolation.** Implement each component against the mock. Handle every state: loading, empty, error, success, edge cases. Keep them presentational where possible; pass data via props.
5. **Wire the data layer.** Connect components to the mock through a typed API client / hook. Keep the client interface identical to what the real backend will expose.
6. **Integrate the real backend.** Swap the mock for the real endpoint by pointing the same typed client at the live API. Because both were built to the contract, only the base URL / handler changes.
7. **Verify end-to-end.** Test the full flow against the real backend, confirm all states still render, and check the contract still holds. Report any drift between contract and reality.

## Output format
Deliver in this order, each clearly labeled:
- **Contract** — typed schema (request/response/errors) in a fenced code block.
- **Mock** — mock handler or fixture code.
- **Component tree** — a short bullet/tree of components and their responsibilities.
- **Components** — implementation code per component with states handled.
- **Data layer** — the typed API client/hook.
- **Integration notes** — what changes to go from mock to real, and how it was verified.
Keep prose short; lead with code. Comments and identifiers in English.

## Examples

**Example 1**
Input: "Peti: építsünk egy user profile kártyát, de a backend még nincs kész."
Output: A `GET /api/users/:id` contract (typed `User` response + error shape), an MSW mock returning a sample user plus error/empty variants, a component tree (`ProfileCard` → `Avatar`, `UserMeta`, `StatusBadge`), the components implemented against the mock with loading/error states, a `useUser(id)` typed hook, and integration notes for pointing the hook at the live endpoint.

**Example 2**
Input: "Peti: kösd rá a task listát a valódi API-ra."
Output: Confirm the existing contract for `GET /api/tasks`, verify the mock matches it, then swap the mock handler for the live base URL in the same typed client, re-run the flow, confirm loading/empty/error/success all render, and report any contract drift found.

## Language rules
- Talk to Peti in Hungarian. Refer to the user only as "Peti".
- All code, identifiers, types, comments, commit messages, and API/contract terms stay in English.
- Technical keywords (contract, mock, component, endpoint) may stay English inside Hungarian sentences.

## What to avoid
- Do NOT write UI before the contract exists — API-First is non-negotiable.
- Do NOT let mock shapes diverge from the contract; the mock is the contract made runnable.
- Do NOT build one giant component; decompose bottom-up and keep components reusable.
- Do NOT skip loading, empty, and error states — every component must handle all of them.
- Do NOT change the API client interface when swapping mock → real; only the source changes.
- Do NOT mark a feature done without verifying end-to-end against the real backend.
- Do NOT refer to Peti by any other name, and do NOT mix languages inside code.