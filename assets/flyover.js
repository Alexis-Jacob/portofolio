/* Survol 3D d'une trace GPS — MapLibre GL + terrain (façon Strava Flyover).
   Utilisation : Flyover.mount(element, track) où `track` vient de scripts/fit-to-json.mjs. */
(function (global) {
  'use strict';

  var ACCENT = '#b1803f';
  var DONE = '#f0a03c';

  // — Fonds de carte (aucune clé API requise) —
  var BASEMAPS = {
    satellite: {
      label: 'Satellite',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      maxzoom: 19,
      attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics',
    },
    topo: {
      label: 'Carte',
      tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
              'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
              'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
      maxzoom: 17,
      attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap',
    },
  };
  var DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];

  var EXAGGERATION = 1.3;   // doit rester aligné avec setTerrain()
  var CLEARANCE = 200;      // garde minimale au-dessus du relief, en mètres
  var TAU = 1.1;            // constante de temps du lissage du cap, en secondes
  var MAX_TURN = 45;        // vitesse de rotation maximale, en degrés par seconde (× la vitesse de lecture)

  // — Géométrie —
  var RAD = Math.PI / 180;
  function haversine(a, b) {
    var dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 12742000 * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    var y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
    var x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) -
      Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  // Point situé à `dist` mètres dans la direction `brng` depuis (lng, lat).
  function destination(lng, lat, brng, dist) {
    var d = dist / 6371000, b = brng * RAD, la = lat * RAD, lo = lng * RAD;
    var la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    var lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la),
                              Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [lo2 / RAD, la2 / RAD];
  }

  function lerpAngle(from, to, t) {
    var d = ((to - from + 540) % 360) - 180;
    return (from + d * t + 360) % 360;
  }

  // — Formatage —
  function spaced(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f'); }
  function km(m) { return (m / 1000).toFixed(1).replace('.', ',') + ' km'; }
  function hms(s) {
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    return h ? h + ' h ' + (m < 10 ? '0' + m : m) : m + ' min';
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function clock(date, seconds, tzOffset) {
    var d = new Date(date.getTime() + (seconds + tzOffset) * 1000);
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }

  function Flyover(el, track, opts) {
    opts = opts || {};
    this.el = el;
    this.track = track;
    this.pts = track.pts;
    this.startDate = new Date(track.date);
    this.tz = track.tzOffset || 0;
    this.duration = opts.duration || 75;     // secondes de survol pour la trace entière
    this.peaks = opts.peaks || [];           // [lon, lat, altitude, nom] autour de la trace
    this.rate = 1;
    this.playing = false;
    this.freeLook = false;
    this.progress = 0;                        // 0 → 1, le long de la distance
    this.heading = null;

    // Distance cumulée + dénivelé cumulé, pour l'interpolation et le HUD
    var cum = [0], gain = [0], up = 0;
    for (var i = 1; i < this.pts.length; i++) {
      cum.push(cum[i - 1] + haversine(this.pts[i - 1], this.pts[i]));
      var dz = this.pts[i][2] - this.pts[i - 1][2];
      if (dz > 0) up += dz;
      gain.push(up);
    }
    // Le D+ cumulé du HUD est mis à l'échelle du dénivelé mesuré par la montre,
    // pour que la valeur finale colle à celle affichée sous la carte.
    var official = track.stats && track.stats.ascent;
    if (official && up > 0) {
      var k = official / up;
      for (var g = 0; g < gain.length; g++) gain[g] *= k;
    }
    this.cum = cum;
    this.gain = gain;
    this.total = cum[cum.length - 1] || 1;
    // Sur une trace courte et sinueuse, une anticipation proportionnelle devient
    // minuscule et la caméra suit chaque lacet : on la borne en mètres absolus.
    this.lookAhead = Math.max(250, Math.min(600, this.total * 0.02));
    this.camBack = Math.max(300, Math.min(950, this.total / 15));
    this.camBack0 = this.camBack;
    this.orbit = 0;      // décalage d'angle autour du coureur, en degrés
    this.height = 1;     // hauteur de la caméra, en multiples de la valeur par défaut
    this.lockHeading = false;

    this.build();
  }

  // Position interpolée à la distance d (mètres)
  Flyover.prototype.at = function (d) {
    var cum = this.cum, lo = 0, hi = cum.length - 1;
    d = Math.max(0, Math.min(this.total, d));
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    var a = this.pts[lo], b = this.pts[hi];
    var span = cum[hi] - cum[lo];
    var t = span > 0 ? (d - cum[lo]) / span : 0;
    return {
      i: lo,
      lng: a[0] + (b[0] - a[0]) * t,
      lat: a[1] + (b[1] - a[1]) * t,
      alt: a[2] + (b[2] - a[2]) * t,
      time: a[3] + (b[3] - a[3]) * t,
      gain: this.gain[lo] + (this.gain[hi] - this.gain[lo]) * t,
    };
  };

  // — DOM —
  Flyover.prototype.build = function () {
    var s = this.track.stats;
    this.el.innerHTML =
      '<div class="fo-map"></div>' +
      '<div class="fo-hud">' +
        '<div class="fo-stat"><span>Distance</span><b data-fo="dist">0,0 km</b></div>' +
        '<div class="fo-stat"><span>Altitude</span><b data-fo="alt">' + s.altMin + ' m</b></div>' +
        '<div class="fo-stat"><span>D+</span><b data-fo="gain">0 m</b></div>' +
        '<div class="fo-stat"><span>Heure</span><b data-fo="clock">' + clock(this.startDate, 0, this.tz) + '</b></div>' +
      '</div>' +
      '<div class="fo-note" data-fo="note"></div>' +
      '<div class="fo-bottom">' +
        '<div class="fo-profile" data-fo="profile"></div>' +
        '<div class="fo-controls">' +
          '<button class="fo-btn fo-play" data-fo="play" aria-label="Lancer le survol">▶</button>' +
          '<button class="fo-btn" data-fo="restart" aria-label="Recommencer">↻</button>' +
          '<button class="fo-btn fo-rate" data-fo="rate">1×</button>' +
          '<button class="fo-btn fo-lock" data-fo="lock" title="Figer l\'orientation de la caméra" aria-pressed="false">Cap</button>' +
          '<button class="fo-btn fo-pano" data-fo="pano" title="Tour d\'horizon depuis le point haut" aria-pressed="false">Horizon</button>' +
          '<input class="fo-scrub" data-fo="scrub" type="range" min="0" max="1000" value="0" aria-label="Position sur le parcours">' +
          '<button class="fo-btn fo-recenter" data-fo="recenter" hidden>Recadrer</button>' +
        '</div>' +
      '</div>' +
      '<div class="fo-basemaps">' +
        '<button class="fo-chip is-on" data-basemap="satellite">Satellite</button>' +
        '<button class="fo-chip" data-basemap="topo">Carte</button>' +
      '</div>' +
      '<div class="fo-loading" data-fo="loading">Chargement du relief…</div>';

    this.q = {};
    var self = this;
    Array.prototype.forEach.call(this.el.querySelectorAll('[data-fo]'), function (n) {
      self.q[n.getAttribute('data-fo')] = n;
    });

    this.drawProfile();
    this.initMap();
    this.bindControls();
  };

  // — Profil altimétrique (SVG) —
  Flyover.prototype.drawProfile = function () {
    var W = 1000, H = 100, pts = this.pts, cum = this.cum, total = this.total;
    var lo = this.track.stats.altMin, hi = this.track.stats.altMax;
    var span = Math.max(1, hi - lo);
    var d = '';
    for (var i = 0; i < pts.length; i++) {
      var x = (cum[i] / total) * W;
      var y = H - ((pts[i][2] - lo) / span) * (H - 8) - 4;
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    var marks = (this.track.pauses || []).map(function (p) {
      return '<line x1="' + ((cum[p.i] / total) * W).toFixed(1) + '" y1="0" x2="' +
        ((cum[p.i] / total) * W).toFixed(1) + '" y2="' + H + '" class="fo-pause"/>';
    }).join('');

    this.q.profile.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><clipPath id="fo-clip-' + this.track.id + '"><rect data-fo-clip x="0" y="0" width="0" height="' + H + '"/></clipPath></defs>' +
        '<path class="fo-prof-bg" d="' + d + '"/>' +
        '<path class="fo-prof-fg" d="' + d + '" clip-path="url(#fo-clip-' + this.track.id + ')"/>' +
        marks +
      '</svg>';
    this.clipRect = this.q.profile.querySelector('[data-fo-clip]');
    this.profW = W;
  };

  // — Carte —
  Flyover.prototype.initMap = function () {
    var self = this;
    var line = { type: 'Feature', geometry: { type: 'LineString', coordinates: this.pts.map(function (p) { return [p[0], p[1]]; }) } };

    var map = this.map = new maplibregl.Map({
      container: this.el.querySelector('.fo-map'),
      antialias: true,
      pitch: 62,
      bearing: 0,
      maxPitch: 80,
      attributionControl: { compact: true },
      style: {
        version: 8,
        sources: {
          base: { type: 'raster', tiles: BASEMAPS.satellite.tiles, tileSize: 256, maxzoom: BASEMAPS.satellite.maxzoom, attribution: BASEMAPS.satellite.attribution },
          dem: { type: 'raster-dem', tiles: DEM_TILES, tileSize: 256, maxzoom: 14, encoding: 'terrarium', attribution: 'Relief : Mapzen / AWS Terrain Tiles' },
          demShade: { type: 'raster-dem', tiles: DEM_TILES, tileSize: 256, maxzoom: 14, encoding: 'terrarium' },
          route: { type: 'geojson', data: line },
          done: { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } },
          here: { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Point', coordinates: this.pts[0].slice(0, 2) } } },
          pins: { type: 'geojson', data: this.pinData() },
          // maxzoom bas volontairement : les sommets lointains partagent alors la tuile
          // du premier plan, sinon MapLibre ne charge jamais celle du Mont Blanc à 54 km
          // et l'étiquette n'apparaît pas. Coût : ~10 m d'imprécision de position.
          peaks: { type: 'geojson', data: this.peakData(), maxzoom: 5 },
        },
        layers: [
          { id: 'fond', type: 'background', paint: { 'background-color': '#cdc6b8' } },
          { id: 'base', type: 'raster', source: 'base' },
          { id: 'hillshade', type: 'hillshade', source: 'demShade', paint: { 'hillshade-exaggeration': 0.28, 'hillshade-shadow-color': '#1b1813' } },
          { id: 'route-halo', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#1b1813', 'line-width': 7, 'line-opacity': 0.35, 'line-blur': 3 } },
          { id: 'route-todo', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#f8f7f3', 'line-width': 2.5, 'line-opacity': 0.5 } },
          { id: 'route-done', type: 'line', source: 'done', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': DONE, 'line-width': 5 } },
          { id: 'peaks-dot', type: 'circle', source: 'peaks', minzoom: 10.5,
            paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'km'], 0, 2.5, 20, 2, 45, 1.6],
                     'circle-color': 'rgba(248,247,243,.85)',
                     'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(27,24,19,.7)' } },
          { id: 'peaks-label', type: 'symbol', source: 'peaks', minzoom: 10.5,
            layout: { 'text-field': ['get', 'label'], 'text-line-height': 1.15,
                      // au loin, l'étiquette s'efface un peu pour laisser le premier plan lisible
                      'text-size': ['interpolate', ['linear'], ['get', 'km'], 0, 10.5, 20, 9.5, 45, 9],
                      'text-offset': [0, -0.7], 'text-anchor': 'bottom', 'text-padding': 6,
                      'text-allow-overlap': false, 'text-optional': true,
                      'symbol-sort-key': ['get', 'rank'] },
            paint: { 'text-color': ['interpolate', ['linear'], ['get', 'km'], 0, 'rgba(248,247,243,.92)', 45, 'rgba(248,247,243,.75)'],
                     'text-halo-color': 'rgba(20,18,15,.85)', 'text-halo-width': 1.3 } },
          { id: 'pins-dot', type: 'circle', source: 'pins',
            paint: { 'circle-radius': 5, 'circle-color': '#f8f7f3', 'circle-stroke-width': 2, 'circle-stroke-color': '#1b1813' } },
          { id: 'pins-label', type: 'symbol', source: 'pins',
            layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-allow-overlap': false },
            paint: { 'text-color': '#fff', 'text-halo-color': '#1b1813', 'text-halo-width': 1.4 } },
          { id: 'here-glow', type: 'circle', source: 'here',
            paint: { 'circle-radius': 14, 'circle-color': DONE, 'circle-opacity': 0.25, 'circle-blur': 0.6 } },
          { id: 'here-dot', type: 'circle', source: 'here',
            paint: { 'circle-radius': 6, 'circle-color': DONE, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } },
        ],
        sky: {
          'sky-color': '#7ba6c8', 'sky-horizon-blend': 0.6,
          'horizon-color': '#e6dcc8', 'horizon-fog-blend': 0.6,
          'fog-color': '#d9d2c4', 'fog-ground-blend': 0.05,
        },
      },
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.on('load', function () {
      map.setTerrain({ source: 'dem', exaggeration: 1.3 });
      // Attribution repliée derrière la pastille ⓘ : elle masquait la barre de lecture.
      var attrib = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
      if (attrib) attrib.classList.remove('maplibregl-compact-show');
      self.q.loading.hidden = true;
      self.overview(0);
      self.update(0);
    });
    map.on('error', function (e) {
      if (e && e.error && /dem|terrarium/i.test(String(e.error.url || ''))) return; // tuile de relief manquante : pas bloquant
    });

    this.bindGestures();
  };

  Flyover.prototype.pinData = function () {
    var pts = this.pts, feats = [];
    function pin(p, label) {
      feats.push({ type: 'Feature', properties: { label: label }, geometry: { type: 'Point', coordinates: [p[0], p[1]] } });
    }
    pin(pts[0], 'Départ');
    (this.track.pauses || []).forEach(function (p) {
      if (p.seconds > 3 * 3600) pin(pts[p.i], 'Bivouac · ' + hms(p.seconds));
    });
    var top = 0;
    for (var i = 1; i < pts.length; i++) if (pts[i][2] > pts[top][2]) top = i;
    pin(pts[top], 'Sommet · ' + pts[top][2] + ' m');
    pin(pts[pts.length - 1], 'Arrivée');
    return { type: 'FeatureCollection', features: feats };
  };

  // Sommets voisins : on écarte celui qui tombe sur le point haut de la trace,
  // déjà signalé par son propre repère.
  Flyover.prototype.peakData = function () {
    var pts = this.pts, top = 0;
    for (var i = 1; i < pts.length; i++) if (pts[i][2] > pts[top][2]) top = i;
    var summit = [pts[top][0], pts[top][1]];
    var feats = [];
    for (var j = 0; j < this.peaks.length; j++) {
      var p = this.peaks[j];
      if (!p || p.length < 4) continue;
      if (haversine([p[0], p[1]], summit) < 250) continue;
      var ele = typeof p[2] === 'number' ? p[2] : null;
      // 5e champ facultatif : distance à la trace, utilisée pour l'échelle des étiquettes
      var km = typeof p[4] === 'number' ? p[4] / 1000 : 0;
      feats.push({
        type: 'Feature',
        properties: {
          label: p[3] + (ele === null ? '' : '\n' + spaced(ele) + ' m'),
          ele: ele === null ? 0 : ele,
          km: km,
          // Les hauts sommets passent devant, mais à altitude comparable
          // le plus proche gagne : c'est lui qu'on identifie à l'œil.
          rank: -((ele === null ? 0 : ele) - km * 15),
        },
        geometry: { type: 'Point', coordinates: [p[0], p[1]] },
      });
    }
    return { type: 'FeatureCollection', features: feats };
  };

  // Vue d'ensemble inclinée sur toute la trace
  Flyover.prototype.overview = function (ms) {
    var b = new maplibregl.LngLatBounds();
    this.pts.forEach(function (p) { b.extend([p[0], p[1]]); });
    var c = b.getCenter();
    this.map.fitBounds(b, {
      padding: { top: 90, bottom: 160, left: 60, right: 60 },
      pitch: 58,
      bearing: bearing([c.lng, c.lat], [this.pts[0][0], this.pts[0][1]]) + 180,
      duration: ms || 0,
    });
  };

  // — Rendu d'un instant du survol —
  Flyover.prototype.update = function (progress, moveCamera) {
    this.progress = Math.max(0, Math.min(1, progress));
    var d = this.progress * this.total;
    var p = this.at(d);

    // Trace parcourue
    var coords = this.pts.slice(0, p.i + 1).map(function (q) { return [q[0], q[1]]; });
    coords.push([p.lng, p.lat]);
    var src = this.map.getSource('done');
    if (src) src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
    var here = this.map.getSource('here');
    if (here) here.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });

    // Caméra de poursuite
    if (moveCamera && !this.freeLook) {
      var ahead = this.at(Math.min(this.total, d + this.lookAhead));
      var target = bearing([p.lng, p.lat], [ahead.lng, ahead.lat]);
      this.heading = this.steer(target);
      this.chase(p, this.heading);
    }

    // HUD
    this.q.dist.textContent = km(d);
    this.q.alt.textContent = Math.round(p.alt) + ' m';
    this.q.gain.textContent = Math.round(p.gain) + ' m';
    this.q.clock.textContent = clock(this.startDate, p.time, this.tz);
    this.clipRect.setAttribute('width', (this.progress * this.profW).toFixed(1));
    this.q.scrub.value = String(Math.round(this.progress * 1000));

    // Note contextuelle quand on traverse une pause longue
    var note = '';
    (this.track.pauses || []).forEach(function (pause) {
      if (p.i === pause.i && pause.seconds > 900) {
        note = pause.seconds > 3 * 3600 ? 'Bivouac — ' + hms(pause.seconds) + ' sur place' : 'Pause — ' + hms(pause.seconds);
      }
    });
    this.q.note.textContent = note;
    this.q.note.classList.toggle('is-on', !!note);
  };

  // Oriente la caméra vers `target` sans jamais pivoter plus vite que MAX_TURN.
  // Le lissage se fait sur le temps écoulé, pas sur le nombre d'images : la rotation
  // est identique sur un téléphone poussif et sur un écran à 120 Hz.
  Flyover.prototype.steer = function (target) {
    var now = performance.now();
    var dt = this._lastSteer ? Math.min(0.12, (now - this._lastSteer) / 1000) : 0;
    this._lastSteer = now;
    if (this.heading === null) return target;          // premier cadrage : on adopte le cap
    if (this.lockHeading) return this.heading;         // cap figé par le spectateur
    var eased = lerpAngle(this.heading, target, 1 - Math.exp(-dt / TAU));
    var step = ((eased - this.heading + 540) % 360) - 180;
    var max = MAX_TURN * (this.rate || 1) * dt;
    if (step > max) step = max; else if (step < -max) step = -max;
    return (this.heading + step + 360) % 360;
  };

  // Altitude du relief affiché en un point (le DEM est exagéré, la valeur l'est aussi).
  Flyover.prototype.ground = function (lng, lat, fallback) {
    var z = this.map.queryTerrainElevation([lng, lat]);
    return (z === null || z === undefined || !isFinite(z)) ? fallback : z;
  };

  // Place la caméra derrière le point courant, à une altitude qui domine tout le
  // relief situé entre elle et lui. On ne relit jamais le zoom de la carte : MapLibre
  // le recalcule lui-même quand l'altitude du sol change, et le réinjecter créait une
  // boucle qui rapprochait la caméra jusqu'à l'enfoncer dans la montagne.
  Flyover.prototype.chase = function (p, heading) {
    var map = this.map;
    var view = (heading + this.orbit + 360) % 360;   // angle de vue choisi par le spectateur
    var fallback = p.alt * EXAGGERATION;
    var target = this.ground(p.lng, p.lat, fallback);
    var cam = destination(p.lng, p.lat, view + 180, this.camBack);
    var now = performance.now();

    // Sonder le relief à chaque image coûte cher pour rien : le point haut entre la
    // caméra et le coureur ne bouge pas d'une image à l'autre. On le recalcule tous
    // les 150 ms, et on garde l'altitude entre deux mesures.
    if (!this._peakAt || now - this._peakAt > 150) {
      var peak = target;
      for (var i = 1; i <= 4; i++) {
        var s = destination(p.lng, p.lat, view + 180, this.camBack * i / 4);
        peak = Math.max(peak, this.ground(s[0], s[1], fallback));
      }
      this._peak = peak;
      this._peakAt = now;
    }
    // Hauteur demandée par le spectateur, jamais en dessous de la garde au relief.
    var wanted = Math.max(Math.max(this._peak, target) + CLEARANCE,
                          target + this.camBack * 0.45 * this.height);

    // On monte d'un coup quand le relief l'exige, on redescend en douceur : la garde
    // au sol reste garantie, sans à-coups quand la paroi s'éloigne.
    if (this._camAlt === undefined || wanted > this._camAlt) this._camAlt = wanted;
    else this._camAlt += (wanted - this._camAlt) * 0.08;

    map.jumpTo(map.calculateCameraOptionsFromTo(
      { lng: cam[0], lat: cam[1] }, this._camAlt,
      { lng: p.lng, lat: p.lat }, target));
  };

  // Pendant la lecture, la carte n'est plus manipulée par MapLibre : les gestes
  // pilotent la caméra de poursuite (tourner autour, monter, s'éloigner) et le
  // coureur reste au centre. À l'arrêt, la carte redevient une carte normale.
  var HANDLERS = ['dragPan', 'scrollZoom', 'dragRotate', 'touchZoomRotate', 'doubleClickZoom', 'keyboard'];
  Flyover.prototype.mapHandlers = function (on) {
    var m = this.map;
    HANDLERS.forEach(function (h) { if (m[h]) on ? m[h].enable() : m[h].disable(); });
  };

  Flyover.prototype.adjusted = function () {
    return Math.abs(this.orbit) > 0.5 || Math.abs(this.height - 1) > 0.02 ||
           Math.abs(this.camBack - this.camBack0) > 1;
  };

  Flyover.prototype.touched = function () {
    this.q.recenter.hidden = !this.adjusted();
    this._camAlt = undefined;   // le réglage doit répondre tout de suite, sans lissage
    if (this.playing) this.update(this.progress, true);
  };

  Flyover.prototype.bindGestures = function () {
    var self = this;
    var el = this.map.getCanvasContainer();
    var pointers = {};
    var pinch = null;

    var live = function () { return self.playing; };
    var list = function () { return Object.keys(pointers).map(function (k) { return pointers[k]; }); };

    el.addEventListener('pointerdown', function (e) {
      if (!live()) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY, type: e.pointerType };
      if (e.pointerType === 'mouse' && el.setPointerCapture) el.setPointerCapture(e.pointerId);
      var pts = list();
      if (pts.length === 2) pinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    });

    el.addEventListener('pointermove', function (e) {
      var prev = pointers[e.pointerId];
      if (!live() || !prev) return;
      var dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      prev.x = e.clientX; prev.y = e.clientY;
      var pts = list();
      // Au doigt, il faut deux points de contact : un seul doigt doit pouvoir
      // faire défiler la page par-dessus la carte.
      if (e.pointerType === 'touch' && pts.length < 2) return;
      e.preventDefault();
      if (pts.length >= 2) {
        var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinch) self.setBack(self.camBack * (pinch / (d || pinch)));
        pinch = d;
        dx /= 2; dy /= 2;   // le geste est compté une fois par doigt
      }
      self.orbit = ((self.orbit - dx * 0.3 + 180) % 360 + 360) % 360 - 180;
      self.height = Math.max(0.4, Math.min(3.5, self.height * (1 + dy * 0.005)));
      self.touched();
    }, { passive: false });

    var end = function (e) {
      delete pointers[e.pointerId];
      if (list().length < 2) pinch = null;
    };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { el.addEventListener(t, end); });

    el.addEventListener('wheel', function (e) {
      if (!live()) return;
      e.preventDefault();
      self.setBack(self.camBack * Math.pow(1.0016, e.deltaY));
      self.touched();
    }, { passive: false });
  };

  Flyover.prototype.setBack = function (v) {
    this.camBack = Math.max(120, Math.min(6000, v));
  };

  // — Tour d'horizon —
  // En survol la caméra pique vers le sol : l'horizon reste au-dessus du cadre et
  // les sommets lointains ne sont jamais dessinés. Ici on se pose au-dessus du point
  // haut, presque à l'horizontale, et on fait un tour complet — c'est le seul moment
  // où le Mont Blanc entre dans l'image.
  // MapLibre borne la distance de rendu à la hauteur de vol : à 300 m au-dessus
  // du sommet, plus rien n'est dessiné au-delà d'une vingtaine de kilomètres.
  // Il faut monter à ~2,5 km au-dessus du point visé pour que le Mont Blanc,
  // à 54 km, entre dans l'image. D'où le mouvement en deux temps.
  var PANO_PITCH = 80, PANO_LOW = 700, PANO_HIGH = 2600, PANO_RISE = 0.2;

  Flyover.prototype.topPoint = function () {
    if (!this._top) {
      var t = 0;
      for (var i = 1; i < this.pts.length; i++) if (this.pts[i][2] > this.pts[t][2]) t = i;
      this._top = this.pts[t];
    }
    return this._top;
  };

  // u ∈ [0,1] : d'abord la prise de hauteur, puis le tour complet.
  // Pur positionnement, sans animation — le rendu vidéo appelle la même
  // fonction image par image.
  Flyover.prototype.panoAt = function (u) {
    var top = this.topPoint();
    var rise = Math.min(1, u / PANO_RISE);
    var turn = u <= PANO_RISE ? 0 : (u - PANO_RISE) / (1 - PANO_RISE);
    var clear = PANO_LOW + (PANO_HIGH - PANO_LOW) * (rise * rise * (3 - 2 * rise));
    var view = ((this.panoFrom || 0) + turn * 360) % 360;
    var look = top[2] * EXAGGERATION;
    var back = clear * Math.tan(PANO_PITCH * Math.PI / 180);
    var cam = destination(top[0], top[1], (view + 180) % 360, back);
    this.map.jumpTo(this.map.calculateCameraOptionsFromTo(
      { lng: cam[0], lat: cam[1] }, look + clear, { lng: top[0], lat: top[1] }, look));
  };

  Flyover.prototype.panorama = function (ms) {
    if (this.panning) return;
    if (this.playing) this.stop();
    this.panning = true;
    this.mapHandlers(false);
    this.el.classList.add('is-playing');
    this.q.pano.setAttribute('aria-pressed', 'true');
    this.panoFrom = this.map.getBearing();
    var self = this, span = ms || 14000, t0 = performance.now();
    cancelAnimationFrame(this._raf);
    (function frame(now) {
      if (!self.panning) return;
      var u = (now - t0) / span;
      if (u >= 1) { self.endPanorama(); return; }
      self.panoAt(u);
      self._raf = requestAnimationFrame(frame);
    })(performance.now());
  };

  Flyover.prototype.endPanorama = function () {
    if (!this.panning) return;
    this.panning = false;
    cancelAnimationFrame(this._raf);
    this.mapHandlers(true);
    this.el.classList.remove('is-playing');
    this.q.pano.setAttribute('aria-pressed', 'false');
    this._camAlt = undefined;
    this.heading = null;
    this.update(this.progress, true);
  };

  // — Lecture —
  Flyover.prototype.play = function () {
    if (this.progress >= 1) this.progress = 0;
    this._camAlt = undefined;
    this.playing = true;
    this.freeLook = false;
    this.q.recenter.hidden = !this.adjusted();
    this.mapHandlers(false);
    this.q.play.textContent = '❚❚';
    this.q.play.setAttribute('aria-label', 'Mettre en pause');
    this.el.classList.add('is-playing');
    this.heading = null;
    this.anchor();
    var self = this;
    cancelAnimationFrame(this._raf);
    (function frame(now) {
      if (!self.playing) return;
      // Progression au temps réel écoulé : un appareil lent joue moins fluide, pas plus lentement.
      var next = self._p0 + ((now - self._t0) / 1000 / self.duration) * self.rate;
      if (next >= 1) { self.update(1, true); self.stop(true); return; }
      self.update(next, true);
      self._raf = requestAnimationFrame(frame);
    })(performance.now());
  };

  // Repart du point courant : à appeler à chaque changement de vitesse.
  Flyover.prototype.anchor = function () {
    this._p0 = this.progress;
    this._t0 = performance.now();
  };

  Flyover.prototype.stop = function (finished) {
    this.playing = false;
    this.mapHandlers(true);
    cancelAnimationFrame(this._raf);
    this.q.play.textContent = finished ? '↻' : '▶';
    this.q.play.setAttribute('aria-label', finished ? 'Recommencer' : 'Lancer le survol');
    this.el.classList.remove('is-playing');
    if (finished) this.overview(2500);
  };

  Flyover.prototype.bindControls = function () {
    var self = this, q = this.q;
    q.play.addEventListener('click', function () {
      if (self.panning) return self.endPanorama();
      self.playing ? self.stop() : self.play();
    });
    q.pano.addEventListener('click', function () {
      self.panning ? self.endPanorama() : self.panorama();
    });
    q.restart.addEventListener('click', function () { self.stop(); self.progress = 0; self.heading = null; self.update(0, false); self.overview(1200); });
    q.rate.addEventListener('click', function () {
      self.rate = self.rate === 1 ? 2 : self.rate === 2 ? 4 : 1;
      q.rate.textContent = self.rate + '×';
      if (self.playing) self.anchor();
    });
    q.lock.addEventListener('click', function () {
      self.lockHeading = !self.lockHeading;
      q.lock.classList.toggle('is-on', self.lockHeading);
      q.lock.setAttribute('aria-pressed', self.lockHeading ? 'true' : 'false');
      q.lock.title = self.lockHeading ? 'Rendre l\'orientation automatique' : 'Figer l\'orientation de la caméra';
    });
    q.scrub.addEventListener('input', function () {
      self.stop();
      self.freeLook = false;
      if (!self.lockHeading) self.heading = null;   // recadrage immédiat
      self.update(+q.scrub.value / 1000, true);
    });
    q.recenter.addEventListener('click', function () {
      self.orbit = 0; self.height = 1; self.camBack = self.camBack0;
      self.freeLook = false; self._camAlt = undefined;
      q.recenter.hidden = true;
      self.update(self.progress, true);
    });
    Array.prototype.forEach.call(this.el.querySelectorAll('[data-basemap]'), function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-basemap'), bm = BASEMAPS[key];
        if (!bm) return;
        Array.prototype.forEach.call(self.el.querySelectorAll('[data-basemap]'), function (b) { b.classList.toggle('is-on', b === btn); });
        var src = self.map.getSource('base');
        if (src && src.setTiles) src.setTiles(bm.tiles);
      });
    });
  };

  // — Chargement paresseux de MapLibre —
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = function () { rej(new Error('échec du chargement de ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadCss(href) {
    if (document.querySelector('link[href="' + href + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  }

  var MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js';
  var MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css';
  var pending = null;

  global.Flyover = {
    Flyover: Flyover,
    ready: function () {
      if (global.maplibregl) return Promise.resolve();
      if (!pending) { loadCss(MAPLIBRE_CSS); pending = loadScript(MAPLIBRE_JS); }
      return pending;
    },
    mount: function (el, track, opts) {
      return this.ready().then(function () { return new Flyover(el, track, opts); });
    },
  };
})(window);
