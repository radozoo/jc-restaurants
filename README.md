# Kam vyrazit na oběd? 🍽️

Interní obědový průvodce **Joyful Craftsmen** — restaurace v okolí kanceláří na Olivově (Nové Město, Praha).
Statická webová appka (jeden `index.html`) na GitHub Pages, s Supabase (zdarma) pro sdílená data.

Nahrazuje starý Tableau dashboard. Funkce: hledání, filtry (kuchyně / cena / hodnocení / vzdálenost),
řazení, mapa (Leaflet + OpenStreetMap), sdílená ❤️ oblíbená a formulář „Navrhnout podnik".

---

## Jak to funguje (architektura)

- **Frontend:** jediný statický `index.html` (žádný build step). Hostí se na GitHub Pages.
- **Data:** Supabase (Postgres, free tier). Frontend čte/zapisuje přes **veřejný anon klíč** — data chrání
  Row Level Security (RLS), ne skrývání klíče.
  - `restaurants` — jen ke čtení (edituješ v Supabase Table Editoru)
  - `favorites` — čtení/vložení/smazání (sdílená ❤️)
  - `suggestions` — jen vložení (návrhy kolegů; schvaluješ v dashboardu)
- **Mapa:** Leaflet + dlaždice CARTO/OSM (bez API klíče).
- **Identita:** bez hesla — jméno se uloží v prohlížeči a připojí se k ❤️.

---

## První nastavení (jednorázově, ~15 minut)

### 1. Vytvoř Supabase projekt
1. Založ účet na <https://supabase.com> → **New project** (region klidně Frankfurt/EU).
2. Až se projekt vytvoří, jdi do **Project Settings → API** a poznamenej si:
   - **Project URL** (např. `https://abcdxyz.supabase.co`)
   - **anon public** klíč (dlouhý JWT) — je veřejný, půjde do `index.html`
   - **service_role** klíč (tajný!) — půjde jen do lokálního `.env` pro skripty

### 2. Vytvoř tabulky + RLS
V Supabase: **SQL Editor → New query** → vlož obsah [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
Tím vzniknou tabulky `restaurants`, `favorites`, `suggestions` a bezpečnostní politiky.

### 3. Nahraj data z Excelu + geokóduj
Excel [`Karel_Vaclavak_Prague_Restaurants_Guide.xlsx`](Karel_Vaclavak_Prague_Restaurants_Guide.xlsx)
je zdroj dat. (Volitelně do něj přidej sloupce **Web** a **Denní menu** — import je pozná.)

```bash
cd scripts
cp .env.example .env          # vyplň SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm install
npm run import                # nahraje restaurace do Supabase (idempotentní)
npm run geocode               # doplní souřadnice pro mapu (přes OpenStreetMap Nominatim)
```

> `npm run import` lze pouštět opakovaně — aktualizuje podle názvu a nesmaže oblíbená.
> `npm run geocode` doplní jen chybějící souřadnice; pár nepřesností dolaď ručně v Table Editoru
> (sloupce `lat` / `lng`).

### 4. Napoj frontend
Otevři [`index.html`](index.html), najdi blok `CONFIG` (hned nahoře ve `<script>`) a vyplň:

```js
var CONFIG = {
  SUPABASE_URL: 'https://TVUJ-PROJEKT.supabase.co',
  SUPABASE_ANON_KEY: 'tvuj-verejny-anon-klic',
  OFFICE: { lat: 50.08360, lng: 14.42970, label: 'Olivova 4, Nové Město' }
};
```

> Souřadnice `OFFICE` klidně dolaď, ať modrá tečka sedí přesně na budově.
> Anon klíč je veřejný záměrně — bezpečnost řeší RLS z kroku 2.

### 5. Vyzkoušej lokálně
```bash
# z kořene projektu
python3 -m http.server 8000
# otevři http://localhost:8000
```

### 6. Nasaď na GitHub Pages
1. Vytvoř repo na GitHubu a pushni tenhle projekt.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, zvol větev
   (`main`) a složku `/ (root)`. Ulož.
3. Za chvíli poběží na `https://<ty>.github.io/<nazev-repa>/`.

---

## Běžný provoz

| Úloha | Kde |
|------|-----|
| Přidat / upravit restauraci | Supabase → **Table Editor → restaurants** (vyplň i `category` pro filtr) |
| Schválit návrh kolegy | Supabase → **Table Editor → suggestions** → zkopíruj dobrý řádek do `restaurants`, nastav `status = approved` |
| Doplnit souřadnice nové restaurace | znovu `npm run geocode`, nebo ručně `lat`/`lng` v Table Editoru |
| Změnit vzhled / texty | uprav `index.html` a pushni |

### Pole `category` vs `cuisine_type`
- `cuisine_type` = volný, detailní popis (zobrazuje se na kartě, např. „Japanese / Ramen").
- `category` = **kurátorovaný koš pro filtr** (např. „Japonská"). Drž jich pár (~10–15).
  Import ho odhadne automaticky; u nových/návrhů ho nastav ručně. Neznámé spadnou do „Ostatní".

---

## Struktura projektu

```
index.html                      # celá appka (jeden soubor)
supabase/schema.sql             # tabulky + RLS (spusť jednou v SQL Editoru)
scripts/
  import-restaurants.mjs        # Excel → Supabase (npm run import)
  geocode-restaurants.mjs       # souřadnice přes Nominatim (npm run geocode)
  .env.example                  # šablona pro SUPABASE_URL + service_role klíč
Karel_Vaclavak_Prague_Restaurants_Guide.xlsx   # zdroj dat
docs/                           # brainstorm + plán
```

## Bezpečnost — na co si dát pozor
- **Nikdy** nedávej `service_role` klíč do `index.html` ani do repa. Patří jen do `scripts/.env` (gitignored).
- Anon klíč v `index.html` je OK (veřejný). Vše drží RLS ze `schema.sql`.
- Nejhorší, co může kdokoli s anon klíčem udělat, je zaspamovat `suggestions` — což prostě ignoruješ.
  Do `restaurants` se z frontendu zapsat nedá.
