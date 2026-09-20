#!/usr/bin/env node
// Recolle plusieurs exports GPX d'une même sortie (montre arrêtée puis relancée)
// en une seule trace, remise dans l'ordre chronologique.
//
//   node scripts/merge-gpx.mjs trelod-1.gpx trelod-2.gpx > tracks/mont-trelod.gpx
//
// Les points sont recopiés tels quels (altitude, heure, fréquence cardiaque) :
// seul leur regroupement change. Les trous de plus d'une minute sont signalés
// sur stderr — ce sont les interruptions d'enregistrement, que le décodeur
// retrouvera ensuite comme pauses.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const R = 6371000, RAD = Math.PI / 180;

function haversine(a, b) {
  const p1 = a.lat * RAD, p2 = b.lat * RAD;
  const dp = (b.lat - a.lat) * RAD, dl = (b.lon - a.lon) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function readPoints(text, file) {
  const blocks = text.match(/<trkpt\b[\s\S]*?<\/trkpt>|<trkpt\b[^>]*\/>/g) || [];
  if (!blocks.length) throw new Error(`${file} : aucun point GPS`);
  return blocks.map(xml => {
    const lat = /\blat="([\d.eE+-]+)"/.exec(xml), lon = /\blon="([\d.eE+-]+)"/.exec(xml);
    const time = /<time>([^<]+)<\/time>/.exec(xml);
    return {
      xml,
      lat: lat ? +lat[1] : NaN,
      lon: lon ? +lon[1] : NaN,
      t: time ? Date.parse(time[1]) : NaN,
    };
  });
}

export function mergePoints(groups) {
  const all = groups.flat().filter(p => Number.isFinite(p.t));
  all.sort((a, b) => a.t - b.t);
  const out = [], gaps = [];
  for (const p of all) {
    const last = out[out.length - 1];
    if (last && last.t === p.t && last.lat === p.lat && last.lon === p.lon) continue;
    if (last) {
      const dt = (p.t - last.t) / 1000;
      if (dt > 60) gaps.push({ dt, metres: haversine(last, p), at: last.t });
    }
    out.push(p);
  }
  return { points: out, gaps };
}

function gpx(name, points) {
  const head = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="scripts/merge-gpx.mjs" version="1.1"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/11.xsd">
  <metadata>
    <time>${new Date(points[0].t).toISOString().replace(/\.\d+Z$/, '.000Z')}</time>
  </metadata>
  <trk>
    <name>${name.replace(/[<&]/g, '')}</name>
    <type>hiking</type>
    <trkseg>
`;
  const body = points.map(p => '      ' + p.xml.trim().replace(/\n\s+/g, '\n        ')).join('\n');
  return head + body + '\n    </trkseg>\n  </trk>\n</gpx>\n';
}

function main(files) {
  if (files.length < 2) {
    console.error('usage : node scripts/merge-gpx.mjs a.gpx b.gpx [...] > fusion.gpx');
    process.exit(1);
  }
  const groups = [], names = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const pts = readPoints(text, f);
    const n = /<trk>[\s\S]*?<name>([^<]+)<\/name>/.exec(text);
    if (n) names.push(n[1]);
    console.error(`${f} : ${pts.length} points, ${new Date(pts[0].t).toISOString().slice(11, 19)} → ${new Date(pts[pts.length - 1].t).toISOString().slice(11, 19)}`);
    groups.push(pts);
  }
  const { points, gaps } = mergePoints(groups);
  for (const g of gaps) {
    console.error(`  trou de ${Math.round(g.dt)} s (${Math.round(g.metres)} m) à ${new Date(g.at).toISOString().slice(11, 19)}`);
  }
  console.error(`fusion : ${points.length} points, ${gaps.length} interruption(s)`);
  process.stdout.write(gpx(names[0] || 'Sortie', points));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
