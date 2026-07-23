---
name: campaign-analytics
description: Kampányanalitika beállítás, audit és értelmezés -- UTM struktúra, konverzió-tracking, csatorna-attribúció, North Star metrika, riport. Triggerek: "analytics audit", "UTM", "tracking", "mi a konverziós arányom", "kampány mérés", "attribúció", "melyik csatorna teljesít".
---
# Campaign Analytics

## Mikor használd
Tracking beállításakor, meglévő analytics audit-jakor, kampányteljesítmény értelmezésekor, vagy mérési keretrendszer kialakításakor.

## Eljárás

### 1. North Star metrika meghatározása
Minden kampányhoz egy elsődleges metrika, ami az értéket méri (nem a hiúságot):

| Cél | North Star |
|---|---|
| Awareness | Egyedi látogatók (első session) |
| Lead gen | Minősített lead (MQL) |
| Trial konverzió | Trial → Aktivált user |
| Bevétel | MRR / ARR növekmény |
| Retenció | Churn rate / NRR |

Hiúságmetrika ≠ North Star: follower szám, page view (kontextus nélkül), email nyitási arány.

### 2. UTM struktúra (kötelező szabvány)
```
?utm_source=[csatorna]&utm_medium=[típus]&utm_campaign=[kampány]&utm_content=[variáns]

Példák:
utm_source: linkedin, google, newsletter, partner-cegx
utm_medium: paid, organic, email, cpc, referral
utm_campaign: launch-2026q3, vertical-office, webinar-jul10
utm_content: headline-a, cta-blue, video-30s
```

Szabályok:
- Mindig lowercase, kötőjel szóelválasztónak
- `utm_campaign` azonosítja a kampányt -- ne változtasd menet közben
- Soha ne taggelj belső linkeket (torz forrásadat)

### 3. Konverzió-tracking audit checklist
- [ ] Minden kulcs-esemény tüzelódik? (regisztráció, demo kérés, fizetés)
- [ ] Duplikált konverzió szűrve? (többszörös form submit)
- [ ] Offline konverzió importálva? (telefon, értékesítői close)
- [ ] A "thank you" oldal ellenőrizve, nem blokkol ad blocker?
- [ ] Cross-device tracking aktív (GA4 User-ID vagy azonosított session)?

### 4. Csatorna-attribúció modellek

| Modell | Logika | Mikor jó |
|---|---|---|
| Last Click | Utolsó érintkezési pont kap mindent | Rövid értékesítési ciklus |
| First Click | Első érintkezési pont kap mindent | Awareness mérése |
| Linear | Minden pont egyenlően | B2B, hosszú ciklus |
| Data-Driven | ML alapú súlyozás | Ha van elég adat (500+ konv.) |

B2B SaaS-nál: **Linear vagy Data-Driven** -- a vevő 5-8 érintkezési ponton megy keresztül.

### 5. Heti / havi kampány-riport struktúra
```
1. Összefoglaló (3 mondat): mi ment, mi nem, egy döntés szükséges
2. North Star metrika: aktuális vs. cél vs. előző időszak
3. Csatorna teljesítmény (táblázat):
   Csatorna | Költség | Kattintás | Konverzió | CAC | ROAS
4. Legfontosabb insight (1-2 db): miért változott ami változott
5. Következő lépés (konkrét): mit optimalizálunk a jövő héten
```

### 6. Gyors diagnózis -- ha valami nem stimmel
- **Magas CTR, alacsony konverzió:** Üzenet-landing page mismatch, vagy rossz közönség
- **Alacsony CTR:** Kreatív fáradt, vagy rossz targeting
- **Magas CPC:** Aukcióverseny nőtt, vagy quality score csökkent
- **Sok session, nulla konverzió:** Tracking törött, vagy UX probléma

## Kimenet
1. UTM-struktúra javasolt konvenciókkal.
2. Tracking audit checklist (pass/fail).
3. Attribúció-modell ajánlás indoklással.
4. Heti/havi riport template kitöltve, ha van adat.

## Buktatók
- Egyszerre több változtatás = nem tudod, mi hatott. Egy változó, egy időszak.
- "Sessions" mérése revenue nélkül = hiúság-metrika csapda.
- UTM szabvány következetlenség: "LinkedIn" vs. "linkedin" kétfelé split a reportban.
- Last-click B2B-ben: az email nurture kap mindent, az awareness semmiért van.

## Ellenőrzés
- Meghatározott a North Star metrika?
- Az UTM paraméterek következetesek (lowercase, kötőjel)?
- A riport tartalmaz döntési javaslatot?
- A tracking audit elvégezve a kampány indítása előtt?
