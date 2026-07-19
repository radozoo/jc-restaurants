---
title: "feat: Vylepšený formulář návrhu restaurace + obohacení a schvalování"
type: feat
status: active
date: 2026-07-19
---

# Vylepšený formulář „Navrhnout podnik" + automatické obohacení a schvalování

## Přehled

Uživatel může v návrhu vyplnit všechny atributy restaurace **kromě ceny**. Povinný je jen
název a odkaz na Google Maps (s validací tvaru URL). Chybějící atributy se doplní
**při schvalování** — obohacení provádí Claude (webový výzkum, stejná metodika jako u
původních 53 restik), deterministické kroky (načtení návrhů, vložení do DB, souřadnice)
dělá skript. Součástí je poloautomatický schvalovací příkaz, který nahradí dnešní ruční
přepisování v Supabase Table Editoru.

## Rozhodnutí (potvrzená uživatelem)

- Obohacení běží **při schvalování, lokálně, přes Claude** — žádná Edge Function, žádný
  Google Places API klíč. (Scraping Google Maps jsme otestovali: HTTP 429, bez API klíče
  nefunguje. Webový výzkum Claudem je ověřený — web/menu/popis/tagy pro původních 53.)
- Tagy ve formuláři: **výběr z pevné šestice** (Rychlý oběd, Budget option, Vegetarian,
  Business oběd, Gurmánský zážitek, Dobrý výběr vín) — klikací pilulky, multi-select.
- Typ kuchyně: **výběr z existujících NEBO vlastní text** (`<input list>` + `<datalist>`
  už ve formuláři je; naplnit granulárními `cuisine_type` hodnotami z DATA, ne širokými
  kategoriemi).
- Poloautomatické schválení: **ano** — příkaz, který návrh promění v ostrou restauraci.

### Zpřesnění po triezvém přezkumu (potvrzeno uživatelem 2026-07-19)

- **Uživatelův vstup = zdrojový materiál, ne finální text.** Pravidlo „nikdy nepřepisuji
  vyplněné" je příliš tvrdé. Místo něj: originál se **nikdy neztratí** (zůstává v
  `suggestions`), ale do `restaurants` jde uhlazená/normalizovaná verze, kterou schvalovatel
  vidí a potvrdí ve formátu „uživatel zadal X → navrhuji Y":
  - *Popis*: kolegův osobní/1. osobou psaný text („byl jsem tam, super tacos!") se
    přeformuluje do katalogového tónu jako zbytek seznamu.
  - *Vlastní typ kuchyně*: normalizuje se, aby ho `categorize()` rozpoznal (kolega napíše
    „vietnamská" → mapovat na typ, který nespadne do „Ostatní"; případně rozšířit
    `CATEGORY_RULES`).
- **Tagy**: vybrané tagy se **nikdy neodebírají**; obohacení smí jen *navrhnout doplnění*
  chybějících, schvalovatel potvrdí.
- **CLI zjednodušení**: žádný samostatný `export` — jen `list` (lidsky čitelný výpis) s
  přepínačem `--json` pro obohacovací pipeline. Méně kódu, méně dokumentace.
- **Zdroj pravdy se posouvá**: schválené restaurace žijí jen v Supabase, ne v Excelu.
  Re-import z Excelu je nesmaže (upsert dle jména jen aktualizuje shody), ale je nutné to
  napsat do README/APPROVAL.md, ať to za půl roku nepřekvapí.

## Fáze 1 — Schéma DB

- [x] `supabase/schema.sql`: do `create table public.suggestions` přidat sloupce
      `tags text[]` a `description text` + idempotentní
      `alter table public.suggestions add column if not exists ...` (stejný vzor jako u
      `restaurants.tags`).
- [x] Uživatel spustí ALTER v Supabase SQL Editoru **před** nasazením nového formuláře
      (jinak insert s novými sloupci spadne).
- Sloupce `price_tier` a `note` v tabulce zůstávají (historické řádky), formulář je už
  nebude plnit.

## Fáze 2 — Formulář (index.html)

- [x] **Odebrat pole Cena** (select `s-price`) z formuláře.
- [x] **Typ kuchyně**: `fillCuisineOptions()` plnit unikátními granulárními
      `r.cuisine` hodnotami z DATA (seřazené, deduplikované) místo `CATS`. Vlastní text
      zůstává možný (datalist neomezuje vstup).
- [x] **Tagy**: nový blok se 6 klikacími pilulkami (vizuálně shodné s `.tag-pill` na
      kartách / filter chips), multi-select, stav v JS poli → payload `tags: [...]`.
      Pevný seznam tagů definovat jako konstantu (nezávisle na tom, co je v DB — ať jde
      tag vybrat, i když ho zatím žádná restaurace nemá).
- [x] **Popis**: textarea „Proč ho doporučuješ?" přejmenovat na
      „Popis — proč ho doporučuješ?" a ukládat do `description` (místo `note`).
- [x] **Validace Google Maps odkazu**: místo obecného `/^https?:\/\/.+/` použít regex na
      známé tvary: `maps.app.goo.gl/…`, `goo.gl/maps/…`, `google.<tld>/maps…`
      (`share.google/...` NE — to není maps odkaz). Chybová hláška pod polem:
      „Vlož odkaz na Google Maps (např. https://maps.app.goo.gl/…)."
      Hlubší ověření (že odkaz vede na existující podnik) z prohlížeče nejde (CORS) —
      proběhne ve Fázi 3 při resolvování odkazu.
- [x] **Duplicitní návrh** (nice-to-have): při psaní názvu porovnat s načtenými DATA
      (normalizovaně) a zobrazit neblokující upozornění „Tenhle podnik už v seznamu máme."
- [x] Aktualizovat payload insertu + reset polí v `openSuggest()`.

## Fáze 3 — Schvalování + obohacení

Dělba práce: **skript = deterministika, Claude = výzkum.** Předávání přes JSON soubor.

- [x] `scripts/manage-suggestions.mjs` (service role key z `.env`, vzor
      `import-restaurants.mjs`), subpříkazy:
      - `list` — vypíše čekající (`status='pending'`) návrhy; s `--json` je zapíše do
        `suggestions-pending.json` pro obohacovací pipeline (žádný samostatný `export`).
      - `approve <soubor>` — načte obohacený JSON, pro každý záznam:
        - kontrola kolize jména s existující restaurací → **přeskočit a nahlásit**
          (nikdy tiše neupsertovat přes existující řádek!),
        - insert do `restaurants` včetně `lat`/`lng`,
        - update návrhu na `status='approved'`.
      - `reject <id>` — označí návrh `status='rejected'`.
      - npm skripty v `scripts/package.json` s `--env-file=.env`.
- [x] **Obohacovací workflow** (dokumentovat v `docs/APPROVAL.md`): uživatel v Claude
      Code řekne „schvál návrhy" →
      1. `list --json` → načíst `suggestions-pending.json`,
      2. resolvovat gmaps short-link → ověřit, že vede na podnik; vytáhnout přesné
         souřadnice z `!3d…!4d…` (NE z `@lat,lng` — to je viewport, ověřená chyba)
         a rating z názvu/stránky; mrtvý odkaz → návrh nahlásit, neimportovat,
      3. doplnit chybějící: web, denní menu, typ kuchyně, cena, český popis
         (webový výzkum — stejná metodika jako u původních 53; jeden plochý agent na
         restauraci, žádné vnořené sub-agenty),
      4. **zpracovat uživatelův vstup jako materiál, ne finál** (viz Zpřesnění výše):
         popis přeformulovat do katalogového tónu, vlastní typ kuchyně normalizovat pro
         `categorize()`, vybrané tagy zachovat + navrhnout doplnění chybějících,
      5. ukázat uživateli souhrn k potvrzení ve formátu „uživatel zadal X → navrhuji Y" →
         po potvrzení `approve`.
- [x] Souřadnice bereme z resolvovaného pinu → **geokódovací krok (Nominatim) se pro
      návrhy nepoužívá** (pin je přesnější, ověřeno na 52/53).
- [x] `category` odvodí `approve` ze `cuisine_type` stejnou logikou `CATEGORY_RULES`
      jako import (funkci `categorize()` sdílet/zkopírovat).

## Fáze 4 — Dokumentace

- [x] `docs/APPROVAL.md`: schvalovací workflow + **kritéria tagů** (přenést uvolněná
      kritéria použitá pro tagování 53 restik, aby obohacení bylo opakovatelné a
      konzistentní).
- [x] `README.md`: sekce o návrzích — co uživatel vyplní, co se doplní automaticky,
      jak schvalovat (`npm run suggestions:list` atd.).

## Validace řešení (proč to bude fungovat)

| Krok | Ověřeno |
|---|---|
| Resolvování gmaps short-linku + přesné souřadnice z `!3d!4d` | ✅ 52/53 restik v této session |
| Webový výzkum: web + denní menu + popis | ✅ 49/53 webů, 24/53 menu |
| Odvození tagů z popisu/ceny/kuchyně | ✅ 28/53, kritéria schválena uživatelem |
| Insert do `restaurants` service klíčem, RLS | ✅ existující import skript |
| Datalist „vyber nebo napiš" pro kuchyni | ✅ už ve formuláři |
| Scraping Google Maps bez API klíče | ❌ HTTP 429 → proto Claude výzkum, ne skript |

Rizika / okrajové případy:
- Mrtvý/nevalidní maps odkaz projde regexem → zachytí se při resolvování (krok 2),
  návrh se nahlásí uživateli místo importu (precedens: Wokin, 404).
- Kolize jména s existující restaurací → approve přeskočí a nahlásí (chrání data).
- Anon klíč a RLS: nové sloupce ničemu nevadí, insert policy je `with check (true)`;
  jen je nutné pořadí Fáze 1 → Fáze 2.

## Mimo rozsah (rozhodne se později)

- Omezení, kdo smí návrhy posílat (tímový kód / auth) — samostatné téma, viz konverzace.
- Plně automatické obohacení na insertu (Edge Function + Places API).
