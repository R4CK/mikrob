# Bash egress guard

`scripts/hooks/bash-egress-guard.py` -- PreToolUse hook, amely a Bash-parancsok **tényleges hálózati
célját** nézi, interpretertől függetlenül.

Ez a dokumentum az üzemeltetőnek szól. A mechanika és a döntések indoklása a hook saját
fejlécében van, és az a mérvadó, ha a kettő valaha eltérne.

## Mit old meg

A `settings.permissions.deny` `Bash(curl *https://*)` alakja mérhetően nem használható
(f6db6978 kártya, négy próba két kontrollal, valódi Claude Code 2.1.263 binárison): a mintaillesztés
a **teljes parancssoron** megy, tehát nem tudja megkülönböztetni a curl **célját** a payloadban
utazó bármelyik linktől. A flotta minden belső írási útja (memória, kanban-komment, inter-agent
üzenet, napi napló) egy localhost-ra menő curl, ami rutinszerűen tartalmaz linket a JSON-jében --
mind eltalálódna.

Ez a hook a célt nézi, nem a parancs szövegét, és nem csak a curl alakját (Cybered lelete: egy
csak-curl hook egy ajtót zár és négyet nyitva hagy -- `python3 -c urllib`, `node -e fetch`,
`perl -e LWP`, `bash /dev/tcp`).

## Üzemmódok

| `BASH_EGRESS_GUARD` | viselkedés |
| --- | --- |
| *nincs beállítva* | **`log`** -- soha nem blokkol, csak ír a `store/bash-egress.log`-ba. **Ez a szállított alapértelmezés.** |
| `enforce` | blokkol |
| `off` | kill-switch, a hook azonnal visszatér |

Egyszeri kivétel egy parancsra: `BASH_EGRESS_ALLOW=1 <parancs>` (greppelhető, és csak a **saját**
egyszerű parancsára vonatkozik, nem a sor többi részére).

**Miért log-only az alapértelmezés.** A korpuszmérés szerint a flotta 874 205 hálózati parancsából
845 777 (96,7%) localhost -- beleértve minden csatornát, amin egy hibát jelezni lehetne. Egy 1%-os
detektálási hiba ~8 458 legitim belső hívást ölne meg csendben, azon a csatornán, amin a panasz
utazna. Ezért a napló az, ami eldönti, mikor szabad `enforce`-ra kapcsolni, nem a bizalom.

**Mielőtt `enforce`-ra kapcsolsz:** olvasd el a naplót, és nézd meg, mely hostok jönnek elő
ismételten. Ami legitim, vedd fel az allowlistára; ami feloldhatatlan cél (változó a host helyén),
azt a hívó írja át literálra. A mért kiindulási állapot lent, a „Mért hatás" szakaszban.

## Allowlist

`store/bash-egress-allowlist.json`, verziókövetett, minden hívásnál újraolvasva -- egy engedély
azonnal hat, nincs újraindítás és nincs deploy.

```json
{ "hosts": ["api.github.com", "api.telegram.org"] }
```

- A localhost **nincs** benne: az beépített szabály, nem engedély.
- Egy host önmagát és az aldomainjeit engedi: `example.com` engedi az `api.example.com`-ot is.
  Nem részsztring-illesztés: az `evilexample.com` **nem** felel meg az `example.com`-nak.
- Hiányzó vagy hibás fájl = **nulla engedély** (csak localhost). A fájl elvesztése soha nem
  szélesíti, amit szabad -- csak engedélyeket vesz el, ami a biztonságos irány.

Külön fájl, nem a `store/egress-allowlist.json` (a WebFetch-kapué), szándékosan: ott egy host
felvétele azt jelenti, hogy a modell **karanténon kívül** olvashat onnan tartalmat. Ha a két lista
egy lenne, egy curl-höz adott engedély csendben megnyitná a karantén nélküli tartalomcsatornát is.
Két döntés, két lista.

## Hatókör -- kimondva, hogy ez a doksi ne állíthasson többet a valóságnál

**Lefedve:** a Bash-tool `curl` / `wget` / `nc` / `ncat` / `netcat` / `telnet` / `socat` hívásai,
az olyan interpreter-egysorosok (`python3 -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`,
`deno`/`bun eval`), amelyek **megneveznek egy hálózati API-t**, valamint a `/dev/tcp` és `/dev/udp`.

**NEM lefedve, szándékosan és néven nevezve:**

- `ssh`, `scp`, `rsync`, `git`, `npm`/`pnpm`/`yarn`, `pip`, `docker`, `apt` -- mind elér a hálózatra,
  és egyiket sem kapuzza ez a hook.
- Interpreter, ami **fájlt futtat** (`python3 script.py`): a kód nincs benne a parancssorban, tehát
  nincs mit elemezni. Ez a hook parancssorokat lát, nem programokat.
- Interpreter-egysoros, aminek a **teljes szövege változóból** jön (`python3 -c "$SCRIPT"`,
  `bash -c "$CMD"`): nincs kimutatható hálózati szándék, tehát nincs mire fail-closed-ot alapozni
  (lásd lent az 5a. pontot).
- Bármi a Bash-toolon kívül. A WebFetch és az MCP fetch-toolok külön kapun mennek
  (`scripts/hooks/egress-gate.mjs`), ami viszont a Bash-t **nem** fedi -- a kettő diszjunkt.

## Ami a cél, és ami csak úgy NÉZ KI

Három gate-lelet egy körben (Cybersec NO-GO + QA FAIL, 2026-09-13) mind ugyanarra a tengelyre
esett, és Cybersec így is fogalmazta meg: **a kapcsolat tényleges célja eltér attól, amit az URL
szövege mutat.** Ezért a kapu nem az URL szövegét nézi, hanem azt, hova megy a kapcsolat:

**1. Az authority az első `/`, `?` VAGY `#` karakternél ér véget (RFC 3986).** Csak `/`-re vágva a
`user@host` szétválasztás belenyúlt a query/fragment belsejébe, és onnan vette a hostot:
`http://evil.example.org#@api.github.com/` allowlistásnak látszott, miközben a curl az
`evil.example.org`-hoz csatlakozik (a fragmentet el sem küldi). A `#@localhost/` alak a legrosszabb
volt: LOCAL-nak minősült, tehát log-only módban **nyom nélkül** maradt volna.

**2. A cél átirányító kapcsolók UNRESOLVED-ot adnak (fail-closed):**
`--resolve`, `--connect-to`, `--dns-servers`, `--doh-url`, `-K`/`--config`, és wget-oldalon
`--input-file`/`-i` és `-e`/`--execute`. A `curl --resolve api.github.com:443:203.0.113.99` az URL-ben
allowlistás hostnevet hagy, miközben a TCP-kapcsolat tetszőleges IP-re megy. A `--resolve` korábban
az „adatot hordoz" táblában ült, tehát a kapu **csendben lenyelte** -- ez rosszabb, mint nem ismerni
a kapcsolót, mert kezeltnek látszott.

**3. A `--proxy`/`-x`/`--socks*` ennél erősebb választ kap:** ezek önálló célként ítélődnek meg az
allowlist ellen, mert egy proxy VALÓBAN az a host, ahova a kapcsolat megy, és ott áll a soron.

**4. A `--url` (és `--url=`) a célt a saját kapcsolójából olvassa ki**, mindkét alakban, mindkét
irányban -- tehát nem elutasítás, hanem megítélés. Ez **nem volt harmadik hiba**: lemértem, hogy már
helyesen blokkolt, és Cybersec is újramérte és visszavonta a felvetést. Amit viszont jelent: egy
**második hívási út** az 1. ponthoz -- a `--url http://evil.example.org#@api.github.com/` ugyanazon
az úton ment át, tehát ugyanaz a javítás zárja, és a regressziós esetek ezt is rögzítik.

Ennek a mérhető ára a korpuszon: `--resolve` 570, `--connect-to` 210, wget `-e`/`--execute` 30
előfordulás -- ezek mostantól fail-closed-ot kapnak. A `--dns-servers` és `--doh-url` nulla
előfordulású; azért vannak lefedve, mert ugyanaz a tengely, és egy kapu, ami négyből kettőt nevez
meg, miközben a doksi zárt szobát állít, pontosan az a hibaosztály, amiért ez a kártya létezik.

## A fail-closed költségnövelés, nem bizonyítható garancia

Ha egy parancsnak kimutatható hálózati szándéka van, de a célja nem oldható fel -- a URL változóban
van, base64-ből jön, pipe-on érkezik, konfigfájlból olvasódik --, a hook inkább visszautasítja, mint
hogy találgasson. Ez **megdrágítja** egy külső cél elrejtését; nem teszi lehetetlenné. Aki „blokkolt"
sort lát a naplóban, azt úgy olvassa, hogy „ez az alak mostantól egy lépéssel többe kerül", nem
úgy, hogy „az egress zárva".

Két korlát, amit külön érdemes érteni:

1. A fail-closed **kizárólag** a kimutatott hálózati szándékra vonatkozik (verdikt 5a). A korpuszban
   551 816 olyan interpreter-hívás van, amiben nincs hálózati API -- ezeket a hook meg sem vizsgálja.
   Ha a fail-closed az „interpreter" tényre szólna, fél millió legitim parancsot ölne meg.
2. A **fájlba írás nem hívás** (verdikt 5b). Egy heredoc, ami egy curl-sort ír egy fájlba, nem
   hálózati hívás -- a korpuszban 3 165 ilyen van. Ez az osztályozás **első** lépése, nem utólagos
   szűrés, mert ugyanez a payload-vs-cél összetévesztés háromszor futott át korábban a mérésen.

## Mért hatás a valódi korpuszon

A hookot lefuttattam a flotta teljes parancs-korpuszán (12 675 session-transcript,
**2 934 009** Bash-parancs, 175 197 egyedi alak), `enforce` módot szimulálva. A mérés maga találta
meg a hook öt hibáját -- nem a kód olvasása:

| verzió | blokkolna | mi derült ki |
| --- | --- | --- |
| első | 94 470 (3,22%) | `2>/dev/null` fd-száma hostnak olvasva (21 015); a `\`+újsor sor-folytatás literálisan a szóba ragadva; a *teljes szó* feloldhatatlannak véve, pedig csak az útvonalban volt változó (62 445) |
| tokenizer-javítás után | 13 365 (0,46%) | a heredoc helyére tett helyőrző-szó curl-operandussá vált (4 725) |
| helyőrző eltávolítva | 8 880 (0,30%) | a bare `urllib` marker a tisztán string-műveletes `urllib.parse`-ra is illeszkedett (225); a DNS-feloldó hívások célja nem volt kinyerve, ezért cél nélküli fail-closed lett belőlük (225) |
| első gate-kör előtt | 8 625 (0,294%) | ezen a kódon jött a Cybersec NO-GO és a QA FAIL |
| **szállított állapot** | **8 715 (0,297%)** | a két gate-javítás után; lásd a bontást lent |

A megmaradó 8 715 (a 2,93 millióból) bontása:

| osztály | db | mi ez |
| --- | --- | --- |
| a cél HOSTJA változóban | 5 385 | `for ep in ...; do curl "$BASE$ep"` alakok: valódi feloldhatatlanság, a vállalt fail-closed ár |
| valódi külső cél, nincs allowlistán | 1 770 | `pypi.org`, `huggingface.co`, `registry-1.docker.io`, `dns.google`, `tailscale.com`, `crt.sh` stb.: **üzemeltetői döntés**, ezért indul a hook log-only módban |
| a cél külső fájlból vagy átirányítva | 795 | `-K`/`--config`, `--resolve`, `--connect-to`, wget `-e`: a hook nem látja, hova megy a kapcsolat |
| hálózati egysoros, nem literál cél | 735 | pl. változóból összerakott URL egy `python3 -c` belsejében |
| hostnév nem fejthető ki | 30 | |

A két gate-javítás nettó ára **+60 hívás** (8 655 -> 8 715, 0,002 százalékpont): a
`--resolve`/`--connect-to`/wget `-e` előfordulások nagyobbik része már amúgy is elakadt volna más
okból. Az authority-javítás **nem** mozdította az arányt (a 8 625 -> 8 655 különbség a korpusz saját
növekedése volt két mérés között, nem új elutasítás), vagyis egy valódi biztonsági inverziót zártunk
le mérhető üzemeltetői költség nélkül.

**Két találat, ami elsőre hamis pozitívnak látszott, valójában valódi.** A `a` és `table` „hostok"
(75 hívás) olyan parancsokból jönnek, ahol a `-d '{...}'` JSON-payload tartalmazott egy aposztrófot,
ami lezárta az idézőjelet -- így a próza egy része tényleg **curl-operandussá** vált, és a curl
tényleg megpróbálta lekérni. A bash ugyanígy látja; a hook nem tévedett, a parancs volt hibás.

## Napló

`store/bash-egress.log`, JSON-soronként, `0600` jogosultsággal (a fájlt maga a hook hozza létre,
tehát a mód a miénk -- ellentétben egy shell-átirányítással, ahol a hívó shell hozza létre előbb).
A `-u` / `--user` / `--password` / `Authorization:` értékek redaktálva.

```bash
tail -f /home/neon/marveen/store/bash-egress.log
```

## Ellenőrzés

```bash
python3 scripts/hooks/bash-egress-guard.selftest.py
```

A selftest a landolási teszt-suite-ból is fut (`src/__tests__/bash-egress-guard-wiring.test.ts`),
ami ezen felül azt is rögzíti, hogy a hook **mindkét** bekötési úton (settings-generálás ÉS boot-kori
backfill) meg van-e, és hogy az alapértelmezés log-only maradt-e.
