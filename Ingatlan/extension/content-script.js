// UNVERIFIED AGAINST THE REAL PAGE (card 3f6bcc41, see README "Blokkolt"). This agent could not
// fetch the real ingatlan.com search-result markup to write exact selectors against -- Cloudflare
// blocks any non-browser fetch, and the egress-allowlist blocks a WebFetch too. Peti's browser IS
// authenticated and past Cloudflare, so this runs there instead, on a best-effort DOM heuristic:
// find listing-detail links, walk up to a card container, and read price/area from its text.
//
// If it finds ZERO listings on a page that clearly has some, it sends a debug capture (a chunk of
// the real HTML) to the local server instead of failing silently -- that capture is exactly what
// closes the loop to fix the selectors for real, in one iteration, instead of guessing again.

import { findPrice, findAreaM2, findNm2Ar, findAllapot, findEpitesiEv, findCim } from './parse-listing-text.js'

;(function () {
  const TIPUS = location.href.includes('elado+lakas') ? 'lakas' : 'haz'
  const MAX_ATTEMPTS = 8
  const RETRY_DELAY_MS = 1500
  const sentIds = new Set()
  let attempts = 0

  // Walk up from a listing-detail anchor to the nearest ancestor whose text contains BOTH a price
  // and an area -- that is almost certainly the card, regardless of what its CSS classes are
  // (modern bundlers hash class names, so class-based selectors are the FIRST thing to break).
  function findCardContainer(anchor) {
    let node = anchor
    for (let i = 0; i < 6 && node; i++) {
      const text = node.innerText || ''
      if (findPrice(text) !== null && findAreaM2(text) !== null) return node
      node = node.parentElement
    }
    return null
  }

  function extractListings() {
    const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
      try {
        return /\/(\d{6,})(?:\/|$|\?)/.test(new URL(a.href).pathname)
      } catch {
        return false
      }
    })

    const byId = new Map()
    for (const anchor of anchors) {
      const idMatch = new URL(anchor.href).pathname.match(/(\d{6,})/)
      if (!idMatch) continue
      const id = idMatch[1]
      if (byId.has(id)) continue

      const card = findCardContainer(anchor)
      if (!card) continue
      const text = card.innerText || ''
      const ar = findPrice(text)
      const alapteruletM2 = findAreaM2(text)
      if (ar === null || alapteruletM2 === null) continue
      const nm2Ar = findNm2Ar(text, ar, alapteruletM2)
      if (nm2Ar === null) continue

      byId.set(id, {
        id,
        url: anchor.href,
        tipus: TIPUS,
        allapot: findAllapot(text),
        epitesiEv: findEpitesiEv(text),
        cim: findCim(text),
        alapteruletM2,
        ar,
        nm2Ar,
      })
    }
    return Array.from(byId.values())
  }

  function sendDebugCapture(foundAnchorCount) {
    chrome.runtime.sendMessage({
      type: 'debug',
      payload: {
        pageUrl: location.href,
        tipus: TIPUS,
        foundAnchorCount,
        htmlSnippet: document.body.innerHTML.slice(0, 200_000),
        note: 'zero listings extracted -- see Ingatlan/README.md for how to use this capture to fix the selectors',
      },
    })
  }

  function runOnce() {
    attempts++
    const listings = extractListings()
    const fresh = listings.filter((l) => !sentIds.has(l.id))

    if (fresh.length > 0) {
      fresh.forEach((l) => sentIds.add(l.id))
      chrome.runtime.sendMessage({ type: 'ingest', listings: fresh }, (response) => {
        if (!response?.ok) console.warn('[ingatlan] ingest failed:', response?.error)
        else console.log(`[ingatlan] ingested ${fresh.length} listing(s):`, response.result)
      })
      return
    }

    if (listings.length === 0 && attempts >= MAX_ATTEMPTS) {
      const anchorCount = document.querySelectorAll('a[href]').length
      sendDebugCapture(anchorCount)
    }
  }

  function scheduleRetries() {
    const timer = setInterval(() => {
      runOnce()
      if (attempts >= MAX_ATTEMPTS) clearInterval(timer)
    }, RETRY_DELAY_MS)
  }

  runOnce()
  scheduleRetries()

  // The search-result list is very likely client-rendered (map + list load asynchronously) --
  // re-run on DOM changes too, not just on a fixed retry schedule, so newly-scrolled/loaded cards
  // get picked up without waiting for the next timer tick.
  new MutationObserver(() => runOnce()).observe(document.body, { childList: true, subtree: true })
})()
