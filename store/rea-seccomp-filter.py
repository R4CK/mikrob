#!/usr/bin/env python3
# Minimal, documented seccomp denylist for the REA bwrap sandbox (card 077970fc, RedHat
# follow-up to 9518b377 komment 24382: "a nested userns is closed, but there is no syscall-level
# filter"). Default action is ALLOW (the REA engines are not profiled per-syscall; a full
# allowlist would need a measured strace of every engine and would break on any untested code
# path) -- only the specific syscalls below are denied with EPERM. Each one is denied because it
# is a privilege-escalation or sandbox-escape primitive the REA engines have no legitimate need
# for, not because it showed up in a trace:
#   ptrace       -- process introspection/injection; lets a compromised engine attach to and
#                    rewrite another process's memory (would also defeat this very sandbox's
#                    die-with-parent/pid checks if aimed at a sibling).
#   keyctl       -- kernel keyring access; no REA engine stores or needs kernel-keyring secrets.
#   bpf          -- loading BPF programs is itself a kernel attack-surface primitive (verifier
#                    bugs are a recurring privilege-escalation class); no REA engine uses BPF.
#   userfaultfd  -- userspace page-fault handling, used in several public container-escape PoCs
#                    (race-the-kernel-while-it-reads-your-memory class); no legitimate use here.
#   mount        -- would let a compromised engine remount a read-only bind read-write or widen
#                    its own filesystem view; bwrap already relies on its own mount-namespace
#                    setup finishing before the sandboxed process starts, so the process itself
#                    never needs to mount anything.
#
# Uses libseccomp (already installed system-wide as libseccomp2, "high level interface to Linux
# seccomp filter") via ctypes -- no libseccomp-dev headers or a C compiler needed at runtime, no
# hand-rolled BPF opcodes to keep correct by hand. Deliberately small: this is a filter generator
# only, no syscall data derived from any untrusted input.
import ctypes
import os
import sys

DENY_SYSCALLS = ("ptrace", "keyctl", "bpf", "userfaultfd", "mount")

SCMP_ACT_ALLOW = 0x7FFF0000
_EPERM = 1
SCMP_ACT_ERRNO_EPERM = 0x00050000 | (_EPERM & 0xFFFF)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: rea-seccomp-filter.py <output-path>", file=sys.stderr)
        return 1
    out_path = sys.argv[1]

    lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_rule_add.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_export_bpf.restype = ctypes.c_int
    lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]

    ctx = lib.seccomp_init(SCMP_ACT_ALLOW)
    if not ctx:
        print("rea-seccomp-filter: seccomp_init failed", file=sys.stderr)
        return 1

    for name in DENY_SYSCALLS:
        nr = lib.seccomp_syscall_resolve_name(name.encode())
        if nr < 0:
            print(f"rea-seccomp-filter: could not resolve syscall '{name}' on this kernel/arch", file=sys.stderr)
            lib.seccomp_release(ctx)
            return 1
        rc = lib.seccomp_rule_add(ctx, SCMP_ACT_ERRNO_EPERM, nr, 0)
        if rc != 0:
            print(f"rea-seccomp-filter: seccomp_rule_add({name}) failed: {rc}", file=sys.stderr)
            lib.seccomp_release(ctx)
            return 1

    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        rc = lib.seccomp_export_bpf(ctx, fd)
    finally:
        os.close(fd)
        lib.seccomp_release(ctx)
    if rc != 0:
        print(f"rea-seccomp-filter: seccomp_export_bpf failed: {rc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
