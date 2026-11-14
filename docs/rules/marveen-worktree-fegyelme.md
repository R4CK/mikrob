## Marveen repo saját-worktree fegyelme -- SZABÁLY (Peti 2026-08-17, kártya dc185b52)

A marveen repo (ez a checkout) EGYETLEN megosztott working tree-t oszt meg AZ ÖSSZES ügynökkel volt --
ez okozta a `dc185b52` incidenst (backend2 stage-elt fájljait QA commitja szippantotta be és
pusholta, backend2 sajat gate nelkul landolt). Az ELSŐ próbált javítás (könnyű per-agent BRANCH a
megosztott fán, `store/agent-branch.sh`) WhiteHat élő reprodukcióval bizonyított NO-GO-t kapott
(komment 14284): a branch-váltó `git checkout` a MEGOSZTOTT working tree-n futott, és egy MÁSIK,
egyidejűleg sima Read/Edit/Write-tal dolgozó ügynök (nem maga hívta a scriptet) a checkout
alatt/után a RÉGI, már beolvasott tartalom alapján visszaírt egy fájlt -- ez CSENDESEN, hibaüzenet
nélkül felülírta egy másik ügynök MÁR COMMITOLT branch-tartalmát. Rosszabb mint az eredeti incidens
(ott a tartalom megmaradt, csak rossz SHA alatt landolt -- itt csendben eltűnhet). MikroB
visszavonta a plan-grilling döntést (komment 14285): **teljes per-agent worktree-izoláció kell,
a CleanCore `agent-worktree.sh` mintájának általánosításával** -- ez STRUKTURÁLISAN zárja ki a
versenyt (saját index, saját checkoutolt fájlok), nem fegyelemmel.

**A függőség-könyvtár alakja marveen-en (kártya 0b23ec28).** A worktree függőség-könyvtára eddig KÖNYVTÁR-SZIMLINK volt a fő klónba, és ez az enabler a `9dc0fba8` hibaosztály mögött: egy `cd <worktree>/<dep-dir> && rm -rf ../src` a MEGOSZTOTT klón forrását törli, mert a `cd` a feloldott könyvtárba visz, tehát a `..` már a fő klónban van. A `store/agent-worktree-deps.sh <neved>` VALÓDI könyvtárrá alakítja (idempotens; `--check` csak jelent, nem módosít) -- ez az egyetlen alak, amiből a `..` nem tud kilépni; a bejegyzésenkénti szimlink csak eggyel mélyebbre tolja a kijáratot (318 csomag = 318 ajtó). **Egyelőre OPT-IN**, és a rollout szándékosan worktree-nként történik, nem sweepben, mert 15 élő fán más ügynökök munka közben vannak: az `agent-worktree-marveen.sh` alapból továbbra is linkel, és kiírja, mivel teheted valódivá (`MARVEEN_WORKTREE_REAL_DEPS=1` létrehozáskor).

**Következmény a telepítőkre MARVEEN-en (a mopsion-szabály NEM változik).** Amíg szimlink, a fenti mopsion-szabály áll: telepítő nem futhat a worktree-ből, mert a közös fát írná át. **Miután `agent-worktree-deps.sh`-val valódi könyvtárrá tetted, ez a tilalom ERRE a worktree-re megszűnik** -- az `npm` ott a sajátját írja, senki máséit. A `--check` megmondja, melyik állapotban vagy; ha nem tudod, futtasd le, ne találgass. A mopsion-oldal (`store/agent-worktree.sh`, per-package linkek) EGYELŐRE VÁLTOZATLAN, ott a tilalom teljes erővel áll.

1. `bash store/agent-worktree-marveen.sh <neved>` -- saját worktree létrehozása/frissítése
   (`/home/neon/marveen-agent-worktrees/<neved>`, branch `agent/<neved>/work`), idempotens. **A
   TELJES munkamenetre érvényes, nem csak commit előtt**: az adott ponttól kezdve MINDEN
   Read/Edit/Write/Bash, ami marveen-repo fájlt érint, ebben a könyvtárban történjen, nem
   `/home/neon/marveen`-ben közvetlenül -- az útvonalat mindig a scripttől kérdezd le
   (`--path`), sose írd be fixen.
2. Commit a saját worktree-dben (szokásos safe-commit fegyelem is ráfér, bár a saját index miatt
   már redundáns védelem: nincs `git add -A`, `git diff --staged` ellenőrzés stb.).
3. `bash store/marveen-land.sh <neved>` -- a saját branch-et egy ELDOBHATÓ, KÜLÖN worktree-ben
   mergeli `develop`-ba (seam-check mindkét irányban), a MERGE EREDMÉNYÉN lefuttatja a
   `store/fleet-test.sh`-t, csak zöld esetén pusholja `origin/develop`-ra. A visszaadott sha a
   Gate-SHA -- REVIEW előtt ez legyen meg, ne a lokális branch-commit shája. A saját worktree-d NEM
   resetelődik automatikusan landolás után (mint a mopsion landoló scriptje sem teszi) -- szinkronizáld
   kézzel, ha akarod.

MikroB-vezérelt periodikus háló (backstop, nem elsődleges út): `bash store/marveen-land.sh --all`
végigsöpri az összes `agent/*/work` branch-et, amit a tulajdonos még nem landolt saját maga -- ezt
egy ütemezett feladat futtathatja, hasonlóan a `gate-reconciler`-hez.

**A `store/agent-branch.sh` és `store/agent-branch-land.sh` RETIRÁLVA (törölve) -- ne hivatkozz
rájuk, ne próbáld újraéleszteni.**
