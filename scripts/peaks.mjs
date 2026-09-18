#!/usr/bin/env node
// Récupère les sommets nommés autour de chaque trace (OpenStreetMap, via Overpass)
// et écrit data/peaks.js. À relancer seulement quand on ajoute une sortie.
//
//   node scripts/peaks.mjs                      # toutes les traces de data/ete-2026.js
//   node scripts/peaks.mjs --radius=12 --max=50
//   node scripts/peaks.mjs --endpoint=http://…  # pour les tests
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

const R = 6371000, RAD = Math.PI / 180;
function haversine(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// « 2341 », « 2341 m », « 2 341 », « 1,5 » … OSM n'impose rien.
export function parseEle(raw) {
  if (raw === undefined || raw === null) return null;
  const txt = String(raw).replace(/\s| /g, '').replace(/m(ètres?)?$/i, '').replace(',', '.');
  const v = parseFloat(txt);
  return Number.isFinite(v) && v > -500 && v < 9000 ? Math.round(v) : null;
}

export function bboxOf(pts, marginMetres) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const p of pts) {
    if (p[0] < minLon) minLon = p[0];
    if (p[0] > maxLon) maxLon = p[0];
    if (p[1] < minLat) minLat = p[1];
    if (p[1] > maxLat) maxLat = p[1];
  }
  const dLat = marginMetres / 111320;
  const dLon = marginMetres / (111320 * Math.cos(((minLat + maxLat) / 2) * RAD));
  return [minLat - dLat, minLon - dLon, maxLat + dLat, maxLon + dLon];   // ordre Overpass
}

export function query(bbox) {
  return `[out:json][timeout:90];
(
  node["natural"="peak"]["name"](${bbox.map(v => v.toFixed(5)).join(',')});
  node["natural"="volcano"]["name"](${bbox.map(v => v.toFixed(5)).join(',')});
);
out body;`;
}

// Trie par altitude, écarte ce qui est trop loin de la trace, plafonne le nombre.
export function selectPeaks(elements, pts, radiusMetres, max) {
  const seen = new Set();
  const out = [];
  for (const el of elements || []) {
    const name = el.tags && (el.tags.name || el.tags['name:fr']);
    if (!name || typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
    const key = name + '@' + el.lat.toFixed(3) + ',' + el.lon.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    let dist = Infinity;
    for (const p of pts) {
      const d = haversine([el.lon, el.lat], p);
      if (d < dist) dist = d;
      if (dist < 50) break;
    }
    if (dist > radiusMetres) continue;
    out.push({ name: name.trim(), ele: parseEle(el.tags.ele), lon: +el.lon.toFixed(5), lat: +el.lat.toFixed(5), dist: Math.round(dist) });
  }
  // Les plus hauts d'abord : ce sont eux qu'on voit depuis la trace.
  out.sort((a, b) => (b.ele ?? -1) - (a.ele ?? -1) || a.dist - b.dist);
  return out.slice(0, max);
}

async function ask(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'booketin.fr flyover peaks (contact via github.com/Alexis-Jacob)' },
    body: 'data=' + encodeURIComponent(body),
  });
  if (!res.ok) throw new Error(`${endpoint} → HTTP ${res.status}`);
  return res.json();
}

async function askAnyMirror(endpoints, body) {
  let last;
  for (const e of endpoints) {
    try { return await ask(e, body); }
    catch (err) { last = err; console.error(`  ${err.message}, on essaie le miroir suivant…`); }
  }
  throw last;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
  const radius = Math.round(parseFloat(opt('radius', '12')) * 1000);
  const max = parseInt(opt('max', '45'), 10);
  const endpoints = opt('endpoint') ? [opt('endpoint')] : MIRRORS;

  const dataFile = opt('tracks', 'data/ete-2026.js');
  const outFile = opt('out', 'data/peaks.js');
  const tracks = JSON.parse(readFileSync(dataFile, 'utf8').split('= ')[1].replace(/;\s*$/, ''));

  // On repart de l'existant : une trace dont la requête échoue garde ses sommets.
  let peaks = {};
  if (existsSync(outFile)) {
    try { peaks = JSON.parse(readFileSync(outFile, 'utf8').split('= ')[1].replace(/;\s*$/, '')); }
    catch { /* fichier illisible : on repart de zéro */ }
  }

  let failures = 0;
  for (const t of tracks) {
    const bbox = bboxOf(t.pts, radius);
    process.stderr.write(`${t.id} … `);
    try {
      const json = await askAnyMirror(endpoints, query(bbox));
      const found = selectPeaks(json.elements, t.pts, radius, max);
      peaks[t.id] = found.map(p => [p.lon, p.lat, p.ele, p.name]);
      console.error(`${found.length} sommets` +
        (found.length ? ` (le plus haut : ${found[0].name}${found[0].ele ? ' ' + found[0].ele + ' m' : ''})` : ''));
    } catch (err) {
      failures++;
      console.error(`échec : ${err.message}${peaks[t.id] ? ' — on garde les ' + peaks[t.id].length + ' sommets déjà connus' : ''}`);
    }
    await new Promise(r => setTimeout(r, 1500));   // Overpass est un service bénévole : on y va doucement
  }

  writeFileSync(outFile,
    '// Sommets issus d\'OpenStreetMap, générés par scripts/peaks.mjs — ne pas éditer à la main.\n' +
    '// [longitude, latitude, altitude (m ou null), nom]\n' +
    'window.ETE2026_PEAKS = ' + JSON.stringify(peaks) + ';\n');
  console.error(`\n→ ${outFile} écrit${failures ? ` (${failures} trace(s) en échec)` : ''}`);
  if (failures === tracks.length) process.exitCode = 1;
}

// Exécuté directement, et non importé par un test : comparer les URL, pas les suffixes
// (« test-peaks.mjs » se termine lui aussi par « peaks.mjs »).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
