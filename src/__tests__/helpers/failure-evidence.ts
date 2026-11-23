// Card a5c827ca: persist real evidence the moment a full-suite-only flake actually fires, instead of
// re-running the suite repeatedly hoping to catch it with better logging next time. Best-effort and
// synchronous: a capture failure must never turn a real PASS into something else, and the file must
// exist before the test's own assertion throws, not racing a process teardown after it.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export function captureFailureEvidence(label: string, extra: Record<string, unknown>): string {
  try {
    const dir = process.env.FLEET_TEST_LOG_DIR || process.env.TMPDIR || tmpdir()
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
    const dest = join(dir, `channel-poller-reap-failure-${stamp}-${safeLabel}.json`)
    let ps = ''
    try {
      ps = execFileSync('ps', ['-eo', 'pid,ppid,pgid,lstart,cmd'], { encoding: 'utf-8', timeout: 10_000 })
    } catch (e) {
      ps = `<ps failed: ${String(e)}>`
    }
    writeFileSync(dest, JSON.stringify({ label, ps_eo_pid_ppid_pgid_lstart_cmd: ps, ...extra }, null, 2))
    return dest
  } catch (e) {
    return `<failure evidence capture failed (best-effort, ignored): ${String(e)}>`
  }
}
