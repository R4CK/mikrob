#!/usr/bin/env python3
"""PreToolUse hook: judge a Bash call's ACTUAL NETWORK TARGET, interpreter-agnostic.

WHY NOT settings.permissions.deny (card f6db6978, measured on a real Claude Code 2.1.263 binary,
four probes with two controls). A `Bash(curl *https://*)` deny rule matches the WHOLE command
string, so it cannot tell the curl's target apart from any `https://` substring that merely rides
along in the payload. Every internal write path of this fleet -- memory, kanban comment,
inter-agent message, daily log -- is a curl to localhost:3420 that routinely carries a link in its
JSON body, so all of them would be denied. Measured: both the single- and double-quoted payload
spellings are denied, and the deny is evaluated BEFORE --dangerously-skip-permissions.

WHY NOT A CURL-SHAPED HOOK EITHER (Cybered's finding on the same gate). A guard that only parses
`curl`/`wget` ships with four other doors open: `python3 -c urllib`, `node -e fetch`, `perl -e LWP`,
`bash /dev/tcp`. A document claiming "egress gated" next to that guard would close one door and
silently leave four -- worse than no guard, because it buys false confidence. So the unit of
analysis here is NETWORK INTENT plus TARGET, for any interpreter, not a command name.

THE CORPUS THIS IS BUILT ON (card 854182c7, comment 2928; 12,675 session transcripts,
2,928,984 Bash commands -- the DB's tool_call_log could not answer the question because
input_summary is silently truncated at 200 characters, which lands right on the target URL).

  network-intent commands        874,205   (~30% of all Bash calls)
  ... localhost ONLY             845,777   (96.7% of those)
  ... literal external target     21,033   (2.4%)
  stdin-header idiom (-H @-)     632,912   (the fleet's dominant spelling)
  interpreter, NO network marker 551,816
  curl/wget with no literal URL     6,885 -> 3,165 of them WRITE A FILE, 555 are real
                                             variable-target invocations

Three numbers drove three design decisions, and each is load-bearing:

1. 845,777 localhost calls mean a localhost-detection bug is not a theoretical risk. At a 1% error
   rate it silently kills ~8,458 legitimate internal calls -- over the very channel the failure
   would have to be reported on. Hence log-only by default (see MODES) and hence the -H @- idiom
   being the first thing the parser gets right: the header value is CONSUMED by -H, so it can
   never be mistaken for the target.

2. 551,816 interpreter calls with no network marker mean FAIL-CLOSED MUST NOT KEY ON "INTERPRETER"
   (verdict 5a). An interpreter one-liner that shows no network API is not in scope at all and is
   never examined for a target. Only demonstrated network intent puts a command in scope.

3. 3,165 of the 6,885 "no literal URL" curls are heredocs that WRITE a curl line into a file. That
   is the same payload-vs-target confusion as the settings.deny failure, and my own first pass
   over this corpus fell into it too, overcounting by 12x. Hence verdict 5b: heredoc bodies are
   stripped as the FIRST classification step, before anything looks for a command, and per-segment
   dispatch is by COMMAND NAME so an `echo`/`cat` segment is never a network call no matter what
   text it carries.

SCOPE, STATED SO THIS DOCUMENT CANNOT OVERCLAIM (verdict point 4). Covered: the Bash tool's
`curl`/`wget`/`nc`/`ncat`/`netcat`/`telnet`/`socat`, inline interpreter one-liners
(`python3 -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, `deno`/`bun eval`) that name a network
API, and `/dev/tcp` + `/dev/udp`. NOT covered, deliberately and by name:

  * ssh, scp, rsync, git, npm/pnpm/yarn, pip, docker, apt -- all of them reach the network and
    none of them is gated here. They have their own controls or none at all.
  * an interpreter running a FILE (`python3 script.py`): the code is not in the command string, so
    there is nothing to analyse. This guard sees command lines, not programs.
  * anything outside the Bash tool (WebFetch and the MCP fetch tools are gated separately by
    scripts/hooks/egress-gate.mjs, which in turn does NOT cover Bash -- the two are disjoint).

FAIL-CLOSED IS A COST-RAISING MEASURE, NOT A PROVABLE GUARANTEE (verdict point 5). When a command
has demonstrated network intent but its target cannot be resolved -- the URL is in a variable, is
base64-decoded, is piped in, is read from a config file -- this guard refuses it rather than
guessing. That raises the cost of hiding an external target behind an indirection; it does not
make it impossible. A determined caller can still reach the network through any of the uncovered
channels listed above. Anyone reading a "blocked" line here should read it as "this shape now
costs an extra step", not as "egress is closed".

MODES (verdict point 3: kill switch AND a log-only grace period BEFORE enforcement).

  BASH_EGRESS_GUARD unset  -> "log": nothing is ever blocked; would-be blocks are appended to
                              store/bash-egress.log for review. THIS IS THE SHIPPING DEFAULT.
  BASH_EGRESS_GUARD=enforce-> blocks. Flip this on only after the log has been read and the
                              false-positive count on real fleet traffic is known.
  BASH_EGRESS_GUARD=off    -> kill switch: the guard returns immediately, touching nothing.
  BASH_EGRESS_ALLOW=1      -> per simple command, greppable one-off (same shape as the sibling
                              guards). Naming it elsewhere on the line does not cover THIS command.

THE ALLOWLIST IS A FILE, NOT CODE (verdict point 2): store/bash-egress-allowlist.json, versioned,
re-read on every invocation, so an operator grant needs no restart and no deploy. A missing or
malformed file falls back to the built-in localhost rules only -- it never widens what is allowed.

EXCEPTION BOUNDARY (verdict point 6). An analysis error on ONE segment makes that segment
unresolved, which is fail-closed for its own command in enforce mode -- and nothing else. The hook
itself never raises out of main(): a guard that throws would wedge the PreToolUse pipeline for
every tool call in the fleet, which is a strictly worse outcome than any single missed egress. The
one place that deliberately exits 0 is an unreadable hook ENVELOPE (bad JSON on stdin, no
tool_name): at that point we do not know we are looking at a Bash call at all, and refusing an
unknown tool call is not fail-closed, it is just broken.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

MODE_ENV = "BASH_EGRESS_GUARD"
ALLOW_ENV = "BASH_EGRESS_ALLOW"

REPO_ROOT = Path(__file__).resolve().parents[2]
# Read from the tree this script LIVES in, not the caller's cwd: the hook command registered in
# every agent's settings.json points at the main clone's copy, so the main clone's allowlist is the
# one that governs. A worktree copy of this file would read its own -- which is correct for anyone
# testing a change, and is why the selftest can point both at a fixture.
ALLOWLIST_PATH = REPO_ROOT / "store" / "bash-egress-allowlist.json"
LOG_PATH = REPO_ROOT / "store" / "bash-egress.log"

# A word whose value this guard cannot know: $VAR, ${...}, $(...), `...`, and anything an analysis
# error made unreadable. Its presence in a TARGET position is what fail-closed keys on.
#
# THE PLACEHOLDER MUST NOT CONTAIN A URL DELIMITER. It used to be "\x00?\x00", and the moment the
# authority split started honouring `?` (the RFC 3986 fix below), that `?` cut the placeholder in
# half: `curl "$(build-url)"` stopped being recognised as unresolvable and went from BLOCK to
# allow. The two existing substitution cases in the selftest caught it; a fix that closes one hole
# while opening another is the failure mode this guard's own history is made of.
UNRESOLVED = "\x00SUBST\x00"

# ---------------------------------------------------------------------------------------------
# Step 0: heredoc bodies. FIRST, before anything looks for a command (verdict 5b).
#
# `cat > setup.sh <<'EOF' ... curl https://example.com ... EOF` writes a file. It is not a network
# call, and 3,165 commands in the corpus have exactly this shape. Stripping the body here means no
# later stage can mistake the written text for an executed command -- the distinction is structural
# rather than a filter applied afterwards, which is the form the same mistake kept defeating.
_HEREDOC_RX = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1.*?^\s*\2\s*$", re.S | re.M)
# An UNTERMINATED heredoc (the body runs to the end of the string) still writes a file; without
# this the trailing text falls through to the scanner as if it were commands.
_HEREDOC_OPEN_RX = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1.*\Z", re.S)


def strip_heredoc_bodies(cmd):
    """Remove the whole heredoc -- operator, delimiter and body.

    The replacement is a SPACE, not a placeholder word. A placeholder left a bare token sitting in
    the operand list of `curl -d @- <<'EOF' ... EOF`, where it was read as a hostname: 4,725
    corpus invocations blocked on a target this function had invented. A heredoc is stdin data; it
    has no bearing on where the command connects, so the right amount of it to leave behind is
    none.
    """
    out = _HEREDOC_RX.sub(" ", cmd)
    return _HEREDOC_OPEN_RX.sub(" ", out)


# ---------------------------------------------------------------------------------------------
# Step 1: tokenize into simple commands, keeping quoted text (the target usually LIVES in quotes).
#
# This is where this guard parts company with cd-chain-guard.py, which blanks quoted literals
# wholesale: `curl -s 'http://localhost:3420/api/x'` would lose the very thing being judged. So
# quotes are REMOVED and their contents kept, while expansions inside them still mark the word
# unresolved.

class Word:
    __slots__ = ("text", "unresolved", "redirect", "quoted")

    def __init__(self, text, unresolved, redirect, quoted):
        self.text = text
        self.unresolved = unresolved
        self.redirect = redirect
        self.quoted = quoted

    def __repr__(self):  # pragma: no cover - debugging aid
        return f"Word({self.text!r}, unresolved={self.unresolved}, redirect={self.redirect})"


def _read_double_quoted(cmd, i, nested):
    """Contents of a double-quoted span starting at cmd[i] == '"'. Returns (text, end, unresolved)."""
    out = []
    unresolved = False
    n = len(cmd)
    i += 1
    while i < n:
        c = cmd[i]
        if c == "\\" and i + 1 < n:
            out.append(cmd[i + 1])
            i += 2
        elif c == '"':
            i += 1
            break
        elif c == "$" and i + 1 < n and cmd[i + 1] == "(":
            end = _close_paren(cmd, i + 2)
            nested.append(cmd[i + 2:max(i + 2, end - 1)])
            out.append(UNRESOLVED)
            unresolved = True
            i = end
        elif c == "`":
            j = cmd.find("`", i + 1)
            nested.append(cmd[i + 1:j] if j >= 0 else cmd[i + 1:])
            out.append(UNRESOLVED)
            unresolved = True
            i = n if j < 0 else j + 1
        elif c == "$":
            j, txt = _read_expansion(cmd, i)
            out.append(txt)
            unresolved = True
            i = j
        else:
            out.append(c)
            i += 1
    return "".join(out), i, unresolved


def _read_expansion(cmd, i):
    """A `$VAR` or `${...}` starting at cmd[i] == '$'. Returns (end, placeholder)."""
    n = len(cmd)
    j = i + 1
    if j < n and cmd[j] == "{":
        depth = 1
        j += 1
        while j < n and depth:
            if cmd[j] == "{":
                depth += 1
            elif cmd[j] == "}":
                depth -= 1
            j += 1
        return j, UNRESOLVED
    while j < n and (cmd[j].isalnum() or cmd[j] == "_"):
        j += 1
    if j == i + 1:  # a lone `$`, not an expansion
        return i + 1, "$"
    return j, UNRESOLVED


def _close_paren(cmd, k):
    """Index just past the `)` closing a `$(` whose body starts at k, or len(cmd).

    Quoted spans are stepped over rather than counted -- a `)` inside quotes is literal text to
    bash, and counting it would close the substitution early, truncating exactly the text we are
    trying to read.
    """
    depth, n = 1, len(cmd)
    while k < n:
        c = cmd[k]
        if c == "\\":
            k += 2
        elif c == "'":
            j = cmd.find("'", k + 1)
            k = n if j < 0 else j + 1
        elif c == '"':
            j = k + 1
            while j < n and cmd[j] != '"':
                j += 2 if cmd[j] == "\\" else 1
            k = n if j >= n else j + 1
        elif c == "(":
            depth += 1
            k += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return k + 1
            k += 1
        else:
            k += 1
    return n


_SEPARATORS = ";\n|&()"


def tokenize(cmd):
    """(segments, nested_command_strings).

    A segment is a list of Words making up one simple command. Command substitutions are NOT
    inlined: their text is handed back separately so the caller can scan it as its own command
    string -- `curl "$(build-url)"` is both an unresolved target AND, potentially, a command with
    its own network intent.
    """
    # A backslash-newline is a LINE CONTINUATION: bash removes it and joins the two halves into
    # one command. Treating the newline as a literal character (which is what the escape branch
    # below would otherwise do) glued a newline into the middle of a word and scrambled every
    # multi-line curl in the fleet's own idiom -- measured on the corpus, not reasoned about.
    cmd = cmd.replace("\\\n", "")
    segments = []
    nested = []
    seg = []
    buf = []
    has_word = False
    unresolved = False
    quoted = False
    next_is_redirect = False
    i, n = 0, len(cmd)

    def flush_word():
        nonlocal buf, has_word, unresolved, quoted, next_is_redirect
        if has_word:
            seg.append(Word("".join(buf), unresolved, next_is_redirect, quoted))
            next_is_redirect = False
        buf = []
        has_word = False
        unresolved = False
        quoted = False

    def flush_seg():
        nonlocal seg, next_is_redirect
        flush_word()
        if seg:
            segments.append(seg)
        seg = []
        next_is_redirect = False

    while i < n:
        c = cmd[i]
        if c == "\\" and i + 1 < n:
            buf.append(cmd[i + 1])
            has_word = True
            i += 2
            continue
        if c == "'":
            j = cmd.find("'", i + 1)
            buf.append(cmd[i + 1:j] if j >= 0 else cmd[i + 1:])
            has_word = True
            quoted = True
            i = n if j < 0 else j + 1
            continue
        if c == '"':
            text, i, unres = _read_double_quoted(cmd, i, nested)
            buf.append(text)
            has_word = True
            quoted = True
            unresolved = unresolved or unres
            continue
        if c == "$" and i + 1 < n and cmd[i + 1] == "(":
            end = _close_paren(cmd, i + 2)
            nested.append(cmd[i + 2:max(i + 2, end - 1)])
            buf.append(UNRESOLVED)
            has_word = True
            unresolved = True
            i = end
            continue
        if c == "`":
            j = cmd.find("`", i + 1)
            nested.append(cmd[i + 1:j] if j >= 0 else cmd[i + 1:])
            buf.append(UNRESOLVED)
            has_word = True
            unresolved = True
            i = n if j < 0 else j + 1
            continue
        if c == "$":
            j, txt = _read_expansion(cmd, i)
            buf.append(txt)
            has_word = True
            if txt is UNRESOLVED or txt == UNRESOLVED:
                unresolved = True
            i = j
            continue
        if c in "<>":
            # The redirect OPERATOR ends the current word; the word AFTER it is the redirect
            # target. Kept rather than dropped, because `exec 3<>/dev/tcp/host/port` puts a real
            # network target in exactly that position -- but flagged, so `curl http://x > out.html`
            # cannot read `out.html` as a second target.
            #
            # A bare FILE DESCRIPTOR in front of the operator (`2>/dev/null`, `1>&2`) belongs to
            # the redirect, not to the command. Measured cost of not knowing that: the digit `2`
            # was read as a bare hostname and became the single largest false positive in the
            # corpus, 21,015 invocations -- every `curl ... 2>/dev/null` in the fleet.
            if has_word and not quoted and "".join(buf).isdigit():
                buf = []
                has_word = False
            flush_word()
            next_is_redirect = True
            i += 1
            while i < n and cmd[i] in "<>&":
                i += 1
            continue
        if c in _SEPARATORS:
            flush_seg()
            i += 1
            continue
        if c.isspace():
            flush_word()
            i += 1
            continue
        buf.append(c)
        has_word = True
        i += 1

    flush_seg()
    return segments, nested


# ---------------------------------------------------------------------------------------------
# Step 2: what kind of command is this segment?

_ASSIGN_RX = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# Wrappers that carry the real command as their own arguments.
_WRAPPERS = {"sudo", "time", "command", "nohup", "nice", "ionice", "env", "stdbuf", "timeout"}
_DURATION_RX = re.compile(r"^\d+(?:\.\d+)?[smhd]?$")

DIRECT_NET = {"curl", "wget", "nc", "ncat", "netcat", "telnet", "socat"}
# socat is NOT in the measured corpus. It is here anyway because it is the same primitive as nc,
# and the failure this card exists to prevent is precisely a control that names three doors out of
# four while the documentation claims the room is sealed. Naming it costs nothing: the fleet does
# not use it, so it cannot produce a false positive on real traffic.

# Inline-script flags PER FAMILY. Sharing one set across families was wrong in both directions:
# `-r` is ruby's `require` but bash's `restricted`, `-p`/`-n` are perl loop wrappers but mean other
# things elsewhere. An interpreter invoked WITHOUT its inline flag is running a FILE, which is out
# of scope (see the module docstring): the code is not in the command string, so there is nothing
# to analyse.
SHELLS = {"bash", "sh", "zsh", "ksh", "dash"}
_INLINE_FLAGS_BY_FAMILY = {
    "bash": {"-c"}, "sh": {"-c"}, "zsh": {"-c"}, "ksh": {"-c"}, "dash": {"-c"},
    "python": {"-c"}, "python2": {"-c"}, "python3": {"-c"},
    "node": {"-e", "--eval", "-p", "--print"}, "nodejs": {"-e", "--eval", "-p", "--print"},
    "bun": {"-e", "--eval"}, "deno": {"eval"},
    "perl": {"-e", "-E"}, "ruby": {"-e"}, "php": {"-r"},
}
INTERPRETERS = set(_INLINE_FLAGS_BY_FAMILY)

# Network APIs, by language. A URL LITERAL IS DELIBERATELY NOT ON THIS LIST: a URL inside an
# interpreter one-liner is as likely to be a payload as a target, and treating it as intent would
# re-import the exact payload-vs-target confusion this guard exists to end.
_NET_MARKERS = (
    # python. `urllib.request`, NOT bare `urllib`: `urllib.parse`/`urlencode` are pure string
    # operations with no socket anywhere near them, and matching the package name flagged 225
    # corpus invocations that never touch the network -- fail-closed noise with nothing to be
    # closed against, which is exactly what verdict 5a forbids.
    "urllib.request", "requests", "http.client", "httplib", "httpx", "aiohttp", "urlopen",
    "socket.", "socket(", "create_connection", "ftplib", "smtplib", "telnetlib", "pycurl",
    # node
    "fetch(", "https.get", "https.request", "http.get", "http.request", "net.connect",
    "net.createconnection", "axios", "node-fetch", "undici", "xmlhttprequest", "websocket",
    "require('http", 'require("http', "require('net", 'require("net',
    "require('https", 'require("https',
    # perl
    "lwp", "http::tiny", "io::socket", "net::http", "net::ftp",
    # ruby
    "net::http", "open-uri", "uri.open", "tcpsocket", "tcpsocket.new",
    # php
    "file_get_contents", "curl_init", "fsockopen", "stream_socket_client",
)
_DEV_NET_RX = re.compile(r"/dev/(?:tcp|udp)/([^/\s]+)/(\S+)")


def _command_name(seg):
    """(name, index of the name word) after skipping assignments and wrappers, or (None, -1)."""
    i = 0
    while i < len(seg):
        w = seg[i]
        if w.redirect:
            i += 1
            continue
        t = w.text
        if _ASSIGN_RX.match(t):
            i += 1
            continue
        name = os.path.basename(t.strip())
        if name in _WRAPPERS:
            i += 1
            # `env`/`timeout`/`nice` may be followed by their own options AND by a bare numeric
            # operand -- `timeout 30 curl ...`, `nice -n 5 curl ...`. Skipping only the options
            # left the duration `30` standing where the command name should be, so the curl behind
            # it was never examined (caught by the selftest, not by reading the code).
            while i < len(seg) and (seg[i].text.startswith("-") or _DURATION_RX.match(seg[i].text)):
                i += 1
            continue
        return name, i
    return None, -1


def _has_allow_hatch(seg):
    return any(w.text == f"{ALLOW_ENV}=1" for w in seg)


# ---------------------------------------------------------------------------------------------
# Step 3: targets.
#
# The option tables below are the payload-vs-target boundary made explicit. Everything listed here
# carries DATA (a header, a body, a file, a credential), so its value can never be the target --
# which is what makes the 632,912-occurrence `-H @-` idiom safe to parse, and is precisely the
# distinction a whole-command-string pattern cannot draw.
_CURL_VALUE_FLAGS = {
    "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
    "--data-ascii", "-F", "--form", "--form-string", "-o", "--output", "-T", "--upload-file",
    "-X", "--request", "-A", "--user-agent", "-b", "--cookie", "-c", "--cookie-jar",
    "-e", "--referer", "-u", "--user", "-K", "--config", "--url-query", "-w", "--write-out",
    "--max-time", "-m", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time",
    "--cert", "--key", "--cacert", "--capath", "--proxy-user", "--oauth2-bearer",
    "--unix-socket", "--abstract-unix-socket", "--interface",
    "--output-dir", "--create-file-mode", "--expect100-timeout", "--limit-rate", "--range", "-r",
}
_CURL_TARGET_FLAGS = {"--url", "--proxy", "-x", "--socks5", "--socks5-hostname", "--socks4"}
# THE ONE AXIS ALL THREE GATE FINDINGS SHARE (Cybersec, comment 2959 + msg 1724; QA, same round):
# "the connection's actual destination differs from what the URL text says". Everything in this set
# moves the destination somewhere the URL cannot show, so the URL stops being evidence and the
# command is UNRESOLVED -- fail-closed, the same answer as a target hidden in a variable.
#
#   -K/--config       reads URLs from a file this guard cannot see
#   --resolve         pins host:port to an arbitrary IP: `--resolve api.github.com:443:203.0.113.99`
#                     keeps an allowlisted hostname in the URL while the TCP connection goes to
#                     203.0.113.99. It used to sit in the "carries data" table, which consumed it
#                     quietly -- worse than not knowing the flag, because it looked handled.
#   --connect-to      the same redirection in a different spelling
#   --dns-servers,    move name resolution itself, so the hostname no longer decides the peer.
#   --doh-url         NOT measured in the corpus (neither is --connect-to); they are here because
#                     they are the same axis, and a control that names two doors of four while the
#                     documentation claims the room is sealed is the failure this card exists for.
#
# `--proxy`/`-x`/`--socks*` belong to the same axis but get a STRONGER answer: they are treated as
# targets in their own right and judged against the allowlist, because a proxy IS the host the
# connection goes to and it is named right there on the line.
_CURL_OPAQUE_FLAGS = {"-K", "--config", "--resolve", "--connect-to", "--dns-servers", "--doh-url"}

_WGET_VALUE_FLAGS = {
    "-O", "--output-document", "-o", "--output-file", "-P", "--directory-prefix",
    "--header", "--post-data", "--post-file", "--body-data", "--body-file", "--user",
    "--password", "--user-agent", "-U", "--referer", "--load-cookies", "--save-cookies",
    "-T", "--timeout", "-t", "--tries", "--limit-rate", "--ca-certificate", "--certificate",
    "--private-key",
}
_WGET_TARGET_FLAGS = {"--input-file", "-i"}
# Same axis as _CURL_OPAQUE_FLAGS. `--input-file` supplies URLs the guard cannot see; `-e/--execute`
# injects a wgetrc directive, and `-e http_proxy=http://evil:8080` sends the whole transfer through
# a host the URL never mentions. QA flagged this one as untried rather than broken; it is the same
# defect as --resolve in wget's spelling, so it is closed in the same round instead of waiting for
# someone to prove it separately.
_WGET_OPAQUE_FLAGS = {"--input-file", "-i", "-e", "--execute"}

_URL_RX = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*://")
# RFC 3986: the authority ends at the FIRST of `/`, `?` or `#`. Splitting on `/` alone was a
# blocking Cybersec finding (card 854182c7, comment 2959) and it inverted the verdict, not merely
# widened it: in `http://evil.example.org#@api.github.com/` the authority is `evil.example.org`
# and everything after `#` is a fragment curl never even sends -- but the `/`-only split handed
# `evil.example.org#@api.github.com` to the userinfo rsplit, which read the FRAGMENT as the host
# and called it allowlisted. The `#@localhost/` spelling was worse: classified LOCAL, so in
# log-only mode it left no trace at all. Reproduced on all six spellings before fixing.
_AUTHORITY_END_RX = re.compile(r"[/?#]")
# A bare operand curl would treat as a host: `curl localhost:3420/api/x`, `curl example.com`.
# Applied to the AUTHORITY, not to the whole word, for the same reason: anchoring the tail to
# `(?:/|$)` meant `evil.example.org?@localhost` matched nothing and was skipped as "not a target
# shape" -- a second way through the same gap, and a silent one.
_BARE_HOST_RX = re.compile(r"^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9_.\-]+)(?::\d+)?$")

LOCAL = "local"
EXTERNAL = "external"
UNKNOWN = "unknown"


def _target_host(target):
    """(host, resolvable) for a candidate target word.

    RESOLVABILITY IS A PROPERTY OF THE HOST, NOT OF THE WHOLE WORD. This was the single largest
    false positive in the corpus run: 62,445 invocations of the fleet's own idiom

        curl -H @- -s "http://localhost:3420/api/kanban/$id/comments"

    where the target host is a LITERAL localhost and only the PATH carries a variable. Marking the
    whole word unresolved refused every one of them -- on the channel the refusal would have to be
    reported over. The host is what this guard judges, so the host is what has to be known.

    Returns (None, True) for a word that is not a target shape at all, so a stray operand is
    skipped rather than guessed at.
    """
    t = target.strip()
    if not t:
        return None, True
    if _URL_RX.match(t):
        rest = t.split("://", 1)[1]
    else:
        authority = _AUTHORITY_END_RX.split(t, maxsplit=1)[0]
        if not (UNRESOLVED in authority or _BARE_HOST_RX.match(authority)):
            return None, True  # not a target shape
        rest = t
    hostpart = _AUTHORITY_END_RX.split(rest, maxsplit=1)[0]
    if "@" in hostpart:  # user:pass@host -- and ONLY within the authority, never across a ?/#
        hostpart = hostpart.rsplit("@", 1)[1]
    if UNRESOLVED in hostpart:
        return None, False
    if hostpart.startswith("["):
        end = hostpart.find("]")
        return (hostpart[1:end].lower() if end > 0 else None), True
    h = hostpart.split(":", 1)[0]
    return (h.lower() or None), True


def _host_of(target):
    """Hostname only, for callers that have already established the word is resolvable."""
    return _target_host(target)[0]


_LOCAL_NAMES = {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", ""}
_IPV4_RX = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")


def is_local_host(host):
    if host is None:
        return False
    h = host.lower().rstrip(".")
    if h in _LOCAL_NAMES:
        return True
    if h in ("::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"):
        return True
    m = _IPV4_RX.match(h)
    if m:
        octets = [int(x) for x in m.groups()]
        if any(o > 255 for o in octets):
            return False
        # 127.0.0.0/8 is loopback. 0.0.0.0 as a CONNECT target resolves to loopback on Linux, and
        # it is what a bound-everywhere service is often probed as, so it counts as local here.
        return octets[0] == 127 or octets == [0, 0, 0, 0]
    return False


def classify_host(host, allowed):
    if host is None:
        return UNKNOWN
    if is_local_host(host):
        return LOCAL
    h = host.rstrip(".").lower()
    for entry in allowed:
        e = entry.strip().lower().lstrip("*").lstrip(".")
        if not e:
            continue
        if h == e or h.endswith("." + e):
            return EXTERNAL
    return None  # a real, resolved, NOT-allowed external host


def load_allowlist(path=None):
    """Hostnames an operator has granted. A missing or malformed file yields an EMPTY list.

    Fail-open on the FILE, fail-safe on the DECISION: losing the file never widens what is allowed,
    it only removes grants, so the worst case is a noisy log (or, under enforce, a refusal) rather
    than silent permission.
    """
    p = Path(path) if path else ALLOWLIST_PATH
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []
    hosts = data.get("hosts") if isinstance(data, dict) else None
    if not isinstance(hosts, list):
        return []
    return [h for h in hosts if isinstance(h, str) and h.strip()]


def _operands_after(words, start, value_flags, target_flags, opaque_flags):
    """(targets, opaque) for a curl/wget-style argument list."""
    targets = []
    opaque = False
    i = start
    n = len(words)
    while i < n:
        w = words[i]
        if w.redirect:
            i += 1
            continue
        t = w.text
        if t.startswith("-") and t != "-":
            base = t.split("=", 1)[0]
            if base in opaque_flags:
                opaque = True
                i += 2 if "=" not in t else 1
                continue
            if base in target_flags:
                if "=" in t:
                    targets.append(Word(t.split("=", 1)[1], w.unresolved, False, w.quoted))
                elif i + 1 < n:
                    targets.append(words[i + 1])
                    i += 1
                i += 1
                continue
            if base in value_flags:
                if "=" not in t:
                    i += 1  # its value is DATA, never a target
                i += 1
                continue
            # A short-option cluster (`-sS`, `-fsSL`) carries no value here.
            i += 1
            continue
        if t == "-":
            i += 1  # stdout/stdin placeholder, not a host
            continue
        targets.append(w)
        i += 1
    return targets, opaque


def _interpreter_script(words, start, name):
    """The inline script text of an interpreter one-liner, or None when it runs a file."""
    flags = _INLINE_FLAGS_BY_FAMILY.get(name, set())
    i = start + 1
    n = len(words)
    while i < n:
        w = words[i]
        if w.redirect:
            i += 1
            continue
        t = w.text
        if t in flags:
            # An inline flag with nothing after it is a malformed command whose script we cannot
            # see; unresolved is the fail-closed direction and costs nothing (it does not run).
            return words[i + 1] if i + 1 < n else Word("", True, False, False)
        if t.startswith("-"):
            i += 1
            continue
        return None  # first non-flag operand is a FILE -> out of scope
    return None


def _script_targets(script_text):
    """Hosts named inside an interpreter one-liner that already showed network intent."""
    out = []
    for m in re.finditer(r"""[A-Za-z][A-Za-z0-9+.\-]*://[^\s'"`)\],]+""", script_text):
        out.append(m.group(0))
    for m in _DEV_NET_RX.finditer(script_text):
        out.append(m.group(1))
    # Host arguments that are not URLs: connect(("host", 80)), TCPSocket.new('host', 80), and the
    # name-resolution helpers. The resolvers are here rather than excluded because a DNS lookup IS
    # a network operation and a known exfiltration channel -- but with the host extracted it gets
    # JUDGED (an allowlisted name passes) instead of producing a fail-closed refusal with no
    # target, which is what 225 corpus invocations of a plain hostname lookup got.
    for m in re.finditer(
            r"""(?:connect\w*|gethostbyname|gethostbyaddr|getaddrinfo|getfqdn)\s*\(\s*\(?\s*"""
            r"""['"]([^'"]+)['"]""", script_text):
        out.append(m.group(1))
    for m in re.finditer(r"""TCPSocket\.new\(\s*['"]([^'"]+)['"]""", script_text):
        out.append(m.group(1))
    return out


def _has_net_marker(text):
    low = text.lower()
    return any(marker in low for marker in _NET_MARKERS)


class Finding:
    __slots__ = ("kind", "command", "targets", "reason")

    def __init__(self, kind, command, targets, reason):
        self.kind = kind          # EXTERNAL (denied) or UNKNOWN
        self.command = command
        self.targets = targets
        self.reason = reason


def _judge_targets(name, target_words, opaque, allowed, findings):
    if opaque:
        findings.append(Finding(UNKNOWN, name, [],
                                "a cel egy kulso fajlbol/konfigbol jon, ezt a hook nem latja"))
        return
    if not target_words:
        # `curl --help`, `wget --version`, `nc -h`: network-capable command, no target, no call.
        return
    for w in target_words:
        text = w.text
        host, resolvable = _target_host(text)
        if not resolvable:
            findings.append(Finding(UNKNOWN, name, [text.replace(UNRESOLVED, "$?")],
                                    "a cel HOSTJA valtozoban/behelyettesitesben van"))
            continue
        if host is None:
            continue  # not a target shape at all (a stray operand)
        verdict = classify_host(host, allowed)
        if verdict in (LOCAL, EXTERNAL):
            continue
        if verdict == UNKNOWN:
            findings.append(Finding(UNKNOWN, name, [text], "a celbol nem fejtheto ki hostnev"))
        else:
            findings.append(Finding(EXTERNAL, name, [text],
                                    f"kulso cel, nincs az allowlistan: {host}"))
    return


def _judge_hostport_command(name, words, start, allowed, findings):
    """nc / ncat / netcat / telnet / socat: the host sits among the operands."""
    targets = []
    i = start + 1
    n = len(words)
    while i < n:
        w = words[i]
        if w.redirect or (w.text.startswith("-") and not w.unresolved):
            i += 1
            continue
        targets.append(w)
        i += 1
    if not targets:
        return
    for w in targets:
        if UNRESOLVED in w.text.split("/", 1)[0]:
            findings.append(Finding(UNKNOWN, name, [w.text.replace(UNRESOLVED, "$?")],
                                    "a cel HOSTJA valtozoban/behelyettesitesben van"))
            return
        text = w.text
        if text.isdigit():
            continue  # the port operand
        if name == "socat" and ":" in text:
            text = text.split(":", 1)[1] if text.split(":", 1)[0].upper() in (
                "TCP", "TCP4", "TCP6", "UDP", "UDP4", "UDP6", "OPENSSL", "SOCKS4") else text
        host = _host_of(text)
        verdict = classify_host(host, allowed)
        if verdict in (LOCAL, EXTERNAL):
            return
        if verdict == UNKNOWN:
            findings.append(Finding(UNKNOWN, name, [w.text], "a celbol nem fejtheto ki hostnev"))
        else:
            findings.append(Finding(EXTERNAL, name, [w.text],
                                    f"kulso cel, nincs az allowlistan: {host}"))
        return


def analyse_segment(seg, allowed, findings, depth=0):
    """Judge ONE simple command. Any error here is caught by the caller and becomes fail-closed
    FOR THIS SEGMENT ONLY -- never an exception out of the hook (verdict point 6)."""
    if _has_allow_hatch(seg):
        return
    name, idx = _command_name(seg)
    if name is None:
        return

    # /dev/tcp and /dev/udp: the target is in a redirect, not an operand, and the "command" may be
    # anything (`exec`, `cat`, a bare `>`). Checked on every segment for that reason.
    for w in seg:
        m = _DEV_NET_RX.search(w.text)
        if m:
            host = m.group(1)
            if UNRESOLVED in host:
                findings.append(Finding(UNKNOWN, "/dev/tcp", [host.replace(UNRESOLVED, "$?")],
                                        "a /dev/tcp cel valtozoban van"))
            else:
                verdict = classify_host(_host_of(host), allowed)
                if verdict not in (LOCAL, EXTERNAL):
                    findings.append(Finding(
                        UNKNOWN if verdict == UNKNOWN else EXTERNAL, "/dev/tcp", [host],
                        "kulso /dev/tcp cel" if verdict != UNKNOWN else "feloldhatatlan /dev/tcp cel"))
        elif w.redirect and UNRESOLVED in w.text and "/dev/" in w.text:
            findings.append(Finding(UNKNOWN, "/dev/tcp", ["$?"],
                                    "a /dev/tcp cel valtozoban van"))

    if name == "curl":
        targets, opaque = _operands_after(
            seg, idx + 1, _CURL_VALUE_FLAGS, _CURL_TARGET_FLAGS, _CURL_OPAQUE_FLAGS)
        _judge_targets(name, targets, opaque, allowed, findings)
        return
    if name == "wget":
        targets, opaque = _operands_after(
            seg, idx + 1, _WGET_VALUE_FLAGS, _WGET_TARGET_FLAGS, _WGET_OPAQUE_FLAGS)
        _judge_targets(name, targets, opaque, allowed, findings)
        return
    if name in DIRECT_NET:
        _judge_hostport_command(name, seg, idx, allowed, findings)
        return
    if name in INTERPRETERS:
        script = _interpreter_script(seg, idx, name)
        if script is None:
            return  # running a FILE: out of scope, stated in the docstring
        if name in SHELLS:
            # `bash -c "curl https://x"` is a COMMAND STRING, not a program in a language whose
            # network API we could look for -- marker-matching it would find nothing and wave the
            # curl straight through. It gets re-analysed as what it is.
            #
            # A body that carries an expansion is re-analysed ANYWAY, placeholder and all, rather
            # than refused wholesale: `nohup bash -c "cd /x && bash suite.sh $FILES"` is 1,530
            # corpus invocations with no network command in it at all, and refusing it would be
            # fail-closed with no network intent to justify it (verdict 5a).
            findings.extend(analyse(script.text, allowed, depth=depth + 1))
            return
        # VERDICT 5a, THE SINGLE MOST LOAD-BEARING BRANCH IN THIS FILE. 551,816 interpreter calls
        # in the corpus show no network API at all. If fail-closed keyed on "interpreter" rather
        # than on demonstrated network intent, this line is where half a million legitimate
        # commands would die. No marker -> not in scope -> not examined for a target.
        if not (_has_net_marker(script.text) or _DEV_NET_RX.search(script.text)):
            return
        found = _script_targets(script.text)
        if not found:
            findings.append(Finding(UNKNOWN, name, [],
                                    "halozati hivas az egysorosban, de a cel nem literal"))
            return
        for t in found:
            host = _host_of(t)
            verdict = classify_host(host, allowed)
            if verdict in (LOCAL, EXTERNAL):
                continue
            if verdict == UNKNOWN:
                findings.append(Finding(UNKNOWN, name, [t], "a celbol nem fejtheto ki hostnev"))
            else:
                findings.append(Finding(EXTERNAL, name, [t],
                                        f"kulso cel, nincs az allowlistan: {host}"))
        return


def analyse(raw, allowed, depth=0):
    """All findings for a whole Bash command string."""
    findings = []
    if depth > 3:  # a substitution chain this deep is pathological; stop rather than recurse away
        return findings
    try:
        segments, nested = tokenize(strip_heredoc_bodies(raw))
    except Exception:
        # The EXCEPTION BOUNDARY of verdict point 6: an unparseable command is fail-closed for
        # ITSELF, and the hook returns normally so the pipeline is untouched.
        return [Finding(UNKNOWN, "<parse>", [], "a parancs nem elemezheto")]
    for seg in segments:
        try:
            analyse_segment(seg, allowed, findings, depth)
        except Exception as exc:  # noqa: BLE001 - deliberate: one segment's failure, not the hook's
            findings.append(Finding(UNKNOWN, "<segment>", [],
                                    f"elemzesi hiba, fail-closed erre a parancsra: {type(exc).__name__}"))
    for sub in nested:
        findings.extend(analyse(sub, allowed, depth + 1))
    return findings


# ---------------------------------------------------------------------------------------------
# Logging. The log is the whole point of the grace period: it is what tells an operator whether
# enforce is safe to switch on.
_REDACT_RX = re.compile(
    r"(-u\s+|--user[= ]|--password[= ]|--oauth2-bearer[= ]|[Aa]uthorization:\s*\S+\s+)(\S+)")


def _redact(cmd):
    return _REDACT_RX.sub(lambda m: m.group(1) + "<redacted>", cmd)


def log_finding(mode, findings, cmd, path=None):
    p = Path(path) if path else LOG_PATH
    line = json.dumps({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "mode": mode,
        "agent": os.environ.get("MARVEEN_AGENT_ID") or os.environ.get("CLAUDE_AGENT_ID") or "",
        "findings": [{"kind": f.kind, "cmd": f.command, "targets": f.targets, "why": f.reason}
                     for f in findings],
        "command": _redact(cmd)[:4000],
    }, ensure_ascii=False)
    try:
        # 0600 because the line can still carry an internal URL or a path. The file is created by
        # THIS process, so its mode is ours to set -- unlike a shell redirect, where the calling
        # shell creates the file first and our umask never applies.
        fd = os.open(str(p), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass  # a guard that cannot write its log must still let the fleet work


def _message(mode, findings):
    lines = [
        "BASH-EGRESS-GUARD: ez a parancs halozati hivast tartalmaz, aminek a celja nem localhost "
        "es nincs az allowlistan (vagy egyaltalan nem feloldhato).",
        "",
    ]
    for f in findings[:5]:
        tgt = ", ".join(f.targets) if f.targets else "(nincs literal cel)"
        lines.append(f"  {f.command}: {tgt}  --  {f.reason}")
    lines += [
        "",
        "Ha a cel legitim kulso szolgaltatas, vedd fel az allowlistra (verziokovetett fajl, "
        f"ujrainditas nem kell): {ALLOWLIST_PATH}",
        f"Egyszeri korre: {ALLOW_ENV}=1 <parancs>. A guard kikapcsolasa: {MODE_ENV}=off.",
        "",
        "FONTOS: ez koltseg-noveles, nem garancia. ssh/git/npm/docker es a fajlbol futtatott "
        "interpreter-szkriptek NEM esnek a hatokorbe -- reszletek a scripts/hooks/"
        "bash-egress-guard.py fejleceben es a docs/bash-egress-guard.md-ben.",
    ]
    return "\n".join(lines)


def main():
    mode = (os.environ.get(MODE_ENV) or "").strip().lower()
    if mode == "off":
        sys.exit(0)
    if mode not in ("enforce", "log"):
        mode = "log"  # the shipping default: observe first, block later

    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unreadable ENVELOPE: we do not know this is even a Bash call
    if not isinstance(payload, dict) or (payload.get("tool_name") or "") != "Bash":
        sys.exit(0)
    ti = payload.get("tool_input") or {}
    raw = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        sys.exit(0)

    try:
        findings = analyse(raw, load_allowlist())
    except Exception as exc:  # noqa: BLE001 - the hook itself must never raise (verdict point 6)
        findings = [Finding(UNKNOWN, "<guard>", [],
                            f"a guard hibara futott, fail-closed erre a parancsra: {type(exc).__name__}")]

    if not findings:
        sys.exit(0)

    log_finding(mode, findings, raw)
    if mode != "enforce":
        sys.exit(0)
    sys.stderr.write(_message(mode, findings) + "\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
