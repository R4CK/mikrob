// Service worker intentionally DISABLED. A caching SW caused iOS load
// failures (respondWith null on cache miss) and a reload-loop when combined
// with re-registration. We no longer register one, and we actively
// unregister any previously-installed SW so a wedged client self-heals on
// the next visit. The dashboard is a localhost/tailnet tool that does not
// need offline caching.
//
// Extracted from an inline <script> in index.html (card bac41395): CSP's
// script-src cannot allowlist inline script content without a hash that goes
// stale silently on the next edit -- an external file needs no such hash.
if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => {});
}
