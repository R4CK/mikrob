// Content-Security-Policy for the dashboard (card bac41395, Cybered finding 9bf6a1e0/13169):
// second-layer defense that tempers any future injection (XSS) even if an output-escaping bug
// slips through. Surveyed the actual resource needs before writing this, rather than guessing:
//   - script-src: only same-origin + the jsDelivr CDN (xterm.js/addon-fit, qrcode-generator). The
//     one inline <script> that used to be in index.html (service-worker unregister) is now an
//     external file (web/sw-unregister.js, card bac41395) SPECIFICALLY so this stays hash-free --
//     a CSP hash for inline content goes stale silently the next time someone edits that script.
//   - style-src: 'unsafe-inline' is a deliberate, not accidental, gap. The dashboard has 300+
//     inline style="" attributes across web/index.html with no build step to hash or nonce them;
//     forcing that here would be a multi-hundred-line, constantly-drifting maintenance trap for a
//     lower-severity vector (CSS injection) than the one script-src actually closes.
//   - connect-src 'self': every fetch()/EventSource() in web/*.js targets a relative path (grep
//     confirmed zero absolute-URL fetch calls); the SSE terminal stream is same-origin too.
//   - frame-ancestors 'none': nothing embeds this dashboard in an iframe (grep: zero <iframe> in
//     web/, no prior X-Frame-Options) -- free clickjacking protection, not asked for by the card
//     but the standard reason CSP exists alongside script/style-src.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')
