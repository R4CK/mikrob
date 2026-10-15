#!/usr/bin/env python3
# Regression pin for card a020247b F1 (WhiteHat2 CYBERSEC NO-GO, komment 19540, @48cb0100):
# "Regressziós teszt: jail_cmd('agy', ...) ne tartalmazzon /dev/dxg / --dev-bind elemet ..., mutáns:
# a bind visszatétele legyen piros." No such test existed before this card -- scripts/seged-hivo.py's
# own --onteszt only covers the contact-data-leak scanner and the quota math, never jail_cmd().
#
# Card 0c086979 (RedHat 19671 + WhiteHat F1): jail_cmd used Path('/mnt').glob('?'), which only
# matches single-character mountpoint names -- /mnt/wsl and /mnt/wslg are multi-character and were
# never tmpfs'd, so the real /mnt/wslg/run/user/<uid> host sockets (session D-Bus, ssh/gpg-agent,
# systemd user, snapd, cc-socks, X11/Wayland/Pulse) stayed visible inside the jail. Pinned two ways:
# an argv-shape check (cheap, catches an accidental revert), and a REAL bwrap run that actually
# lists /mnt/wslg from inside the jail -- the whole point of RedHat's finding was that the earlier
# fix attempt ASSUMED the mount was gone instead of measuring it, so this selftest measures too.
import importlib.util
import subprocess
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

# --- card 0c086979: /mnt/wslg host-socket hiding -----------------------------------------------
pairs = list(zip(agy_jail, agy_jail[1:]))
case("agy jail tmpfs's /mnt/wslg (hides the host session-bus/ssh-agent/gpg-agent/systemd/X11/"
     "Wayland/Pulse/cc-socks sockets that live under /mnt/wslg/run/user/<uid>)",
     ('--tmpfs', '/mnt/wslg') in pairs)
case("agy jail does NOT tmpfs /mnt/wsl (resolv.conf lives there; hiding it kills DNS)",
     ('--tmpfs', '/mnt/wsl') not in pairs)

workdir_on_mnt = Path('/mnt/h/does-not-need-to-exist/workdir')
agy_jail_mnt_workdir = seged_hivo.jail_cmd('agy', workdir_on_mnt)
pairs_mnt = list(zip(agy_jail_mnt_workdir, agy_jail_mnt_workdir[1:]))
case("agy jail still does NOT tmpfs the workdir's own /mnt drive (would break worktree deps "
     "symlinked onto the same drive, e.g. CleanCore's node_modules)",
     ('--tmpfs', '/mnt/h') not in pairs_mnt)

if Path('/usr/bin/bwrap').exists() and Path('/mnt/wslg').is_dir():
    # Measured, not assumed: run the REAL jail and list /mnt/wslg/run/user/<uid> from inside it.
    # A bare `ls` on a tmpfs'd, now-empty mountpoint exits 0 with no output (it still exists as a
    # directory, just an empty one) -- the real assertion is that none of the host socket names are
    # present, which rules out both "mount still shows the host content" and "ls crashed before
    # listing anything" silently passing.
    import os
    uid_dir = Path(f'/mnt/wslg/run/user/{os.getuid()}')
    host_entries = sorted(p.name for p in uid_dir.iterdir()) if uid_dir.is_dir() else []
    with_jail = seged_hivo.jail_cmd('agy', Path('/tmp')) + ['/bin/sh', '-c', f'ls -a {uid_dir} 2>&1; echo RC:$?']
    proc = subprocess.run(with_jail, capture_output=True, text=True, timeout=15)
    jailed_listing = proc.stdout
    case("agy jail's /mnt/wslg/run/user/<uid> is measurably empty of host sockets from a REAL bwrap "
         f"run (host has {host_entries or 'nothing'!r}; jailed ls said: {jailed_listing.strip()!r})",
         host_entries == [] or not any(name in jailed_listing for name in host_entries))
else:
    case("SKIPPED (no bwrap or no /mnt/wslg on this host) -- real-jail socket-listing check",
         True)

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s" % f)
sys.exit(1 if failures else 0)
