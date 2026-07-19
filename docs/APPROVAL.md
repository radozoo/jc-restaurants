# Schvaľovanie návrhov reštaurácií

Kolegovia posielajú tipy cez tlačidlo **„Navrhnout podnik"**. Vo formulári je povinný len
**názov** a **odkaz na Google Maps**; všetko ostatné je nepovinné a doplní sa pri
schvaľovaní. Tento dokument popisuje, ako z čakajúceho návrhu spraviť ostrú reštauráciu.

> **Zdroj pravdy:** schválené reštaurácie žijú **iba v Supabase**, nie v pôvodnom Exceli.
> Re-import z Excelu (`npm run import`) ich nezmaže — upsert podľa mena len aktualizuje
> zhody — ale nové restiky v Exceli nebudú. S tým počítaj.

## Rýchly prehľad

```
kolega → formulár → suggestions (pending)
                         │
      npm run suggestions:list            ← pozri, čo čaká
      npm run suggestions:list -- --json  ← export do suggestions-pending.json
                         │
      obohatenie cez Claude (viz nižšie)  → suggestions-enriched.json
                         │
      npm run suggestions:approve -- suggestions-enriched.json
                         │
                 restaurants (live) + suggestion označený approved
```

Všetky príkazy sa púšťajú z priečinka `scripts/` (potrebujú `.env` so `SUPABASE_URL` a
`SUPABASE_SERVICE_ROLE_KEY` — service key nikdy necommitovať).

## Krok za krokom

### 1. Pozri, čo čaká

```bash
cd scripts
npm run suggestions:list
```

Vypíše čakajúce návrhy vrátane `id`, odkazu na mapu a toho, čo kolega vyplnil.

### 2. Export na obohatenie

```bash
npm run suggestions:list -- --json
```

Zapíše čakajúce návrhy do `scripts/suggestions-pending.json` (súbor je v `.gitignore`).

### 3. Obohatenie (robí Claude)

V Claude Code povedz **„schvál návrhy"** (alebo „obohať `suggestions-pending.json`").
Claude pre každý návrh:

1. **Rozresolvuje Google Maps odkaz** a overí, že vedie na existujúci podnik.
   - Presné súradnice sa berú z `!3d{lat}!4d{lng}` v odkaze — **nie** z `@lat,lng` (to je
     stred výrezu mapy, systémovo posunutý; overené).
   - Mŕtvy/nevalidný odkaz → návrh sa **nahlási a preskočí**, neimportuje sa.
2. **Doplní chýbajúce atribúty** webovým výskumom (rovnaká metodika ako pri pôvodných 53):
   - `website_url`, `daily_menu_url`, `rating`, `price_tier`, `cuisine_type`.
3. **Spracuje vstup kolegu ako materiál, nie ako finálny text:**
   - **Popis** — osobný/1. osobou písaný text prepíše do katalógového tónu, ako zvyšok
     zoznamu. Originál ostáva v `suggestions.description`, do `restaurants` ide uhladená
     verzia.
   - **Vlastný typ kuchyne** — normalizuje tak, aby ho `categorize()` rozpoznal (napr.
     „vietnamská" → typ, ktorý nespadne do „Ostatní"). Ak treba, rozšír `CATEGORY_RULES`
     v `manage-suggestions.mjs` aj `import-restaurants.mjs`.
   - **Tagy** — vybrané tagy sa **nikdy neodoberajú**; obohatenie môže len navrhnúť
     doplnenie chýbajúcich podľa kritérií nižšie.
4. **Ukáže súhrn na potvrdenie** vo formáte „kolega zadal X → navrhujem Y". Rozhoduješ ty.
5. Po potvrdení zapíše `scripts/suggestions-enriched.json`.

Formát obohateného JSON (pole objektov) — kľúče, ktoré `approve` číta:

```json
[
  {
    "id": "uuid-z-pôvodného-návrhu",
    "name": "Název podniku",
    "maps_url": "https://maps.app.goo.gl/…",
    "lat": 50.08290,
    "lng": 14.43040,
    "rating": 4.5,
    "price_tier": "€€",
    "cuisine_type": "Vietnamese",
    "category": "Asijská",
    "website_url": "https://…",
    "daily_menu_url": "https://…",
    "description": "Uhlazený český popis…",
    "tags": ["Rychlý oběd", "Budget option"]
  }
]
```

- `id` je dôležité — podľa neho sa pôvodný návrh označí `approved`.
- `lat`/`lng` sú povinné; bez nich `approve` záznam preskočí.
- `category` je nepovinná — ak chýba, odvodí sa z `cuisine_type` cez `categorize()`.

### 4. Schválenie

```bash
npm run suggestions:approve -- suggestions-enriched.json
```

Pre každý záznam: skontroluje kolíziu mena s existujúcou reštauráciou (**zhodu preskočí a
nahlási** — nikdy neprepisuje existujúci riadok), vloží do `restaurants` vrátane súradníc,
a pôvodný návrh označí `approved`. Nové restiky sú hneď naživo — stačí obnoviť appku.

### Zamietnutie

```bash
npm run suggestions:reject -- <id-návrhu>
```

---

## Návrhy úprav existujúcich reštaurácií

Kolegovia môžu navrhnúť opravu ktoréhokoľvek poľa existujúcej reštaurácie — na karte cez
ceruzku vpravo hore (objaví sa pri prejdení myšou / po kliknutí na kartu). Formulár je
predvyplnený súčasnými hodnotami; odošlú sa **len zmenené polia**. Ukladajú sa do tabuľky
`restaurant_edits` (odkaz na reštauráciu cez `restaurant_id`, zmeny v JSONB `changes`).

Schvaľovanie beží podobne ako pri nových podnikoch:

```bash
cd scripts
npm run edits:list                # ľudsky čitateľný diff: súčasná → navrhovaná hodnota
npm run edits:list -- --json      # export → edits-pending.json (na kontrolu / prepočet)
npm run edits:approve -- edits-pending.json
npm run edits:reject -- <id-úpravy>
```

**Čo robí `approve`:** aplikuje `changes` na reštauráciu cez **UPDATE podľa `id`** (takže
úprava názvu je bezpečná — srdiečka viazané na `restaurant_id` prežijú). Automaticky:
- zmena `cuisine_type` → prepočíta `category` (rovnaké `CATEGORY_RULES` ako import),
- zmena `maps_url` → potrebuje nové `lat`/`lng`. Pri kontrole (`--json`) rozresluj nový pin
  (`!3d…!4d…`, **nie** `@lat,lng`) a doplň `lat`/`lng` do JSON pred `approve`. Ak sa
  `maps_url` zmenil a súradnice nedodáš, hodnota sa zapíše, ale súradnice ostanú staré
  (skript to nahlási).

Formát `edits-pending.json` (pole objektov) — kľúče, ktoré `approve` číta:

```json
[
  {
    "id": "uuid-úpravy",
    "restaurant_id": "uuid-reštaurácie",
    "restaurant_name": "Název",
    "changes": { "price_tier": "€€€", "website_url": "https://…" },
    "current": { "price_tier": "€€", "website_url": null },
    "lat": 50.08290,
    "lng": 14.43040
  }
]
```

- `changes` obsahuje len zmenené polia; povolené sú: `name`, `maps_url`, `cuisine_type`,
  `price_tier`, `website_url`, `daily_menu_url`, `description`, `tags`.
- `lat`/`lng` doplň **iba** ak sa mení `maps_url`.
- `current` je len kontext pre kontrolu (skript ho ignoruje).

Popis môžeš pri kontrole uhladiť do katalógového tónu (rovnako ako pri nových podnikoch).

## Kritériá tagov

Sedem tagov (anglické názvy), priraď konzervatívne (radšej nechať bez tagu než dať
nesediaci). Kolegom vybrané tagy sa zachovávajú; toto je návod na *doplnenie* chýbajúcich.

| Tag | Kedy priradiť |
|---|---|
| **Quick lunch** | Rýchla obsluha / bufet / objednávka pri pulte / fast-casual — sadneš, ješ, ideš. Typicky aj „budget". |
| **Self-service** | Samoobsluha / kantýna — berieš si tácku, vyberáš pri pulte (napr. Havelská Koruna, Jídelna Světozor). |
| **Budget option** | Cenová hladina €, alebo výslovne lacné denné menu / porcie do ~200 Kč. |
| **Vegetarian/Vegan options** | Výrazná vegetariánska/vegánska ponuka (nie len jeden šalát) — indická, blízkovýchodná, dedikované veggie menu. |
| **Business lunch** | Vhodné na pracovný obed s klientom — pokojnejšie prostredie, obsluha k stolu, reprezentatívne, stredná+ cena. |
| **Gourmet experience** | Fine dining, degustačné menu, Michelin/ambiciózna kuchyňa, zážitkové jedlo. Typicky €€€–€€€€. |
| **Good wine selection** | Vinárna, alebo podnik s explicitne zdôrazneným vínnym lístkom. |

Kritériá sú zámerne uvoľnené (schválené pri tagovaní pôvodných 53) — ak popis/cena/typ
kuchyne rozumne sedí, tag pokojne priraď.
