// ============================================================================
//  geocode-restaurants.mjs — fill lat/lng for restaurants that don't have them
//  yet, using the free OpenStreetMap Nominatim geocoder.
//
//  Usage:
//    npm run geocode        (run AFTER `npm run import`)
//
//  Safe to re-run: only touches rows where lat/lng IS NULL, so any coordinates
//  you fixed by hand in the Table Editor are left alone.
//
//  Respects Nominatim's usage policy: max 1 request/second + a descriptive
//  User-Agent. For ~53 rows this takes about a minute. Requires Node 18+ (global fetch).
// ============================================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example → .env and fill it in.');
  process.exit(1);
}

const USER_AGENT = 'kam-na-obed-guide/1.0 (internal office lunch guide; contact: radoslav.zatovic@revolt.bi)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const { data: todo, error } = await supabase
  .from('restaurants')
  .select('id, name')
  .or('lat.is.null,lng.is.null');

if (error) { console.error('✗ Could not read restaurants:', error.message); process.exit(1); }
if (!todo || todo.length === 0) { console.log('✓ Nothing to geocode — every restaurant already has coordinates.'); process.exit(0); }

console.log(`Geocoding ${todo.length} restaurant(s) via Nominatim (≈1/sec)…\n`);

let ok = 0, missed = 0;
for (const r of todo) {
  const query = `${r.name}, Praha, Czechia`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'cs' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const hits = await res.json();
    if (hits.length > 0) {
      const lat = Number(hits[0].lat), lng = Number(hits[0].lon);
      const { error: upErr } = await supabase.from('restaurants').update({ lat, lng }).eq('id', r.id);
      if (upErr) throw upErr;
      ok++;
      console.log(`  ✓ ${r.name}  →  ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    } else {
      missed++;
      console.log(`  ? ${r.name}  →  no match (fix by hand in the Table Editor)`);
    }
  } catch (e) {
    missed++;
    console.log(`  ✗ ${r.name}  →  ${e.message}`);
  }
  await sleep(1100); // stay under Nominatim's 1 req/sec limit
}

console.log(`\nDone. ${ok} geocoded, ${missed} need a manual lat/lng in the Supabase Table Editor.`);
