const tokenInput = document.getElementById('token')
const portInput = document.getElementById('port')
const statusEl = document.getElementById('status')

async function load() {
  const { token, port } = await chrome.storage.local.get(['token', 'port'])
  tokenInput.value = token || ''
  portInput.value = port || 8787
}

document.getElementById('save').addEventListener('click', async () => {
  const token = tokenInput.value.trim()
  const port = Number(portInput.value) || 8787
  await chrome.storage.local.set({ token, port })
  statusEl.textContent = 'Mentve.'
  setTimeout(() => { statusEl.textContent = '' }, 2000)
})

load()
