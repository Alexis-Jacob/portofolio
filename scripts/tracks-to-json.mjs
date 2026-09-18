#!/usr/bin/env node
// Décodeur de traces GPS sans dépendance : .fit (Garmin/Wahoo/Suunto) et .gpx.
// Usage: node scripts/tracks-to-json.mjs tracks/* > data/ete-2026.js
//        node scripts/tracks-to-json.mjs --json tracks/sortie.gpx   (JSON brut sur stdout)
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// — Types de base FIT : [taille en octets, lecteur, valeur "invalide"] —
const BASE = {
  0x00: [1, (b, o) => b.readUInt8(o), 0xFF],                 // enum
  0x01: [1, (b, o) => b.readInt8(o), 0x7F],                  // sint8
  0x02: [1, (b, o) => b.readUInt8(o), 0xFF],                 // uint8
  0x83: [2, (b, o, le) => le ? b.readInt16LE(o) : b.readInt16BE(o), 0x7FFF],
  0x84: [2, (b, o, le) => le ? b.readUInt16LE(o) : b.readUInt16BE(o), 0xFFFF],
  0x85: [4, (b, o, le) => le ? b.readInt32LE(o) : b.readInt32BE(o), 0x7FFFFFFF],
  0x86: [4, (b, o, le) => le ? b.readUInt32LE(o) : b.readUInt32BE(o), 0xFFFFFFFF],
  0x07: [1, (b, o) => b.readUInt8(o), 0x00],                 // string (traité octet par octet)
  0x88: [4, (b, o, le) => le ? b.readFloatLE(o) : b.readFloatBE(o), null],
  0x89: [8, (b, o, le) => le ? b.readDoubleLE(o) : b.readDoubleBE(o), null],
  0x0A: [1, (b, o) => b.readUInt8(o), 0x00],                 // uint8z
  0x8B: [2, (b, o, le) => le ? b.readUInt16LE(o) : b.readUInt16BE(o), 0x0000],
  0x8C: [4, (b, o, le) => le ? b.readUInt32LE(o) : b.readUInt32BE(o), 0x00000000],
  0x0D: [1, (b, o) => b.readUInt8(o), 0xFF],                 // byte
  0x8E: [8, (b, o, le) => le ? b.readBigInt64LE(o) : b.readBigInt64BE(o), null],
  0x8F: [8, (b, o, le) => le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o), null],
  0x90: [8, (b, o, le) => le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o), null],
};

const SEMI = 180 / Math.pow(2, 31);          // semicercles -> degrés
const FIT_EPOCH = Date.UTC(1989, 11, 31);    // 1989-12-31T00:00:00Z

// Champs qui nous intéressent : { numéro: [nom, échelle, offset] }
const RECORD_FIELDS = {
  253: ['timestamp', 1, 0],
  0:   ['lat', 1, 0],
  1:   ['lon', 1, 0],
  2:   ['altitude', 5, 500],
  3:   ['hr', 1, 0],
  4:   ['cadence', 1, 0],
  5:   ['distance', 100, 0],
  6:   ['speed', 1000, 0],
  7:   ['power', 1, 0],
  13:  ['temperature', 1, 0],
  73:  ['speed', 1000, 0],      // enhanced_speed
  78:  ['altitude', 5, 500],    // enhanced_altitude
};
const SESSION_FIELDS = {
  253: ['timestamp', 1, 0],
  2:   ['startTime', 1, 0],
  5:   ['sport', 1, 0],
  7:   ['elapsed', 1000, 0],
  8:   ['moving', 1000, 0],
  9:   ['distance', 100, 0],
  14:  ['avgSpeed', 1000, 0],
  15:  ['maxSpeed', 1000, 0],
  16:  ['avgHr', 1, 0],
  17:  ['maxHr', 1, 0],
  22:  ['ascent', 1, 0],
  23:  ['descent', 1, 0],
  20:  ['avgPower', 1, 0],
};

const ACTIVITY_FIELDS = {
  253: ['timestamp', 1, 0],
  5:   ['localTimestamp', 1, 0],
};

const SPORTS = {
  0: 'Sortie', 1: 'Course', 2: 'Vélo', 5: 'Natation', 11: 'Marche',
  12: 'Ski de fond', 13: 'Ski', 14: 'Snowboard', 15: 'Aviron',
  16: 'Alpinisme', 17: 'Randonnée', 18: 'Multisport', 19: 'Paddle',
  21: 'Trail', 37: 'Voile', 41: 'Kayak', 43: 'Escalade',
};

function decodeFit(buf) {
  const messages = { record: [], session: [], activity: [] };
  let pos = 0;

  while (pos + 12 <= buf.length) {
    // — En-tête de fichier —
    const headerSize = buf.readUInt8(pos);
    if (headerSize !== 12 && headerSize !== 14) break;
    if (buf.toString('ascii', pos + 8, pos + 12) !== '.FIT') break;
    const dataSize = buf.readUInt32LE(pos + 4);
    let p = pos + headerSize;
    const end = Math.min(p + dataSize, buf.length);

    const defs = new Map();  // localType -> définition
    let lastTimestamp = 0;

    while (p < end) {
      const header = buf.readUInt8(p++);
      let localType, timeOffset = null;

      if (header & 0x80) {                       // en-tête horodaté compressé
        localType = (header >> 5) & 0x03;
        timeOffset = header & 0x1F;
      } else {
        localType = header & 0x0F;
        if (header & 0x40) {                     // message de définition
          p++;                                   // réservé
          const le = buf.readUInt8(p++) === 0;
          const globalNum = le ? buf.readUInt16LE(p) : buf.readUInt16BE(p); p += 2;
          const nFields = buf.readUInt8(p++);
          const fields = [];
          for (let i = 0; i < nFields; i++) {
            fields.push({ num: buf.readUInt8(p), size: buf.readUInt8(p + 1), type: buf.readUInt8(p + 2) });
            p += 3;
          }
          if (header & 0x20) {                   // champs développeur
            const nDev = buf.readUInt8(p++);
            for (let i = 0; i < nDev; i++) {
              fields.push({ num: -1, size: buf.readUInt8(p + 1), type: 0x0D, dev: true });
              p += 3;
            }
          }
          defs.set(localType, { globalNum, le, fields });
          continue;
        }
      }

      // — Message de données —
      const def = defs.get(localType);
      if (!def) throw new Error(`message de données sans définition (local type ${localType}, offset ${p - 1})`);

      const map = def.globalNum === 20 ? RECORD_FIELDS
        : def.globalNum === 18 ? SESSION_FIELDS
        : def.globalNum === 34 ? ACTIVITY_FIELDS : null;
      const out = {};
      for (const f of def.fields) {
        const spec = BASE[f.type];
        const start = p;
        p += f.size;
        if (!map || f.dev) continue;
        const want = map[f.num];
        if (!want || !spec) continue;
        const [width, read, invalid] = spec;
        if (f.size < width || p > buf.length) continue;
        const raw = read(buf, start, def.le);
        if (invalid !== null && raw === invalid) continue;
        const [name, scale, offset] = want;
        out[name] = scale === 1 && offset === 0 ? raw : raw / scale - offset;
      }
      if (!map) continue;

      if (timeOffset !== null) {                 // reconstruction de l'horodatage compressé
        const rollover = (timeOffset < (lastTimestamp & 0x1F)) ? 0x20 : 0;
        out.timestamp = (lastTimestamp & ~0x1F) + timeOffset + rollover;
      }
      if (out.timestamp !== undefined) lastTimestamp = out.timestamp;

      if (def.globalNum === 20) messages.record.push(out);
      else if (def.globalNum === 18) messages.session.push(out);
      else if (def.globalNum === 34) messages.activity.push(out);
    }

    pos = end + 2;  // + CRC du fichier
  }
  return messages;
}

// — Ramer–Douglas–Peucker sur (lon, lat), tolérance en degrés —
function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const [x0, y0] = points[i0], [x1, y1] = points[i1];
    const dx = x1 - x0, dy = y1 - y0;
    const norm = Math.hypot(dx, dy);
    let far = -1, best = eps;
    for (let i = i0 + 1; i < i1; i++) {
      const [x, y] = points[i];
      const d = norm === 0
        ? Math.hypot(x - x0, y - y0)
        : Math.abs(dy * x - dx * y + x1 * y0 - y1 * x0) / norm;
      if (d > best) { best = d; far = i; }
    }
    if (far !== -1) { keep[far] = 1; stack.push([i0, far], [far, i1]); }
  }
  return points.filter((_, i) => keep[i]);
}

const haversine = (a, b) => {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

// Corrige les altitudes aberrantes (capteur qui décroche : 0 m ou saut absurde)
// en interpolant depuis les voisins valides.
function cleanAltitude(pts) {
  const bad = i => {
    const z = pts[i][2];
    if (z === undefined || z === null || z <= 0) return true;
    const prev = pts[i - 1]?.[2], next = pts[i + 1]?.[2];
    if (prev > 0 && next > 0 && Math.abs(z - prev) > 80 && Math.abs(z - next) > 80) return true;
    return false;
  };
  for (let i = 0; i < pts.length; i++) {
    if (!bad(i)) continue;
    let a = i - 1; while (a >= 0 && bad(a)) a--;
    let b = i + 1; while (b < pts.length && bad(b)) b++;
    if (a < 0 && b >= pts.length) { pts[i][2] = 0; continue; }
    if (a < 0) pts[i][2] = pts[b][2];
    else if (b >= pts.length) pts[i][2] = pts[a][2];
    else pts[i][2] = pts[a][2] + (pts[b][2] - pts[a][2]) * ((i - a) / (b - a));
  }
  return pts;
}


const PAUSE = 600;  // au-delà de 10 min sans point, on considère une pause (bivouac, arrêt…)

// Décalage horaire (en secondes) d'une zone IANA à une date donnée.
function tzOffsetFor(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).filter(p => p.type !== 'literal');
  const v = Object.fromEntries(parts.map(p => [p.type, +p.value]));
  return Math.round((Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - date.getTime()) / 1000);
}

export let DEFAULT_TZ = 'Europe/Paris';
export function setDefaultTz(z) { DEFAULT_TZ = z; }

// Lissage léger de l'altitude (moyenne glissante) avant calcul du dénivelé :
// sans baromètre, le bruit GPS gonfle le D+ de plusieurs centaines de mètres.
function smoothAltitude(pts, win) {
  const half = Math.floor(win / 2);
  const src = pts.map(p => p[2]);
  return pts.map((p, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(src.length - 1, i + half); j++) { sum += src[j]; n++; }
    return [p[0], p[1], sum / n, p[3], p[4], p[5]];
  });
}

// Étape commune aux deux formats : nettoyage, simplification, statistiques.
// `session` porte les valeurs de l'appareil quand elles existent (FIT), sinon on calcule tout.
function finalize(rawPts, meta, session) {
  const s = session || {};
  const pts = cleanAltitude(rawPts);
  if (!pts.length) throw new Error(`${meta.file} : aucun point GPS dans le fichier`);

  const t0 = pts[0][3];
  const simplified = rdp(pts, 2.5 / 111320);   // ~2,5 m de tolérance
  const forGain = s.ascent !== undefined ? pts : smoothAltitude(pts, 9);

  let dist = 0, moving = 0;
  for (let i = 1; i < pts.length; i++) {
    dist += haversine(pts[i - 1], pts[i]);
    const dt = pts[i][3] - pts[i - 1][3];
    if (dt > 0 && dt < PAUSE) moving += dt;
  }

  // Dénivelé par hystérésis : on ne comptabilise qu'au-delà de 3 m d'écart avec le
  // dernier palier retenu. Un seuil appliqué point par point effacerait les montées
  // régulières (chaque pas gagne moins que le seuil) ; l'hystérésis, elle, les garde.
  let ascent = 0, descent = 0, ref = forGain[0][2];
  for (let i = 1; i < forGain.length; i++) {
    const z = forGain[i][2];
    if (z - ref > 3) { ascent += z - ref; ref = z; }
    else if (ref - z > 3) { descent += ref - z; ref = z; }
  }

  const pauses = [];
  for (let i = 1; i < simplified.length; i++) {
    const dt = simplified[i][3] - simplified[i - 1][3];
    if (dt >= PAUSE) pauses.push({ i: i - 1, seconds: Math.round(dt) });
  }

  const alts = pts.map(p => p[2]).filter(z => z > 0);
  const hrs = pts.map(p => p[4]).filter(v => v !== undefined && v !== null);

  const startedAt = new Date(FIT_EPOCH + (s.startTime ?? t0) * 1000);

  return {
    id: basename(meta.file).replace(/\.(fit|gpx)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: meta.name || basename(meta.file).replace(/\.(fit|gpx)$/i, '').replace(/[_-]+/g, ' '),
    sport: meta.sport || 'Sortie',
    date: startedAt.toISOString(),
    // Décalage du lieu de la sortie : l'heure affichée ne dépend pas du fuseau du visiteur.
    tzOffset: meta.tzOffset ?? tzOffsetFor(startedAt, DEFAULT_TZ),
    stats: {
      distance: Math.round(s.distance ?? dist),
      ascent: Math.round(s.ascent ?? ascent),
      descent: Math.round(s.descent ?? descent),
      elapsed: Math.round(s.elapsed ?? (pts.at(-1)[3] - t0)),   // départ → arrivée, pauses incluses
      moving: Math.round(s.moving ?? moving),                    // temps réellement en mouvement
      altMin: Math.round(Math.min(...alts)),
      altMax: Math.round(Math.max(...alts)),
      avgHr: s.avgHr ?? (hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null),
      maxHr: s.maxHr ?? (hrs.length ? Math.max(...hrs) : null),
      points: pts.length,
    },
    pauses,
    // [lon, lat, altitude, secondes depuis le départ]
    pts: simplified.map(p => [
      +p[0].toFixed(6), +p[1].toFixed(6), Math.round(p[2]), Math.round(p[3] - t0),
    ]),
  };
}

function parseFit(buf, file) {
  const decoded = decodeFit(buf);
  const { record, session } = decoded;
  const pts = record
    .filter(r => r.lat !== undefined && r.lon !== undefined)
    .map(r => [r.lon * SEMI, r.lat * SEMI, r.altitude, r.timestamp ?? 0, r.hr, r.speed]);
  const s = session[0] || {};
  const act = (decoded.activity || [])[0];
  const tzOffset = act && act.localTimestamp !== undefined && act.timestamp !== undefined
    ? act.localTimestamp - act.timestamp
    : undefined;
  return finalize(pts, { file, sport: SPORTS[s.sport], tzOffset }, s);
}

// — GPX (Garmin Connect, Strava, Komoot…) —
const GPX_SPORTS = {
  hiking: 'Randonnée', walking: 'Marche', running: 'Course', trail_running: 'Trail',
  cycling: 'Vélo', road_biking: 'Vélo', mountain_biking: 'VTT', gravel_cycling: 'Gravel',
  backcountry_skiing: 'Ski de rando', resort_skiing: 'Ski', snowboarding: 'Snowboard',
  mountaineering: 'Alpinisme', rock_climbing: 'Escalade', kayaking: 'Kayak', swimming: 'Natation',
  1: 'Vélo', 4: 'Randonnée', 9: 'Course', 16: 'Marche',
};

function parseGpx(text, file) {
  const num = /lat="([-\d.eE]+)"\s+lon="([-\d.eE]+)"|lon="([-\d.eE]+)"\s+lat="([-\d.eE]+)"/;
  const pts = [];
  const blocks = text.match(/<trkpt\b[\s\S]*?<\/trkpt>|<trkpt\b[^>]*\/>/g) || [];
  for (const b of blocks) {
    const m = b.match(num);
    if (!m) continue;
    const lat = parseFloat(m[1] ?? m[4]), lon = parseFloat(m[2] ?? m[3]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const ele = b.match(/<ele>([-\d.eE]+)<\/ele>/);
    const time = b.match(/<time>([^<]+)<\/time>/);
    const hr = b.match(/<(?:\w+:)?hr>(\d+)<\/(?:\w+:)?hr>/);
    pts.push([
      lon, lat,
      ele ? parseFloat(ele[1]) : undefined,
      time ? Math.round((Date.parse(time[1]) - FIT_EPOCH) / 1000) : 0,   // même base de temps que FIT
      hr ? +hr[1] : undefined,
      undefined,
    ]);
  }
  const name = (text.match(/<trk>[\s\S]*?<name>([^<]+)<\/name>/) || [])[1];
  const type = (text.match(/<trk>[\s\S]*?<type>([^<]+)<\/type>/) || [])[1];
  return finalize(pts, {
    file,
    name: name && name.trim(),
    sport: type ? (GPX_SPORTS[type.trim()] || GPX_SPORTS[type.trim().toLowerCase()] || 'Sortie') : undefined,
  }, null);
}

export function parseTrack(buf, file) {
  const isGpx = /\.gpx$/i.test(file) || buf.slice(0, 200).toString('utf8').includes('<gpx');
  return isGpx ? parseGpx(buf.toString('utf8'), file) : parseFit(buf, file);
}

// — CLI —
const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const rawJson = args.includes('--json');
  const tzArg = args.find(a => a.startsWith('--tz='));
  if (tzArg) setDefaultTz(tzArg.slice(5));
  const files = args.filter(a => !a.startsWith('--'));
  if (!files.length) {
    console.error('usage: node scripts/tracks-to-json.mjs [--json] [--tz=Europe/Paris] <fichiers .fit|.gpx>');
    process.exit(1);
  }
  const tracks = files.map(f => {
    const t = parseTrack(readFileSync(f), f);
    console.error(`${f} → ${t.stats.points} pts → ${t.pts.length} après simplification · ` +
      `${(t.stats.distance / 1000).toFixed(1)} km · D+${t.stats.ascent} m` +
      (t.pauses.length ? ` · ${t.pauses.length} pause(s)` : ''));
    return t;
  }).sort((a, b) => a.date.localeCompare(b.date));

  const payload = JSON.stringify(tracks, null, 0);
  process.stdout.write(rawJson ? payload + '\n'
    : `// Généré par scripts/fit-to-json.mjs — ne pas éditer à la main.\nwindow.ETE2026_TRACKS = ${payload};\n`);
}
