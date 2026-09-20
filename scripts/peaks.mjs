#!/usr/bin/env node
// Récupère les sommets nommés autour de chaque trace (OpenStreetMap, via Overpass)
// et écrit data/peaks.js. À relancer seulement quand on ajoute une sortie.
//
//   node scripts/peaks.mjs                      # toutes les traces de data/ete-2026.js
//   node scripts/peaks.mjs --radius=12 --far=60 --max=80 --far-max=24
//   node scripts/peaks.mjs --endpoint=http://…  # pour les tests
//
// Deux cercles : dans le rayon proche (--radius) on garde tout sommet nommé ;
// au-delà, jusqu'à --far, on ne garde que ce qui se voit vraiment de loin —
// l'altitude minimale exigée monte avec la distance, de --far-ele au bord du
// cercle proche à --far-ele-max au bord du lointain. C'est ce qui laisse
// passer le Mont Blanc à 54 km sans ramener 400 bosses anonymes avec lui.
// Les deux cercles ont leur propre quota : sinon les quatre-mille raflent toutes
// les places et le sommet du jour n'est plus étiqueté. Au loin on ne garde qu'un
// nom tous les --far-gap kilomètres, sans quoi le Mont Blanc arrive avec ses
// quinze épaules nommées.
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

export function query(bbox, minEle) {
  const box = bbox.map(v => v.toFixed(5)).join(',');
  // Sur un grand rayon, filtrer côté Overpass évite de rapatrier tout le massif.
  const floor = minEle ? `(if:number(t["ele"]) >= ${Math.round(minEle)})` : '';
  return `[out:json][timeout:180];
(
  node["natural"="peak"]["name"]${floor}(${box});
  node["natural"="volcano"]["name"]${floor}(${box});
);
out body;`;
}

// Altitude minimale exigée à une distance donnée : rien dans le cercle proche,
// puis une rampe linéaire jusqu'au bord du cercle lointain.
export function minEleAt(dist, near, far, eleNear, eleFar) {
  if (dist <= near) return 0;
  if (far <= near) return eleNear;
  const k = Math.min(1, (dist - near) / (far - near));
  return eleNear + k * (eleFar - eleNear);
}

// Nom d'affichage : OSM donne souvent « Mont Blanc / Monte Bianco ».
export function shortName(name) {
  const cut = name.split(/\s+\/\s+/)[0].trim();
  return cut.length >= 3 ? cut : name.trim();
}

// Garde ce qui est assez près, ou assez haut pour se voir de loin.
// Chaque cercle a son quota ; au loin, un seul nom par voisinage.
export function selectPeaks(elements, pts, opts) {
  const near = opts.near, far = Math.max(opts.far ?? 0, near);
  const eleNear = opts.eleNear ?? 1800, eleFar = opts.eleFar ?? 3200;
  const farMax = opts.farMax ?? 24, gap = opts.farGap ?? 4000;
  const seen = new Set();
  const dedans = [], dehors = [];
  for (const el of elements || []) {
    const raw = el.tags && (el.tags.name || el.tags['name:fr']);
    if (!raw || typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
    const key = raw + '@' + el.lat.toFixed(3) + ',' + el.lon.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    let dist = Infinity;
    for (const p of pts) {
      const d = haversine([el.lon, el.lat], p);
      if (d < dist) dist = d;
      if (dist < 50) break;
    }
    if (dist > far) continue;
    const ele = parseEle(el.tags.ele);
    // Au-delà du cercle proche, il faut dépasser la hauteur exigée à cette distance.
    const floor = minEleAt(dist, near, far, eleNear, eleFar);
    if (floor > 0 && (ele === null || ele < floor)) continue;
    const peak = { name: shortName(raw), ele, lon: +el.lon.toFixed(5), lat: +el.lat.toFixed(5), dist: Math.round(dist) };
    (dist <= near ? dedans : dehors).push(peak);
  }
  const parAltitude = (a, b) => (b.ele ?? -1) - (a.ele ?? -1) || a.dist - b.dist;
  dedans.sort(parAltitude);
  dehors.sort(parAltitude);

  // Un seul sommet par voisinage au loin : le plus haut prend la place.
  const loin = [];
  for (const p of dehors) {
    if (loin.length >= farMax) break;
    if (loin.some(q => haversine([p.lon, p.lat], [q.lon, q.lat]) < gap)) continue;
    loin.push(p);
  }
  return dedans.slice(0, opts.max).concat(loin).sort(parAltitude);
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
  const near = Math.round(parseFloat(opt('radius', '12')) * 1000);
  const far = Math.max(near, Math.round(parseFloat(opt('far', '60')) * 1000));
  const eleNear = parseFloat(opt('far-ele', '1800'));
  const eleFar = parseFloat(opt('far-ele-max', '3200'));
  const max = parseInt(opt('max', '80'), 10);
  const farMax = parseInt(opt('far-max', '24'), 10);
  const farGap = Math.round(parseFloat(opt('far-gap', '4')) * 1000);
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
    process.stderr.write(`${t.id} … `);
    const elements = [];
    let ok = false, why = '';

    // 1. le cercle proche : tout sommet nommé
    try {
      const json = await askAnyMirror(endpoints, query(bboxOf(t.pts, near)));
      elements.push(...(json.elements || []));
      ok = true;
    } catch (err) { why = err.message; }

    // 2. le cercle lointain : seulement les grands, filtrés côté serveur.
    //    Un échec ici ne coûte que les sommets lointains.
    if (far > near) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const json = await askAnyMirror(endpoints, query(bboxOf(t.pts, far), eleNear));
        elements.push(...(json.elements || []));
      } catch (err) {
        console.error(`  cercle lointain indisponible (${err.message}) — on garde le proche`);
      }
    }

    if (ok) {
      const found = selectPeaks(elements, t.pts, { near, far, eleNear, eleFar, max, farMax, farGap });
      peaks[t.id] = found.map(p => [p.lon, p.lat, p.ele, p.name, p.dist]);
      const loin = found.filter(p => p.dist > near);
      console.error(`${found.length} sommets` +
        (found.length ? ` (le plus haut : ${found[0].name}${found[0].ele ? ' ' + found[0].ele + ' m' : ''}` +
          `${loin.length ? `, dont ${loin.length} à plus de ${Math.round(near / 1000)} km` : ''})` : ''));
    } else {
      failures++;
      console.error(`échec : ${why}${peaks[t.id] ? ' — on garde les ' + peaks[t.id].length + ' sommets déjà connus' : ''}`);
    }
    await new Promise(r => setTimeout(r, 1500));   // Overpass est un service bénévole : on y va doucement
  }

  writeFileSync(outFile,
    '// Sommets issus d\'OpenStreetMap, générés par scripts/peaks.mjs — ne pas éditer à la main.\n' +
    '// [longitude, latitude, altitude (m ou null), nom, distance à la trace (m)]\n' +
    'window.ETE2026_PEAKS = ' + JSON.stringify(peaks) + ';\n');
  console.error(`\n→ ${outFile} écrit${failures ? ` (${failures} trace(s) en échec)` : ''}`);
  if (failures === tracks.length) process.exitCode = 1;
}

// Exécuté directement, et non importé par un test : comparer les URL, pas les suffixes
// (« test-peaks.mjs » se termine lui aussi par « peaks.mjs »).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
