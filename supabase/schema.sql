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
  tags           text[],                        -- curated labels (e.g. "Budget option", "Vegetarian") — used for filtering
  lat            double precision,              -- filled by the geocoding script
  lng            double precision,
  created_at     timestamptz not null default now(),
  unique (name)                                 -- lets the import upsert idempotently (re-runs never duplicate or wipe favorites)
);

-- Existing installs (table already created before `tags` existed): re-running
-- this file is safe, this just adds the column if it isn't there yet.
alter table public.restaurants add column if not exists tags text[];

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
  price_tier     text,                          -- legacy: form no longer collects this; enriched at approval
  website_url    text,
  daily_menu_url text,
  tags           text[],                        -- colleague's picks from the fixed six; enrichment may add more
  description    text,                          -- colleague's raw pitch; polished into catalog tone at approval
  note           text,                          -- legacy column, kept for old rows
  suggested_by   text,                          -- submitter's stored name
  status         text not null default 'pending'
                 check (status in ('pending','approved','rejected')),
  created_at     timestamptz not null default now()
);

-- Existing installs (suggestions table created before tags/description existed):
-- re-running this file is safe, this just adds the columns if they aren't there yet.
alter table public.suggestions add column if not exists tags        text[];
alter table public.suggestions add column if not exists description text;

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

-- suggestions: NO direct client access. Inserts go through the SECURITY DEFINER
-- function public.submit_suggestion(code, payload), which checks the team code
-- first (see "Submit gating" below). With RLS on and no insert policy, a direct
-- insert from the anon key is denied — the shared code can't be bypassed.
drop policy if exists "suggestions_insert" on public.suggestions;

-- ---------- Edit suggestions --------------------------------------------------
-- Colleagues can propose corrections to an existing restaurant (any field). Each
-- row references the restaurant by id and carries ONLY the changed fields in a
-- JSONB blob (e.g. {"price_tier":"€€€","website_url":"https://…"}). You review +
-- approve them with `npm run edits:*` (see docs/APPROVAL.md); approval UPDATEs the
-- restaurant row in place — so editing a restaurant's name here is safe (favorites
-- reference restaurant_id, which never changes).
create table if not exists public.restaurant_edits (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  changes       jsonb not null,                -- only the fields being changed
  note          text,                          -- optional "what / why"
  suggested_by  text,                          -- submitter's stored name
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected')),
  created_at    timestamptz not null default now()
);

create index if not exists restaurant_edits_restaurant_id_idx on public.restaurant_edits (restaurant_id);

alter table public.restaurant_edits enable row level security;

-- restaurant_edits: NO direct client access — same posture as suggestions.
-- Inserts go through public.submit_edit(code, ...), which checks the team code.
drop policy if exists "restaurant_edits_insert" on public.restaurant_edits;

-- ---------- Submit gating (shared team code) --------------------------------
-- Sending a suggestion OR an edit requires a shared "team code". It is enforced
-- in the database (not just the browser): the two tables above have no insert
-- policy, so the ONLY way to write to them is through the SECURITY DEFINER
-- functions below, which run as the table owner and check the code first. Nobody
-- can bypass it with the public anon key / dev tools.
--
-- The code lives in a private key/value table with NO RLS policy, so it is never
-- readable from the client — only the definer functions (which bypass RLS) read
-- it. Set YOUR code once, after running this file:
--   update public.app_config set value = 'your-secret-here' where key = 'submit_code';
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
insert into public.app_config (key, value) values ('submit_code', 'CHANGE-ME')
  on conflict (key) do nothing;          -- re-running this file never resets your code

alter table public.app_config enable row level security;   -- no policies ⇒ no client access

-- Validate the team code — the frontend calls this to "unlock" the forms.
create or replace function public.check_submit_code(code text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from app_config where key = 'submit_code' and value = code);
$$;

-- Insert a new-restaurant suggestion — only when the code matches.
create or replace function public.submit_suggestion(code text, payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.check_submit_code(code) then
    raise exception 'invalid submit code' using errcode = '28000';
  end if;
  insert into public.suggestions (name, maps_url, website_url, daily_menu_url, tags, description, suggested_by)
  values (
    nullif(payload->>'name',''),
    nullif(payload->>'maps_url',''),
    nullif(payload->>'website_url',''),
    nullif(payload->>'daily_menu_url',''),
    case when payload ? 'tags' and jsonb_typeof(payload->'tags') = 'array'
         then array(select jsonb_array_elements_text(payload->'tags')) else null end,
    nullif(payload->>'description',''),
    nullif(payload->>'suggested_by','')
  );
end;
$$;

-- Insert an edit suggestion — only when the code matches.
create or replace function public.submit_edit(code text, p_restaurant_id uuid, p_changes jsonb, p_note text, p_suggested_by text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.check_submit_code(code) then
    raise exception 'invalid submit code' using errcode = '28000';
  end if;
  insert into public.restaurant_edits (restaurant_id, changes, note, suggested_by)
  values (p_restaurant_id, p_changes, nullif(p_note,''), nullif(p_suggested_by,''));
end;
$$;

grant execute on function public.check_submit_code(text)                         to anon, authenticated;
grant execute on function public.submit_suggestion(text, jsonb)                  to anon, authenticated;
grant execute on function public.submit_edit(text, uuid, jsonb, text, text)      to anon, authenticated;
