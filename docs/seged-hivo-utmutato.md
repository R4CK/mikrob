# seged-hivo: guide for calling a helper (Codex / agy)

A Claude agent may hand a well-bounded task to an outside helper (OpenAI Codex CLI or Google agy/Gemini).
Every call is logged and rated, so after a few weeks you can see from data which helper is reliable for
which kind of task, and where a Claude agent stays better.
A helper as an agent's main engine is a different question; decide it from this data, not before.
Tool: `scripts/seged-hivo.py --help`. Log: `store/seged-hivo-naplo.jsonl`.

## First question: should a helper do this at all?

If you would finish it yourself faster than you can write the brief and review the result, do not call a helper.
Helper output is never final: the calling agent reviews it, and that review is part of the cost being measured.

## Which helper for what (one measurement, 2026-10-03, the same landing-page brief for all)

| helper / model | landing page result | tokens | time | verdict |
|---|---|---|---|---|
| codex:gpt-6.1-sol | complete, generated hero photo, test-page marking, 2px radius | 37 378 | ~5 min | **hero photo: yes**; page: usable draft |
| codex:gpt-6-astra | no hero (skipped it), `.example` placeholders, 3px | 37 286 | ~6 min | clean, but no image |
| codex:gpt-6-luna | photo, 4px, BUT a real-looking company e-mail, no test-page marking | 41 223 | ~3.5 min | fast, needs a strict brief |
| agy:gemini-3.8-flash-high | invented promises (24h, guarantee), US loft hero with English text | 415 066 | 348 s | **not for page building** |
| agy:gemini-3.1-pro-high | template look, invented company name + real-looking e-mail, loft hero | 45 996 | 81 s | **not for page building** |
| Claude frontend agent (claude-sonnet-5-5), reference | best fit to the house rules, no hero image | (Claude) | 2 min 20 s wall | **page building stays with Claude** |

Code review as a second reviewer: `codex` on a known bad commit named the real defect (analytics script
loading without consent) and scored it 4-6; on the fix it scored 10. Usable as a second reviewer.

Fixed base cost, small task (create one hello.txt): codex:gpt-6-luna **4 800** tokens,
agy:gemini-3.8-flash-low **24 033** tokens (23 885 of it input = agy's own system text). For small jobs agy
is the expensive one; it only pays off on large tasks, if at all.

Plan limits (OpenAI Codex pricing page, read 2026-10-03): ChatGPT Plus per 5 hours 5-45 (Astra) /
10-100 (Sol) / 250-2000 (Luna) local messages, plus a weekly cap. Gemini via agy: AI Pro plan, refills every
5 hours (antigravity.google/docs/plans); user reports say agy drains it fast (not measured).
These numbers age fast: re-measure on your own tasks.

## Brief template (copy into the prompt file)

```
# Helper brief: <task>, card <ID>. TEST / NOT LIVE / NOT PUBLIC
Goal: <one sentence>
Output: only in this folder: <file list>. Do not create anything else.
Language: visible text in Hungarian, with correct accents.
House rules: <your design rules, e.g. border-radius at most 4px; no em dash; no external CDN>
DO NOT INVENT: prices, deadlines, guarantees, company names, certificates. If the brief does not give a
fact, leave a visible placeholder like [ÁR], [HATÁRIDŐ].
CONTACT DATA, PLACEHOLDERS ONLY, IN UNDELIVERABLE FORM:
  e-mail: info@ceg.example
  phone:  the literal text [TELEFON], no digits
  address: [CÍM]
Mark the page visibly as a test page.
At the end write NOTES.md: what you did, what you left out, and why.
```

Why the contact rule is in the brief: the gate in `seged-hivo.py` scans the prompt AND every text file in
the work folder for e-mail addresses and phone numbers, and it is strict on purpose (no allowlist beyond
`*.example`, `*.test`, `example.com`). A helper that writes a real-looking address or `+36 30 000 0000` into
the footer blocks the next call in the same folder (exit 3). Encoded forms count too: `&#64;`, `@`,
`%40`, an address split by tags (`kovacs<span>@</span>...`) or glued with `"a" + "@" + "b"`.

## Call

```
python3 ~/marveen/scripts/seged-hivo.py --seged codex:gpt-6.1-sol --mappa ~/seged-munka/<task folder> \
  --prompt <brief.md> --hivo <your agent id> --kartya <card id> --feladattipus <type>
```

- The work folder must be a subfolder of `~/seged-munka/` (override: `SEGED_BASE`), one per task. The
  Marveen repo and credential folders are refused even if `SEGED_BASE` points at them.
- Only these file types may be in the work folder: `.md .txt .html .css .js .json .csv .py .ts .tsx .jsx
  .mjs .svg`. Anything else stops the call, images included (a photo of a business card is client data
  the gate cannot read), and so do docx, xlsx, pdf, zip, a `.git` folder and symlinks. Convert the content
  to text (with placeholders) first; describe images in the brief instead of putting them in the folder.
- The helper runs in bubblewrap: it sees nothing of `$HOME` except its own folder; writing outside it fails.
  It gets no environment variable of yours (no session token, no API key), only `PATH`, `HOME`, `LANG`, `TZ`.
  A FIFO or an unreadable subfolder in the work folder also stops the call.
- No client data (real name, e-mail, phone, address) in the brief or in the folder: it would go to an outside
  provider (Google / OpenAI). Only with a legal (GDPR) decision behind it, never by default.
  If the gate stops you, remove the data, do not work around the gate.
- `--feladattipus` is required: `kod | kod-atnezes | szoveg | kep | weboldal | kutatas | adat | egyeb`.
  Pick the closest one; the summary is helper x task type.
- Exit codes: 0 ok, 1 helper failed, 3 blocked by the gate, 4 timeout, 5 quota or lock (try later).
- **Quota**: at most **5 calls per agent per day**, all agents together at most **agy 20 / codex 40 per day**,
  and only **one helper call running at a time**. Every call that went out counts (ok, error, timeout); a
  blocked one does not. Over a limit, or while another call runs, nothing is sent: `status=blocked`,
  `blokk=kvota|zar`, exit 5. Why so tight: a subscription used through an unofficial client can be banned
  (Google did it to Gemini users in 2026-02; a second offence is permanent). On exit 5 do the task yourself
  or try later; do not loop on retries. Limits: `store/seged-hivo-kvota.json` or env (`seged-hivo.py --help`).
- `--hivo` must be your agent folder name (`agents/<name>`); case and spaces are ignored, an unknown name
  stops the call (exit 2); without an `agents/` folder (standalone install) the name is not checked. A call counts from the moment it starts: if your process is killed while the
  helper runs (e.g. your own command timeout is shorter than `--timeout`), the call still counts.
- **Pause**: between two helper calls there is a random 5-15 s gap, waited out by the tool (count it into
  your command timeout). **Stop flag**: if a helper fails with a 403 / 429-type answer (account refused or
  throttled), `store/seged-hivo-STOP.json` is written and the main agent gets an alert; from then on every
  call is refused (`blokk=stop`, exit 5) until a human has checked the account and deleted that file. Never
  delete it yourself.
- The limits are self-restraint, not a lock against a determined caller: env variables or a changed system
  clock can lift them. They protect the account from accidents, not from someone who wants to get around them.

## After every ok call: rate it (this is the data you decide from)

```
python3 ~/marveen/scripts/seged-hivo.py --ertekel <ido of the call> --eredmeny elfogadva|javitva|eldobva \
  --pont <1-10> --velemeny "<at most 2 sentences>" --hivo <your agent id>
```

- `--eredmeny`, was Claude work still needed: `elfogadva` used as is; `javitva` usable after a Claude fix;
  `eldobva` thrown away, Claude redid it.
- `--pont` 1-10, **relative to a Claude agent doing the same task: 5 = as good as Claude**, 7 = clearly better,
  3 = clearly worse. Judge the result, not the speed (time and tokens are logged anyway).
- `--velemeny` at most 2 sentences: what it was good or weak at. Example:
  `"Gyors és pontos kód. A hibaüzenetek angolok maradtak, átírtam."`
- All three are required. The call prints the exact command with its `ido` at the end; an unrated call
  shows as `unrated` in the summary. If you rate twice, the last rating counts.
- Rate honestly, also when it hurts the helper: the point is to learn which helper can be trusted with what.

**Blind A/B:** every 5th call that actually goes out is marked `ab=true` in the log and announced on stderr.
Leave that helper result unchanged in the folder, so a reviewer can score it blind against a Claude result.

Summary per helper: `seged-hivo.py --osszesito --tol <start date>` (ok / error / blocked / timeout rate,
median time, average tokens, as is / fixed / dropped counts, average score, A/B count), plus a second table
by task type x helper. `--json` for machine use.
