# portofolio

Site photo d'Alexis Jacob — une page unique (`index.html`), sans build ni dépendance.

## Section « Été 2026 » — survol 3D des traces GPS

Section non listée dans la navigation, accessible via `#ete-2026` (comme `#paris-nuit`).
Chaque sortie est rejouée en relief : caméra qui suit la trace, profil altimétrique,
distance / altitude / D+ / heure en direct.

| Fichier | Rôle |
| --- | --- |
| `tracks/` | traces brutes, `.fit` (montre) ou `.gpx` |
| `scripts/tracks-to-json.mjs` | décodeur sans dépendance : FIT et GPX → JSON compact |
| `scripts/merge-gpx.mjs` | recolle plusieurs GPX d'une même sortie (montre arrêtée en route) |
| `data/ete-2026.js` | données générées (`window.ETE2026_TRACKS`) — ne pas éditer à la main |
| `scripts/peaks.mjs` | récupère les sommets nommés autour des traces (OpenStreetMap) |
| `data/peaks.js` | sommets générés — facultatif, le survol marche sans |
| `assets/flyover.js` | moteur de survol (MapLibre GL + relief), chargé à la demande |

### Ajouter une sortie

```sh
cp ~/ma-sortie.fit tracks/mont-aiguille.fit        # le nom du fichier donne l'identifiant
node scripts/tracks-to-json.mjs tracks/*.fit tracks/*.gpx > data/ete-2026.js
```

Puis renseigner le titre, le lieu et le texte dans l'objet `ETE2026.tracks` de `index.html`,
en utilisant l'identifiant affiché par le script (`mont-aiguille` ici). Sans entrée,
le nom du fichier (ou du GPX) sert de titre.

Options du script : `--json` (JSON brut sur stdout), `--tz=Europe/Paris` (fuseau retenu
pour les GPX ; les fichiers FIT portent le leur).

Si la montre a été arrêtée puis relancée, Garmin livre deux fichiers : on les recolle
d'abord en une seule trace, remise dans l'ordre chronologique. Les interruptions sont
signalées, et celles de plus de dix minutes ressortent ensuite comme pauses.

```sh
node scripts/merge-gpx.mjs sortie-1.gpx sortie-2.gpx > tracks/mont-trelod.gpx
```

### Sommets alentour

Les sommets nommés affichés autour de la trace viennent d'OpenStreetMap et sont
récupérés une fois pour toutes. Sans terminal, depuis GitHub (application mobile
comprise) : onglet **Actions → Sommets alentour → Run workflow**, en ajustant au
besoin le rayon et le nombre de sommets. Le workflow commite `data/peaks.js`
tout seul et résume ce qu'il a trouvé.

En local, c'est la même chose :

```sh
node scripts/peaks.mjs                       # met à jour data/peaks.js
node scripts/peaks.mjs --radius=15 --max=60  # plus large, plus de sommets
```

Le script travaille en deux cercles. Dans le cercle proche (`--radius`, 12 km par
défaut) il garde tout sommet nommé. Au-delà, jusqu'à `--far` (60 km), il ne retient
que ce qui se voit vraiment de loin : l'altitude minimale exigée monte avec la
distance, de `--far-ele` (1 800 m au bord du cercle proche) à `--far-ele-max`
(3 200 m au bord du lointain). C'est ce qui laisse passer le Mont Blanc, à 54 km du
Trélod, sans ramener quatre cents bosses anonymes avec lui.

Chaque cercle a son propre quota — `--max` (80) pour le proche, `--far-max` (24) pour
le lointain. Sans cette séparation, les quatre-mille raflent toutes les places et le
sommet du jour n'est même plus étiqueté. Et au loin on ne garde qu'un nom tous les
`--far-gap` kilomètres (4 par défaut) : sinon le Mont Blanc arrive avec ses quinze
épaules nommées. Les noms bilingues d'OSM sont raccourcis (« Mont Blanc / Monte
Bianco » → « Mont Blanc »).

Chaque trace donne donc deux requêtes ; celle du cercle lointain filtre les altitudes
côté Overpass pour ne pas rapatrier tout le massif. Un échec sur le cercle lointain ne
coûte que les grands sommets, un échec complet conserve les sommets déjà connus.
Overpass étant un service bénévole, le script espace ses requêtes : à ne relancer que
lorsqu'on ajoute une sortie.

Sans `data/peaks.js`, le survol fonctionne exactement pareil, sans les étiquettes.

### Tour d'horizon

Bouton **Horizon** sous chaque carte. En survol la caméra pique vers le sol : la ligne
d'horizon reste au-dessus du cadre, et un sommet à 50 km n'est jamais dessiné — MapLibre
borne la distance de rendu à la hauteur de vol. Le tour d'horizon prend donc de la
hauteur au-dessus du point haut de la trace (2 600 m, tangage 80°) puis fait un tour
complet. C'est le seul moment où les Alpes lointaines entrent dans l'image.

Même mouvement en vidéo : `--pano=8` ajoute huit secondes de tour d'horizon à la fin
du rendu (entrée « pano » du workflow).

Ce que le script calcule : distance, dénivelé (valeur barométrique de la montre pour les FIT,
sinon hystérésis de 3 m sur l'altitude lissée), temps en mouvement, altitudes extrêmes,
fréquence cardiaque, pauses de plus de 10 min (un bivouac apparaît comme repère sur la carte).
La trace est simplifiée (Douglas-Peucker, ~2,5 m) pour tenir en quelques dizaines de ko.

### Export vidéo

`scripts/render-flyover.mjs` rejoue un survol image par image dans un Chromium sans
écran et assemble le tout en H.264. Depuis le téléphone : onglet **Actions → Vidéo du
survol → Run workflow**. La vidéo est déposée en artefact *et* commitée dans `videos/`.

| Entrée | Rôle |
| --- | --- |
| `track` | identifiant de la sortie |
| `from` / `to` | portion du parcours, de 0 à 1 (`0` → `0.5` = la montée seule) |
| `seconds`, `fps` | durée et fluidité |
| `pano` | secondes de tour d'horizon ajoutées à la fin |
| `width`, `height` | 960×540 par défaut |
| `title` | bandeau affiché en bas |
| `out` | chemin du fichier produit |

Compter une cinquantaine de minutes pour 300 images : le rendu tourne en OpenGL
logiciel sur le runner, et chaque image attend que les tuiles soient arrivées.
En local le relief ne se charge pas derrière un proxy non approuvé : la vidéo sort
plate, seul le rendu en CI fait foi.

### Cartes

Aucune clé API : imagerie Esri World Imagery ou OpenTopoMap, relief depuis les
tuiles Terrarium (Mapzen / AWS). MapLibre GL est chargé depuis unpkg, uniquement
quand la section est ouverte, et chaque carte n'est initialisée qu'à l'approche de l'écran.
