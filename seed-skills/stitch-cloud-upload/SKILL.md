---
name: stitch-cloud-upload
description: Stitch cloud screen generation and persistent upload. Use when generating and persisting screens to a Stitch cloud project via the @google/stitch-sdk. Triggers: "Stitch generate", "Stitch cloud", "generate screens", "upload to Stitch project".
---
# Stitch Cloud Screen Upload

## Core bug / invariant

`project.generate(prompt)` returns an **ephemeral** screen object. The ID it returns does NOT appear in `project.screens()` (which calls `list_screens`). The returned object supports `getHtml()` and `getImage()` directly (transient URLs), but the screen is NOT saved to the cloud project.

**To persist a screen to the cloud project, you MUST call `project.upload(localHtmlPath)`.**

## Correct workflow (generate → save → upload)

```js
const { stitch } = await import('@google/stitch-sdk')
const project = stitch.project(PROJECT_ID)
import fs from 'node:fs'

// 1. Generate (ephemeral -- ID does NOT persist)
const screen = await project.generate(prompt)

// 2. Download HTML immediately (transient URL, works right now)
const htmlUrl = await screen.getHtml()
const r = await fetch(htmlUrl)
fs.writeFileSync(localPath, Buffer.from(await r.arrayBuffer()))

// 3. Upload HTML → creates PERMANENT cloud screen
const result = await project.upload(localPath)
const permanentId = Array.isArray(result) ? result[0]?.id : result?.id

// 4. Verify
const screens = await project.screens()
const confirmed = screens.some(s => s.id === permanentId)
console.log(confirmed ? 'CONFIRMED' : 'NOT_FOUND')
```

## Verification protocol (BINDING per MikroB)

Before reporting done:
1. Run `(await project.screens()).length` BEFORE batch
2. Upload all screens
3. Run `(await project.screens()).length` AFTER -- delta must equal N
4. For each uploaded ID: `screens.some(s => s.id === id)` must be `true`
5. Include the full ID list in the REVIEW comment as evidence

## API key

```bash
KEY=$(echo "K=Stitch" | node /home/neon/marveen/scripts/vault-resolve.mjs 2>/dev/null | sed 's/^K=//')
STITCH_API_KEY="$KEY" node your-script.mjs
```

## Timing notes

- `project.upload()` can take 30-140s per file depending on server load
- Do NOT use per-screen poll loops -- one `project.screens()` call at the end suffices
- `generate_screen_from_text` service occasionally returns "currently unavailable" -- retry after a few minutes
- The `?? screen` fallback pattern (`screens.find(s => s.id === s.id) ?? screen`) masks persistence failures -- never use it as evidence of success

## Buktatók

- **`?? screen` fallback**: if `screens.find()` returns undefined, falling back to the ephemeral object allows `getHtml()`/`getImage()` to work, masking the fact that the screen was NOT persisted. Always verify by ID in `project.screens()`.
- **Count verification only**: 133→143 is necessary but not sufficient. Verify each ID individually.
- **Stale `project.screens()` mid-batch**: only call once at the end, not after each upload (quota burn).
- **HTML file size**: 12-20KB HTML files upload fine. Larger files may time out.
- **Working directory**: `stitch-tools/` is in `/home/neon/marveen/store/stitch-tools/`. Scripts write into `DL_BASE = <your own CleanCore worktree>/docs/design-previews/stitch-gen/`; resolve it with `/home/neon/marveen/store/agent-worktree.sh <your agent name> --path` (card 973ed6eb). Never the shared clone -- these files get committed, so they belong in your own tree.

## Ellenőrzés

- [ ] `project.screens().length` increased by exactly N
- [ ] Every uploaded ID confirmed with `screens.some(s => s.id === uploadedId)`
- [ ] REVIEW comment includes all N IDs and the before/after count
