#!/usr/bin/env python3
"""
quota-bridge.selftest.py -- does the recovery probe stay suppressed only when it is SAFE to?
(card cd7376ed)

WHAT PETI REPORTED: during a quota outage the Ghost handover message and the "MikroB is back"
message alternated every few minutes. One loop, not two bugs -- the recovery test is
`banner AND heartbeat-stale`, the heartbeat counts as fresh for 12 minutes, so one scheduled task
touching that file flips mikrob_down() to false, the loop announces recovery, resets the notified
flag, immediately re-detects the outage and announces the handover again. Two messages per flap,
no information in either.

THE ASYMMETRY THIS FILE DEFENDS, and the reason the cases are ordered the way they are:

  Suppressing the probe TOO LITTLE costs a message. That is the bug being fixed, and it is
  annoying rather than dangerous.

  Suppressing it TOO MUCH costs the real orchestrator: a Ghost latched on after MikroB is back
  holds the Telegram getUpdates slot, so Peti talks to a 7B model believing it is MikroB. Every
  case below where the answer is "probe" exists to make that outcome impossible on bad state --
  a missing file, unparseable JSON, a missing or non-numeric deadline, a deadline in the past, or
  one so far out it cannot belong to this outage.

So: exactly ONE input shape suppresses the probe (a numeric deadline, in the future, beyond the
window, within the trusted horizon). Everything else probes.
"""
import importlib.util
import json
import os
import signal
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PASS = 0
FAIL = 0


def ok(name):
    global PASS
    PASS += 1
    print(f"  ok   {name}")


def bad(name, detail=""):
    global FAIL
    FAIL += 1
    print(f"  FAIL {name}\n     {detail}")


def load_module():
    spec = importlib.util.spec_from_file_location("quota_bridge", HERE / "quota-bridge.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    print("quota-bridge selftest")
    try:
        m = load_module()
    except Exception as exc:  # noqa: BLE001 -- the selftest must report, not crash
        print(f"  FAIL could not import quota-bridge.py: {type(exc).__name__}: {exc}")
        print("\nselftest: 0 passed, 1 failed")
        return 1

    NOW = 1_800_000_000.0
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        cd = td / "countdown.json"
        m.COUNTDOWN_FILE = str(cd)

        def write(obj):
            cd.write_text(json.dumps(obj), encoding="utf-8")

        # --- the one suppressing shape -------------------------------------------------------
        write({"deadline": NOW + 3600})          # an hour out: well past the window, well inside trust
        if m.recovery_probe_due(NOW) is False:
            ok("a known deadline an hour out SUPPRESSES the probe (this is the fix)")
        else:
            bad("a known deadline an hour out suppresses the probe", "still probing")

        # --- everything else must probe ------------------------------------------------------
        if cd.exists():
            cd.unlink()
        if m.recovery_probe_due(NOW) is True:
            ok("no countdown file -> probe (today's behaviour preserved)")
        else:
            bad("no countdown file -> probe")

        cd.write_text("{not json", encoding="utf-8")
        if m.recovery_probe_due(NOW) is True:
            ok("unparseable countdown -> probe, never silence")
        else:
            bad("unparseable countdown -> probe")

        write({"note": "no deadline key here"})
        if m.recovery_probe_due(NOW) is True:
            ok("countdown without a deadline field -> probe")
        else:
            bad("countdown without a deadline field -> probe")

        write({"deadline": "2026-09-10T12:00:00Z"})   # a string, not epoch
        if m.recovery_probe_due(NOW) is True:
            ok("a non-numeric deadline -> probe (no string/number comparison crash)")
        else:
            bad("a non-numeric deadline -> probe")

        write({"deadline": NOW - 60})
        if m.recovery_probe_due(NOW) is True:
            ok("a deadline already past -> probe (the reset may have happened)")
        else:
            bad("a deadline already past -> probe")

        # The boundary, stated as a value rather than left implicit: at exactly the window edge the
        # probe runs. Off-by-one here would silence the last 3 minutes, which is the one stretch
        # where recovery is most likely.
        write({"deadline": NOW + m.RECOVERY_PROBE_WINDOW_SEC})
        if m.recovery_probe_due(NOW) is True:
            ok("exactly at the probe window edge -> probe")
        else:
            bad("exactly at the probe window edge -> probe")

        write({"deadline": NOW + m.RECOVERY_PROBE_WINDOW_SEC + 1})
        if m.recovery_probe_due(NOW) is False:
            ok("one second beyond the window -> suppressed (the boundary is where it is claimed)")
        else:
            bad("one second beyond the window -> suppressed")

        # A quota window is 5h05m; anything past the trusted horizon is stale or corrupt state, and
        # trusting it would hold the Ghost latched for hours.
        write({"deadline": NOW + m.COUNTDOWN_MAX_TRUSTED_SEC + 1})
        if m.recovery_probe_due(NOW) is True:
            ok("an implausibly distant deadline -> probe, not hours of silence")
        else:
            bad("an implausibly distant deadline -> probe")

        # MUST NOT RAISE. This function runs inside outage_loop's only exit path, so an exception
        # does not degrade to "probe anyway" -- it kills the loop holding Peti's channel and leaves
        # the Ghost dead mid-outage with the getUpdates slot claimed. Shapes JSON permits but the
        # arithmetic does not: a list, an object, null.
        for shape in ([1, 2], {"x": 1}, None):
            write({"deadline": shape})
            try:
                got = m.recovery_probe_due(NOW)
            except Exception as exc:  # noqa: BLE001
                bad(f"a {type(shape).__name__} deadline must not raise", f"{type(exc).__name__}: {exc}")
                break
            if got is not True:
                bad(f"a {type(shape).__name__} deadline -> probe", f"got {got}")
                break
        else:
            ok("list / object / null deadlines probe instead of raising (the loop survives)")

        # THE CASE THAT REACHES THE OUTER except, and the reason it is not decoration. Every shape
        # above is caught by an inner guard, so none of them proves the broad handler does anything
        # -- mutation testing showed exactly that: replacing `except Exception` with a narrower one
        # left the suite green. A file whose JSON ROOT is not an object is different: json.load()
        # succeeds, and `.get("deadline")` then raises AttributeError before any guard sees it.
        # That is a real state (a truncated or half-written file), and it must probe, not kill the
        # loop.
        cd.write_text("[1, 2, 3]", encoding="utf-8")
        try:
            got = m.recovery_probe_due(NOW)
        except Exception as exc:  # noqa: BLE001
            bad("a non-object JSON root must not raise", f"{type(exc).__name__}: {exc}")
        else:
            if got is True:
                ok("a non-object JSON root probes instead of raising (reaches the outer handler)")
            else:
                bad("a non-object JSON root -> probe", f"got {got}")

        # NOT ASSERTED, deliberately: the `isinstance(deadline, bool)` rejection in the source has
        # no observable effect. `True - now` is a large negative remaining, which lands on the same
        # `probe` answer the rejection produces, so a test for it passes with or without the guard
        # (mutation-verified). The guard stays for honest arithmetic; this suite does not claim to
        # prove it, because a case that passes either way proves nothing.

    # --- _telegram_state_dir: TELEGRAM_STATE_DIR is trusted only under the marveen checkout
    # (card 01dea2f0, Cybersec: this dir also gates access.json, the pairing allowlist) ------
    with tempfile.TemporaryDirectory() as fake_marveen_parent:
        fake_marveen = Path(fake_marveen_parent) / "marveen"
        fake_marveen.mkdir()
        old_marveen, old_env = m.MARVEEN, os.environ.get("TELEGRAM_STATE_DIR")
        m.MARVEEN = str(fake_marveen)
        try:
            inside = fake_marveen / "some" / "nested" / "dir"
            inside.mkdir(parents=True)
            os.environ["TELEGRAM_STATE_DIR"] = str(inside)
            if m._telegram_state_dir() == str(inside):
                ok("a real subdirectory of the marveen checkout is trusted as-is")
            else:
                bad("a subdirectory of marveen should be trusted", m._telegram_state_dir())

            os.environ["TELEGRAM_STATE_DIR"] = str(fake_marveen)
            if m._telegram_state_dir() == str(fake_marveen):
                ok("the marveen checkout root itself is trusted (exact-match edge)")
            else:
                bad("the marveen root itself should be trusted", m._telegram_state_dir())

            outside = Path(fake_marveen_parent) / "elsewhere"
            outside.mkdir()
            os.environ["TELEGRAM_STATE_DIR"] = str(outside)
            got = m._telegram_state_dir()
            if got != str(outside):
                ok("a directory outside the marveen checkout is ignored, not trusted")
            else:
                bad("a directory outside marveen must not be trusted", got)

            # THE PREFIX-STRING TRAP: "marveen-evil" starts with "marveen" as a bare string,
            # but is a SIBLING directory, not a subdirectory -- a naive .startswith(MARVEEN)
            # would wrongly trust it. This is why the check requires the os.sep boundary.
            sibling = Path(fake_marveen_parent) / (fake_marveen.name + "-evil")
            sibling.mkdir()
            os.environ["TELEGRAM_STATE_DIR"] = str(sibling)
            got = m._telegram_state_dir()
            if got != str(sibling):
                ok("a sibling dir sharing the checkout name as a string prefix is rejected")
            else:
                bad("a same-prefix sibling directory must not be trusted", got)

            # A symlink escaping the checkout must be caught by realpath, not the raw string.
            escape_target = Path(fake_marveen_parent) / "outside-target"
            escape_target.mkdir()
            escape_link = fake_marveen / "escape-link"
            escape_link.symlink_to(escape_target, target_is_directory=True)
            os.environ["TELEGRAM_STATE_DIR"] = str(escape_link)
            got = m._telegram_state_dir()
            if got != str(escape_link):
                ok("a symlink resolving outside the checkout is rejected, not trusted by its raw path")
            else:
                bad("a symlink escaping the checkout must not be trusted", got)
        finally:
            m.MARVEEN = old_marveen
            if old_env is None:
                os.environ.pop("TELEGRAM_STATE_DIR", None)
            else:
                os.environ["TELEGRAM_STATE_DIR"] = old_env

    # --- card 612058c2: session-outage marker + Ghost runner start/stop -----------------------
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        marker = td / "mikrob-session-outage.json"
        old_marker = m.SESSION_OUTAGE_FILE
        m.SESSION_OUTAGE_FILE = str(marker)
        try:
            m.mark_session_outage()
            first_doc = json.loads(marker.read_text()) if marker.exists() else {}
            if marker.exists() and first_doc.get("active") is True:
                ok("mark_session_outage() writes an active:true marker")
            else:
                bad("mark_session_outage() should write active:true", marker.read_text() if marker.exists() else "<missing>")

            # H2 (WhiteHat2 NO-GO, delta-gate @c5e5ec28): a heartbeat field must be present and
            # fresh -- this is what readSessionOutageActive() now checks for staleness.
            if isinstance(first_doc.get("heartbeat"), (int, float)) and abs(first_doc["heartbeat"] - time.time()) < 5:
                ok("mark_session_outage() writes a fresh heartbeat field")
            else:
                bad("mark_session_outage() should write a fresh numeric heartbeat", repr(first_doc.get("heartbeat")))

            # H2: a REFRESH (second call) must advance heartbeat but preserve the ORIGINAL `since`
            # -- the acceptance criterion is "stays fresh while alive", not "restarts the clock".
            time.sleep(0.05)
            m.mark_session_outage()
            second_doc = json.loads(marker.read_text())
            if second_doc.get("since") == first_doc.get("since") and second_doc.get("heartbeat", 0) > first_doc.get("heartbeat", 0):
                ok("mark_session_outage() refresh advances heartbeat but preserves the original since")
            else:
                bad("mark_session_outage() refresh should preserve since and advance heartbeat",
                    f"first={first_doc}, second={second_doc}")

            m.clear_session_outage()
            if not marker.exists():
                ok("clear_session_outage() removes the marker")
            else:
                bad("clear_session_outage() should remove the marker")

            # Must not raise when the marker is already gone (recovery can race a manual cleanup).
            try:
                m.clear_session_outage()
                ok("clear_session_outage() is a no-op (not a crash) when already absent")
            except Exception as exc:  # noqa: BLE001
                bad("clear_session_outage() must not raise on a missing marker", f"{type(exc).__name__}: {exc}")

            # Write failures (e.g. an unwritable directory) must not raise either -- this runs
            # inside outage_loop, same fail-safe posture as recovery_probe_due above.
            m.SESSION_OUTAGE_FILE = str(td / "no" / "such" / "dir" / "marker.json")
            try:
                m.mark_session_outage()
                ok("mark_session_outage() does not raise when the path is unwritable")
            except Exception as exc:  # noqa: BLE001
                bad("mark_session_outage() must not raise on a write failure", f"{type(exc).__name__}: {exc}")
        finally:
            m.SESSION_OUTAGE_FILE = old_marker

        old_runner = m.GHOST_RUNNER_SCRIPT
        try:
            # A real, short-lived script: confirms start_ghost_runner() returns a live Popen handle
            # and stop_ghost_runner() actually terminates it rather than leaking the process.
            runner = td / "fake-runner.sh"
            runner.write_text("#!/bin/bash\ntrap 'exit 0' TERM\nwhile true; do sleep 0.05; done\n")
            runner.chmod(0o755)
            m.GHOST_RUNNER_SCRIPT = str(runner)
            proc = m.start_ghost_runner()
            if proc is not None and proc.poll() is None:
                ok("start_ghost_runner() returns a live process handle")
            else:
                bad("start_ghost_runner() should return a live process", repr(proc))
            if proc is not None:
                m.stop_ghost_runner(proc)
                try:
                    proc.wait(timeout=5)
                    if proc.poll() is not None:
                        ok("stop_ghost_runner() actually terminates the process (acceptance: exit stops the runner)")
                    else:
                        bad("stop_ghost_runner() should terminate the process")
                except Exception as exc:  # noqa: BLE001
                    bad("stop_ghost_runner() left the process unreaped", f"{type(exc).__name__}: {exc}")

            # A missing/non-executable script must not raise -- best-effort, Ghost's own Telegram
            # loop must survive it.
            m.GHOST_RUNNER_SCRIPT = str(td / "does-not-exist.sh")
            try:
                got = m.start_ghost_runner()
                if got is None:
                    ok("start_ghost_runner() fails soft (returns None) when the script is missing")
                else:
                    bad("start_ghost_runner() should return None on a missing script", repr(got))
            except Exception as exc:  # noqa: BLE001
                bad("start_ghost_runner() must not raise on a missing script", f"{type(exc).__name__}: {exc}")

            # stop_ghost_runner(None) -- the no-start-happened case -- must be a safe no-op.
            try:
                m.stop_ghost_runner(None)
                ok("stop_ghost_runner(None) is a safe no-op")
            except Exception as exc:  # noqa: BLE001
                bad("stop_ghost_runner(None) must not raise", f"{type(exc).__name__}: {exc}")

            # M1 (WhiteHat2 NO-GO, delta-gate @c5e5ec28): a fake runner that spawns a CHILD
            # process (mirrors the real script's `node dist/gemini-orchestrator-draft*.js` step,
            # still running when the runner itself is asked to stop) -- stop_ghost_runner() must
            # reach that orphaned child too, not just the runner's own top-level PID.
            orphan_marker = td / "orphan.pid"
            child_runner = td / "spawns-child.sh"
            child_runner.write_text(
                "#!/bin/bash\n"
                "sleep 60 &\n"
                f"echo $! > {orphan_marker}\n"
                "trap 'exit 0' TERM\n"
                "while true; do sleep 0.05; done\n"
            )
            child_runner.chmod(0o755)
            m.GHOST_RUNNER_SCRIPT = str(child_runner)
            proc = m.start_ghost_runner()
            child_pid = None
            if proc is not None:
                for _ in range(50):  # wait for the child to actually spawn and record its pid
                    if orphan_marker.exists() and orphan_marker.read_text().strip():
                        child_pid = int(orphan_marker.read_text().strip())
                        break
                    time.sleep(0.05)
            if child_pid is None:
                bad("M1 setup: the fake runner never recorded its spawned child's pid")
            else:
                m.stop_ghost_runner(proc)
                time.sleep(0.3)
                try:
                    os.kill(child_pid, 0)  # raises ProcessLookupError if the pid is gone
                    bad("stop_ghost_runner() left an orphaned child process running (M1)")
                except ProcessLookupError:
                    ok("stop_ghost_runner() also reaps a child the runner spawned (M1, process-group kill)")
        finally:
            m.GHOST_RUNNER_SCRIPT = old_runner

    # --- F-RH-V4 (RedHat NO-GO/GO @c5e5ec28): pin outage_loop()'s try/finally on BOTH exit paths -
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        old = {
            "allowed_chats": m.allowed_chats, "mark_session_outage": m.mark_session_outage,
            "start_ghost_runner": m.start_ghost_runner, "stop_ghost_runner": m.stop_ghost_runner,
            "clear_session_outage": m.clear_session_outage, "send": m.send,
            "save_state": m.save_state, "recovery_probe_due": m.recovery_probe_due,
            "mikrob_down": m.mikrob_down,
        }
        calls = {"start": 0, "stop": 0, "clear": 0}
        m.allowed_chats = lambda: {"1"}
        m.mark_session_outage = lambda: None
        m.start_ghost_runner = lambda: (calls.__setitem__("start", calls["start"] + 1), "FAKE_PROC")[1]
        m.stop_ghost_runner = lambda proc: calls.__setitem__("stop", calls["stop"] + 1)
        m.clear_session_outage = lambda: calls.__setitem__("clear", calls["clear"] + 1)
        m.send = lambda token, chat_id, text: None
        m.save_state = lambda s: None
        try:
            # Path A: the normal "MikroB recovered" return. recovery_probe_due=True (probe not
            # suppressed) + mikrob_down=False (healthy) takes the `elif not mikrob_down(): ...
            # return` branch on the FIRST loop iteration, before ever reaching tg_api.
            m.recovery_probe_due = lambda now=None: True
            m.mikrob_down = lambda: False
            m.outage_loop("fake-token", {"offset": 0, "notified_outage": False})
            if calls["start"] == 1 and calls["stop"] == 1 and calls["clear"] == 1:
                ok("outage_loop()'s return path calls start/stop/clear exactly once each (F-RH-V4)")
            else:
                bad("outage_loop()'s return path should call start/stop/clear exactly once each", calls)

            # Path B: an exception INSIDE the loop (recovery_probe_due raises) must still run the
            # finally -- this is the acceptance criterion ("kilepeskor a runner leall") on its
            # OTHER exit path, which nothing exercised before this case.
            calls["start"] = calls["stop"] = calls["clear"] = 0

            def _boom(now=None):
                raise RuntimeError("boom")

            m.recovery_probe_due = _boom
            m.mikrob_down = lambda: False
            raised = None
            try:
                m.outage_loop("fake-token", {"offset": 0, "notified_outage": False})
            except RuntimeError as exc:
                raised = exc
            if raised is not None and calls["start"] == 1 and calls["stop"] == 1 and calls["clear"] == 1:
                ok("outage_loop()'s exception path ALSO calls start/stop/clear via finally (F-RH-V4)")
            else:
                bad("outage_loop()'s exception path should still call start/stop/clear via finally",
                    f"raised={raised!r}, calls={calls}")
        finally:
            for name, fn in old.items():
                setattr(m, name, fn)

    # --- F1 (WhiteHat GO, card 612058c2 Teendo @6b9f61eb, comment 19967): outage_loop()'s
    # --- PER-ITERATION heartbeat refresh was never pinned -- every case above either stubbed
    # --- mark_session_outage() to a no-op (so removing the per-loop call left them all green) or
    # --- never drove a second iteration at all. Here mikrob_down() answers True once (still down,
    # --- falls through to the tg_api call and the per-iteration refresh) then False (recovered,
    # --- returns on the SECOND iteration) -- so a correct implementation calls
    # --- mark_session_outage() at least twice: once at entry, once in the loop body. -----------
    old2 = {
        "allowed_chats": m.allowed_chats, "mark_session_outage": m.mark_session_outage,
        "start_ghost_runner": m.start_ghost_runner, "stop_ghost_runner": m.stop_ghost_runner,
        "clear_session_outage": m.clear_session_outage, "send": m.send,
        "save_state": m.save_state, "recovery_probe_due": m.recovery_probe_due,
        "mikrob_down": m.mikrob_down, "tg_api": m.tg_api,
    }
    mark_calls = {"n": 0}
    down_calls = {"n": 0}
    m.allowed_chats = lambda: {"1"}
    m.mark_session_outage = lambda: mark_calls.__setitem__("n", mark_calls["n"] + 1)
    m.start_ghost_runner = lambda: "FAKE_PROC"
    m.stop_ghost_runner = lambda proc: None
    m.clear_session_outage = lambda: None
    m.send = lambda token, chat_id, text: None
    m.save_state = lambda s: None
    m.recovery_probe_due = lambda now=None: True
    m.tg_api = lambda *a, **kw: {"ok": True, "result": []}

    def _mikrob_down_once_then_recovered():
        down_calls["n"] += 1
        return down_calls["n"] == 1

    m.mikrob_down = _mikrob_down_once_then_recovered
    try:
        m.outage_loop("fake-token", {"offset": 0, "notified_outage": False})
        if mark_calls["n"] >= 2:
            ok("outage_loop() refreshes the heartbeat at entry AND at least once per loop "
               "iteration (F1)")
        else:
            bad("outage_loop() should call mark_session_outage() at entry and per iteration",
                f"mark_session_outage called {mark_calls['n']} time(s)")
    finally:
        for name, fn in old2.items():
            setattr(m, name, fn)

    # --- F1 (WhiteHat GO, comment 19967): main() must actually REGISTER the SIGTERM handler, not
    # --- just have a handler that behaves correctly if called directly (the F-RH-V3 cases below
    # --- test the handler's own body, not whether main() ever wires it up) -- and the startup
    # --- clear_session_outage() must run when NOT re-entering outage phase, but must NOT run when
    # --- phase is already "outage" (a live outage marker must survive a restart that re-enters the
    # --- SAME outage, per H2's own docstring). -------------------------------------------------
    old3 = {
        "read_token": m.read_token, "load_state": m.load_state, "kill_pid_holder": m.kill_pid_holder,
        "save_state": m.save_state, "outage_loop": m.outage_loop,
        "clear_session_outage": m.clear_session_outage,
    }
    orig_sigterm_handler = signal.getsignal(signal.SIGTERM)
    orig_argv = m.sys.argv
    clear_calls = {"n": 0}
    m.read_token = lambda: "fake-token"
    m.kill_pid_holder = lambda: None
    m.save_state = lambda s: None
    m.outage_loop = lambda token, state: None
    m.clear_session_outage = lambda: clear_calls.__setitem__("n", clear_calls["n"] + 1)
    m.sys.argv = ["quota-bridge.py", "--force-outage"]
    try:
        m.load_state = lambda: {"phase": "healthy", "offset": 0, "notified_outage": False}
        m.main()
        registered = signal.getsignal(signal.SIGTERM) is m._handle_sigterm
        if registered and clear_calls["n"] == 1:
            ok("main() registers _handle_sigterm for SIGTERM, and clears a stale marker on a "
               "non-outage startup (F1)")
        else:
            bad("main() should register SIGTERM and clear the marker when phase != outage",
                f"registered={registered}, clear_calls={clear_calls['n']}")

        clear_calls["n"] = 0
        m.load_state = lambda: {"phase": "outage", "offset": 0, "notified_outage": False}
        m.main()
        if clear_calls["n"] == 0:
            ok("main() does NOT clear the marker on startup when phase is already outage (F1)")
        else:
            bad("main() should not clear the marker when re-entering the same outage",
                f"clear_calls={clear_calls['n']}")
    finally:
        signal.signal(signal.SIGTERM, orig_sigterm_handler)
        m.sys.argv = orig_argv
        for name, fn in old3.items():
            setattr(m, name, fn)

    # --- F-RH-V3 (RedHat NO-GO/GO @c5e5ec28): the SIGTERM handler itself, directly -----------
    old_stop, old_clear, old_exit = m.stop_ghost_runner, m.clear_session_outage, m.sys.exit
    sigterm_calls = {"stop_arg": "unset", "clear": 0, "exit_code": None}
    m.stop_ghost_runner = lambda proc: sigterm_calls.__setitem__("stop_arg", proc)
    m.clear_session_outage = lambda: sigterm_calls.__setitem__("clear", sigterm_calls["clear"] + 1)

    class _FakeExit(BaseException):
        pass

    def _fake_exit(code=0):
        sigterm_calls["exit_code"] = code
        raise _FakeExit()

    m.sys.exit = _fake_exit
    m._active_ghost_runner = "SOME_PROC"
    try:
        try:
            m._handle_sigterm(signal.SIGTERM, None)
        except _FakeExit:
            pass
        if sigterm_calls["stop_arg"] == "SOME_PROC" and sigterm_calls["clear"] == 1 and sigterm_calls["exit_code"] == 0:
            ok("_handle_sigterm() stops the active runner, clears the marker, exits 0 (F-RH-V3)")
        else:
            bad("_handle_sigterm() should stop the active runner, clear the marker, exit 0", sigterm_calls)

        # A stop_ghost_runner that THROWS must not prevent clear_session_outage from still running
        # -- the marker is the more important half to clean up (H2's own staleness check is only a
        # backstop, this handler is the fast path).
        sigterm_calls["clear"] = 0
        sigterm_calls["exit_code"] = None

        def _stop_throws(proc):
            raise RuntimeError("stop failed")

        m.stop_ghost_runner = _stop_throws
        try:
            m._handle_sigterm(signal.SIGTERM, None)
        except _FakeExit:
            pass
        if sigterm_calls["clear"] == 1 and sigterm_calls["exit_code"] == 0:
            ok("_handle_sigterm() still clears the marker and exits even if stop_ghost_runner raises")
        else:
            bad("_handle_sigterm() should still clear the marker and exit if stop_ghost_runner raises", sigterm_calls)
    finally:
        m.stop_ghost_runner, m.clear_session_outage, m.sys.exit = old_stop, old_clear, old_exit
        m._active_ghost_runner = None

    print(f"\nselftest: {PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
