// ============================================================================
//  manage-suggestions.mjs — review colleague suggestions and promote the good
//  ones into the live `restaurants` table.
//
//  Suggestions arrive from the public form with only name + Google Maps link
//  guaranteed; everything else is optional. The enrichment (resolving the maps
//  pin → coordinates, finding the website / daily menu, polishing the Czech
//  description, deriving cuisine + price + tags) is done by Claude at approval
//  time — see docs/APPROVAL.md. This script is the deterministic half: it reads
//  what's pending, and writes approved rows into `restaurants`.
//
//  Usage (from scripts/, after `npm install`):
//    npm run suggestions:list                 human-readable list of pending
//    npm run suggestions:list -- --json       write pending → suggestions-pending.json
//    npm run suggestions:approve -- <file>    insert enriched rows into restaurants
//    npm run suggestions:reject -- <id>       mark one suggestion as rejected
//
//  The service-role key (local only, never shipped) bypasses RLS so this can
//  write to `restaurants`. Coordinates come straight from the resolved maps pin
//  (more accurate than Nominatim — verified 52/53), so approved rows do NOT go
//  through `npm run geocode`.
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example → .env and fill it in.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const PENDING_FILE = new URL('./suggestions-pending.json', import.meta.url);

// ---- Category mapping (kept in sync with import-restaurants.mjs) --------------
// The frontend filters on the broad `category` bucket; `cuisine_type` keeps the
// granular label. If a colleague typed a cuisine we don't recognise, it falls
// back to "Ostatní" — enrichment should normalise it before approval.
const CATEGORY_RULES = [
  [/Michelin|Fine dining/i, 'Fine dining'],
  [/Steak/i,                'Steakhouse'],
  [/Sushi|Ramen|Japanese|Nikkei|Izakaya/i, 'Japonská'],
  [/Chinese|Dim Sum|Chongqing/i, 'Čínská'],
  [/Korean/i,               'Korejská'],
  [/Thai/i,                 'Thajská'],
  [/Pan-Asian|Asian fusion|^Asian/i, 'Asijská'],
  [/Indian/i,               'Indická'],
  [/Italian|Pasta|Neapolitan/i, 'Italská'],
  [/American|Burger/i,      'Americká'],
  [/Mexican/i,              'Mexická'],
  [/Wine bar/i,             'Wine bar'],
  [/Tapas|Spanish/i,        'Španělská'],
  [/Middle Eastern/i,       'Blízkovýchodní'],
  [/Turkish/i,              'Turecká'],
  [/Brazilian|Churrascaria/i, 'Brazilská'],
  [/Cocktail/i,             'Mezinárodní'],
  [/Czech|Česk/i,           'Česká'],
  [/International|European|Moderní/i, 'Mezinárodní'],
];
function categorize(cuisine) {
  const c = cuisine || '';
  for (const [re, label] of CATEGORY_RULES) if (re.test(c)) return label;
  return 'Ostatní';
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// ---- Commands ----------------------------------------------------------------

async function cmdList(asJson) {
  const { data, error } = await supabase
    .from('suggestions')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) { console.error('✗ Could not read suggestions:', error.message); process.exit(1); }

  if (!data || data.length === 0) {
    if (asJson) { writeFileSync(PENDING_FILE, '[]\n'); console.log('✓ No pending suggestions. Wrote empty suggestions-pending.json.'); }
    else console.log('✓ No pending suggestions.');
    return;
  }

  if (asJson) {
    writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2) + '\n');
    console.log(`✓ Wrote ${data.length} pending suggestion(s) → suggestions-pending.json`);
    console.log('  Next: enrich them (see docs/APPROVAL.md), then `npm run suggestions:approve -- <file>`.');
    return;
  }

  console.log(`${data.length} pending suggestion(s):\n`);
  for (const s of data) {
    console.log(`• ${s.name}   [${s.id}]`);
    console.log(`    maps:    ${s.maps_url}`);
    if (s.cuisine_type)   console.log(`    kuchyně: ${s.cuisine_type}`);
    if (s.website_url)    console.log(`    web:     ${s.website_url}`);
    if (s.daily_menu_url) console.log(`    menu:    ${s.daily_menu_url}`);
    if (s.tags && s.tags.length) console.log(`    tagy:    ${s.tags.join(', ')}`);
    if (s.description)    console.log(`    popis:   ${s.description}`);
    if (s.suggested_by)   console.log(`    od:      ${s.suggested_by}`);
    console.log('');
  }
  console.log('To enrich for approval:  npm run suggestions:list -- --json');
}

async function cmdApprove(file) {
  if (!file) { console.error('✗ Usage: npm run suggestions:approve -- <enriched.json>'); process.exit(1); }
  let rows;
  try { rows = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error(`✗ Could not read/parse ${file}:`, e.message); process.exit(1); }
  if (!Array.isArray(rows) || rows.length === 0) { console.error('✗ Enriched file is empty or not an array.'); process.exit(1); }

  // Guard against name collisions with restaurants that already exist.
  const { data: existing, error: exErr } = await supabase.from('restaurants').select('name');
  if (exErr) { console.error('✗ Could not read existing restaurants:', exErr.message); process.exit(1); }
  const existingSet = new Set((existing || []).map((r) => norm(r.name)));

  let inserted = 0, skipped = 0, approvedIds = [];
  for (const r of rows) {
    if (!r.name || !r.maps_url) { console.log(`  ⚠ skip (missing name/maps_url): ${JSON.stringify(r).slice(0, 80)}`); skipped++; continue; }
    if (existingSet.has(norm(r.name))) { console.log(`  ⚠ skip (already in restaurants): ${r.name}`); skipped++; continue; }
    if (r.lat == null || r.lng == null) { console.log(`  ⚠ skip (no coordinates — resolve the maps pin first): ${r.name}`); skipped++; continue; }

    const record = {
      name: r.name,
      rating: r.rating != null ? Number(String(r.rating).replace(',', '.')) : null,
      price_tier: r.price_tier || null,
      cuisine_type: r.cuisine_type || null,
      category: r.category || categorize(r.cuisine_type),
      maps_url: r.maps_url,
      website_url: r.website_url || null,
      daily_menu_url: r.daily_menu_url || null,
      description: r.description || null,
      tags: Array.isArray(r.tags) ? r.tags : [],
      lat: Number(r.lat),
      lng: Number(r.lng),
    };

    const { error: insErr } = await supabase.from('restaurants').insert(record);
    if (insErr) { console.log(`  ✗ insert failed for ${r.name}: ${insErr.message}`); skipped++; continue; }
    existingSet.add(norm(r.name));
    inserted++;
    console.log(`  ✓ ${r.name}  →  ${record.category}  (${record.lat.toFixed(5)}, ${record.lng.toFixed(5)})`);
    if (r.id) approvedIds.push(r.id);
  }

  // Mark the corresponding suggestions approved (only those we actually inserted).
  if (approvedIds.length) {
    const { error: upErr } = await supabase.from('suggestions').update({ status: 'approved' }).in('id', approvedIds);
    if (upErr) console.log(`  ⚠ inserted rows, but could not flag suggestions approved: ${upErr.message}`);
  }

  console.log(`\nDone. ${inserted} inserted, ${skipped} skipped.`);
  if (inserted) console.log('New restaurants are live — refresh the app to see them on the map.');
}

async function cmdReject(id) {
  if (!id) { console.error('✗ Usage: npm run suggestions:reject -- <suggestion-id>'); process.exit(1); }
  const { data, error } = await supabase.from('suggestions').update({ status: 'rejected' }).eq('id', id).select('name');
  if (error) { console.error('✗ Reject failed:', error.message); process.exit(1); }
  if (!data || data.length === 0) { console.log(`? No pending/known suggestion with id ${id}.`); return; }
  console.log(`✓ Rejected: ${data[0].name}`);
}

// ---- Dispatch ----------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'list':    await cmdList(rest.includes('--json')); break;
  case 'approve': await cmdApprove(rest.find((a) => !a.startsWith('--'))); break;
  case 'reject':  await cmdReject(rest.find((a) => !a.startsWith('--'))); break;
  default:
    console.log('Usage:');
    console.log('  node --env-file=.env manage-suggestions.mjs list [--json]');
    console.log('  node --env-file=.env manage-suggestions.mjs approve <enriched.json>');
    console.log('  node --env-file=.env manage-suggestions.mjs reject <suggestion-id>');
    process.exit(cmd ? 1 : 0);
}
