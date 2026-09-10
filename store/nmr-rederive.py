#!/usr/bin/env python3
"""
nmr-rederive.py -- read-only re-derivation script for needs_manual_review triage.

For each of the 991 cards in nmr-backend2/nmr-backend3/nmr-fullstack.jsonl:
  1. Fetch live description from GET /api/kanban/<id>
  2. Find ALL verdict:<TYPE>@<timestamp> patterns
  3. Chronologically last verdict decides the derived result
  4. If description truncated (...) OR no verdict pattern -> nem_cafolhato
  5. Emit diff report: cards whose current status != derived status

Does NOT write to the DB. Report only.
"""
import json, re, sys, time
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

# --- Config ---
BASE_URL = "http://localhost:3420"
TOKEN_FILE = "/home/neon/marveen/store/.dashboard-token"
BATCH_DIR = Path("/home/neon/marveen/store/review-batches")
BATCHES = [
    ("036a0913", "nmr-backend2.jsonl"),
    ("7da45e54", "nmr-backend3.jsonl"),
    ("73ba1567", "nmr-fullstack.jsonl"),
]
REQUEST_DELAY = 0.02   # 20ms between requests, ~991 * 20ms = ~20s total

# Maps last verdict type to the expected kanban status
PASS_VERDICTS = {"QA PASS", "CYBERSEC GO", "CYBERED GO"}
FAIL_VERDICTS = {"QA FAIL", "CYBERSEC NO-GO", "CYBERED NO-GO"}

# regex: verdict:QA PASS@2026-08-14T17:35:59.401Z
VERDICT_RE = re.compile(
    r"verdict:(QA PASS|QA FAIL|CYBERSEC GO|CYBERSEC NO-GO|CYBERED GO|CYBERED NO-GO)"
    r"@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"
)

def load_token():
    return Path(TOKEN_FILE).read_text().strip()

def fetch_card(session, card_id):
    import urllib.request, urllib.error
    url = f"{BASE_URL}/api/kanban/{card_id}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    except Exception as e:
        print(f"  WARN: fetch {card_id} failed: {e}", file=sys.stderr)
        return None

def derive_status(description):
    """Return ('done'|'in_progress'|'nem_cafolhato', evidence_str)"""
    if not description:
        return "nem_cafolhato", "empty description"

    desc = description.strip()
    if desc.endswith("..."):
        return "nem_cafolhato", "description truncated (ends with ...)"

    matches = VERDICT_RE.findall(desc)
    if not matches:
        return "nem_cafolhato", "no verdict pattern found"

    # Sort by timestamp; last one wins
    def parse_ts(ts_str):
        ts_str = ts_str.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(ts_str)
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)

    sorted_matches = sorted(matches, key=lambda m: parse_ts(m[1]))
    last_verdict, last_ts = sorted_matches[-1]

    if last_verdict in PASS_VERDICTS:
        derived = "done"
    elif last_verdict in FAIL_VERDICTS:
        derived = "in_progress"
    else:
        derived = "nem_cafolhato"

    evidence = f"last verdict: {last_verdict}@{last_ts} (of {len(matches)} total)"
    return derived, evidence

def main():
    global TOKEN
    TOKEN = load_token()

    total = 0
    batch_results = {}

    for batch_id, filename in BATCHES:
        filepath = BATCH_DIR / filename
        card_ids = []
        with open(filepath) as fh:
            for line in fh:
                row = json.loads(line)
                card_ids.append(row["id"])

        print(f"\n=== Batch {batch_id} ({filename}): {len(card_ids)} cards ===")
        results = []

        for i, card_id in enumerate(card_ids):
            card = fetch_card(None, card_id)
            if i % 50 == 0:
                print(f"  [{i}/{len(card_ids)}] ...", file=sys.stderr)
            time.sleep(REQUEST_DELAY)

            if card is None:
                results.append({
                    "id": card_id,
                    "current_status": "NOT_FOUND",
                    "derived": "nem_cafolhato",
                    "evidence": "card not found in live kanban (404)",
                    "mismatch": False,
                })
                continue

            current_status = card.get("status") or "none"
            description = card.get("description") or ""
            derived, evidence = derive_status(description)

            # Mismatch: derived is not nem_cafolhato AND current_status != what derived says
            mismatch = (derived != "nem_cafolhato") and (current_status != derived)

            results.append({
                "id": card_id,
                "current_status": current_status,
                "derived": derived,
                "evidence": evidence,
                "mismatch": mismatch,
            })

        batch_results[batch_id] = results
        total += len(card_ids)

    # --- Report ---
    print("\n" + "=" * 70)
    print("DIFF REPORT -- needs_manual_review re-derivation")
    print("=" * 70)

    grand_mismatch = 0
    grand_cafolhato = 0
    grand_ok = 0

    for batch_id, filename in BATCHES:
        results = batch_results[batch_id]
        mismatches = [r for r in results if r["mismatch"]]
        nc = [r for r in results if r["derived"] == "nem_cafolhato"]
        ok = [r for r in results if not r["mismatch"] and r["derived"] != "nem_cafolhato"]

        print(f"\nBatch {batch_id} ({filename}):")
        print(f"  Total: {len(results)} | Mismatch: {len(mismatches)} | "
              f"nem_cafolhato: {len(nc)} | ok: {len(ok)}")

        if mismatches:
            print(f"  Mismatched cards:")
            for r in mismatches:
                print(f"    {r['id']}: current={r['current_status']} -> derived={r['derived']} | {r['evidence']}")

        grand_mismatch += len(mismatches)
        grand_cafolhato += len(nc)
        grand_ok += len(ok)

    print(f"\n{'=' * 70}")
    print(f"GRAND TOTAL: {total} cards")
    print(f"  Mismatch (status would change): {grand_mismatch}")
    print(f"  nem_cafolhato (undecidable):    {grand_cafolhato}")
    print(f"  Status confirmed correct:        {grand_ok}")
    print("=" * 70)

    # Save full results to JSON
    out_path = Path("/tmp/nmr-rederive-results.json")
    with open(out_path, "w") as fh:
        json.dump(batch_results, fh, ensure_ascii=False, indent=2)
    print(f"\nFull results saved: {out_path}")

if __name__ == "__main__":
    main()
