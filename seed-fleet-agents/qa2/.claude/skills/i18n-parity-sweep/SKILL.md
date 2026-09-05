---
name: i18n-parity-sweep
description: Find and fix EN-copy violations in locale files (de/es/fr/it/pl). Use when i18n parity check fails or a new namespace is added. Covers WSL2/NTFS caching trap and LEGIT_SAME detection.
---
# i18n Parity Sweep

## Mikor használd
- Új namespace kerül az EN locale-ba és a többi nyelv nem kapja meg
- Parity test / CI fail: "EN-copy violation in de/es/fr/it/pl"
- i18n fordítási sprint (df12479a-típusú kártyák)

## Munkakönyvtár: eldobható worktree HEAD-en, NEM a megosztott klón (kártya 973ed6eb, qa2-javítás c4f431e4 v2 -- QA FAIL utáni fix)

**A qa2-nek NINCS állandó worktree-je** (ellenőrizve: `store/agent-worktree.sh qa2 --path` létező
lévén a NEVRE nem hoz létre semmit -- a `--path` ág mindig csak KISZÁMÍTJA az útvonalat, még ha az
soha nem lett létrehozva, `ls .../CleanCore-worktrees/` szerint nincs `qa2` könyvtár). Az első
verzió ezt a print-only útvonalat használta ellenőrzés nélkül, ami `cd`/fájlírásnál azonnal elszállt
(FileNotFoundError) -- ezt QA FAIL-lel reprodukálta (kártya-komment c4f431e4). A qa-testvér skill
(2a44d04d) ugyanígy nincs-worktree állapotban van, és ugyanezt a mintát alkalmazza: mivel ez a
workflow ÚJ tartalmat ír (nem egy már felülvizsgált SHA-t ellenőriz), az elején nyitunk egy
eldobható worktree-t HEAD-en, és a végén eldobjuk:

```bash
QA2_MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
export QA2_WT="$(mktemp -d)"   # export: a lenti python is olvassa os.environ-ből
git -C "$QA2_MAIN" worktree add "$QA2_WT" HEAD
# ... dolgozz a $QA2_WT alatt (lásd lent) ...
git -C "$QA2_MAIN" worktree remove "$QA2_WT"   # a végén, eldobható
```

Ha csak ELLENŐRZÖL és nem írsz (pl. gate-ként nézed, mi landolt), a fő klón a helyes hivatkozás
## Munkakönyvtár: a SAJÁT worktree-d, NEM a megosztott klón (kártya 973ed6eb)

A CleanCore-t minden fejlesztő ügynök a saját git-worktree-jében szerkeszti; a megosztott klón
CSAK fetch/landolás-alap, oda senki nem commitol. Ezért ez a skill sehol nem nevez fix útvonalat --
az elején egyszer feloldod a sajátodat, és onnantól `$CC`-t (shellben) vagy `CC`-t (Pythonban)
használsz:

```bash
CC="$({{INSTALL_DIR}}/store/agent-worktree.sh <a te agent-neved> --path)"   # pl. backend, fullstack
```

```python
import subprocess
CC = subprocess.run(['{{INSTALL_DIR}}/store/agent-worktree.sh', '<a te agent-neved>', '--path'],
                    capture_output=True, text=True).stdout.strip()
```

Ha csak ELLENŐRZŐL és nem írsz (pl. gate-ként nézed, mi landolt), a fő klón a helyes hivatkozás
`${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}` -- de ott ne commitolj, és NE dolgozz más
ügynök worktree-jében.

## Procedure

### 1. Parity check futtatása (mit kell fordítani)

```python
import json, re, pathlib

BASE = pathlib.Path('packages/i18n/messages')
langs = ['de','es','fr','hu','it','pl']

LEGIT_WORDS = {
    # Rövidítések, tech-szavak (minden nyelvben ugyanaz)
    'Normal','Status','Details','Total','Start','Site','Zone','Asset','Job','Filter',
    'Optional','Branding','Plan','Name','Admin','Team','Brigade','Check-in','Check-out',
    'Dashboard','Score','Manager','Dispatcher','Stock','Client','Type','Actions','Notes',
    'Surface','Maintenance','Notifications','Inspections','Sites','Zones','Certifications',
    'Incidents','Document','Certification','Checklist','Individual','CleanCore','MRR','MGR',
    'Auto','NFC','API','Google Calendar','NAV Online Számlá','000000','Alarm','Email','SMS',
    'Push','OK','ID','PDF','CSV','QR','URL','TOTP','ISO','OPEN','CLAIMED','ASSIGNED',
    'CANCELLED','Inspector','Info','Demo','Navigation','pH','Min / Max','Subtotal','Feedback',
    'Zapier','Xero','live','Manual','VAT','In-app',
    # Francia/spanyol/olasz kognátok (azonos helyesírás a forrás EN-nel)
    'Pagination','Date','Description','Messages','Finance','Module','Note','Photos','Photo',
    'Contact','Clients','Zones','Sites','Stable','Urgent','Inspection',
    # Brand names that are product-specific and identical in all languages
    'CleanCore Platform',
    # B2B finance/accounting terms used internationally
    'Profit','Margin','KPIs','STANDARD','PASS','FAIL',
    # Auth/account terms that are the same in many languages
    'Password','Account','Privacy',
    # Unit abbreviations that are universal
    'pcs',
    # Tech terms used in all languages
    'NFC Tag Scanner','Scan URL',
    # Finance column labels used internationally (HU/DE business context)
    'Margin %','margin',
    # Country/city placeholders (HU: Budapest is a local city placeholder)
    'Budapest',
    # Tax term with template (universally used as VAT in all EU countries)
    'VAT ({rate}%)',
    # Pagination with template
    'Page {page}',
    # Photo cognates (identical in FR/IT/ES)
    'photo(s)','photos',
    # FR cognates: words spelled identically in English and French
    'sites','zones','points',
}

# FR/IT/ES/DE ICU plural cognate words (identical spelling in EN + target lang)
FR_COGNATES = {'site','sites','zone','zones','photo','photos','points','page','pages','other','one'}

def _is_icu_cognate_plural(s):
    """True when s is an ICU plural form whose content words are all cognates."""
    # Strip all {...} blocks (including nested ICU plural forms)
    cleaned = re.sub(r'\{[^}]*\}', '', s)
    # Then check remaining words are all cognates or punctuation
    words = re.findall(r'[a-zA-Z]+', cleaned)
    return bool(words) and all(w.lower() in FR_COGNATES for w in words)

def is_legit(val):
    s = str(val).strip()
    if s in LEGIT_WORDS: return True
    # Pure template ({count} min, {value} m², {score} / 5, {count} pcs)
    # After stripping placeholders, only math/unit chars or short unit abbreviations remain
    stripped = re.sub(r'\{[^}]+\}', '', s).strip()
    if re.fullmatch(r'[\s\-–/().,:;°²³%★☆©•#!mh\d]*', stripped): return True
    # Single-letter/short unit abbreviations (d=day, s=second, h=hour, pcs, min)
    if re.fullmatch(r'[\d\s]*(d|pcs|min|sec|h|km|m|kg|g|l|ml)', stripped): return True
    # ICU plural forms where content is all-cognate (e.g. FR: {count, plural, one {# site} ...})
    if _is_icu_cognate_plural(s): return True
    if s.startswith('© '): return True
    return False

def flatten(d, prefix=''):
    out = {}
    for k,v in d.items():
        key = f'{prefix}.{k}' if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out

with open(BASE / 'en.json') as f:
    en = flatten(json.load(f))

for lang in langs:
    with open(BASE / f'{lang}.json') as f:
        tgt = flatten(json.load(f))
    violations = [(k, v) for k,v in tgt.items()
                  if k in en and str(v) == str(en[k]) and not is_legit(v)]
    print(f'{lang}: {len(violations)} violations')
    for k,v in violations[:10]:
        print(f'  {k}: {v!r}')
```

### 1b. Local-LLM draft offload (card 4245417b) -- OPCIONÁLIS, token-spórló

A hiányzó kulcsok **mechanikus fordítás-draftját** add ki a lokális GPU-modellnek, ne égess
online Claude-tokent rá. A `store/i18n-draft.sh` a SOURCE (EN) fájl VALÓS namespace-eiből
(összes top-level kulcs, rekurzívan flattelve -- **nincs hardcode-olt namespace-allowlist**,
így egy új namespace, pl. `vertical.*`, sosem csúszik át vakfoltként) kiszedi a célnyelvből
HIÁNYZÓ kulcsokat, és a `local-llm.sh --task translate` preseten át mindegyikhez draftot kér:

```bash
# egy nyelvre, a repo tényleges messages-mappájával (NINCS hardcode-olt projekt-út):
store/i18n-draft.sh --messages-dir <repo>/packages/i18n/messages --lang de --limit 40
# -> <messages-dir>/de.draft.json (CSAK a hiányzó kulcsok, nyelvenként), a valós fájlt NEM írja
```

A `.draft.json` **DRAFT-only**: ember + i18n-gate ellenőrzi (ICU-placeholderek, LEGIT_SAME,
kontextus), majd a lenti SINGLE-PROCESS mintával mergeled a valós locale-fájlba. A draft NEM
megy közvetlenül élesbe. A placeholdereket (`{name}`, `{rate}`, `<b>..</b>`) a preset megőrzi,
de a gate KÖTELEZŐEN visszaellenőrzi (lásd §QA gate: double-brace ICU).

### 2. Fordítás -- SINGLE PROCESS PATTERN (WSL2/NTFS kötelező!)

**KRITIKUS:** WSL2-n a `/mnt/h/...` (NTFS 9P mount) caching miatt külön Python processzek elavult fájlt olvasnak. Mindig EGY processz tölt be mindent, módosít memóriában, és írja ki az összeset.

```python
import json, pathlib, os

BASE = pathlib.Path(os.environ['QA2_WT']) / 'packages/i18n/messages'  # a fenti eldobható worktree
import json, pathlib

BASE = pathlib.Path('/mnt/h/LM_Studio_Workdir/CleanCore/packages/i18n/messages')
BASE = pathlib.Path(CC) / 'packages/i18n/messages'   # CC: a SAJÁT worktree-d, lásd fent
langs = ['de','es','fr','it','pl']

def sn(d, dotpath, value):
    keys = dotpath.split('.')
    cur = d
    for k in keys[:-1]:
        cur = cur.setdefault(k, {})
    cur[keys[-1]] = value

# ❌ ROSSZ: külön script/process per fájl -> stale read
# ✅ JÓ: egy process, load all → apply all → write all

TRANS = {
    'de': {
        'namespace.key': 'Übersetzung',
        # ...
    },
    'es': { ... },
    'fr': { ... },
    'it': { ... },
    'pl': { ... },
}

# Load ALL
all_data = {}
for lang in langs:
    with open(BASE / f'{lang}.json', encoding='utf-8') as f:
        all_data[lang] = json.load(f)

# Apply ALL in memory
for lang, keys in TRANS.items():
    for dotpath, val in keys.items():
        sn(all_data[lang], dotpath, val)

# Write ALL
for lang in langs:
    with open(BASE / f'{lang}.json', 'w', encoding='utf-8') as f:
        json.dump(all_data[lang], f, ensure_ascii=False, indent=2)

print('Done.')
```

### 3. Commit (namespace-enként vagy batch)

```bash
cd /mnt/h/LM_Studio_Workdir/CleanCore
cd "$QA2_WT"   # a fenti eldobható worktree, NEM a megosztott fő klón
cd "$({{INSTALL_DIR}}/store/agent-worktree.sh <a te agent-neved> --path)"
git add packages/i18n/messages/de.json packages/i18n/messages/es.json \
        packages/i18n/messages/fr.json packages/i18n/messages/it.json \
        packages/i18n/messages/pl.json
# NE git add -A -- shared checkout, más ágensek is dolgozhatnak!
# NE git add -A -- a fő klónban más ágensek is dolgozhatnak, a worktree-nek is csak a sajátodat!
# Explicit fájllista, ne `git add -A`: a saját worktree-d indexe már megvéd más ügynök
# stage-elt munkájától, de a te SAJÁT szemetedet (build-artefakt, ideiglenes fájl) még mindig
# beviheti egy -A.
git commit -m "feat(i18n): <namespace> translations — de/es/fr/it/pl"
```

### 4. Teszt

```bash
cd /mnt/h/LM_Studio_Workdir/CleanCore
cd "$QA2_WT"   # a fenti eldobható worktree, NEM a megosztott fő klón
cd "$({{INSTALL_DIR}}/store/agent-worktree.sh <a te agent-neved> --path)"
npx vitest run apps/web/src/i18n-locale-guard.test.ts
# 14/14 kell
```

## QA gate: double-brace ICU szintaxis ellenőrzés (KÖTELEZŐ, MikroB calibration 2026-07-13)

A projekt `i18next-icu`-t használ: **single-brace `{name}`** a helyes ICU formátum. A `{{name}}` dupla-brace INVALID -- runtime silently fallback-el, a placeholder nem renderel.

**Gate szabály**: minden i18n-t érintő kártya sign-off-ja ELŐTT kötelező double-brace sweep ALL 7 locale-fájlban, AZ ADOTT COMMIT-ON (nem HEAD-en!):

```python
import json, re, sys

# Futtatni: git show <sha>:packages/i18n/messages/<lang>.json | python3 <script>
data = json.load(sys.stdin)

def flat(o, p=''):
    for k, v in (o.items() if isinstance(o, dict) else []):
        key = f'{p}.{k}' if p else k
        if isinstance(v, dict): flat(v, key)
        elif isinstance(v, str) and re.search(r'\{\{', v):
            print(f'DOUBLE-BRACE INVALID: {key}={v[:80]}')
flat(data)
```

Bash wrapper (mind a 7 locale, egy commiton):
```bash
SHA=<commit>
for lang in en de es fr hu it pl; do
  echo "=== $lang ==="
  git show $SHA:packages/i18n/messages/$lang.json | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
def flat(o,p=''):
    for k,v in (o.items() if isinstance(o,dict) else []):
        key=f'{p}.{k}' if p else k
        if isinstance(v,dict): flat(v,key)
        elif isinstance(v,str) and re.search(r'\{\{',v):
            print(f'  DOUBLE-BRACE: {key}={v[:60]}')
flat(d)
print('  OK' if True else '')" 2>/dev/null
done
```

Ha BÁRMELY locale-ban `{{...}}` dupla-brace van: **FAIL**. A verdikt-kommentbe írd bele a vizsgált commit SHA-t, nem a HEAD-et.

## Új kulcsok hozzáadása mind a 7 locale-ba (rollout workflow)

Amikor új user-facing string kerül a kódba és az összes locale-ba egyszerre kell bevenni:

QA2-nél ugyanaz a worktree-szabály, mint a 2. lépésnél: `$QA2_WT`, nem a megosztott fő klón.

### Pattern: ordered-insert after anchor key

```python
import json, pathlib, os

BASE = pathlib.Path(os.environ['QA2_WT']) / 'packages/i18n/messages'
import json, pathlib

BASE = pathlib.Path('/mnt/h/LM_Studio_Workdir/CleanCore/packages/i18n/messages')
BASE = pathlib.Path(CC) / 'packages/i18n/messages'   # CC: a SAJÁT worktree-d, lásd fent

# Fordítások per locale
NEW_KEYS = {
    'en': {'newKey': 'English value', 'nested': {'a': 'A', 'b': 'B'}},
    'de': {'newKey': 'Deutsch', 'nested': {'a': 'A-de', 'b': 'B-de'}},
    'es': {'newKey': 'Español', 'nested': {'a': 'A-es', 'b': 'B-es'}},
    'fr': {'newKey': 'Français', 'nested': {'a': 'A-fr', 'b': 'B-fr'}},
    'hu': {'newKey': 'Magyar', 'nested': {'a': 'A-hu', 'b': 'B-hu'}},
    'it': {'newKey': 'Italiano', 'nested': {'a': 'A-it', 'b': 'B-it'}},
    'pl': {'newKey': 'Polski', 'nested': {'a': 'A-pl', 'b': 'B-pl'}},
}

ANCHOR_KEY = 'existingKey'  # Insert new keys AFTER this in the namespace

for lang, additions in NEW_KEYS.items():
    path = BASE / f'{lang}.json'
    with open(path, encoding='utf-8') as f:
        data = json.load(f)

    # Rebuild namespace dict preserving order, inserting after anchor
    namespace = data['parent']['namespace']  # adjust path to your namespace
    new_ns = {}
    for k, v in namespace.items():
        new_ns[k] = v
        if k == ANCHOR_KEY:
            for new_k, new_v in additions.items():
                if new_k not in new_ns:  # idempotent
                    new_ns[new_k] = new_v
    data['parent']['namespace'] = new_ns

    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'{lang}: patched')
```

### Pre-commit checklist

1. `npx vitest run packages/i18n/__tests__/messages.test.ts` -- 76/76 PASS
2. Double-brace sweep on changed commit (see QA gate below)
3. `git add packages/i18n/messages/{en,de,es,fr,hu,it,pl}.json` (ne `git add -A`)
4. Mention locale count + parity result in commit/REVIEW comment

### Translation quality: safe fallbacks by language

Short UI labels that are the same across languages (safe EN fallback -- legitimate same):
- `Type`, `Description`, `Date`, `Status`, `Total`, `Name`, `Note`, `Module`, `Contact`, `ID`, `PDF`, `CSV`
- Numbers/templates: `{count} items`, `{value}%`, `{date}`

Languages that commonly differ from EN:
- HU: almost always different (Magyar szórend + suffixes)
- PL: different (padded consonant clusters, feminine forms)
- DE: similar structure but different vocabulary + compound words
- FR/ES/IT: often cognates but different gender/ending

## Buktatók

- **`agent-worktree.sh qa2 --path` önmagában NEM elég (valós QA FAIL, kártya c4f431e4)**: a `--path` ág a szkriptben MIELŐTT bármilyen létezés-ellenőrzés/mkdir/worktree-add futna, már kiszámolja és kiírja az elméleti útvonalat, majd kilép -- tehát akkor is sikeresen (exit 0) ad vissza egy utat, ha az a könyvtár SOSE lett létrehozva. A qa2-nek nincs állandó worktree-je (`ls .../CleanCore-worktrees/` szerint nincs `qa2` könyvtár, csak backend/backend2/fron-ted/fullstack/teszter -- akik tényleg dolgoznak a klónon). Az első verzió ezt a print-only utat használta ellenőrzés nélkül: a skillt szó szerint követve `cd`/fájlírásnál azonnal elszállt (FileNotFoundError). Ezért ez a skill a fenti eldobható-worktree-HEAD-en mintát használja, nem a fejlesztő-ügynökök állandó-worktree mintáját.
- **WSL2/NTFS caching**: soha ne használj több Python processzt ugyanarra a locale fájlra. Egy session = egy processz = load-all/apply-all/write-all.
- **git add -A tilos**: shared checkout, más agent módosíthatott más fájlokat. Csak a saját i18n fájljaidat addd.
- **LEGIT_SAME false positive**: FR, IT, ES sok kognátot tartalmaz ami pontosan ugyanúgy íródik mint EN (Date, Description, Module, Finance, Photos stb.). Ezek NEM hibák. Frissítsd a LEGIT_WORDS listát ha új kategória kerül elő.
- **Plural forms**: ICU MessageFormat (`{count, plural, one {...} other {...}}`) csak akkor fordítandó, ha a szöveg valóban más (pl. PL 4 formájú plurális). FR-ben `site`/`sites` ugyanaz.
- **Template-only strings**: ha az EN value csupa `{placeholder}` és elválasztó (`{score} / 5`, `{value} m²`), ez LEGIT_SAME, nem fordítandó.
- **Stale HEAD csapda**: ha a kártya egy korábbi commit hash-t jelöl, mindig `git show <sha>:file`-lal ellenőrizz -- a HEAD-en esetleg már javítva van, de a commit-en nem volt az! (Valós eset: 4573921 double-brace volt, a1d9f96 javította; HEAD-en check = téves PASS.)

## Ellenőrzés

- `is_legit()` filter után 0 maradó violation az adott névtérben
- Double-brace sweep: 0 `{{...}}` találat mind a 7 locale-ban AZ ADOTT COMMIT SHA-N
- `i18n-locale-guard.test.ts` 14/14 passing
- Commit SHA dokumentálva a kártya kommentjében
