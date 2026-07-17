# Prague Restaurant Guide: Tableau → moderná webová appka

**Dátum:** 2026-07-16

## Zdroj

- Inšpirácia (nekopírovať): pôvodný Tableau Public dashboard [RESTAURANT GUIDE FOR OFFICE PEOPLE OF PALMOVKA PRAGUE](https://public.tableau.com/app/profile/rado.zatovic/viz/REATURANTGUIDEFOROFFICEPEOPLEOFPALMOVKAPRAGUE/RESTAURANTS) — poslúžil len na pochopenie zámeru (reštauračný sprievodca pre kolegov z kancelárie), dizajn ani rozsah appky sa ním neobmedzuje. Firma sa medzičasom presťahovala z Palmovky do centra Prahy, takže appka **nie je** pre Palmovku.
- Zdrojové dáta: `Karel_Vaclavak_Prague_Restaurants_Guide.xlsx` — 54 reštaurácií v okolí **nových** kancelárií, stĺpce: `Název`, `Rating`, `Cena` (€/€€/€€€), `Typ kuchyně`, `Odkaz` (Google Maps link), `Popis`.
- Nové kancelárie: **Olivova 2096/4, 110 00 Nové Město** (blízko Hlavního nádraží) — mapa v appke bude východzo centrovaná okolo tejto adresy.

## What We're Building

Moderná webová appka — zoznam/prehliadač reštaurácií v okolí nových kancelárií firmy v centre Prahy (Nové Město), s filtrovaním, interaktívnou mapou centrovanou na kanceláriu a zdieľanými obľúbenými položkami naprieč tímom. Je to "fun project" — priorita je jednoduchosť a nulové náklady pred robustnosťou. Vizuálny dizajn appky nie je viazaný na vzhľad pôvodného Tableau dashboardu — moderný, čistý web dizajn podľa najlepších postupov.

## Why This Approach

Používateľ chcel appku rozšíriť o nové funkcie (nie len 1:1 kópiu Tableau), ale zároveň sa vyhnúť zbytočnej komplexite. Kľúčové zjednodušenia oproti "štandardnému" riešeniu:

- **Žiadne skutočné prihlasovanie** — namiesto e-mailu/hesla si každý kolega raz zadá meno (uloží sa v prehliadači), ktoré sa posiela spolu s obľúbenými do databázy. Eliminuje celý auth flow (overovacie e-maily, session management).
- **Žiadne vlastné admin rozhranie** — úpravy dát (pridanie/zmena reštaurácie) sa robia priamo cez vstavaný Supabase Table Editor namiesto programovania admin UI.
- **Frontend zostáva 100% statický** na GitHub Pages (zadarmo); Supabase free tier rieši len dáta a je volaný priamo z klientského JS — žiadny vlastný server.
- **Mapa bez API kľúča** — Leaflet + OpenStreetMap dlaždice namiesto Google Maps API (zadarmo, bez limitov/billing).

## Key Decisions

1. **Rozsah appky:** rozšírenie o nové funkcie (nie len parita s Tableau).
2. **Funkcie v MVP:**
   - Zoznam reštaurácií s vyhľadávaním a filtrami (typ kuchyne, cena €/€€/€€€, rating)
   - Interaktívna mapa s pinmi (Leaflet + OpenStreetMap)
   - Zdieľané obľúbené ❤️ — toggle na reštauráciu, viditeľný počet obľúbených od celého tímu, filter "len obľúbené"
3. **Bez komentárov/vlastného hviezdičkového hodnotenia** — len jednoduchý ❤️ toggle, nič zložitejšie.
4. **Prístup používateľov:** interný tím, žiadne heslo/e-mail overenie. Meno sa zadá raz, uloží sa lokálne (localStorage) a posiela sa s každým ❤️ do Supabase.
5. **Správa dát:** cez vstavaný Supabase Table Editor, žiadne vlastné admin UI.
6. **Tech stack:**
   - Frontend: statická stránka (React + Vite alebo jednoduchšie vanilla JS/HTML — rozhodne sa v pláne) nasadená na GitHub Pages
   - Backend/dáta: Supabase free tier (Postgres) — tabuľka `restaurants` (import z Excelu) + tabuľka `favorites` (restaurant_id, meno, timestamp)
   - Mapa: Leaflet + OpenStreetMap dlaždice
7. **Cenový filter:** zachovať vizuálne ako €/€€/€€€ (multi-select filter tlačidlá), žiadny prevod na číselnú škálu.
8. **Geokódovanie pre mapu:** dáta nemajú súradnice, len Google Maps odkazy. Jednorazový skript automaticky zgeokoduje podľa názvu + "Praha" cez bezplatný geokodér (napr. OpenStreetMap Nominatim) a uloží lat/lng do Supabase; prípadné nepresnosti sa doladia ručne.

## Resolved Questions

- **Geokódovanie:** automaticky podľa názvu + Praha (Nominatim), s ručnou opravou výnimiek.
- **Cenový filter:** ponechať ako €/€€/€€€ symboly.
- **Obľúbené/hlasovanie:** jednoduchý ❤️ toggle, nie hviezdičkové hodnotenie ani komentáre.
- **Auth:** meno bez hesla/e-mailu, ukladané v localStorage.
- **Admin/správa dát:** Supabase Table Editor namiesto vlastného UI.
- **Hosting/backend:** GitHub Pages (frontend) + Supabase free tier (dáta), nie čisto statické riešenie bez databázy.
- **Vzťah k Tableau dashboardu:** iba inšpirácia zámeru, appka ho nekopíruje ani vzhľadom, ani rozsahom.
- **Poloha/kontext appky:** appka je pre nové kancelárie na adrese Olivova 2096/4, 110 00 Nové Město (nie Palmovka); mapa je defaultne centrovaná na túto adresu. Vzdialenostné triedenie zoznamu nie je požadované.
- **Dizajn:** voľná ruka — moderný, čistý web dizajn podľa best practices, nie replika Tableau vzhľadu.

## Open Questions

Žiadne zostávajúce otvorené otázky — všetky kľúčové rozhodnutia sú vyriešené vyššie.

## Next Steps

Spustiť `/cde:plan` s týmto brainstorm dokumentom pre detailný implementačný plán (výber React vs vanilla JS, štruktúra Supabase schémy, migračný skript z Excelu, geokódovací skript, deployment pipeline na GitHub Pages).
