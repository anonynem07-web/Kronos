# Frises — version app web autonome (un seul fichier HTML)

Aucune installation, aucun terminal. Toute l'app tient dans `index.html`
(plus le dossier `icons/`, `manifest.json` et `sw.js` pour l'installation en
PWA). Stockage local au navigateur, export/import JSON pour circuler entre
appareils.

## Utilisation

- **En local** : double-cliquez sur `index.html`, ça s'ouvre dans votre
  navigateur. Ça fonctionne même sans connexion internet (à part les polices
  Google Fonts, chargées en ligne — sans elles, l'app utilise une police de
  secours automatiquement).
- **En ligne (Vercel)** : sur vercel.com, « Add New Project » → « Deploy » en
  glissant-déposant ce dossier entier (`index.html`, `icons/`,
  `manifest.json`, `sw.js`) — aucune configuration nécessaire, ce sont des
  fichiers statiques.
- **Installation comme application** : une fois hébergée en HTTPS (Vercel le
  fait automatiquement), votre navigateur (Chrome/Samsung Internet/Edge)
  proposera « Installer l'application » ou « Ajouter à l'écran d'accueil »,
  avec sa propre icône.

## Fonctionnalités

Toutes celles des versions précédentes : formats de date étendus (siècles,
saisons, décennies, incertitudes, périodes compactes `350-500`), dossiers,
export/import JSON, vue horizontale (à l'échelle, avec graduations
réglables) et verticale (séquentielle, périodes à gauche/dates à droite,
optimisée mobile), retour à la ligne automatique du texte, éclatement en
plusieurs événements à la même date, raccourcis clavier (`Ctrl+B/I/U`,
`Maj+Alt+K`), et **pagination A4 automatique à l'impression** (une frise
large est découpée en plusieurs pages A4, alignées horizontalement ou
verticalement selon l'orientation).

## Notes techniques

- Toute la logique (parseur de dates, mise en page, rendu SVG) a été
  testée avec de vrais scénarios avant livraison — y compris un test
  d'impression réel généré via un navigateur headless, pour vérifier le
  nombre de pages A4 produites sur des frises courtes, denses et très
  longues (2500 ans / 19 événements).
- L'échelle d'impression automatique vise un compromis lisibilité/nombre de
  pages ; réglez « Échelle (px/année) » dans le panneau latéral pour un
  contrôle total (y compris à l'impression, qui respecte alors ce réglage).
