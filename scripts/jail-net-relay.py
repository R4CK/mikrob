#!/usr/bin/env python3
"""jail-net-relay.py -- runs INSIDE the network-isolated jail (card 5229ea1e).

seged-hivo.py's bwrap sandbox now runs with --unshare-net: the jailed process has loopback only,
no real network. This tiny relay listens on 127.0.0.1:<port> (inside the jail's own isolated
netns -- this port number can never collide with anything on the host, they are different
network namespaces) and forwards every connection to a UNIX domain socket that was bind-mounted
into the jail from the host side (scripts/jail-net-proxy.py listens there). HTTP_PROXY/HTTPS_PROXY
are set to this local port so the jailed HTTP client (confirmed: the real `agy` binary honors
them) routes through it automatically.

Exits when its parent process group is torn down (bwrap --die-with-parent + --unshare-pid kills
every process in the jail's pid namespace once the real command exits) -- no self-timeout needed.
"""
import socket
import socketserver
import sys
import threading


def splice(a, b):
    try:
        a.settimeout(300)
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
        try:
            upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            upstream.connect(self.server.uds_path)
        except OSError:
            return
        try:
            t = threading.Thread(target=splice, args=(upstream, conn), daemon=True)
            t.start()
            splice(conn, upstream)
            t.join(timeout=305)
        finally:
            upstream.close()


class ThreadingTCPServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if len(sys.argv) != 3:
        print("usage: jail-net-relay.py <listen-port> <uds-path>", file=sys.stderr)
        return 2
    port, uds_path = int(sys.argv[1]), sys.argv[2]
    server = ThreadingTCPServer(('127.0.0.1', port), Handler)
    server.uds_path = uds_path
    server.serve_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
