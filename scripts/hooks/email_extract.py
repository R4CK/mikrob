#!/usr/bin/env python3
"""Shared email-payload extraction (EMAILKAPU901 PR1).

Single source of truth for recovering the OUTGOING LETTER (recipients, subject,
body) from a send invocation, used by BOTH gates:
  - scripts/hooks/outgoing-copy-gate.py (copy audit: accents, names, em dash)
  - the level-2 email approval gate (PR2): content-hash anchor over
    to + cc + subject + body -- the approval record pins the EXACT letter, and
    a send is allowed only on an exact match.

The extraction boundary (Marveen, msg 17900) is deterministic-or-deny:
  - readable literal (--body "...", heredoc, MCP fields) -> text
  - anything shell-expanded at run time ($(cat), `...`, $VAR, unresolvable
    path, pipe) -> unreadable_reason, and the CALLER must fail closed.
  - a file-body form (< /abs/path, or any GATEBINVAK916 @file/-F/--post-file/-T
    shape) -> ALSO unreadable_reason (TOCTOU924, card 14256aac): this gate
    anchors an approval on what it reads, and the actual send reads the same
    path again later, so a file swapped in between would be approved under a
    different letter's anchor. Fail-closed, not merely unresolved.
The SAME boundary applies to recipients (msg 17936): a --to that comes from a
variable is not "approximately right", it is unreadable -> deny. A body+subject
hash alone would let an approved letter be re-sent to a DIFFERENT recipient.

collect_bash_body / collect_mcp_body moved here VERBATIM from
outgoing-copy-gate.py (behavior-neutral; parity proven byte-for-byte against a
golden captured from the pre-move code -- scripts/__tests__/email-extract-parity.test.py).
"""
import hashlib
import os
import re


# WhiteHat2 NO-GO F2 (card e4eb72c9, komment 16134): the Bash extraction branch
# never populates `attachments` at all (collect_mcp_attachments is only called
# on the MCP/connector branch), so a Bash sender that DOES carry a file
# attachment -- swaks's `--attach <file>` / `--attach @<file>` -- goes out with
# an anchor that is identical with and without the attachment, and identical
# across two DIFFERENT attached files (measured: 9ac71cacbd for all three).
# Hashing the referenced file here would face the same TOCTOU exposure as the
# `<`/@file body forms above (the attach happens in a LATER process, after
# this hook reads), so this takes the same fail-closed route as those: a
# swaks/relative --attach flag makes the call unreadable rather than silently
# anchoring a letter with no attachment information in it.
_BASH_ATTACH_RE = re.compile(r"(?:^|\s)--attach(?:-body)?(?:=|\s+)['\"]?@?([^\s'\"|;&<>]+)")


def collect_bash_body(cmd: str):
    """Return (text, unreadable_reason). text is '' when nothing was recovered."""
    attach_m = _BASH_ATTACH_RE.search(cmd)
    if attach_m:
        return ("", f"a parancs mellekletet csatol (--attach {attach_m.group(1)}) -- a Bash-agon "
                "ez nem hashelheto (a csatolas egy kesobbi folyamatban tortenik, ugyanaz a "
                "TOCTOU-kitettseg, mint a fajl-torzsnel) -- hasznalj MCP send_email-t "
                "melleklettel, vagy tavolitsd el a mellekletet")
    parts = []
    for m in re.finditer(r"--(?:body|subject)[= ]+(\"([^\"]*)\"|'([^']*)'|(\S+))", cmd):
        val = m.group(2) or m.group(3) or m.group(4) or ""
        # A shell-expanded --body ($(cat f), `cat f`, $VAR) reaches this hook
        # UNEXPANDED: what we would audit is the literal command text, not the
        # letter. That is worse than useless -- it fires on words that happen to
        # sit in the PATH while the real copy goes uninspected. Measured
        # 2026-08-11 on a live customer letter: `--body "$(cat .../hidli_zaro_
        # level.txt)"` blocked on "level" from the FILENAME, and the letter
        # itself was never read. Same fail-closed rule as the `<` branch below.
        if re.search(r"\$\(|`|\$\{?\w", val):
            return ("\n".join(parts),
                    "a --body shell-behelyettesitest tartalmaz, amit a hook nem old fel "
                    f"({val[:60]}...) -- igy a parancs szoveget vizsgalnam, nem a levelet")
        parts.append(val)
    # heredoc payloads sit inline in the command string
    for m in re.finditer(r"<<-?\s*'?(\w+)'?\n(.*?)\n\1", cmd, re.S):
        parts.append(m.group(2))
    # A single `<` only. Without the lookarounds a heredoc (`<<'EOF'`) matches
    # here and the quoted delimiter is taken for a filename -- caught by the
    # first live probe of this gate, which blocked with "'EOF': No such file".
    # `(?<![<=])`: a `=<` is curl's `-F "name=<file"` (read by the file-body
    # forms below), not a shell redirect; the quoted form would otherwise be
    # taken as a redirect to a path ending in the closing quote.
    # TOCTOU924 (card 14256aac, Cybersec NO-GO F2 on e8b479d0, MikroB decision): this gate
    # ANCHORS an approval on the content it reads here, but the actual send (curl/sendmail,
    # a separate process) reads the same path again, LATER. Measured live: an attacker who
    # can swap the file between this hook's read and the send's own read gets an approved
    # anchor for letter A while letter B is what actually goes out (19/60 runs in the live
    # measurement). A `<` redirect is a file read by definition, so it carries the same
    # TOCTOU exposure as the GATEBINVAK916 @file forms below -- unreadable, never anchored,
    # matching the pre-GATEBINVAK916 parent's fail-closed behaviour for this gate. The copy
    # gate (outgoing-copy-gate.py) keeps reading this shape: it only AUDITS text at call
    # time, it never binds an approval to it, so it carries no TOCTOU risk.
    redirect = re.search(r"(?<![<=])<(?!<)\s*([^\s|;&<>]+)", cmd)
    if redirect:
        return ("\n".join(parts),
                f"a torzs egy fajlbol jon (< {redirect.group(1)}) -- fajl-torzset ez a kapu "
                "nem horgonyoz (a kapu es a tenyleges kuldes kozott a fajl kicserelhetne a "
                "jovahagyott tartalmat), hasznalj inline --body-t")
    # GATEBINVAK916: curl's `@file` payload (-d/--data/--data-binary/--json/
    # --data-urlencode @path) and the sibling file-body shapes below. TOCTOU924
    # (see the `<` redirect comment above): this gate ANCHORS an approval on
    # what it reads, and a file read between the hook and the actual send can
    # carry different content than what was approved -- so these forms are
    # unreadable here too, same as the `<` redirect, never read or anchored.
    # --data-raw is deliberately NOT in _FILE_BODY_FORMS: it sends a literal
    # "@path", it reads no file, so it carries no TOCTOU exposure and stays an
    # ordinary inline literal.
    for label, rx in _FILE_BODY_FORMS:
        for m in rx.finditer(cmd):
            ref = m.group(1)
            if ref in ("-", "."):
                # stdin: a heredoc is already in `parts`; a pipe is not readable.
                if not parts:
                    return ("", f"a torzs stdin-rol jon ({label} {ref}), heredoc nelkul -- a hook nem latja")
                continue
            return ("\n".join(parts),
                    f"a torzs egy fajlbol jon ({label} {ref}) -- fajl-torzset ez a kapu nem "
                    "horgonyoz (a kapu es a tenyleges kuldes kozott a fajl kicserelhetne a "
                    "jovahagyott tartalmat), hasznalj inline --body-t")
    if not parts and re.search(r"\|\s*(python3?|node|tsx)?[^|]*send", cmd):
        return ("", "a torzs egy pipe-bol jon, a hook nem latja")
    return ("\n".join(parts), None)


# GATEBINVAK916: the file-body shapes. Each flag must stand alone (leading
# space or start), so an address like x@y.hu or an @ inside a quoted payload is
# never taken for a file. Measured list (Marveen's #1507 review, against the
# gate's own _CURL_BODY_OPTS): the six @-flags, plus the five shapes that also
# send a FILE but were not read: --data-urlencode name@file, -F/--form
# name=@file or name=<file, wget --post-file / --body-file, curl -T.
# NOT here, deliberately: --data-raw (sends a literal "@path", reads nothing)
# and --form-string (literal). The inline literal flags (-d '...',
# --post-data '...') stay outside this branch as before.
_REF = r"['\"]?([^\s'\"|;&<>]+)"
_FILE_BODY_FORMS = (
    ("@", re.compile(
        r"(?:^|\s)(?:-d|--data|--data-binary|--data-ascii|--json|--data-urlencode)"
        r"(?:=|\s+|(?<=-d))['\"]?@([^\s'\"|;&<>]+)")),
    ("--data-urlencode name@", re.compile(
        r"(?:^|\s)--data-urlencode(?:=|\s+)['\"]?[A-Za-z0-9_.-]+@([^\s'\"|;&<>]+)")),
    ("-F/--form name=@|<", re.compile(
        r"(?:^|\s)(?:-F|--form)(?:=|\s+)['\"]?[^\s'\"=]+=[@<]([^\s'\";|&<>]+)")),
    ("wget --post-file/--body-file", re.compile(
        r"(?:^|\s)--(?:post|body)-file(?:=|\s+)" + _REF)),
    ("curl -T/--upload-file", re.compile(
        r"(?:^|\s)(?:-T|--upload-file)(?:=|\s+)" + _REF)),
)


def collect_mcp_body(tool_input: dict):
    fields = ("body", "text", "html", "htmlBody", "message", "subject", "content", "forwardText")
    got = [str(tool_input[f]) for f in fields if tool_input.get(f)]
    return "\n".join(got)

# --- recipients (new in PR1; consumed by the PR2 approval gate) --------------
# Same unreadable boundary as the body branches above: shell substitution in a
# recipient value means the hook would hash the COMMAND TEXT while the real
# recipient is decided at run time -- deny, never approximate.
_SHELL_SUBST = re.compile(r"\$\(|`|\$\{?\w")


def collect_bash_recipients(cmd: str):
    """Return (to, cc, bcc, unreadable_reason); recipient lists hold literal
    values. bcc is part of the envelope since EMAILBCCHORGONY903: an anchor
    that ignores it lets an approved letter be re-sent WITH an added --bcc,
    delivering to a recipient nobody approved."""
    to, cc, bcc = [], [], []
    buckets = {"to": to, "cc": cc, "bcc": bcc}
    for m in re.finditer(r"--(to|cc|bcc)[= ]+(\"([^\"]*)\"|'([^']*)'|(\S+))", cmd):
        val = m.group(3) or m.group(4) or m.group(5) or ""
        if _SHELL_SUBST.search(val):
            return (to, cc, bcc,
                    f"a --{m.group(1)} shell-behelyettesitest tartalmaz, amit a hook "
                    f"nem old fel ({val[:60]}...) -- a cimzett futasidoben dol el")
        buckets[m.group(1)].append(val)
    return (to, cc, bcc, None)


def collect_mcp_recipients(tool_input: dict):
    """Return (to, cc, bcc, unreadable_reason). Values are kept RAW (no
    splitting, no lowercasing): the hash anchor needs exact bytes, not address
    semantics. bcc: see collect_bash_recipients (EMAILBCCHORGONY903)."""
    def norm(v):
        if v is None or v == "":
            return []
        if isinstance(v, (list, tuple)):
            return [str(x) for x in v]
        return [str(v)]
    return (norm(tool_input.get("to")), norm(tool_input.get("cc")),
            norm(tool_input.get("bcc")), None)


# --- attachments (card e4eb72c9) ---------------------------------------------
# The gmail MCP send tool's `attachments[].content` field accepts EITHER a
# base64 string OR an ABSOLUTE local file path in the SAME key (measured
# against gmail-mcp-server@1.0.30 dist/index.js:198: "Base64 encoded content
# ... OR ABSOLUTE file path to read from disk"). Before this, the approval
# anchor (content_anchor in email-approval-gate.py) covered to/cc/bcc/text
# only -- an approved letter could be re-sent with ANY local file attached
# and the hash would not change. Both shapes get hashed so the anchor pins
# WHAT was actually attached, not just the envelope text.
#
# WhiteHat2 NO-GO F1 (card e4eb72c9, komment 16134): this hook's own idea of
# "file" (_ABS_PATH_RE, absolute path only) and the MCP server's idea of
# "file" (gmail-mcp-server@1.0.30 dist/utils/gmail-operations.js:425-444
# isFilePath) disagree -- the server treats a RELATIVE path (`./x`, `../x`,
# a bare filename with an extension like `report.pdf` or `.env`, or any
# string containing `/`/`\` that is not base64-shaped) as a file too, and
# reads it relative to its own cwd at send time. This hook used to hash
# every such string as INLINE TEXT (the plain sha256 of the literal
# characters), so an approval anchored on that string never matched the
# bytes the server actually attached -- the content-pin the card exists to
# add was bypassed by the simplest possible relative path. Fix: an
# allow-list, not a copy of the server's regex (which drifts across
# versions) -- only an ABSOLUTE path (read + hash the real bytes) or a
# STRICT base64 string (hash the literal string, as today) are accepted;
# everything else is unreadable_reason, fail-closed (a new approval is
# required rather than silently anchoring the wrong thing).
# WhiteHat2 NO-GO F1' (card e4eb72c9, komment 16365/16368, delta on the allow-list above):
# Python's `re.match`/`$` anchors at the end of the string OR right before a TRAILING newline --
# "abc/def\n" matches _STRICT_B64_RE (the JS side has no such exception: a trailing "\n" makes
# isFilePath's own `/^[A-Za-z0-9+\/]+=*$/` fail, so the MCP server reads the string as a relative
# FILE instead, same bypass class as the one this allow-list exists to close). `fullmatch` has no
# such exception -- `$` inside it still means "end of string", but `fullmatch` additionally
# requires the WHOLE string to be consumed, so a trailing "\n" (or anything else after the base64
# body) fails. Measured: a full 1-5 char / 15-symbol-alphabet search for hook=inline vs MCP=file
# pairs found 40 matches, all of the "<alnum with at least one `/`> + trailing \n" shape; 0 after
# this fix.
_ABS_PATH_RE = re.compile(r"^(?:/|[A-Za-z]:[\\/])")
_STRICT_B64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


def collect_mcp_attachments(tool_input: dict):
    """Return (attachments, unreadable_reason). attachments: list of
    {"filename", "sha256"} (plus "path" when the content was a file
    reference), sorted for a deterministic hash order. A missing/empty list
    is not an error (most letters have none)."""
    raw = tool_input.get("attachments")
    if not raw:
        return [], None
    if not isinstance(raw, list):
        return [], "a melleklet-lista alakja nem lista"
    out = []
    for item in raw:
        if not isinstance(item, dict):
            return [], "egy melleklet-bejegyzes alakja nem objektum"
        filename = str(item.get("filename") or "")
        content = item.get("content")
        if not isinstance(content, str) or not content:
            return [], f"a '{filename}' melleklet tartalma hianyzik vagy nem szoveg"
        if _ABS_PATH_RE.match(content):
            # F3 (WhiteHat2, card e4eb72c9 komment 16368 -> a2cb71f1 elesitesi feltetel, TOCTOU):
            # a hook EZEN a ponton olvasta/hashelte a fajlt, de az MCP-szerver a TENYLEGES kuldeskor
            # UJRA olvassa UGYANAZT az utvonalat -- a ket olvasas kozott a fajl (vagy egy szimlink)
            # kicserelheto, a jovahagyott horgony a REGI tartalomra pinnel, a kiment a UJ. A hook
            # PreToolUse-kent nem irja at a tool_input-ot (updatedInput), ez a fleet szandekos
            # dontese (root CLAUDE.md 14. szabaly: csendes atiras helyett block-and-suggest, az
            # atirasra valtas kulon kartyat igenyel, fc3a6a39). Ezert az abszolut-utvonalu alak itt
            # fail-closed TILTVA: a melleklet csak szigoru base64 (inline bajtok, nincs masodik
            # olvasas, nincs TOCTOU-ablak) formaban fogadhato el.
            return [], (f"a '{filename}' melleklet abszolut utvonalkent erkezett ({content!r}) -- "
                        "ezt a hook mar nem fogadja el: a fajlt a hook es az MCP-szerver KULON "
                        "olvasna, a ketto kozott a tartalom kicserelheto (TOCTOU). Kuldd a "
                        "melleklet BAJTJAIT szigoru base64-kent a 'content' mezoben.")
        elif _STRICT_B64_RE.fullmatch(content) and len(content) % 4 == 0:
            out.append({"filename": filename,
                        "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest()})
        else:
            return [], (f"a '{filename}' melleklet tartalma se nem abszolut utvonal, se nem "
                        "szigoru base64 (pl. relativ utvonal: './x', '../x', 'nev.ext') -- "
                        "az MCP-szerver ezt megis FAJLNAK olvashatja, es ezt a hook nem tudja "
                        "hashelni a bytejai szerint -- fail-closed, uj jovahagyas kell "
                        f"({content[:60]!r})")
    out.sort(key=lambda a: (a.get("path", ""), a["filename"], a["sha256"]))
    return out, None


# Upstream's EMAILHTMLHORGONY929 (collect_bash_attachments / _FILE_FLAG_RE, Köteg 17
# 0e681c83..9845015f) was NOT ported here: it reads and hashes a --html/--attach file
# at HOOK time on the Bash path, which is exactly the TOCTOU exposure WhiteHat2's F2
# finding (card e4eb72c9, see the comment above _BASH_ATTACH_RE below) already closed
# for Bash --attach -- the actual send reads the same path again in a LATER process,
# so the file (or a symlink) can be swapped between the two reads. Fork's existing,
# reviewed answer stays: a Bash --attach makes the call unreadable_reason (fail-closed,
# forces a fresh approval) instead of silently anchoring on a hashable-but-swappable
# file. See DECISIONS.md, Köteg 17 merge entry.
# Card a2cb71f1 H1 (RedHat NO-GO, komment 20438): field names on a gmail-mcp send-shaped tool's
# schema that can reference a local file -- the hook must either hash their content (and so pin it
# into content_anchor) or the whole call must be denied outright by gateDecision. Kept as one named
# constant, not only prose, so a future schema's new field is a conscious addition here, cross-read
# by src/__tests__/email-send-gate.test.ts (catalog-drift test) against the pinned package's real
# schema -- the test goes red if the package gains a path-capable field not listed here.
HANDLED_FILE_FIELDS = ("attachments", "inlineImages")


def collect_mcp_inline_images(tool_input: dict):
    """Return (inline_images, unreadable_reason). inline_images: list of
    {"cid", "filename", "sha256"}, sorted for a deterministic hash order.

    Card a2cb71f1 H1 (RedHat NO-GO, komment 20438): @artymclabin/gmail-mcp@1.2.3's
    InlineImageSchema (send_email/draft_email/update_draft/reply_all, dist/tools.js:6-19) adds a
    SECOND file-attaching field next to `attachments` -- each entry sets exactly one of `path`
    (absolute file path, read by the server at send time) or `content` (base64, inline bytes), per
    the server's own zod .refine(). Before this, content_anchor never looked at this field: an
    approved send_email letter's inlineImages path could be swapped for ANY locally readable file
    (a key, a token, .env) and the anchor would not change, because collect_email_envelope only
    ever read to/cc/bcc/text/attachments. Measured (RedHat): the same letter with and without an
    inlineImages path gave a byte-identical content_anchor, unreadable_reason none.

    `path` is refused outright, not hashed -- same TOCTOU reasoning as the attachments
    absolute-path rule (F3, e4eb72c9/a2cb71f1): the hook and the MCP server would read the file
    SEPARATELY, so the content could change between the two reads. An inline image can only be
    approved as base64 `content` bytes, which this hook hashes directly (no second read, no
    TOCTOU window)."""
    raw = tool_input.get("inlineImages")
    if not raw:
        return [], None
    if not isinstance(raw, list):
        return [], "az inlineImages mezo alakja nem lista"
    out = []
    for item in raw:
        if not isinstance(item, dict):
            return [], "egy inlineImages bejegyzes alakja nem objektum"
        cid = str(item.get("cid") or "")
        path = item.get("path")
        content = item.get("content")
        if path:
            return [], (f"a '{cid}' inline kep abszolut utvonalkent erkezett ({path!r}) -- "
                        "ezt a hook nem fogadja el: a fajlt a hook es az MCP-szerver KULON "
                        "olvasna, a ketto kozott a tartalom kicserelheto (TOCTOU, az attachments "
                        "F3-zarasanak mintaja). Kuldd az inline kep BAJTJAIT a 'content' mezoben "
                        "szigoru base64-kent.")
        if not isinstance(content, str) or not content:
            return [], (f"a '{cid}' inline kep tartalma hianyzik vagy nem szoveg "
                        "(sem path, sem ervenyes content)")
        filename = str(item.get("filename") or "")
        out.append({"cid": cid, "filename": filename,
                    "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest()})
    out.sort(key=lambda a: (a["cid"], a["filename"], a["sha256"]))
    return out, None


# The claude.ai Gmail connector's send-shaped tools (mcp__claude_ai_Gmail__*):
# no "send_email" in the name, so the name-based test above never saw them.
# Kept for importers; the gates classify with classify_mail_tool below, which
# matches every name this pattern matches.
CONNECTOR_SEND_RE = re.compile(r"gmail__(reply|reply_all|send_message|forward)$", re.I)


# --- tool-name classification -------------------------------------------------
# ONE classifier for the main agent's mail gates (email-approval-gate.py,
# outgoing-copy-gate.py, credential-gate.py) and, as a JS twin, for the
# sub-agent gate (scripts/email-send-gate.mjs classifyMailTool). Both copies
# are bound by the shared case list scripts/hooks/mail-tool-name-cases.json,
# which src/__tests__/email-gate-matcher-drift.test.ts runs through both.
#
# Why the base-name SUFFIX: vendor/gmail-mcp-fork prepends its tool prefix
# (--tool-prefix / GMAIL_MCP_TOOL_PREFIX) to every tool name VERBATIM, with no
# separator guaranteed ("v2_", "v2", "work-", ...). The patterns the gates
# carried described what stands BEFORE the base name (`gmail__reply_all$`,
# `(^|__)draft_email$`, `(^|__)manage_email$`), so every prefixed name slipped
# past them: mcp__gmail__v2_reply_all was not a send for any gate, and
# mcp__gmail__v2_draft_email skipped the sub-agent recipient ledger. A verbatim
# prefix leaves exactly one invariant intact, that the base name is the END of
# the tool name, so the test is endswith(base) and nothing is assumed about
# what precedes it. The same holds for the server segment: reply_all and
# send_draft are sends on a server of any name (the vendored server registered
# as server-gmail-autoauth-mcp never matched `gmail__reply_all$`).
#
# The classifier covers every name the patterns it replaces matched:
#   - send_email and the three draft names keep the SUBSTRING match the
#     widest of the old gates used;
#   - manage_email is the suffix: a prefixed mcp__x__v2_manage_email is the
#     multiplexer, a look-alike such as manage_emails_bulk is not (the
#     sub-agent gate's pinned rule). The approval gate, whose scope always
#     matched the substring, keeps that on top (its scope_kind);
#   - `gmail__(reply|reply_all|send_message|forward)$` implies "gmail" in the
#     name plus the suffix, which is what the connector test checks;
#   - the generic words send_message / reply / forward count only with "gmail"
#     somewhere in the qualified name, because the Telegram plugin's tool is
#     `..._telegram__reply` and the mail gates must never fire on it;
#   - send_gmail_message / draft_gmail_message (the Google Workspace MCP's
#     Gmail send and draft tools) carry neither "send_email" nor a known
#     draft name, so they are matched by name (substring) as send_email and
#     draft kinds;
#   - send_draft is NEW: it sends an existing draft by draftId and no gate knew
#     it. The vendored server ships it next to draft_email, so a sub-agent
#     could draft (ledger-checked) and then send the draft with no gate at all.
# A read tool whose name happens to END in a send-shaped base is classified as
# a send: that false positive fails closed, the direction a mail gate may err
# in. lowercase + endswith/in, no regex, so the two copies cannot drift on
# `$`-before-newline semantics.
# Cybered NO-GO 28354 F3: "forward_message" added -- mcp__google_workspace__gmail_forward_message
# ends in "forward_message", not bare "forward", so it missed every suffix here and classified
# as None (not an outbound mail tool at all): unaudited by the copy gate, unapproved by the
# approval gate, and allowed by the sub-agent governance gate -- all three at once.
_CONNECTOR_GENERIC_SUFFIXES = ("send_message", "reply", "forward", "forward_message")
_DRAFT_NAMES = ("draft_email", "create_draft", "update_draft", "draft_gmail_message")

# Kinds (the same vocabulary as classifyMailTool in email-send-gate.mjs):
#   "send_email"     address-carrying direct send (to/cc/bcc fields)
#   "connector_send" reply_all, or a Gmail send_message / reply / forward
#                    (often addressed by messageId)
#   "send_draft"     sends an existing draft by draftId: no envelope visible
#   "manage_email"   the multiplexer: the operation decides
#   "draft"          writes a draft (draft_email / create_draft / update_draft)
#   None             not an outbound mail tool (reads, search, labels, delete)
MAIL_TOOL_KINDS = ("send_email", "connector_send", "send_draft", "manage_email", "draft")


def classify_mail_tool(tool_name):
    """Classify a (possibly prefixed, qualified) tool name. Strictest kind
    first, so a name that fits two kinds lands in the one that gates harder."""
    n = str(tool_name or "").lower()
    if not n or n == "bash":
        return None
    if "send_email" in n or "send_gmail_message" in n:
        return "send_email"
    if n.endswith("reply_all"):
        return "connector_send"
    if "gmail" in n and n.endswith(_CONNECTOR_GENERIC_SUFFIXES):
        return "connector_send"
    if n.endswith("send_draft"):
        return "send_draft"
    if n.endswith("manage_email"):
        return "manage_email"
    if any(d in n for d in _DRAFT_NAMES):
        return "draft"
    return None


def collect_email_envelope(tool_name: str, tool_input: dict):
    """PR2 entry point: one dict for the recipient+content hash anchor (to/cc/bcc/text), built from the
    SAME collectors the copy gate runs (no second extraction implementation).
    Returns {"to", "cc", "bcc", "text", "unreadable_reason"}; text is the combined
    subject+body exactly as the copy gate audits it. The CALLER decides policy
    (e.g. an empty recipient list on a send is itself grounds to deny)."""
    attachments = []
    # Koteg 23a (upstream #1995): CONNECTOR_SEND_RE requires "gmail__" immediately before the
    # verb (`gmail__reply_all$`), so a vendor-prefixed name (mcp__gmail__v2_reply_all) or an
    # off-brand server whose TOOL itself is gmail-action-shaped (mcp__workspace__
    # send_gmail_message) was "not an email-send tool" to this function at all -- level 2 could
    # never anchor an approval for it. classify_mail_tool's suffix match reaches both; reused for
    # classification only (the file's own classify_mail_tool definition, same module), never for
    # the recipient-ledger decision, which stays NOT ADOPTED.
    if (re.search(r"send_email", tool_name or "", re.I) or CONNECTOR_SEND_RE.search(tool_name or "")
            or classify_mail_tool(tool_name) in ("send_email", "connector_send")):
        ti = tool_input if isinstance(tool_input, dict) else {}
        text = collect_mcp_body(ti)
        to, cc, bcc, reason = collect_mcp_recipients(ti)
        # A connector reply/forward addresses the ORIGINAL message: its
        # recipient is fixed by messageId, not by a `to` field, so the id is
        # the recipient anchor (GMAILCONNECTOR914). Same bytes-exact rule as
        # the addresses: an approval for one message cannot answer another.
        if not to and ti.get("messageId"):
            to = [f"messageId:{ti['messageId']}"]
        attachments, att_reason = collect_mcp_attachments(ti)
        if att_reason and not reason:
            reason = att_reason
        inline_images, img_reason = collect_mcp_inline_images(ti)
        if img_reason and not reason:
            reason = img_reason
    elif tool_name == "Bash":
        cmd = str((tool_input or {}).get("command") or "") if isinstance(tool_input, dict) else ""
        text, reason = collect_bash_body(cmd)
        if not reason:
            to, cc, bcc, reason = collect_bash_recipients(cmd)
        else:
            to, cc, bcc = [], [], []
        inline_images = []
    else:
        return {"to": [], "cc": [], "bcc": [], "text": "", "attachments": [], "inline_images": [],
                "unreadable_reason": f"nem email-kuldo tool ({tool_name!r})"}
    return {"to": to, "cc": cc, "bcc": bcc, "text": text, "attachments": attachments,
            "inline_images": inline_images, "unreadable_reason": reason}
