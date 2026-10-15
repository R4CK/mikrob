#!/usr/bin/env python3
# Regression pin for card a020247b F1 (WhiteHat2 CYBERSEC NO-GO, komment 19540, @48cb0100):
# "Regressziós teszt: jail_cmd('agy', ...) ne tartalmazzon /dev/dxg / --dev-bind elemet ..., mutáns:
# a bind visszatétele legyen piros." No such test existed before this card -- scripts/seged-hivo.py's
# own --onteszt only covers the contact-data-leak scanner and the quota math, never jail_cmd().
import importlib.util
import sys
from pathlib import Path

# seged-hivo.py has a hyphen in its name, so it cannot be a plain `import` target -- load it by
# explicit file path instead (the hyphen is also why its own __main__ guard is harmless here: this
# never executes that block, it only defines/imports the module's top-level functions).
_spec = importlib.util.spec_from_file_location(
    'seged_hivo', Path(__file__).resolve().parent.parent / 'scripts' / 'seged-hivo.py')
seged_hivo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(seged_hivo)

n = 0
failures = []


def case(label, cond):
    global n
    n += 1
    if not cond:
        failures.append(label)


workdir = Path('/tmp')
agy_jail = seged_hivo.jail_cmd('agy', workdir)
codex_jail = seged_hivo.jail_cmd('codex', workdir)

case("agy jail has NO /dev/dxg anywhere in its argv", '/dev/dxg' not in agy_jail)
case("agy jail has NO --dev-bind or --dev-bind-try flag at all",
     not any(tok in ('--dev-bind', '--dev-bind-try') for tok in agy_jail))
case("codex jail is unaffected by the agy-only binds (no 'gate' subdir, no gemini-local-subtask)",
     not any('gate' in tok or 'gemini-local-subtask' in tok for tok in codex_jail))
case("agy jail still binds the dedicated gate dir read-only (F1 replacement for the removed device bind)",
     any(tok.endswith('.gemini-local-subtask-gpu-gate') for tok in agy_jail))
case("agy jail no longer ro-binds vram-guard-check.sh into the jail (nvidia-smi moved to the host)",
     not any(tok.endswith('vram-guard-check.sh') for tok in agy_jail))

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s" % f)
sys.exit(1 if failures else 0)
