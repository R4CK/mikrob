# Dashboard mobilon (biztonságos elérés)

A Marveen dashboard alapból csak a gazdagép saját localhostján (127.0.0.1:3420) figyel, ezért telefonról közvetlenül nem érhető el. Ez a leírás bemutatja, hogyan érd el biztonságosan a dashboardot mobilról, app-szerű ikonnal.

## Biztonság röviden

A javasolt megoldás a Tailscale Serve, ami három réteget ad:

1. **Privát hálózat (tailnet)**: a dashboard csak a saját Tailscale-fiókod eszközeiről érhető el, NEM a nyílt internetről. (Ez nem a Tailscale Funnel, ami publikus lenne, hanem a Serve, ami tailnet-only.)
2. **Titkosítás + HTTPS**: a forgalom WireGuard-titkosított, és a Tailscale automatikus HTTPS-tanúsítványt ad (a PWA-hoz amúgy is kell a biztonságos kapcsolat).
3. **Hozzáférési token**: a dashboard ezen felül egy access tokent is kér. Tehát rajta KELL lenned a tailneten ÉS ismerned a tokent.

A dashboard a localhostra kötve marad; a Tailscale Serve csak proxyzza a tailnet felől a localhostra. Így nem nyitod ki a gépet a helyi hálózatra vagy a netre.

## Beállítás a gazdagépen (egyszeri)

**Automatikus út (ajánlott, kártya b68ddae8 óta).** A telepítő (`install-linux.sh` / `install-macos.sh`,
kártya 0985ac83) opcionálisan felajánlja a Tailscale telepítését -- ezt a lépést jóvá kell hagynod
(egy kérdés, mert a bejelentkezés böngészős folyamata nem automatizálható biztonságosan egy
non-interaktív telepítő-lépésből). A bejelentkezést magát és a proxy indítását utána a dashboardon,
a **Föderáció oldal → Kapcsolódási adataim** szekció **"Bejelentkezés Tailscale-lel"** gombja végzi:
elindítja a `tailscale up`-ot, felugró ablakban/linken megnyitja a bejelentkezést, majd sikeres
csatlakozás után automatikusan lefuttatja a `tailscale serve --bg` lépést és kitölti a
**Rendszer-azonosító** + **Elérési cím** mezőket -- ezeket kell átadnod a másik rendszer adminjának a
társ-párosításhoz. Nem kell terminált nyitnod vagy parancsokat futtatnod.

**Kézi út (ha a telepítőnél kihagytad a Tailscale-t, vagy fejlesztői/fallback okból CLI-t akarsz).**

1. Telepítsd a Tailscale-t a gépre, és lépj be a fiókoddal.
2. Indítsd el a proxyt:
   ```
   tailscale serve --bg 3420
   ```
   Ez a gép Tailscale-nevén HTTPS-en kiszolgálja a localhost:3420-at, csak a tailneted számára.
3. Az elérési cím: `https://<gep-neve>.<tailnet>.ts.net/` (a pontos cím: `tailscale serve status`).
4. Kikapcsolás bármikor: `tailscale serve --https=443 off`.

## Telefonon (iPhone / Android)

1. Telepítsd a Tailscale appot, lépj be UGYANAZZAL a fiókkal, és kapcsold be.
2. A böngészőben nyisd meg a hozzáférési linket a tokennel:
   `https://<gep-neve>.<tailnet>.ts.net/?token=<ACCESS_TOKEN>`
   (Az access token a gazdagépen a `store/.dashboard-token` fájlban van, illetve a dashboard indítási logja kiírja egy "Dashboard access URL" sorban.)
3. Tedd ki a kezdőképernyőre: a böngésző Megosztás menüjében "Add to Home Screen" / "Főképernyőhöz adás". Így app-ikonként indul (PWA).
4. Első indításkor a home-screen app egy token-mezőt kér (mert külön tárhelyet kap a böngészőtől). Illeszd be a TELJES linket vagy csak a tokent, a mező magától kiszedi a tokent, és bejelentkezel. Ezt csak egyszer kell.

## Kinek működik?

- A PWA (app-ikon, token-beillesztő, mobil-nézet) MINDEN telepítésben benne van alapból.
- A home-screen / app-ikon a beállított fő agent avatarját használja (ugyanaz a kép, mint a böngésző faviconja). Ha lecseréled az avatart a dashboardon, az ikon is frissül (a megszokott iOS törlés + újra hozzáadás után).
- A felület tiszteletben tartja az iOS biztonságos területeit (notch, Dynamic Island, home indicator) álló és fekvő nézetben is; notch nélküli eszközön (Android, desktop) ez nem változtat semmin.
- A biztonságos távoli mobil-elérés a fenti Tailscale-beállítást igényli a gazdagépen -- ez a Föderáció-oldal gombjával egy kattintás (lásd fent), a mögötte futó parancsokat (`tailscale up`, `tailscale serve --bg`) nem kell kézzel kiadnod. Tailscale nélkül alternatíva az azonos helyi hálózaton való elérés vagy saját VPN/tunnel.

## Buktatók

- Az iOS a home-screen ikont a hozzáadás pillanatában menti el. Ha frissül az ikon (pl. új verzió), töröld a meglévő ikont és add hozzá újra.
- A token bearer-jellegű: a tailneteden belül érvényes belépő. Tartsd a tailnetedet a saját eszközeidre korlátozva.
