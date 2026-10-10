---
name: atomic-fact-gate-protocol
description: Atomic-fact verification + consensus protocol for the 3-gate pool (QA/WhiteHat/RedHat). Use when gating any card: decompose builder claims into atomic, independently verifiable facts. Green tests alone are NOT proof. Implements the "zold-teszt != bizonyitek" principle from the magic-link incident (151/151 green, 2 MAJOR bugs).
---
# Atomic-fact Gate Protocol

## Mikor használd

Minden gate-elésnél (QA, WhiteHat, RedHat). A builder REVIEW kommentjében állításokat tesz ("X müxik",
"Y tesztelve van", "Z guard érvényes"). Ez a protokoll kötelezi a gate-et arra, hogy ezeket az állításokat
atomi tényekre bontsa és MINDEGYIKET külön igazolja.

**Trigger**: ha egy REVIEW kommentet olvasol, ez a protokoll fut.

## Az atomic-fact alapelv

Egy állítás (claim) = több atomi tény összessége.  
Egy atomi tény = egy lépésben, önállóan ellenőrizhető, konkrét bizonyítékkal igazolható.

Claim elfogadva, ha: MINDEN atom ≥ VERIFIED vagy UNTESTABLE (indokkal).  
Egy FAILED atom = GATE FAIL, akkor is, ha a tesztek zöldek.

## Protokoll lépései

1. **Claim kinyerése**: a REVIEW kommentből listázd az összes állítást (kiemelten: "X tesztelve", "Y guard van", "Z idempotens", "W rollback pont mentve").

2. **Atom decomposition**: minden claimhez 3-5 atomi tényt határozz meg.
   - Atom = pontosan egy paranccsal / grep-pel / git show-val ellenőrizhető
   - Ha egy "atom" maga is több lépést igényel, bontsd tovább

3. **Bizonyíték gyűjtés**: minden atomhoz futtasd le a verifikáló parancsot, rögzítsd az outputot.
   - Soha ne vegyél át git show-t az állításból -- futtasd magad
   - Soha ne working tree: `git show <sha>:path/file`

4. **Atom státusz**:
   - `VERIFIED` -- parancs outputja igazolja az atomot
   - `FAILED` -- parancs outputja cáfolja / hiányt mutat
   - `UNTESTABLE` -- objektíve nem ellenőrizhető e2e nélkül (indok kötelező: miért és mit jelent ez a kockázatból)

5. **Gate verdikt**:
   - PASS: minden atom VERIFIED vagy UNTESTABLE (indokkal)
   - FAIL: bármelyik atom FAILED -- konkrét reprodukálható lépéssel

## Atom-sablon formátum (verdikt kommentben)

```
## Atomic-fact verifikáció

**Claim**: "Az auth guard minden /api/X endpoint előtt fut"

| Atom | Ellenőrzés | Státusz |
|------|-----------|---------|
| `authorize(ctx, Action.X)` létezik a handlerben | `git show <sha>:path/handler.ts \| grep authorize` | VERIFIED |
| ELSŐ hívás (adat-hozzáférés előtt) | `git show <sha>:path/handler.ts \| head -20` | VERIFIED |
| 401 teszt létezik az Action-re | `git show <sha>:path/handler.test.ts \| grep 403\|401` | FAILED |

Atom 3 FAILED -> QA FAIL. A 401 eset nincs tesztelve.
```

## Consensus (3-gate pool)

Minden gate FÜGGETLENÜL dekomponálja a claimeket, saját lencsén át:

| Gate | Lens | Atom-fókusz |
|------|------|-------------|
| **QA** | funkcionális helyesség | viselkedés, edge case, regresszió, i18n, RBAC |
| **WhiteHat** | trust-boundary | auth bypass, injekció, scope szivárgás, enum |
| **RedHat** | assume-breach | kill-chain, worst-case lánc, deception detectability |

Fontos: a gate-ek NEM látják egymás verdiktjeit a saját gate-elés alatt (anchoring bias elkerülése).
Ha WhiteHat talál egy FAILED atomot amit QA nem -- ez EXPECTED és helyes (különböző lencse).
A saját lencséden kívüli atomot ne blokkolj: jelezd, de ne tedd QA FAIL-lé ha az kizárólag WhiteHat hatásköre.

## Magic-link retrospektív (referencia validáció)

151/151 zöld teszt, 2 MAJOR bug. Mi maradt verifikálatlan?

| Claim | Hiányzó atom | Oka |
|-------|-------------|-----|
| "Token auth müxik" | Token nem használható más email-re | Nincs negatív test az email-mismatch esetre |
| "Superadmin login biztonságos" | Superadmin token el van-e izolálva a tenant-user token táblától | Különálló tábla tény volt, de az izoláció nem volt tesztelve |

Következmény: a 151 teszt mind a HAPPY PATH-t fedte. Az atomi verifikáció kötelezte volna a gate-et arra,
hogy a "token nem használható X nélkül" típusú negatív atomokat is letesztelje.

## Referencia: common claim decompositions

Részletes sablon-lista -> `references/atomic-fact.md`
