---
name: video-analysis-reproduction
description: Extract any video (YouTube or other URL) and turn it into a second-accurate, reproducible operational log plus a structured analysis. Use whenever asked to analyze, break down, transcribe, document, or "reproduce" a video, tutorial, demo, walkthrough, or screen recording. Triggers on a video/YouTube link, "analyze this video", "reproduction guide", "break down the video", "mit csinal a videoban", "elemezd a videot".
---
# Video analysis and reproduction guide

Produce output precise enough that another agent or a technical team can reproduce
the process shown in a video. You cannot literally watch pixels; you reconstruct the
video from three evidence sources: the **timestamped transcript** (narration), the
**chapters + description** (structure), and **sampled keyframes** (visual detail where
it matters). Never invent an action that no evidence supports.

## Tooling (already installed)
- `yt-dlp` at `/home/neon/.local/bin/yt-dlp` (add to PATH: `export PATH="/home/neon/.local/bin:$PATH"`)
- `ffmpeg` at `/usr/bin/ffmpeg` (keyframe sampling, audio extraction)

## Procedure

### 1. Extract (no full video download first — transcript is 99% of the signal)
```bash
export PATH="/home/neon/.local/bin:$PATH"
WS="$PWD/workspace"; mkdir -p "$WS"; cd "$WS"
URL="<the video url>"
# metadata (title, duration, uploader, description, CHAPTERS) + english auto-captions
yt-dlp --no-warnings --skip-download --write-auto-subs --sub-langs "en" --sub-format srv1 \
       --write-info-json -o "video.%(ext)s" "$URL"
```
Produces `video.info.json` (metadata + `chapters[]` + `description`) and `video.en.srv1`
(timestamped cues). If the video's spoken language is not English, set `--sub-langs`
to it (list options with `--list-subs "$URL"`), and also fetch `en` if a translated
track exists.

### 2. Parse the transcript into a clean timestamped timeline
```bash
python3 - "$WS/video.en.srv1" <<'PY'
import re,sys,html
t=open(sys.argv[1],encoding="utf-8").read()
for s,txt in re.findall(r'<text start="([0-9.]+)"[^>]*>(.*?)</text>', t, re.S):
    sec=int(float(s)); line=html.unescape(re.sub('<[^>]+>','',txt)).replace('\n',' ').strip()
    if line: print(f"{sec//60:02d}:{sec%60:02d}\t{line}")
PY
```
Read `chapters` from `video.info.json` (`start_time`,`title`) — they are the backbone
of the chronological log. Work chapter by chapter; a long video (hours) MUST be walked
in chapter-sized passes, not one giant read.

### 3. Sample keyframes ONLY where visual detail is needed
The transcript says *what is talked about*; frames show *what is on screen* (which
button, which file, which UI). Sample at a chapter boundary or a specific "click X"
moment:
```bash
ffmpeg -ss 00:12:30 -i "$WS/video.mp4" -frames:v 1 "$WS/frame_1230.png" 2>/dev/null
```
If the video file is not present, download just the needed span (cheap) with
`yt-dlp --download-sections "*00:12:00-00:13:00" -o video.mp4 "$URL"`. Then Read the PNG.
Sample sparingly (cost + time); prefer transcript+description evidence first.

### 3.5 Build the tool inventory + GitHub-first substitutes (Peti rule 2026-07-18)
Every tool, plugin, service, model, IDE and library seen in the video (the distinct
values from the "Alkalmazott Eszköz / Szoftver" column) gets an entry in a substitution
table. For each one, find what OTHER programs can replace it — **GitHub open-source
repos FIRST** (fleet rule 10, GitHub-first / don't reinvent), Stack Overflow + the Stack
Exchange sites as secondary signal, official vendor pages last. Research with `WebSearch`
(e.g. `"<tool> open source alternative github"`) and `WebFetch` on the repo page. Per
alternative capture: repo URL, licence, a maintenance signal (last commit / stars /
open-issue ratio) and whether it is a **drop-in** or a **partial** substitute. Where a
proprietary tool has NO real OSS equivalent, say so plainly and name the closest paid
substitutes. This is due-diligence, not a link dump: flag licence/maintenance/supply-chain
risk (see the `supplychainsecurity` / `skill-security-auditor` skills). Never invent a
repo or a star count — only list what you actually verified via a fetch/search.

### 4. Emit the 5-part deliverable (exact structure)
The persona output contract — always all five, in this order:

1. **Kronológiai Vizuális és Audió Napló** — a Markdown table, one row per meaningful
   beat (not per caption cue; group into logical steps). Columns:
   `| Időbélyeg (MM:SS) | Vizuális Akció / Esemény | Narráció / Audió lényege | Alkalmazott Eszköz / Szoftver |`
   Objective, descriptive, reproducible ("A kurzor a 'Deploy' gombra kattint"), never
   interpretive fluff. Every timestamp must trace to a transcript cue or a sampled frame.
2. **Vezetői Összefoglaló** — max 5 sentences: message, added value, end result.
3. **Műveleti és Technikai Elemzés** — efficiency factors; bottlenecks / failure points /
   missing steps; required tech stack, licenses, competencies.
4. **Eszköz-leltár és GitHub-first Helyettesíthetőség** — the substitution table from
   step 3.5. Columns:
   `| Eredeti eszköz | GitHub-first alternatíva(k) + repo URL | Licenc | Karbantartottság (utolsó commit / csillag) | Drop-in vagy részleges | Megjegyzés / kockázat |`
   One row per distinct tool from the video. Proprietary-only tools flagged as such.
5. **Részletes Megvalósítási Projektterv** — hand to the `operational-project-planning`
   skill (scope, WBS, resources, risk matrix, milestones). If a user-facing product is
   shown, also run `user-flow-menu-design` for the flow/IA.

## Pitfalls
- **No captions available** → extract audio (`yt-dlp -x --audio-format mp3`) and note the
  limitation; if a speech-to-text tool is installed use it, else reconstruct from
  description + chapters + sampled frames and FLAG reduced confidence. Never fabricate narration.
- **Hours-long video** → the transcript is huge (this repo's test video is ~4h / 485KB).
  Do NOT try to hold it all at once; iterate chapter by chapter, write the table
  incrementally. Cap frame sampling.
- **Auto-caption noise** (`>>`, `&#39;`, mis-hearings) → the parser unescapes HTML; still
  read for sense, correct obvious ASR errors from context, don't quote garble verbatim.
- **Age-restricted / private / members-only** → yt-dlp may need cookies; report the block
  to MikroB rather than guessing content.
- **PATH** → fleet shells may not have `~/.local/bin`; always `export PATH` first or call
  the absolute `/home/neon/.local/bin/yt-dlp`.

## Verification
- Every row's timestamp exists in the transcript or a frame you actually sampled.
- No step in the reproduction guide is unsupported by evidence (no hallucinated clicks).
- All 5 sections present; the project plan is actionable (a team could start from it).
- Every tool from the chronological log appears in the substitution table (section 4); each
  listed GitHub alternative was actually verified via fetch/search (real repo, real licence),
  proprietary-only tools flagged, no invented repos or star counts.
- Language: deliverable in the requester's language (Peti → Hungarian headings as above);
  quoted tool/UI names stay in their original language.
