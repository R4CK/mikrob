// The startup line that tells the operator how to reach the dashboard (card 62631948).
//
// It used to be `http://127.0.0.1:<port>/?token=<DASHBOARD_TOKEN>`, written to stderr rather
// than through pino on the grounds that stderr is "not the log stream". Under a service manager
// it IS the log stream: systemd sends stderr to the journal and launchd to the configured
// StandardErrorPath, so a root-equivalent credential ended up in exactly the place the pino
// avoidance was meant to keep it out of -- readable by anyone who can read the journal, and
// retained for as long as the journal is.
//
// So the token is not printed at all. The URL is public information; the token is one `cat`
// away for whoever is entitled to it (the file is 0600), and the dashboard's paste field takes
// it from there. Redacting or truncating it was rejected: a partial credential is still a
// credential in a log, and a shortened one is not usable either, so it would cost the operator
// the login without buying any secrecy.
export function renderBootstrapNotice(port: number, tokenPath: string): string {
  return (
    `\nDashboard: http://127.0.0.1:${port}/\n` +
    `First login: paste the access token when the page asks for it --\n` +
    `  cat ${tokenPath}\n` +
    `(The token is deliberately NOT printed here: stderr is captured by the service manager.)\n\n`
  )
}
