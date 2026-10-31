#!/usr/bin/env python3
"""jail-net-proxy.py -- host-side allowlisting HTTP(S) forward proxy for the Gemini/Codex jail
(card 5229ea1e, backend2 measurement a020247b / msg 12421).

WHY: seged-hivo.py's jail_cmd() bwrap sandbox does not use --unshare-net, so the jailed agy/codex
process can reach ANY external host, not just the Google API it needs -- a prompt-injected brain
could exfiltrate data or call out to a C2 host. Full --unshare-net alone leaves the jail with no
network at all (not even DNS), which breaks the real Google API call. There is no nft/iptables/
slirp4netns/pasta path that stays root-free AND jail-scoped-only (a host-wide nft/iptables rule
would affect the whole fleet's network, explicitly forbidden by the card; slirp4netns/pasta need
`sudo apt-get install`, a root step gated on Peti's approval).

MEASURED FIX (verified live on this machine, no new package, no sudo):
  - `bwrap --unshare-net` genuinely isolates the jail's network (confirmed: a raw socket connect
    to 8.8.8.8:443 from inside returns "Network is unreachable"); loopback comes up automatically.
  - A UNIX DOMAIN SOCKET created on the HOST and bind-mounted into the jail IS reachable from
    inside the netns-isolated jail (unix sockets are filesystem objects, not network-namespace
    scoped) -- confirmed with a live round-trip.
  - The real `agy` binary (Gemini CLI) is a Go HTTP client and genuinely honors
    HTTP_PROXY/HTTPS_PROXY (confirmed live: it CONNECTs to exactly two hosts --
    antigravity-unleash.goog:443 and oauth2.googleapis.com:443 -- nothing else, no Ollama contact
    observed from a plain `agy -p` call).

This script is the HOST side of that bridge: it listens on a per-invocation UNIX domain socket
(bind-mounted into the jail), accepts HTTP CONNECT (for HTTPS) and absolute-form plain-HTTP
requests, and only relays to an explicit allowlist of host:port pairs -- anything else gets a 403
and is logged to stderr, never silently tunnelled. This process is spawned fresh per seged-hivo.py
call (see run_helper()) and torn down when that call finishes; it is not a long-running daemon.

A disallowed host/parse error/timeout always means "close the connection", never "forward anyway"
-- fail closed, matching eedb2871/WhiteHat2's state-write pattern elsewhere in this repo.
"""
import json
import os
import socket
import socketserver
import sys
import threading
import time

CONNECT_TIMEOUT_S = 10
IDLE_TIMEOUT_S = 120
MAX_HEADER_BYTES = 8192

# Card cdcd0f5b (8ffa0c8a plan, step 1-2): agent attribution + a named, versioned report file
# (destination, agent, count), not just stderr lines. The stderr log() calls below are kept for
# interactive debugging, but seged-hivo.py spawns this with stderr=DEVNULL (run_helper), so in
# production NOTHING below ever reached a file before this change -- this is the actual fix.
LOG_PATH = os.environ.get("JAIL_NET_PROXY_LOG") or str(
    __import__("pathlib").Path(__file__).resolve().parent.parent / "store" / "jail-net-proxy.log")


def log(msg):
    print(f"jail-net-proxy: {msg}", file=sys.stderr, flush=True)


def log_decision(agent, host, port, decision):
    """JSON-line log, 0600 (same schema style as store/bash-egress.log: ts/agent/decision fields),
    created by THIS process so the mode is ours -- not a shell redirect's."""
    line = json.dumps({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "agent": agent or "",
        "host": host,
        "port": port,
        "decision": decision,
    }, ensure_ascii=False)
    try:
        fd = os.open(LOG_PATH, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass  # a proxy that cannot log must still relay -- logging failure is not fail-closed here


def parse_allowlist(csv):
    allowed = set()
    for entry in csv.split(','):
        entry = entry.strip()
        if not entry:
            continue
        host, _, port = entry.rpartition(':')
        if not host or not port.isdigit():
            raise ValueError(f"bad allowlist entry (want host:port): {entry!r}")
        allowed.add((host.lower(), int(port)))
    return allowed


def read_header_block(conn):
    """Reads up to the first blank line (end of HTTP headers), capped at MAX_HEADER_BYTES.
    Returns the raw bytes read (including the blank line) or b'' on timeout/EOF/overflow."""
    buf = b''
    conn.settimeout(CONNECT_TIMEOUT_S)
    while b'\r\n\r\n' not in buf:
        if len(buf) > MAX_HEADER_BYTES:
            return b''
        try:
            chunk = conn.recv(4096)
        except socket.timeout:
            return b''
        if not chunk:
            return b''
        buf += chunk
    return buf


def target_from_request(header_block):
    """Returns (host, port, is_connect) from the request line, or None if unparseable.
    Handles 'CONNECT host:port HTTP/1.1' and absolute-form 'METHOD http://host[:port]/path HTTP/1.1'."""
    line = header_block.split(b'\r\n', 1)[0].decode('latin-1', errors='replace')
    parts = line.split(' ')
    if len(parts) < 2:
        return None
    method, target = parts[0], parts[1]
    if method.upper() == 'CONNECT':
        host, _, port = target.rpartition(':')
        if not host or not port.isdigit():
            return None
        return host.lower(), int(port), True
    if target.lower().startswith('http://'):
        rest = target[len('http://'):]
        hostport = rest.split('/', 1)[0]
        host, _, port = hostport.rpartition(':')
        if not host:
            host, port = hostport, '80'
        if not port.isdigit():
            return None
        return host.lower(), int(port), False
    return None


def splice(a, b):
    """Forwards bytes a -> b until EOF or IDLE_TIMEOUT_S of silence; closes both ends on exit."""
    try:
        a.settimeout(IDLE_TIMEOUT_S)
        while True:
            try:
                chunk = a.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            b.sendall(chunk)
    except OSError:
        pass
    finally:
        for sock in (a, b):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        conn = self.request
        header_block = read_header_block(conn)
        if not header_block:
            return
        parsed = target_from_request(header_block)
        if parsed is None:
            log("unparseable request, closing")
            return
        host, port, is_connect = parsed
        if (host, port) not in self.server.allowlist:
            log(f"DENIED {host}:{port} (not in allowlist)")
            log_decision(self.server.agent, host, port, "denied")
            try:
                conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            return
        try:
            upstream = socket.create_connection((host, port), timeout=CONNECT_TIMEOUT_S)
        except OSError as e:
            log(f"upstream connect to {host}:{port} failed: {e}")
            try:
                conn.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            return
        log(f"ALLOWED {host}:{port}")
        log_decision(self.server.agent, host, port, "allowed")
        try:
            if is_connect:
                conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            else:
                # Plain HTTP: the header block we already read IS the request -- forward it as-is.
                upstream.sendall(header_block)
            t = threading.Thread(target=splice, args=(upstream, conn), daemon=True)
            t.start()
            splice(conn, upstream)
            t.join(timeout=IDLE_TIMEOUT_S + 5)
        finally:
            upstream.close()


class UnixThreadingServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if len(sys.argv) not in (3, 4):
        print("usage: jail-net-proxy.py <uds-path> <allowlist: host:port,host:port,...> [agent-id]",
              file=sys.stderr)
        return 2
    uds_path, allowlist_csv = sys.argv[1], sys.argv[2]
    agent = sys.argv[3] if len(sys.argv) == 4 else ""
    allowlist = parse_allowlist(allowlist_csv)
    if os.path.exists(uds_path):
        os.unlink(uds_path)
    server = UnixThreadingServer(uds_path, Handler)
    server.allowlist = allowlist
    server.agent = agent
    log(f"listening on {uds_path}, allowlist={sorted(allowlist)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if os.path.exists(uds_path):
            os.unlink(uds_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
