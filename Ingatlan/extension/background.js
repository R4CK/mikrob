// Service worker (Manifest V3). Does the actual network call to the local ingest server -- NOT
// the content script, because a fetch() from content-script.js would run in ingatlan.com's own
// page origin and hit ordinary cross-origin CORS restrictions against http://127.0.0.1. A fetch
// from here runs in the extension's own privileged context, which host_permissions in
// manifest.json (http://127.0.0.1/*) exempts from that restriction.

async function getSettings() {
  const { token, port } = await chrome.storage.local.get(['token', 'port'])
  return { token: token || '', port: port || 8787 }
}

async function postToLocalServer(path, body) {
  const { token, port } = await getSettings()
  if (!token) {
    return { ok: false, error: 'no token configured -- open the extension options page and paste the token printed by "npm run ingatlan:ingest"' }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: json.error || `HTTP ${res.status}` }
    return { ok: true, result: json }
  } catch (err) {
    return { ok: false, error: `could not reach the local ingest server on 127.0.0.1:${port} -- is "npm run ingatlan:ingest" running? (${err && err.message})` }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ingest') {
    postToLocalServer('/api/ingatlan/ingest', { listings: message.listings }).then(sendResponse)
    return true // keep the message channel open for the async sendResponse
  }
  if (message?.type === 'debug') {
    postToLocalServer('/api/ingatlan/debug', message.payload).then(sendResponse)
    return true
  }
  return false
})
