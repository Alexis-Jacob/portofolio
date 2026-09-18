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
| `data/ete-2026.js` | données générées (`window.ETE2026_TRACKS`) — ne pas éditer à la main |
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

Ce que le script calcule : distance, dénivelé (valeur barométrique de la montre pour les FIT,
sinon hystérésis de 3 m sur l'altitude lissée), temps en mouvement, altitudes extrêmes,
fréquence cardiaque, pauses de plus de 10 min (un bivouac apparaît comme repère sur la carte).
La trace est simplifiée (Douglas-Peucker, ~2,5 m) pour tenir en quelques dizaines de ko.

### Cartes

Aucune clé API : imagerie Esri World Imagery ou OpenTopoMap, relief depuis les
tuiles Terrarium (Mapzen / AWS). MapLibre GL est chargé depuis unpkg, uniquement
quand la section est ouverte, et chaque carte n'est initialisée qu'à l'approche de l'écran.
