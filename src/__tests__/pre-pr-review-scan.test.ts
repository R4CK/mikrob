/**
 * Guard for scripts/pre-pr-review-scan.ts (card 647e0b6f, upstream #1965): the secret
 * filter that runs on the diff BEFORE scripts/pre-pr-review.sh sends it to ChatGPT/Gemini.
 *
 * Secrets below are assembled at runtime, same convention as secret-gate.test.ts, so this
 * file itself does not trip the repo's own secret-write guard.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// pre-pr-review-scan.ts calls main() unconditionally at the bottom (it is a CLI script, not a
// library), so it cannot be imported for its exports without executing it -- every case here
// goes through the real CLI entry point (tsx subprocess), the same way the shipped
// scripts/pre-pr-review.sh invokes it.
const OPENAI_FIXTURE = 'sk-' + 'abcdefghijklmnopqrstuvwx0123';

function diffAdding(line: string): string {
  return [
    'diff --git a/foo.txt b/foo.txt',
    'index 0000000..1111111 100644',
    '--- a/foo.txt',
    '+++ b/foo.txt',
    '@@ -1 +1 @@',
    '-hello',
    `+${line}`,
    '',
  ].join('\n');
}

describe('pre-pr-review-scan.ts (CLI)', () => {
  const tsx = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
  const script = join(__dirname, '..', '..', 'scripts', 'pre-pr-review-scan.ts');

  it('exits 0 on a clean diff file, 1 on a secret-bearing one, prints no secret value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ppr-scan-'));
    try {
      const cleanFile = join(dir, 'clean.diff');
      const secretFile = join(dir, 'secret.diff');
      writeFileSync(cleanFile, diffAdding('world'));
      writeFileSync(secretFile, diffAdding(OPENAI_FIXTURE));

      const cleanOut = execFileSync(tsx, [script, cleanFile], { encoding: 'utf-8' });
      expect(cleanOut.trim()).toBe('');

      let threw = false;
      let out = '';
      try {
        execFileSync(tsx, [script, secretFile], { encoding: 'utf-8' });
      } catch (e: any) {
        threw = true;
        out = String(e.stdout ?? '');
      }
      expect(threw).toBe(true);
      expect(out).not.toContain(OPENAI_FIXTURE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 (not 0 or 1) when the diff file does not exist -- an unscannable diff is a finding, not a pass', () => {
    let code: number | undefined;
    try {
      execFileSync(tsx, [script, '/no/such/file'], { encoding: 'utf-8' });
    } catch (e: any) {
      code = e.status;
    }
    expect(code).toBe(2);
  });

  it('a 40-char commit sha in a git context is clean; a bare 40-char hex run with no context is a finding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ppr-scan-'));
    try {
      const shaFile = join(dir, 'sha.diff');
      const hexFile = join(dir, 'hex.diff');
      writeFileSync(shaFile, diffAdding('cherry-picked from commit 0123456789abcdef0123456789abcdef01234567'));
      writeFileSync(hexFile, diffAdding('token=0123456789abcdef0123456789abcdef01234567'));

      const shaOut = execFileSync(tsx, [script, shaFile], { encoding: 'utf-8' });
      expect(shaOut.trim()).toBe('');

      let threw = false;
      let out = '';
      try {
        execFileSync(tsx, [script, hexFile], { encoding: 'utf-8' });
      } catch (e: any) {
        threw = true;
        out = String(e.stdout ?? '');
      }
      expect(threw).toBe(true);
      expect(out).toContain('hex run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a NUL byte anywhere makes the whole diff an un-scannable finding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ppr-scan-'));
    try {
      const nulFile = join(dir, 'nul.diff');
      writeFileSync(nulFile, Buffer.from('a\0b'));
      let threw = false;
      try {
        execFileSync(tsx, [script, nulFile], { encoding: 'utf-8' });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a credential file path in the diff header is a finding; a .env.example template is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ppr-scan-'));
    try {
      const envFile = join(dir, 'env.diff');
      const templateFile = join(dir, 'template.diff');
      writeFileSync(
        envFile,
        ['diff --git a/.env b/.env', 'index 0000000..1111111 100644', '--- a/.env', '+++ b/.env',
         '@@ -1 +1 @@', '-A=1', '+A=2', ''].join('\n'),
      );
      writeFileSync(
        templateFile,
        ['diff --git a/.env.example b/.env.example', 'index 0000000..1111111 100644',
         '--- a/.env.example', '+++ b/.env.example', '@@ -1 +1 @@', '-A=1', '+A=2', ''].join('\n'),
      );

      let threw = false;
      let out = '';
      try {
        execFileSync(tsx, [script, envFile], { encoding: 'utf-8' });
      } catch (e: any) {
        threw = true;
        out = String(e.stdout ?? '');
      }
      expect(threw).toBe(true);
      expect(out).toContain('credential file path');

      const templateOut = execFileSync(tsx, [script, templateFile], { encoding: 'utf-8' });
      expect(templateOut.trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
