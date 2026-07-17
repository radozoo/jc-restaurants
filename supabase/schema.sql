-- ============================================================================
--  Kam vyrazit na oběd? — Supabase schema + Row Level Security
-- ----------------------------------------------------------------------------
--  Run this ONCE in your Supabase project:
--    Supabase dashboard → SQL Editor → New query → paste this file → Run.
--
--  Security model (see docs/plans/2026-07-16-...-plan.md):
--    - The frontend talks to Supabase with the PUBLIC anon key (safe by design).
--    - RLS scopes what that anon key can do:
--        restaurants  → read-only        (edits happen in the Table Editor as owner)
--        favorites    → read/insert/delete (no update) — shared team ❤️
--        suggestions  → insert-only        (colleagues propose; you approve in dashboard)
--    - The import/geocode scripts use the SERVICE ROLE key (local only, never shipped)
--      which bypasses RLS, so they can write to `restaurants`.
-- ============================================================================

-- ---------- Tables ----------------------------------------------------------

create table if not exists public.restaurants (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  rating         numeric,                       -- Google Maps rating (read-only display)
  price_tier     text,                          -- € / €€ / €€€ / €€€€
  cuisine_type   text,                          -- granular, free text — shown on the card
  category       text,                          -- curated bucket — used for filtering
  maps_url       text,                          -- Google Maps link
  website_url    text,                          -- optional restaurant website
  daily_menu_url text,                          -- optional daily-menu link
  description    text,
  lat            double precision,              -- filled by the geocoding script
  lng            double precision,
  created_at     timestamptz not null default now(),
  unique (name)                                 -- lets the import upsert idempotently (re-runs never duplicate or wipe favorites)
);

create table if not exists public.favorites (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  display_name  text not null,                  -- name as typed by the user
  name_key      text not null,                  -- trimmed + lowercased, used for uniqueness
  created_at    timestamptz not null default now(),
  unique (restaurant_id, name_key)              -- one ❤️ per person per restaurant → idempotent toggle
);

create index if not exists favorites_restaurant_id_idx on public.favorites (restaurant_id);

create table if not exists public.suggestions (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  maps_url       text not null,
  cuisine_type   text,
  price_tier     text,
  website_url    text,
  daily_menu_url text,
  note           text,
  suggested_by   text,                          -- submitter's stored name
  status         text not null default 'pending'
                 check (status in ('pending','approved','rejected')),
  created_at     timestamptz not null default now()
);

-- ---------- Row Level Security ----------------------------------------------

alter table public.restaurants enable row level security;
alter table public.favorites   enable row level security;
alter table public.suggestions enable row level security;

-- restaurants: public read-only (writes go through the dashboard / service role)
drop policy if exists "restaurants_read" on public.restaurants;
create policy "restaurants_read"
  on public.restaurants for select
  to anon, authenticated
  using (true);

-- favorites: public read + insert + delete (needed for toggle-off), but NOT update
drop policy if exists "favorites_read" on public.favorites;
create policy "favorites_read"
  on public.favorites for select
  to anon, authenticated
  using (true);

drop policy if exists "favorites_insert" on public.favorites;
create policy "favorites_insert"
  on public.favorites for insert
  to anon, authenticated
  with check (true);

drop policy if exists "favorites_delete" on public.favorites;
create policy "favorites_delete"
  on public.favorites for delete
  to anon, authenticated
  using (true);

-- suggestions: public INSERT only — no read/update/delete from the frontend.
-- (You review + approve suggestions in the Supabase Table Editor as the owner.)
drop policy if exists "suggestions_insert" on public.suggestions;
create policy "suggestions_insert"
  on public.suggestions for insert
  to anon, authenticated
  with check (true);
