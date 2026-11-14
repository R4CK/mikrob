#!/usr/bin/env python3
"""llm-ledger-append.py -- append one row to the llm_ledger table (card e96d56c5, F4).

Called by local-llm.sh, freellm-call.sh and the gemini offload paths after a
non-Claude LLM call completes (success or failure). Uses the sqlite3 module
with parameterized queries (never raw SQL string interpolation), because
fail-reason/model text is not fully trusted and this fork's own python
scripts already follow that pattern (token-usage-dedup-backfill.py).

Fail-open by design: a logging failure must never fail the caller's actual
LLM call. Exceptions are caught and reported on stderr; exit code is always
0 unless argument parsing itself fails.

USAGE:
  llm-ledger-append.py --agent backend3 --task-type code --provider local \\
    --ok --model qwen3.8 --latency-ms 2680 --prompt-chars 420 --response-chars 1100
"""
import argparse
import os
import sqlite3
import sys
import time

DEFAULT_DB = "/home/neon/marveen/store/claudeclaw.db"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=os.environ.get("LLM_LEDGER_DB", DEFAULT_DB))
    p.add_argument("--agent", required=True)
    p.add_argument("--task-type", required=True)
    p.add_argument("--provider", required=True, choices=["local", "gemini", "freellm"])
    p.add_argument("--card", default=None)
    p.add_argument("--model", default=None)
    ok_group = p.add_mutually_exclusive_group(required=True)
    ok_group.add_argument("--ok", action="store_true")
    ok_group.add_argument("--fail", action="store_true")
    p.add_argument("--fail-reason", default=None)
    p.add_argument("--latency-ms", type=int, default=None)
    p.add_argument("--prompt-chars", type=int, default=None)
    p.add_argument("--response-chars", type=int, default=None)
    p.add_argument("--claude-token-equiv", type=int, default=None)
    args = p.parse_args()

    try:
        conn = sqlite3.connect(args.db, timeout=5)
        try:
            conn.execute(
                """INSERT INTO llm_ledger
                   (ts, agent_id, card_id, task_type, provider, model, ok, fail_reason,
                    latency_ms, prompt_chars, response_chars, claude_token_equiv)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    int(time.time()), args.agent, args.card, args.task_type, args.provider,
                    args.model, 1 if args.ok else 0, args.fail_reason, args.latency_ms,
                    args.prompt_chars, args.response_chars, args.claude_token_equiv,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:  # fail-open: never block the caller's real LLM call
        print(f"llm-ledger-append: WARNING -- could not log row: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
