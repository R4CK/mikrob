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
import re
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


def classify_jailed_listing(jailed_listing, host_entries):
    """True iff a jailed `ls -a <uid_dir>; echo RC:$?` run proves BOTH that the shell actually
    ran inside the jail AND that no host socket name is visible in the result. F-RH-S1 (RedHat,
    card deab5615, source 0c086979 comment 19823): the earlier check only asserted an 'RC:'
    marker was PRESENT, not which RC it carried -- a broken ls (permission error, wrong path,
    anything that is neither "directory hidden" nor "directory visible") would still print an
    'RC:' marker and pass the sockets-absent check vacuously, because its own error text
    contains none of the host socket names either. Only two RC values are a legitimate
    assertion that the LISTING itself (not just the shell) ran as intended:
      - RC:2 with "No such file or directory": the tmpfs mount hides the directory entirely
        (the expected, secure state measured on this host).
      - RC:0: the directory is visible, and the sockets-absent check examines its contents.
    Any other RC (permission denied, a crashed ls) or a missing marker must fail here, before
    the sockets-absent check ever runs."""
    m = re.search(r'RC:(-?\d+)\s*$', jailed_listing.strip())
    if m is None:
        return False
    rc = int(m.group(1))
    if rc == 2:
        return 'No such file or directory' in jailed_listing
    if rc == 0:
        return host_entries == [] or not any(name in jailed_listing for name in host_entries)
    return False


case("classify_jailed_listing: RC:2 'No such file or directory' (mount hides the dir) is accepted",
     classify_jailed_listing("ls: cannot access '/x': No such file or directory\nRC:2\n", ['bus']))
case("classify_jailed_listing: RC:2 WITHOUT the 'No such file or directory' text is rejected -- "
     "an RC:2 alone is not proof the directory is hidden, some other ls error can also exit 2",
     not classify_jailed_listing("ls: some other unrelated error\nRC:2\n", ['bus']))
case("classify_jailed_listing: RC:0 with no host socket name present is accepted",
     classify_jailed_listing(".\n..\nRC:0\n", ['bus', 'wayland-0']))
case("classify_jailed_listing: RC:0 WITH a host socket name present is rejected",
     not classify_jailed_listing(".\n..\nbus\nRC:0\n", ['bus']))
case("classify_jailed_listing: any OTHER exit code (e.g. permission denied) is rejected even "
     "with no host socket name visible -- F-RH-S1's actual bug: a non-2/non-0 RC must not pass "
     "vacuously just because the error text happens to contain no host socket name",
     not classify_jailed_listing("ls: cannot open directory '/x': Permission denied\nRC:13\n", ['bus']))
case("classify_jailed_listing: a missing 'RC:' marker entirely is rejected (the original "
     "BWRAP_BIN=/bin/false vacuous-invocation bug class)",
     not classify_jailed_listing("", ['bus']))

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
    # QA finding on card 0c086979: a broken/swapped-out bwrap binary (e.g. BWRAP_BIN=/bin/false)
    # makes subprocess.run exit immediately with EMPTY stdout, and the sockets-absent check below
    # passes VACUOUSLY on that empty string (no host socket name can appear in ''), giving a false
    # security guarantee that the jail was never actually exercised. The real, working jail always
    # prints the "RC:$?" marker from the shell command (observed RC:2 here, because the tmpfs mount
    # makes /mnt/wslg/run/user/<uid> not exist at all inside the jail -- that is a legitimate pass,
    # not RC:0) -- so the marker's mere presence, not its value, is the positive control that the
    # shell command actually ran inside the jail.
    case("F-RH-S1: the jailed ls produced a recognized, non-vacuous result for /mnt/wslg/run/"
         "user/<uid> -- RC:2 'No such file or directory' (mount hides it) or RC:0 with the "
         "sockets-absent check satisfied below; any other exit code must not pass "
         f"(jailed ls said: {jailed_listing.strip()!r})",
         classify_jailed_listing(jailed_listing, host_entries))
    case("agy jail's /mnt/wslg/run/user/<uid> is measurably empty of host sockets from a REAL bwrap "
         f"run (host has {host_entries or 'nothing'!r}; jailed ls said: {jailed_listing.strip()!r})",
         host_entries == [] or not any(name in jailed_listing for name in host_entries))

    # F-RH-S2 (RedHat, card deab5615, source 0c086979 comment 19823): the check above only lists
    # ONE directory. RedHat measured, by hand, that a host socket reachable through a DIFFERENT
    # bind path sails through unseen: "a selftest PASS (10/10), miközben a jailben 12 host-socket
    # név látszik." A full-tree sweep (mirrors WhiteHat2's own manual verification, 0c086979
    # comment 19786: "find / -type s ... /proc /sys /snap és a drvfs meghajtók kivételével") with
    # its own positive control (a real socket bound INTO the jail) catches any bind path, not
    # just the one this selftest already knows about by name.
    import shutil
    import socket as socket_module
    import tempfile as tempfile_module

    sweep_dir = Path(tempfile_module.mkdtemp(prefix='seged-hivo-sweep-'))
    control_sock_path = sweep_dir / 'control.sock'
    control_sock = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
    try:
        control_sock.bind(str(control_sock_path))
        sweep_cmd = (
            seged_hivo.jail_cmd('agy', Path('/tmp'))
            + ['--ro-bind', str(sweep_dir), str(sweep_dir)]
            + ['/bin/sh', '-c',
               "find / -type s -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null"]
        )
        sweep_proc = subprocess.run(sweep_cmd, capture_output=True, text=True, timeout=20)
        sweep_listing = sweep_proc.stdout
        case("F-RH-S2: the jail-wide socket sweep's own positive control (a real socket bound "
             "INTO the jail) IS found -- proves the sweep is not vacuously blind",
             str(control_sock_path) in sweep_listing)
        case("F-RH-S2: no HOST socket name appears ANYWHERE in the jail's full socket sweep, not "
             f"just in /mnt/wslg/run/user/<uid> (sweep saw: {sweep_listing.strip()!r})",
             host_entries == [] or not any(name in sweep_listing for name in host_entries))

        # Self-check that the sweep machinery above actually catches the exact leak class RedHat
        # measured: bind the SAME host sockets into the jail through an ALTERNATE path (not
        # /mnt/wslg/run/user/<uid>), which the single-directory check has no way to see.
        if host_entries:
            leaked_cmd = (
                seged_hivo.jail_cmd('agy', Path('/tmp'))
                + ['--ro-bind', str(uid_dir), '/tmp/leaked-host-sockets']
                + ['/bin/sh', '-c',
                   "find / -type s -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null"]
            )
            leaked_proc = subprocess.run(leaked_cmd, capture_output=True, text=True, timeout=20)
            case("F-RH-S2 self-check: the full-tree sweep DOES catch a host socket leaked "
                 "through a path OTHER than /mnt/wslg/run/user/<uid> (proves the sweep, not just "
                 "the single-directory check above, is what closes RedHat's finding)",
                 any(name in leaked_proc.stdout for name in host_entries))
    finally:
        control_sock.close()
        shutil.rmtree(sweep_dir, ignore_errors=True)
else:
    case("SKIPPED (no bwrap or no /mnt/wslg on this host) -- real-jail socket-listing check",
         True)

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s" % f)
sys.exit(1 if failures else 0)
