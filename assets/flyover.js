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
  function lerpAngle(from, to, t) {
    var d = ((to - from + 540) % 360) - 180;
    return (from + d * t + 360) % 360;
  }

  // — Formatage —
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
          '<input class="fo-scrub" data-fo="scrub" type="range" min="0" max="1000" value="0" aria-label="Position sur le parcours">' +
          '<button class="fo-btn fo-recenter" data-fo="recenter" hidden>Recentrer</button>' +
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
        },
        layers: [
          { id: 'base', type: 'raster', source: 'base' },
          { id: 'hillshade', type: 'hillshade', source: 'demShade', paint: { 'hillshade-exaggeration': 0.28, 'hillshade-shadow-color': '#1b1813' } },
          { id: 'route-halo', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#1b1813', 'line-width': 7, 'line-opacity': 0.35, 'line-blur': 3 } },
          { id: 'route-todo', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#f8f7f3', 'line-width': 2.5, 'line-opacity': 0.5 } },
          { id: 'route-done', type: 'line', source: 'done', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': DONE, 'line-width': 5 } },
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

    // Toute manipulation de la carte pendant la lecture bascule en vue libre.
    ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart'].forEach(function (ev) {
      map.on(ev, function (e) {
        if (e.originalEvent && self.playing) { self.freeLook = true; self.q.recenter.hidden = false; }
      });
    });
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
      var ahead = this.at(Math.min(this.total, d + Math.max(60, this.total * 0.02)));
      var target = bearing([p.lng, p.lat], [ahead.lng, ahead.lat]);
      this.heading = this.heading === null ? target : lerpAngle(this.heading, target, 0.06);
      this.map.jumpTo({
        center: [p.lng, p.lat],
        bearing: this.heading,
        pitch: 70,
        zoom: this.map.getZoom() < 13 || this.map.getZoom() > 16.5 ? 15 : this.map.getZoom(),
      });
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

  // — Lecture —
  Flyover.prototype.play = function () {
    if (this.progress >= 1) this.progress = 0;
    this.playing = true;
    this.freeLook = false;
    this.q.recenter.hidden = true;
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
    cancelAnimationFrame(this._raf);
    this.q.play.textContent = finished ? '↻' : '▶';
    this.q.play.setAttribute('aria-label', finished ? 'Recommencer' : 'Lancer le survol');
    this.el.classList.remove('is-playing');
    if (finished) this.overview(2500);
  };

  Flyover.prototype.bindControls = function () {
    var self = this, q = this.q;
    q.play.addEventListener('click', function () { self.playing ? self.stop() : self.play(); });
    q.restart.addEventListener('click', function () { self.stop(); self.progress = 0; self.heading = null; self.update(0, false); self.overview(1200); });
    q.rate.addEventListener('click', function () {
      self.rate = self.rate === 1 ? 2 : self.rate === 2 ? 4 : 1;
      q.rate.textContent = self.rate + '×';
      if (self.playing) self.anchor();
    });
    q.scrub.addEventListener('input', function () {
      self.stop();
      self.freeLook = false;
      q.recenter.hidden = true;
      self.update(+q.scrub.value / 1000, true);
    });
    q.recenter.addEventListener('click', function () {
      self.freeLook = false; self.heading = null; q.recenter.hidden = true;
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
