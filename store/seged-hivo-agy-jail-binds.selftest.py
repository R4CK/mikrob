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
skipped = []


def case(label, cond):
    global n
    n += 1
    if not cond:
        failures.append(label)


def skip(label):
    # S3 INFO (CYBERED, card e4d38c2b, source de3fb362): a bare case(label, True) made a host
    # without bwrap or /mnt/wslg pass vacuously, counted the same as a real, exercised check --
    # the final "N case(s) PASS" line could not tell a fully-measured run from one that never ran
    # the jail at all. skip() is counted separately and printed under its own SKIP: line, so a
    # WSLg-less host's run is visibly distinguishable from a real pass instead of folding into it.
    skipped.append(label)


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
    the sockets-absent check ever runs.

    F3 LOW (WhiteHat, card deab5615 comment 20050, "S1 maradék"): the RC:2 branch used to accept
    "No such file or directory" for ANY path handed to it, including a path that was never real
    to begin with (e.g. a wrong uid_dir computed one character off) -- ls on a non-existent path
    always says ENOENT, whether or not that path was ever something a tmpfs mount actually hid.
    host_entries is the SAME uid_dir's real, host-side directory listing (see call sites): if the
    caller's path construction is wrong, host_entries comes back empty too, because the wrong
    path does not exist on the host either. Requiring host_entries to be non-empty ties the RC:2
    acceptance to "this is a path we independently confirmed is real and populated on the host",
    so an ENOENT on a never-real path is rejected instead of passing vacuously."""
    m = re.search(r'RC:(-?\d+)\s*$', jailed_listing.strip())
    if m is None:
        return False
    rc = int(m.group(1))
    if rc == 2:
        return host_entries != [] and 'No such file or directory' in jailed_listing
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
case("classify_jailed_listing (F3): RC:2 'No such file or directory' is REJECTED when "
     "host_entries is empty -- the path being tested was never real on the host either, so an "
     "ENOENT here proves nothing about a tmpfs mount hiding anything",
     not classify_jailed_listing("ls: cannot access '/x': No such file or directory\nRC:2\n", []))

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
triples = list(zip(agy_jail, agy_jail[1:], agy_jail[2:]))
case("agy jail tmpfs's /mnt/wslg (hides the host session-bus/ssh-agent/gpg-agent/systemd/X11/"
     "Wayland/Pulse/cc-socks sockets that live under /mnt/wslg/run/user/<uid>)",
     ('--tmpfs', '/mnt/wslg') in pairs)
case("agy jail does NOT tmpfs /mnt/wsl (resolv.conf lives there; hiding it kills DNS)",
     ('--tmpfs', '/mnt/wsl') not in pairs)

# Card b30ad7e6 F1 (RedHat finding on 19ef0eca's edc5bd86 GO): the gate dir used to be bound under
# $HOME (SUBTASK_JAIL_DIR + '/gate'), which a bad-faith agy could redirect for its own children by
# exporting a scratch HOME -- see the comment on SUBTASK_GATE_JAIL_DIR in scripts/seged-hivo.py.
# Pinned here (not just in the bash selftest) because this IS the file whose job is catching a
# jail_cmd() wiring regression: if a future edit moved the bind target back under HOME, this is
# where it would be caught before a bash-level fixture test even runs.
case("agy jail binds the gate dir at the literal /run/gemini-local-subtask-gate path, not under "
     "$HOME (card b30ad7e6 F1 -- a scratch HOME must not be able to redirect the gate lookup)",
     ('--ro-bind-try', str(seged_hivo.STORE / '.gemini-local-subtask-gpu-gate'),
      '/run/gemini-local-subtask-gate') in triples)
# Only the bind TARGET (inside the jail) matters here -- the bind SOURCE is a legitimate host-side
# path that lives under $HOME/.../store on this host, same as any other source in this function.
bind_targets = [t[2] for t in triples if t[0] in ('--ro-bind-try', '--ro-bind', '--bind') and 'gate' in t[2]]
case("agy jail's gate-dir bind TARGET is NOT anywhere under the real HOME path (mutation-proof: "
     "a regression back to binding under $HOME would make this fail)",
     bind_targets != [] and not any(t.startswith(str(seged_hivo.HOME)) for t in bind_targets))

# --- S2 INFO (CYBERED, card e4d38c2b, source de3fb362): jail_cmd()'s own hardening flags were
# never pinned here, so a future edit could drop one silently -- only the binds/mounts above had
# regression coverage. These three are argv presence/shape checks, same cheap pattern as the
# /dev/dxg and --dev-bind checks above; the comment above jail_cmd() explains what each buys.
case("agy jail unshares its own PID namespace (--unshare-pid) -- --die-with-parent then takes "
     "every descendant down with it, setsid'd ones included",
     '--unshare-pid' in agy_jail)
case("agy jail clears its own environment (--clearenv) before --setenv-ing back only the fixed "
     "allowlisted vars -- no ambient secret (messaging token, SSH/GPG agent sockets, TMUX) leaks in",
     '--clearenv' in agy_jail)
case("agy jail remounts $HOME read-only (--remount-ro) after binding state/workdir back in -- a "
     "write outside DIR then fails loudly instead of landing in a still-writable tmpfs",
     ('--remount-ro', str(seged_hivo.HOME)) in pairs)

# F3 (RedHat, card de3fb362 komment 20293, routed into 0f01b9cf): the remaining jail_cmd()
# hardening flags were never pinned here either -- --new-session, --unshare-ipc and
# --die-with-parent could all be dropped silently, same gap the S2 pins above closed for
# --unshare-pid/--clearenv/--remount-ro.
case("agy jail opens a new session (--new-session) -- blocks TIOCSTI terminal-injection into a "
     "controlling tty it might otherwise inherit",
     '--new-session' in agy_jail)
case("agy jail unshares its own IPC namespace (--unshare-ipc) -- no host shared-memory/semaphore "
     "object is reachable from inside the jail",
     '--unshare-ipc' in agy_jail)
case("agy jail dies with its parent (--die-with-parent) -- paired with --unshare-pid, this takes "
     "every descendant down with it, setsid'd ones included, if the jail launcher itself dies",
     '--die-with-parent' in agy_jail)

# F3 (RedHat, same comment): --clearenv's argv POSITION matters, not just its presence -- bwrap
# applies environment operations in argv order, so a --clearenv placed AFTER the --setenv pairs
# would wipe the fixed allowlisted vars right back out, leaving the jailed process with a
# silently empty environment instead of the intended allowlist (the existing presence-only pin
# above stayed green under exactly this reordering).
_clearenv_idx = agy_jail.index('--clearenv') if '--clearenv' in agy_jail else -1
_setenv_idxs = [i for i, tok in enumerate(agy_jail) if tok == '--setenv']
case("agy jail's --clearenv comes BEFORE every --setenv pair, not after (argv order matters to "
     "bwrap -- a --clearenv after --setenv would wipe the allowlisted vars it just set)",
     _clearenv_idx != -1 and _setenv_idxs != [] and _clearenv_idx < min(_setenv_idxs))

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

    # F3 LOW self-check (WhiteHat, card deab5615 comment 20050): a wrong uid_dir (here, the real
    # path plus a trailing "-x") also ENOENTs inside the jail, but it was never real on the host
    # either -- host_entries_wrong is empty -- so classify_jailed_listing must now reject it,
    # where the pre-fix version (RC:2 + ENOENT text alone, no host_entries requirement) accepted
    # any such path. Measured, not assumed: run the actual wrong path through the real jail.
    uid_dir_wrong = Path(str(uid_dir) + '-x')
    host_entries_wrong = (sorted(p.name for p in uid_dir_wrong.iterdir())
                           if uid_dir_wrong.is_dir() else [])
    with_jail_wrong = (seged_hivo.jail_cmd('agy', Path('/tmp'))
                        + ['/bin/sh', '-c', f'ls -a {uid_dir_wrong} 2>&1; echo RC:$?'])
    proc_wrong = subprocess.run(with_jail_wrong, capture_output=True, text=True, timeout=15)
    case("F3: a wrong uid_dir (real path + '-x', never real on the host -- host_entries_wrong is "
         f"{host_entries_wrong!r}) must be REJECTED even though it also ENOENTs inside the jail "
         f"(jailed ls said: {proc_wrong.stdout.strip()!r})",
         not classify_jailed_listing(proc_wrong.stdout, host_entries_wrong))

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

    # dir='/tmp' is load-bearing, not cosmetic: jail_cmd()'s --tmpfs $HOME + --remount-ro $HOME
    # happen BEFORE our extra --ro-bind below runs, so a sweep_dir created under $TMPDIR (which
    # fleet-test.sh deliberately points at a path under $HOME, card a4a6a5e5) can no longer have
    # its missing parent directories created inside the jail -- bwrap's own mount setup fails
    # silently (empty stdout, nonzero exit), which this selftest then misreads as a real
    # vacuous-sweep finding. /tmp is the one directory jail_cmd already re-binds regardless of
    # TMPDIR, so anchoring here keeps the control reachable under any caller's environment.
    sweep_dir = Path(tempfile_module.mkdtemp(prefix='seged-hivo-sweep-', dir='/tmp'))
    control_sock_path = sweep_dir / 'control.sock'
    control_sock = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
    # F1 LOW (WhiteHat, card deab5615 comment 20050): passing Path('/tmp') as jail_cmd()'s
    # workdir re-binds the HOST's real /tmp over the jail's own fresh --tmpfs (jail_cmd always
    # tmpfs's /tmp first, then --bind's the caller's workdir over it, see scripts/seged-hivo.py).
    # That is a selftest-only artifact -- a real caller's --mappa is always under SEGED_BASE,
    # never /tmp -- but it made real host sockets under /tmp (tmux, X11, ...) visible in the
    # sweep, and the old name-matching check (below) never looked at them because it only
    # compared against host_entries (the uid_dir's own socket names). Measured directly: passing
    # sweep_dir itself as the workdir instead keeps /tmp a fresh, empty tmpfs (only sweep_dir, the
    # one subdirectory jail_cmd's own --bind now re-exposes, is visible under it) -- so the extra
    # --ro-bind sweep_dir sweep_dir this selftest used to add is now genuinely redundant (F5 INFO
    # already flagged the same redundancy for the old /tmp-workdir reason) and is removed.
    sweep_jail_cmd = seged_hivo.jail_cmd('agy', sweep_dir)
    try:
        control_sock.bind(str(control_sock_path))
        # F2 LOW (WhiteHat, card deab5615 comment 20050): excluding /proc/* and /sys/* from the
        # sweep left a vacuous blind spot -- a host socket bound directly over /sys/fs or
        # /proc/sys sailed through unseen. Measured on this host: the full, unexcluded `find /
        # -type s` sweep over a /sys/fs leak took 3.68s against 3.34s with the exclusions (well
        # inside this sweep's own 20s timeout, and the whole selftest's total runtime), so the
        # exclusions bought no real time budget -- just blindness. Removed.
        sweep_cmd = sweep_jail_cmd + ['/bin/sh', '-c', "find / -type s 2>/dev/null"]
        sweep_proc = subprocess.run(sweep_cmd, capture_output=True, text=True, timeout=20)
        sweep_listing_paths = [line for line in sweep_proc.stdout.splitlines() if line.strip()]
        case("F-RH-S2: the jail-wide socket sweep's own positive control (a real socket bound "
             "INTO the jail) IS found -- proves the sweep is not vacuously blind",
             str(control_sock_path) in sweep_listing_paths)

        # F1 delta-fix (RedHat NO-GO, card de3fb362 comment 20293): the exact-set comparison
        # below used to be an inline expression with NO dedicated positive self-check of its
        # own -- RedHat measured that weakening it to `in`/substring matching STILL left the
        # whole selftest 25/25 PASS, because nothing in this file ever fed the comparison a
        # listing that contains the control socket PLUS an extra, differently-named one. Pulled
        # into its own function so the comparison itself has a name and a testable contract
        # (F-RH-S1-style exact-set, not membership), with two unit cases right below that do
        # NOT depend on a live jail run: one gives it an extra foreign-named socket (must be
        # REJECTED -- this is exactly the case a weakened `in` check would wrongly ACCEPT), one
        # gives it only the control socket (must be ACCEPTED). A mutation to `in`/membership
        # flips the first of these two to a false PASS, which is the regression RedHat's
        # measurement names directly.
        def sweep_is_exact(paths, control_path):
            return paths == [str(control_path)]

        case("F1/F-RH-S2: the sweep finds EXACTLY the expected control socket and nothing else -- "
             f"exact-set comparison, not name matching (sweep saw: {sweep_listing_paths!r})",
             sweep_is_exact(sweep_listing_paths, control_sock_path))

        # N1 (RedHat GO, card e4d38c2b komment 20368, routed into 0f01b9cf): the F1 self-check
        # cases below protect sweep_is_exact() ITSELF, but nothing pinned that the LIVE call site
        # above still goes THROUGH that function -- RedHat measured that swapping it for a
        # weakened `in`/membership check leaves the whole selftest green, because no case ever
        # feeds the live call site a listing containing an extra, differently-named socket. A
        # comment-stripped source scan pins the literal call-site text instead (identifier-
        # boundary regex per the comment-defeat class, card a14812e8/e5b7ff19): a revert to `in`
        # or to a bare equality inline is caught here even though the function-level cases below
        # would stay green either way.
        _own_src_no_comments = '\n'.join(
            line for line in Path(__file__).read_text().splitlines()
            if not line.strip().startswith('#'))
        case("N1 source-pin: the live sweep comparison call site still invokes sweep_is_exact(...) "
             "by name, not a weakened inline membership/`in` check",
             re.search(r'\bsweep_is_exact\(sweep_listing_paths,\s*control_sock_path\)',
                       _own_src_no_comments) is not None)

        # F1 self-check (RedHat NO-GO 20293): a listing carrying the control socket PLUS an
        # unrelated, differently-named socket path (never in host_entries, never control.sock)
        # must be REJECTED by sweep_is_exact -- a membership/`in` check would wrongly accept it,
        # which is precisely the undetected weakening RedHat demonstrated.
        case("F1 self-check: sweep_is_exact REJECTS a listing with an extra, differently-named "
             "socket alongside the control socket (an `in`/membership check would wrongly accept "
             "this -- this is the exact regression RedHat's NO-GO measured)",
             not sweep_is_exact(
                 [str(control_sock_path), '/opt/synthetic-other-name.sock'], control_sock_path))

        # F1 self-check (control, RedHat NO-GO 20293): the control-only listing must still be
        # ACCEPTED -- without this the rejection case above could be satisfied by a function that
        # simply always returns False.
        case("F1 self-check: sweep_is_exact ACCEPTS the control-only listing",
             sweep_is_exact([str(control_sock_path)], control_sock_path))

        # Self-check that the sweep machinery above actually catches the exact leak class RedHat
        # measured: bind the SAME host sockets into the jail through an ALTERNATE path (not
        # /mnt/wslg/run/user/<uid>), which the single-directory check has no way to see.
        if host_entries:
            leaked_cmd = (sweep_jail_cmd + ['--ro-bind', str(uid_dir), '/tmp/leaked-host-sockets']
                          + ['/bin/sh', '-c', "find / -type s 2>/dev/null"])
            leaked_proc = subprocess.run(leaked_cmd, capture_output=True, text=True, timeout=20)
            case("F-RH-S2 self-check: the full-tree sweep DOES catch a host socket leaked "
                 "through a path OTHER than /mnt/wslg/run/user/<uid> (proves the sweep, not just "
                 "the single-directory check above, is what closes RedHat's finding)",
                 any(name in leaked_proc.stdout for name in host_entries))

            # F2 self-check: bind the SAME host sockets directly OVER /sys/fs (overwriting the
            # existing mountpoint, not creating a new path under it -- /sys is read-only bound
            # from the initial `--ro-bind / /`, so bwrap cannot mkdir a NEW subdirectory there,
            # but mounting onto an EXISTING directory needs no write permission on its parent).
            # Measured: this is exactly the bind shape WhiteHat used ("a valódi uid_dir ... /sys/
            # fs ... fölé kötve").
            leaked_sys_cmd = (sweep_jail_cmd + ['--ro-bind', str(uid_dir), '/sys/fs']
                              + ['/bin/sh', '-c', "find / -type s 2>/dev/null"])
            leaked_sys_proc = subprocess.run(leaked_sys_cmd, capture_output=True, text=True,
                                              timeout=20)
            case("F2: the unexcluded sweep DOES catch a host socket leaked through /sys/fs "
                 "(the old -not -path '/sys/*' exclusion made this invisible)",
                 any(name in leaked_sys_proc.stdout for name in host_entries))
    finally:
        control_sock.close()
        shutil.rmtree(sweep_dir, ignore_errors=True)
else:
    skip("real-jail socket-listing + full-tree sweep checks (F-RH-S1/S2, F1-F3) did not run -- "
         f"bwrap present: {Path('/usr/bin/bwrap').exists()}, /mnt/wslg a directory: "
         f"{Path('/mnt/wslg').is_dir()}")

print()
# F2 (RedHat, card de3fb362 komment 20293, routed into 0f01b9cf): the old "PASS, K SKIPPED" tail
# still contained the literal substring the shared src/__tests__/store-selftests-all-run.test.ts
# OK_SHAPES regex matches (that regex is not end-anchored), so a WSLg-less host's degraded run
# read as an ordinary PASS to the machine consumer -- only a human reading the tail noticed the
# skip. DEGRADED-SKIP uses wholly different wording (no "PASS" substring at all) so it cannot
# satisfy the PASS pattern by accident; OK_SHAPES gets its own, deliberate entry for this shape
# instead, so the skip stays a real exit 0 (not a CI break) while remaining machine-distinguishable
# from a genuine, fully-exercised pass.
if failures:
    print("selftest: %d case(s), FAIL" % n)
elif skipped:
    print("selftest: %d case(s), DEGRADED-SKIP (%d skipped, not counted as coverage)" % (n, len(skipped)))
else:
    print("selftest: %d case(s), PASS" % n)
for f in failures:
    print("  - %s" % f)
for s in skipped:
    print("  SKIP: %s" % s)
sys.exit(1 if failures else 0)
