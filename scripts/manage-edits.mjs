// ============================================================================
//  manage-edits.mjs — review colleague EDIT suggestions and apply the good ones
//  to the live `restaurants` table.
//
//  Each row in `restaurant_edits` references a restaurant by id and carries only
//  the changed fields in a JSONB `changes` blob. Approval UPDATEs the restaurant
//  row in place (by id), so editing a restaurant's name is safe — favorites point
//  at restaurant_id, which never changes.
//
//  Usage (from scripts/, after `npm install`):
//    npm run edits:list                  human-readable diff of pending edits
//    npm run edits:list -- --json        write pending → edits-pending.json
//    npm run edits:approve -- <file>     apply confirmed edits to restaurants
//    npm run edits:reject -- <id>        mark one edit as rejected
//
//  Auto-recompute on approve:
//    - changes.cuisine_type  → `category` is re-derived (same rules as import)
//    - changes.maps_url      → needs new lat/lng; add them to the approve JSON
//      (resolve the new pin's !3d/!4d — NOT the @lat,lng viewport). If maps_url
//      changed but no lat/lng is supplied, the row is applied but coords are left
//      as-is and a warning is printed.
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
const PENDING_FILE = new URL('./edits-pending.json', import.meta.url);

// ---- Category mapping (kept in sync with import-restaurants.mjs) --------------
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

// Columns an edit is allowed to change directly (category/lat/lng are derived).
const EDITABLE = ['name', 'maps_url', 'cuisine_type', 'price_tier', 'website_url', 'daily_menu_url', 'description', 'tags'];

const fmt = (v) => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v));

// ---- Commands ----------------------------------------------------------------

async function cmdList(asJson) {
  const { data: edits, error } = await supabase
    .from('restaurant_edits')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) { console.error('✗ Could not read edits:', error.message); process.exit(1); }

  if (!edits || edits.length === 0) {
    if (asJson) { writeFileSync(PENDING_FILE, '[]\n'); console.log('✓ No pending edits. Wrote empty edits-pending.json.'); }
    else console.log('✓ No pending edits.');
    return;
  }

  const ids = [...new Set(edits.map((e) => e.restaurant_id))];
  const { data: rests, error: rErr } = await supabase.from('restaurants').select('*').in('id', ids);
  if (rErr) { console.error('✗ Could not read restaurants:', rErr.message); process.exit(1); }
  const byId = Object.fromEntries((rests || []).map((r) => [r.id, r]));

  if (asJson) {
    const out = edits.map((e) => {
      const r = byId[e.restaurant_id] || {};
      const current = {};
      Object.keys(e.changes || {}).forEach((k) => { current[k] = r[k] != null ? r[k] : null; });
      return { id: e.id, restaurant_id: e.restaurant_id, restaurant_name: r.name || '(neznámá)', changes: e.changes, current, note: e.note, suggested_by: e.suggested_by };
    });
    writeFileSync(PENDING_FILE, JSON.stringify(out, null, 2) + '\n');
    console.log(`✓ Wrote ${out.length} pending edit(s) → edits-pending.json`);
    console.log('  Review them (see docs/APPROVAL.md); if maps_url changed, add lat/lng. Then `npm run edits:approve -- edits-pending.json`.');
    return;
  }

  console.log(`${edits.length} pending edit(s):\n`);
  for (const e of edits) {
    const r = byId[e.restaurant_id] || {};
    console.log(`• ${r.name || '(neznámá restaurace)'}   [edit ${e.id}]`);
    for (const [k, v] of Object.entries(e.changes || {})) {
      console.log(`    ${k}:  ${fmt(r[k])}  →  ${fmt(v)}`);
    }
    if (e.note)         console.log(`    pozn.: ${e.note}`);
    if (e.suggested_by) console.log(`    od:    ${e.suggested_by}`);
    console.log('');
  }
  console.log('To apply:  npm run edits:list -- --json   then   npm run edits:approve -- edits-pending.json');
}

async function cmdApprove(file) {
  if (!file) { console.error('✗ Usage: npm run edits:approve -- <edits.json>'); process.exit(1); }
  let rows;
  try { rows = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error(`✗ Could not read/parse ${file}:`, e.message); process.exit(1); }
  if (!Array.isArray(rows) || rows.length === 0) { console.error('✗ File is empty or not an array.'); process.exit(1); }

  let applied = 0, skipped = 0;
  for (const row of rows) {
    if (!row.restaurant_id || !row.changes || typeof row.changes !== 'object') {
      console.log(`  ⚠ skip (missing restaurant_id/changes): ${JSON.stringify(row).slice(0, 80)}`); skipped++; continue;
    }
    const update = {};
    for (const [k, v] of Object.entries(row.changes)) {
      if (EDITABLE.includes(k)) update[k] = v;
      else console.log(`  ⚠ ignoring non-editable field "${k}" for ${row.restaurant_name || row.restaurant_id}`);
    }
    if ('cuisine_type' in update) update.category = categorize(update.cuisine_type);
    if ('maps_url' in update) {
      if (row.lat != null && row.lng != null) { update.lat = Number(row.lat); update.lng = Number(row.lng); }
      else console.log(`  ⚠ ${row.restaurant_name || row.restaurant_id}: maps_url changed but no lat/lng supplied — coordinates left as-is.`);
    }
    if (Object.keys(update).length === 0) { console.log(`  ⚠ skip (nothing to apply): ${row.restaurant_name || row.restaurant_id}`); skipped++; continue; }

    const { error: upErr } = await supabase.from('restaurants').update(update).eq('id', row.restaurant_id);
    if (upErr) { console.log(`  ✗ update failed for ${row.restaurant_name || row.restaurant_id}: ${upErr.message}`); skipped++; continue; }
    applied++;
    console.log(`  ✓ ${row.restaurant_name || row.restaurant_id}  ←  ${Object.keys(update).join(', ')}`);
    if (row.id) {
      const { error: sErr } = await supabase.from('restaurant_edits').update({ status: 'approved' }).eq('id', row.id);
      if (sErr) console.log(`    ⚠ applied, but could not flag edit approved: ${sErr.message}`);
    }
  }

  console.log(`\nDone. ${applied} applied, ${skipped} skipped.`);
  if (applied) console.log('Changes are live — refresh the app to see them.');
}

async function cmdReject(id) {
  if (!id) { console.error('✗ Usage: npm run edits:reject -- <edit-id>'); process.exit(1); }
  const { data, error } = await supabase.from('restaurant_edits').update({ status: 'rejected' }).eq('id', id).select('id');
  if (error) { console.error('✗ Reject failed:', error.message); process.exit(1); }
  if (!data || data.length === 0) { console.log(`? No pending/known edit with id ${id}.`); return; }
  console.log(`✓ Rejected edit ${id}.`);
}

// ---- Dispatch ----------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'list':    await cmdList(rest.includes('--json')); break;
  case 'approve': await cmdApprove(rest.find((a) => !a.startsWith('--'))); break;
  case 'reject':  await cmdReject(rest.find((a) => !a.startsWith('--'))); break;
  default:
    console.log('Usage:');
    console.log('  node --env-file=.env manage-edits.mjs list [--json]');
    console.log('  node --env-file=.env manage-edits.mjs approve <edits.json>');
    console.log('  node --env-file=.env manage-edits.mjs reject <edit-id>');
    process.exit(cmd ? 1 : 0);
}
