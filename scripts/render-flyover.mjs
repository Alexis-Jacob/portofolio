#!/usr/bin/env node
// Exporte un survol en vidéo, image par image (le rendu logiciel est trop lent
// pour une capture en temps réel : on pilote la progression pas à pas).
//
//   node scripts/render-flyover.mjs --track=le-chatelard --to=0.5 --out=montee.mp4
//
// Options : --from/--to (0 à 1, portion du parcours), --seconds, --fps,
//           --width/--height, --title, --port, --ffmpeg, --maplibre (copie locale),
//           --format=jpeg|png, --quality, --idle (ms d'attente des tuiles par image)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a === undefined ? d : a.slice(n.length + 3); };

const track = opt('track', 'le-chatelard');
const from = parseFloat(opt('from', '0'));
const to = parseFloat(opt('to', '1'));
const seconds = parseFloat(opt('seconds', '18'));
const fps = parseInt(opt('fps', '25'), 10);
const width = parseInt(opt('width', '960'), 10);
const height = parseInt(opt('height', '540'), 10);
// Le JPEG s'encode bien plus vite que le PNG sur une image de type photo, et
// chaque image coûte déjà plusieurs secondes en rendu logiciel.
const format = opt('format', 'jpeg') === 'png' ? 'png' : 'jpeg';
const quality = parseInt(opt('quality', '92'), 10);
// Plafond d'attente du chargement des tuiles avant capture.
const idleMs = parseInt(opt('idle', '1200'), 10);
const title = opt('title', '');
const port = parseInt(opt('port', '8123'), 10);
const out = opt('out', 'survol.mp4');
const ffmpeg = opt('ffmpeg', findFfmpeg());
const frames = Math.max(2, Math.round(seconds * fps));
const dir = opt('frames', join(ROOT, '.frames'));

function findFfmpeg() {
  // Celui de Playwright ne sait ni lire une séquence PNG ni encoder en H.264 :
  // on ne le retient qu'en dernier recours.
  const candidats = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg',
                     join(ROOT, 'node_modules/ffmpeg-static/ffmpeg')];
  for (const p of candidats) if (existsSync(p)) return p;
  return 'ffmpeg';
}

// Vérifier l'encodeur avant de rendre quoi que ce soit : un ffmpeg absent
// se découvrait sinon après trois quarts d'heure de calcul.
try {
  execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
} catch {
  console.error(`ffmpeg introuvable (« ${ffmpeg} »). Installez-le, ou indiquez-le avec --ffmpeg=/chemin.`);
  process.exit(1);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = join(ROOT, normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  const f = existsSync(p) && !p.endsWith('/') ? p : join(ROOT, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(port);

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('erreur page :', e.message));

// Machine sans accès aux CDN : servir une copie locale de MapLibre
// (--maplibre=/chemin/vers/dist, ou la variable MAPLIBRE_DIST).
const dist = opt('maplibre', process.env.MAPLIBRE_DIST || '');
if (dist) {
  await page.route(/maplibre-gl\.(js|css)(\?.*)?$/, r => {
    const css = r.request().url().includes('.css');
    r.fulfill({ contentType: css ? 'text/css' : 'text/javascript',
                body: readFileSync(join(dist, css ? 'maplibre-gl.css' : 'maplibre-gl.js')) });
  });
}

await page.goto(`http://localhost:${port}/#ete-2026`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.Flyover && !!window.ETE2026_TRACKS, { timeout: 60000 });

// La carte visée passe en plein écran, seule : on garde le bandeau de chiffres et
// le profil, on retire la navigation, les boutons et les contrôles de la carte.
// On la monte nous-mêmes plutôt que d'attendre le défilement de la page.
const monte = await page.evaluate(async ({ id, title }) => {
  const el = document.getElementById('fo-' + id);
  if (!el) return 'conteneur introuvable : ' + id;
  const t = (window.ETE2026_TRACKS || []).find(x => x.id === id);
  if (!t) return 'trace inconnue : ' + id;

  document.body.appendChild(el);
  Object.assign(el.style, { position: 'fixed', inset: '0', width: '100%', height: '100%',
    maxHeight: 'none', aspectRatio: 'auto', border: 'none', zIndex: '9999' });
  const css = document.createElement('style');
  css.textContent = `
    #app, #lb { display: none !important; }
    body { margin: 0; overflow: hidden; background: #14120f; }
    .fo-controls, .fo-basemaps, .maplibregl-control-container { display: none !important; }
    .fo-bottom { padding-bottom: 22px; }
    .fo-title { position: absolute; left: 0; bottom: 96px; z-index: 5;
      background: rgba(20,18,15,.72); color: #f8f7f3; padding: 12px 18px;
      font: 400 13px/1.5 'Space Mono', monospace; letter-spacing: .12em; text-transform: uppercase; }`;
  document.head.appendChild(css);
  if (title) {
    const d = document.createElement('div');
    d.className = 'fo-title';
    d.textContent = title;
    el.appendChild(d);
  }

  if (!el.__fo) {
    el.dataset.mounted = '1';
    el.__fo = await window.Flyover.mount(el, t, { peaks: (window.ETE2026_PEAKS || {})[id] });
  }
  return null;
}, { id: track, title });
if (monte) { console.error(monte); process.exit(1); }

// `map.loaded()` reste faux tant qu'une source échoue : on se contente du style,
// puis on laisse le relief arriver.
await page.waitForFunction(id => document.getElementById('fo-' + id).__fo?.map?.isStyleLoaded(), track, { timeout: 120000 });
await page.evaluate(id => document.getElementById('fo-' + id).__fo.map.resize(), track);
await page.waitForTimeout(4000);

console.error(`rendu : ${track} de ${(from * 100).toFixed(0)}% à ${(to * 100).toFixed(0)}%, ` +
  `${frames} images à ${fps} im/s (${seconds} s), ${width}×${height}`);

const started = Date.now();
for (let i = 0; i < frames; i++) {
  const p = from + (to - from) * (i / (frames - 1));
  // Les tuiles de la vue courante doivent être arrivées avant la capture, sinon
  // la vidéo clignote : on attend que la carte se déclare au repos.
  await page.evaluate(({ id, p, idle }) => new Promise(res => {
    const fo = document.getElementById('fo-' + id).__fo;
    fo.update(p, true);
    const m = fo.map;
    if (m.areTilesLoaded() && !m.isMoving()) return res();
    const done = () => { m.off('idle', done); res(); };
    m.on('idle', done);
    setTimeout(done, idle);
  }), { id: track, p, idle: idleMs });
  await page.screenshot({
    path: join(dir, String(i).padStart(5, '0') + (format === 'png' ? '.png' : '.jpg')),
    type: format,
    ...(format === 'jpeg' ? { quality } : {}),
    timeout: 120000,        // une capture en rendu logiciel peut dépasser les 30 s par défaut
    animations: 'disabled',
  });
  if (i % 25 === 0 || i === frames - 1) {
    const par = (Date.now() - started) / (i + 1) / 1000;
    console.error(`  ${i + 1}/${frames} — ${par.toFixed(1)} s/image, reste ~${Math.round(par * (frames - i - 1) / 60)} min`);
  }
}

await browser.close();
server.close();

execFileSync(ffmpeg, ['-y', '-framerate', String(fps), '-i', join(dir, '%05d.' + (format === 'png' ? 'png' : 'jpg')),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', out], { stdio: 'inherit' });
rmSync(dir, { recursive: true, force: true });
console.error(`\n→ ${out}`);
