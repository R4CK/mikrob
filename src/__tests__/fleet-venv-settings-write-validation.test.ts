// RedHat F1 (gate ba9a5ca3, card 2bf0d884): the Settings API wrote
// FLEET_PYTHON_VENV with no path validation at all -- an attacker-controlled
// directory (group/other-writable, or owned by another uid) could be set,
// and its bin/ then leads EVERY agent's launch PATH (fleet-venv.ts), so a
// planted `python3` shim would hijack every skill's plain `python3` call
// fleet-wide. This covers the write-time check added to the registry entry.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, chmodSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateFleetPythonVenvDir, SETTINGS_REGISTRY, validateSettingValue } from '../config-registry.js'

describe('validateFleetPythonVenvDir (card 2bf0d884)', () => {
  const dirs: string[] = []
  function tmp(mode?: number): string {
    const d = mkdtempSync(join(tmpdir(), 'fpvenv-'))
    dirs.push(d)
    if (mode !== undefined) chmodSync(d, mode)
    return d
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('accepts an empty value (off)', () => {
    expect(validateFleetPythonVenvDir('')).toBeNull()
    expect(validateFleetPythonVenvDir('   ')).toBeNull()
  })

  it('accepts an absolute path to a directory owned by this process and not group/other-writable', () => {
    const d = tmp(0o700)
    expect(validateFleetPythonVenvDir(d)).toBeNull()
  })

  it('accepts a path that does not exist yet (fleetVenvBin treats it as off, nothing to hijack)', () => {
    expect(validateFleetPythonVenvDir('/this/does/not/exist/anywhere')).toBeNull()
  })

  it('rejects a group-writable directory', () => {
    const d = tmp(0o770)
    expect(validateFleetPythonVenvDir(d)).toMatch(/group- vagy other-writable/)
  })

  it('rejects an other-writable directory', () => {
    const d = tmp(0o707)
    expect(validateFleetPythonVenvDir(d)).toMatch(/group- vagy other-writable/)
  })

  it('rejects a shell-active character, same as fleetVenvBin at use-time', () => {
    for (const bad of ['/x/"venv', '/x/$venv', '/x/`venv', '/x/\\venv']) {
      expect(validateFleetPythonVenvDir(bad)).toMatch(/shell-aktív/)
    }
  })

  it('rejects a relative path', () => {
    for (const rel of ['venv', './venv', '../venv', 'a/b/venv']) {
      expect(validateFleetPythonVenvDir(rel)).toMatch(/abszolút/)
    }
  })

  it('expands a leading ~ against the supplied home before checking', () => {
    const home = tmp(0o700)
    expect(validateFleetPythonVenvDir('~/sub-does-not-exist', home)).toBeNull()
  })

  it('rejects a path to a plain file (not a directory)', () => {
    const d = tmp(0o700)
    const filePath = join(d, 'notadir')
    writeFileSync(filePath, 'x')
    expect(validateFleetPythonVenvDir(filePath)).toMatch(/nem könyvtár/)
  })

  it('is wired as the validate hook on the FLEET_PYTHON_VENV registry entry', () => {
    const def = SETTINGS_REGISTRY.find((e) => e.key === 'FLEET_PYTHON_VENV')
    expect(def?.validate).toBe(validateFleetPythonVenvDir)
  })

  it('validateSettingValue rejects a group-writable directory through the full Settings API path', () => {
    const d = tmp(0o775)
    const def = SETTINGS_REGISTRY.find((e) => e.key === 'FLEET_PYTHON_VENV')!
    const result = validateSettingValue(def, d)
    expect(result.ok).toBe(false)
  })

  it('validateSettingValue still accepts a safe absolute path through the full Settings API path', () => {
    const d = tmp(0o700)
    const def = SETTINGS_REGISTRY.find((e) => e.key === 'FLEET_PYTHON_VENV')!
    const result = validateSettingValue(def, d)
    expect(result.ok).toBe(true)
  })
})
