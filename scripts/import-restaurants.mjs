// ============================================================================
//  import-restaurants.mjs — one-time (re-runnable) import of the Excel guide
//  into the Supabase `restaurants` table.
//
//  Usage:
//    1. cp .env.example .env   (and fill SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
//    2. npm install
//    3. npm run import
//
//  Idempotent: upserts on `name`, so re-running updates existing rows in place
//  (favorites and geocoded lat/lng are preserved — lat/lng are never sent here).
// ============================================================================

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const XLSX_PATH = new URL('../Karel_Vaclavak_Prague_Restaurants_Guide.xlsx', import.meta.url);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example → .env and fill it in.');
  process.exit(1);
}

// ---- Curated category mapping -------------------------------------------------
// Maps the granular `Typ kuchyně` string to a broad filter bucket. The frontend
// filters on `category` (few buckets); `cuisine_type` keeps the granular label.
// Unmatched cuisines fall back to "Ostatní" — reassign them in the Table Editor.
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

// ---- Tolerant column lookup --------------------------------------------------
// Finds a value in a row by trying several possible header names (case-insensitive,
// diacritic-insensitive), so the sheet can add a "Web" / "Denní menu" column later.
function norm(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function pick(row, candidates) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const target = norm(cand);
    const hit = keys.find((k) => norm(k) === target || norm(k).includes(target));
    if (hit && row[hit] != null && String(row[hit]).trim() !== '') return String(row[hit]).trim();
  }
  return null;
}

// ---- Read the workbook -------------------------------------------------------
const wb = XLSX.read(readFileSync(XLSX_PATH), { type: 'buffer' });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

const records = rows
  .map((row) => {
    const name = pick(row, ['Název', 'Nazev', 'Name']);
    if (!name) return null;
    const cuisine = pick(row, ['Typ kuchyně', 'Typ kuchyne', 'Cuisine']);
    const ratingRaw = pick(row, ['Rating', 'Hodnocení']);
    const tagsRaw = pick(row, ['Tagy', 'Tags']);
    return {
      name,
      rating: ratingRaw != null ? Number(String(ratingRaw).replace(',', '.')) : null,
      price_tier: pick(row, ['Cena', 'Price']),
      cuisine_type: cuisine,
      category: categorize(cuisine),
      maps_url: pick(row, ['Odkaz', 'Maps', 'Google Maps', 'URL']),
      website_url: pick(row, ['Web', 'Webstránka', 'Website', 'Web restaurace']),
      daily_menu_url: pick(row, ['Denní menu', 'Denni menu', 'Menu', 'Daily menu']),
      description: pick(row, ['Popis', 'Description']),
      tags: tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [],
    };
  })
  .filter(Boolean);

if (records.length === 0) {
  console.error('✗ No rows found in the spreadsheet. Check the file / column headers.');
  process.exit(1);
}

console.log(`Read ${records.length} restaurants from the spreadsheet.`);

// ---- Upsert into Supabase ----------------------------------------------------
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const { error } = await supabase
  .from('restaurants')
  .upsert(records, { onConflict: 'name', ignoreDuplicates: false });

if (error) {
  console.error('✗ Upsert failed:', error.message);
  process.exit(1);
}

const catCounts = records.reduce((m, r) => ((m[r.category] = (m[r.category] || 0) + 1), m), {});
console.log('✓ Imported/updated', records.length, 'restaurants.');
console.log('  Categories:', Object.entries(catCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(', '));
console.log('\nNext: run `npm run geocode` to fill in map coordinates.');
