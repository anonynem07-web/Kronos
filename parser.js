/* ============================================================================
   parser.js — moteur de reconnaissance des dates et des étiquettes
   ============================================================================
   Transforme le texte brut saisi par l'utilisateur en une liste d'objets
   "événement" prêts à être triés puis dessinés par render.js.

   Limites connues (assumées et documentées pour l'utilisateur) :
   - Le séparateur "\" en tout début/fin de ligne sépare des ENTRÉES ; à
     l'intérieur d'une étiquette déjà extraite, seuls "|" et le tiret long
     "—" servent à découper des sous-événements (pour éviter toute ambiguïté
     avec le découpage des entrées elles-mêmes).
   - La précision jour/mois n'est utilisée que pour le tri et le
     positionnement fin ; l'affichage reprend le texte tel qu'écrit par
     l'utilisateur (reformaté selon les options mois abrégés / av. J.-C.).
   ========================================================================= */

const MONTHS_FR = [
  ["janv\\.?|janvier", 1], ["f[ée]v\\.?|f[ée]vrier", 2], ["mars", 3],
  ["avr\\.?|avril", 4], ["mai", 5], ["juin", 6],
  ["juil\\.?|juillet", 7], ["ao[uû]t", 8], ["sept\\.?|septembre", 9],
  ["oct\\.?|octobre", 10], ["nov\\.?|novembre", 11], ["d[ée]c\\.?|d[ée]cembre", 12]
];
const MONTH_ABBR = ["janv.", "fév.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

const SEASONS = { "printemps": 3, "été": 6, "ete": 6, "automne": 9, "hiver": 12 }; // mois de départ approx.

const ROMAN_MAP = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function romanToInt(s) {
  s = s.toUpperCase();
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = ROMAN_MAP[s[i]], next = ROMAN_MAP[s[i + 1]];
    if (!cur) return null;
    if (next && cur < next) total -= cur; else total += cur;
  }
  return total || null;
}

function intToRoman(n) {
  const table = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
  let out = "", r = n;
  for (const [v, s] of table) while (r >= v) { out += s; r -= v; }
  return out;
}

// ---------------------------------------------------------------------------
// Formattage de l'affichage (respecte les options utilisateur)
// ---------------------------------------------------------------------------
function bcSuffix(opts) {
  if (opts.hideBC) return "";
  return opts.abbreviate ? " apr. J.-C." : ""; // on n'affiche jamais "apr. J.-C." par défaut (voir isADSuffix)
}

function formatBC(opts, forceAbbrShort) {
  if (opts.hideBC) return "";
  return (opts.abbreviate || forceAbbrShort) ? "-" : " av. J.-C.";
}

// ---------------------------------------------------------------------------
// Découpage d'une "période" avec gestion du piège du tiret négatif
// ---------------------------------------------------------------------------
// Règle donnée : "-100 - 44" (borne néga collée à son tiret, tiret de
// période entouré d'espaces) doit se lire "-100" à "44" ; alors que
// "-100 - -44" se lit "-100" à "-44". On repère le tiret de PÉRIODE comme un
// tiret (- – —) entouré d'espace avant ET suivi d'un espace ou d'un signe
// moins collé à un chiffre.
function splitPeriodDash(str) {
  // 1) tiret entouré d'espaces des deux côtés (forme recommandée, sans
  //    ambiguïté possible avec un signe négatif)
  let m = /\s[-–—]\s/.exec(str);
  if (m) return [str.slice(0, m.index).trim(), str.slice(m.index + m[0].length).trim()];
  // 2) tiret collé sans espaces ("1200-1300") : accepté seulement si le
  //    début du texte n'est pas lui-même négatif, pour ne jamais entrer en
  //    conflit avec le cas documenté "-100 - 44" / "-100 - -44"
  if (!/^-/.test(str)) {
    m = /^(\d{1,4})[-–—](\d{1,4})$/.exec(str);
    if (m) return [m[1], m[2]];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Analyse d'un token de date isolé (sans période, sans incertitude "/")
// Retourne { year: Number (valeur décimale pour tri), precision, isBC, raw }
// ---------------------------------------------------------------------------
function parseSingleDateAtom(raw) {
  let str = raw.trim();
  if (!str) return null;

  let isBC = false;
  // "av. J.-C." en suffixe (s'applique à tout le token, quel que soit son type)
  const bcSuffixRe = /\s*(av\.?\s*j\.?-?\s*c\.?)\s*$/i;
  if (bcSuffixRe.test(str)) { isBC = true; str = str.replace(bcSuffixRe, "").trim(); }
  // "-" collé devant un chiffre EN DÉBUT DE TOKEN = négatif (ex. "-44" seul).
  // Pour les formes composées ("23 mars -44", "automne -470"), le signe est
  // détecté plus bas, directement dans le groupe capturant l'année.
  const negRe = /^-\s*(?=\d)/;
  if (negRe.test(str)) { isBC = true; str = str.replace(negRe, "").trim(); }

  const sign = isBC ? -1 : 1;

  // --- fin/début/milieu/moitiés/tiers + siècle romain ---
  // Accepte aussi bien les formes abrégées (1ère, 2e, 3e, 4e) que les formes
  // en toutes lettres (première, deuxième, troisième, quatrième, dernière),
  // et les tiers en plus des moitiés.
  const ORD = "premi[èe]re?|1(?:re|ère|er)?|deuxi[èe]me|2e|troisi[èe]me|3e|quatri[èe]me|4e|derni[èe]re?";
  let m = str.match(new RegExp(`^(d[ée]but|fin|milieu)\\s+(?:du\\s+|de\\s+la\\s+)?([IVXLCDM]+)\\s*e?\\.?\\s*s(?:i[èe]cle)?\\.?$`, "i")) ||
      str.match(new RegExp(`^(${ORD})\\s+(moiti[ée]|tiers)\\s+(?:du\\s+|de\\s+la\\s+)?([IVXLCDM]+)\\s*e?\\.?\\s*s(?:i[èe]cle)?\\.?$`, "i"));
  if (m) {
    let n, y;
    if (m.length === 3) {
      // début/fin/milieu
      const part = m[1].toLowerCase();
      n = romanToInt(m[2]);
      if (n) {
        const { start, end } = centuryRange(n, isBC);
        if (/^d[ée]but/.test(part)) y = start + (end - start) * 0.12;
        else if (/^fin/.test(part)) y = end - (end - start) * 0.12;
        else y = (start + end) / 2; // milieu
        return { year: y, precision: "century", isBC, raw, centuryStart: start, centuryEnd: end };
      }
    } else {
      // Nème moitié/tiers
      const ordWord = m[1].toLowerCase();
      const fraction = m[2].toLowerCase();
      n = romanToInt(m[3]);
      if (n) {
        const { start, end } = centuryRange(n, isBC);
        const isLast = /^derni/.test(ordWord);
        const isFirst = /^(premi|1)/.test(ordWord);
        const parts = /tiers/.test(fraction) ? 3 : 2;
        let idx;
        if (isFirst) idx = 1;
        else if (isLast) idx = parts;
        else if (/^deuxi|^2/.test(ordWord)) idx = 2;
        else if (/^troisi|^3/.test(ordWord)) idx = 3;
        else if (/^quatri|^4/.test(ordWord)) idx = 4;
        idx = Math.min(idx, parts);
        const segStart = start + ((idx - 1) / parts) * (end - start);
        const segEnd = start + (idx / parts) * (end - start);
        y = (segStart + segEnd) / 2;
        return { year: y, precision: "century", isBC, raw, centuryStart: start, centuryEnd: end };
      }
    }
  }

  // --- siècle romain seul : "XIXe s." / "XIXe" / "XIX" ---
  m = str.match(/^([IVXLCDM]+)\s*e?\.?\s*(?:s(?:i[èe]cle)?\.?)?$/i);
  if (m && romanToInt(m[1])) {
    const n = romanToInt(m[1]);
    const { start, end } = centuryRange(n, isBC);
    return { year: (start + end) / 2, precision: "century", isBC, raw, centuryStart: start, centuryEnd: end };
  }

  // --- décennie : "années 1980", "1980s", "années 1980s" (le "-" négatif a
  // déjà été retiré en tête de fonction pour le cas "-1980" / "-1980s") ---
  m = str.match(/^ann[ée]es?\s+(\d{1,4})s?$/i) || str.match(/^(\d{1,4})s$/i);
  if (m) {
    const base = parseInt(m[1], 10);
    const y0 = sign * base;
    const decStart = isBC ? y0 - 9 : y0;
    const decEnd = isBC ? y0 : y0 + 9;
    return { year: decStart, precision: "decade", isBC, raw, decadeStart: decStart, decadeEnd: decEnd, isDecadeLike: true };
  }

  // --- mois nommé + année : "juin 290", "23 mars -44" ---
  // NB : au sein d'une même année (positive ou négative), la fraction de
  // progression dans l'année (mois/jour) s'AJOUTE toujours — jamais dans le
  // sens du signe — sans quoi l'ordre à l'intérieur d'une année av. J.-C.
  // se retrouve inversé (23 mars -44 se retrouverait avant 5 janv. -44).
  const monthPattern = MONTHS_FR.map(([re]) => re).join("|");
  m = str.match(new RegExp(`^(?:(\\d{1,2})\\s+)?(${monthPattern})\\s+(-?\\d{1,4})$`, "i"));
  if (m) {
    const day = m[1] ? parseInt(m[1], 10) : null;
    const monthName = m[2].toLowerCase();
    const monthIdx = MONTHS_FR.findIndex(([re]) => new RegExp(`^(${re})$`, "i").test(monthName));
    const monthNum = monthIdx + 1;
    const tokBC = isBC || /^-/.test(m[3]);
    const year = parseInt(m[3].replace(/^-/, ""), 10);
    const dirSign = tokBC ? -1 : 1;
    const fraction = ((monthNum - 1) + (day ? (day - 1) / 30 : 0.5)) / 12;
    const y = dirSign * year + fraction;
    return { year: y, precision: day ? "day" : "month", isBC: tokBC, raw, day, month: monthNum, yearNum: year };
  }

  // --- saison + année : "printemps 1281", "automne -470" ---
  m = str.match(/^(printemps|[ée]t[ée]|automne|hiver)\s+(-?\d{1,4})$/i);
  if (m) {
    const season = m[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const monthNum = SEASONS[season] || SEASONS[m[1].toLowerCase()] || 3;
    const tokBC = isBC || /^-/.test(m[2]);
    const year = parseInt(m[2].replace(/^-/, ""), 10);
    const dirSign = tokBC ? -1 : 1;
    const y = dirSign * year + (monthNum - 1) / 12;
    return { year: y, precision: "month", isBC: tokBC, raw, month: monthNum, yearNum: year, isSeason: true, seasonName: m[1] };
  }

  // --- JJ/MM/AAAA ou MM/AAAA ou AAAA (numérique) ---
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(-?\d{1,4})$/);
  if (m) {
    const [_, d, mo, yraw] = m;
    const tokBC = isBC || /^-/.test(yraw);
    const year = parseInt(yraw.replace(/^-/, ""), 10);
    const dirSign = tokBC ? -1 : 1;
    const fraction = ((parseInt(mo, 10) - 1) + (parseInt(d, 10) - 1) / 30) / 12;
    const yv = dirSign * year + fraction;
    return { year: yv, precision: "day", isBC: tokBC, raw, day: +d, month: +mo, yearNum: year };
  }
  m = str.match(/^(\d{1,2})\/(-?\d{1,4})$/);
  if (m) {
    const [_, mo, yraw] = m;
    const tokBC = isBC || /^-/.test(yraw);
    const year = parseInt(yraw.replace(/^-/, ""), 10);
    const dirSign = tokBC ? -1 : 1;
    const yv = dirSign * year + (parseInt(mo, 10) - 1) / 12;
    return { year: yv, precision: "month", isBC: tokBC, raw, month: +mo, yearNum: year };
  }
  m = str.match(/^(-?\d{1,4})$/);
  if (m) {
    const tokBC = isBC || /^-/.test(m[1]);
    const year = parseInt(m[1].replace(/^-/, ""), 10);
    return { year: tokBC ? -year : year, precision: "year", isBC: tokBC, raw, yearNum: year };
  }

  return null;
}

function centuryRange(n, isBC) {
  if (!isBC) return { start: (n - 1) * 100 + 1, end: n * 100 };
  return { start: -(n * 100), end: -((n - 1) * 100 + 1) };
}

// ---------------------------------------------------------------------------
// Analyse d'un token de date pouvant contenir : approximation (vers/~/±),
// incertitude "-479/-478", plage "entre 1253 et 1257", ou période "A - B".
// ---------------------------------------------------------------------------
function parseDateExpression(raw) {
  let str = raw.trim();
  let isApprox = false;
  let approxWord = null; // conserve le mot/symbole d'origine (vers/environ/~/±/?)

  const approxRe = /^(vers|environ)\s+|^([~±])\s*/i;
  const am = str.match(approxRe);
  if (am) {
    isApprox = true;
    approxWord = (am[1] || am[2] || "").toLowerCase();
    str = str.replace(approxRe, "").trim();
  }
  // suffixe "?" (ex. venant d'une date entre parenthèses suivie de "?")
  if (/\?\s*$/.test(str)) {
    isApprox = true;
    approxWord = "?";
    str = str.replace(/\?\s*$/, "").trim();
  }

  // "entre X et Y"
  let m = str.match(/^entre\s+(.+?)\s+et\s+(.+)$/i);
  if (m) {
    const a = parseSingleDateAtom(m[1]);
    const b = parseSingleDateAtom(m[2]);
    if (a && b) {
      return {
        type: "range", isApprox: true, approxWord, isBC: a.isBC,
        year: (a.year + b.year) / 2,
        display: `entre ${m[1].trim()} et ${m[2].trim()}`,
        rangeStart: a, rangeEnd: b
      };
    }
  }

  // incertitude "-479/-478" (une seule barre, deux atomes de date valides)
  if (str.includes("/") && !/^\d{1,2}\/\d{1,2}\/\d{1,4}$/.test(str) && !/^\d{1,2}\/\d{1,4}$/.test(str)) {
    const parts = str.split("/");
    if (parts.length === 2) {
      const a = parseSingleDateAtom(parts[0]);
      const b = parseSingleDateAtom(parts[1]);
      if (a && b) {
        return {
          type: "uncertain", isApprox, approxWord, isBC: a.isBC,
          year: (a.year + b.year) / 2,
          display: `${parts[0].trim()}/${parts[1].trim()}`,
          rangeStart: a, rangeEnd: b
        };
      }
    }
  }

  // période "A - B" (attention au tiret négatif, cf. splitPeriodDash)
  const parts = splitPeriodDash(str);
  if (parts) {
    let a = parseSingleDateAtom(parts[0]);
    let b = parseSingleDateAtom(parts[1]);
    if (a && b) {
      // Convention usuelle : "Ve - IVe siècle av. J.-C." ou "300 - 250 av. J.-C."
      // n'indiquent "av. J.-C." qu'une seule fois, à la fin, mais s'appliquent
      // implicitement à toute la période. On ne force ce report que si le
      // premier terme ne porte lui-même aucun signe/indication explicite.
      if (b.isBC && !a.isBC) {
        const hasOwnMark = /^-/.test(parts[0].trim()) || /av\.?\s*j/i.test(parts[0]);
        if (!hasOwnMark) {
          const forced = parseSingleDateAtom(parts[0] + " av. J.-C.");
          if (forced) a = forced;
        }
      }
      return {
        type: "period", isApprox, approxWord, isBC: a.isBC,
        year: a.year, // le début sert de point d'ancrage principal
        yearEnd: b.year,
        display: `${parts[0].trim()} - ${parts[1].trim()}`,
        rangeStart: a, rangeEnd: b
      };
    }
  }

  // sinon date simple
  const single = parseSingleDateAtom(str);
  if (single) {
    return {
      type: single.isDecadeLike ? "decade" : "point",
      isApprox, approxWord, isBC: single.isBC, year: single.year,
      display: str,
      atom: single
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recherche d'une date n'importe où dans la ligne : au début (cas standard),
// entre parenthèses, ou juste avant un ":" — la première date valide
// rencontrée (en lisant de gauche à droite) est retenue.
// ---------------------------------------------------------------------------
// IMPORTANT : l'ordre des alternatives compte (une alternation regex prend la
// première branche qui filtre à une position donnée, pas la plus longue).
// On place donc les formes les plus spécifiques/longues avant les formes
// génériques (sinon "12/05/1820" serait par ex. tronqué en "12").
const DATE_CANDIDATE_RE = new RegExp(
  "(?:(?:vers|environ)\\s+|[~±]\\s*)?" +
  "(?:entre\\s+-?\\d{1,4}(?:\\s+av\\.?\\s*j\\.?-?\\s*c\\.?)?\\s+et\\s+-?\\d{1,4}(?:\\s+av\\.?\\s*j\\.?-?\\s*c\\.?)?|" + // entre X et Y (bornes numériques)
  "\\d{1,2}\\/\\d{1,2}\\/-?\\d{1,4}|" +                                // JJ/MM/AAAA
  "(?:d[ée]but|fin|milieu)\\s+(?:du\\s+|de\\s+la\\s+)?[IVXLCDM]+\\s*e?\\.?\\s*s(?:i[èe]cle)?\\.?|" + // début/fin/milieu de siècle
  "(?:premi[èe]re?|1(?:re|ère|er)?|deuxi[èe]me|2e|troisi[èe]me|3e|quatri[èe]me|4e|derni[èe]re?)\\s+(?:moiti[ée]|tiers)\\s+(?:du\\s+|de\\s+la\\s+)?[IVXLCDM]+\\s*e?\\.?\\s*s(?:i[èe]cle)?\\.?|" + // Nème moitié/tiers de siècle
  "(?:\\d{1,2}\\s+)?(?:" + MONTHS_FR.map(x => x[0]).join("|") + ")\\.?\\s+-?\\d{1,4}|" + // mois année
  "(?:printemps|[ée]t[ée]|automne|hiver)\\s+-?\\d{1,4}|" +             // saison
  "ann[ée]es?\\s+\\d{1,4}s?|" +                                        // décennie "années 1250(s)"
  "\\d{1,4}s|" +                                                       // décennie "1250s"
  "-?\\d{1,4}\\/-?\\d{1,4}|" +                                         // incertitude "-479/-478"
  "\\d{1,2}\\/-?\\d{1,4}|" +                                           // MM/AAAA
  "[IVXLCDM]+\\s*e?\\.?\\s*s(?:i[èe]cle)?\\.?|" +                      // siècle romain seul
  "-?\\d{1,4}(?:\\s*[-–—]\\s*-?\\d{1,4})?" +                           // année seule / période numérique
  ")(?:\\s+av\\.?\\s*j\\.?-?\\s*c\\.?)?(?:\\s*\\?)?",
  "i"
);

function findDateInLine(line) {
  // 1) essai simple : début de ligne
  let m = line.match(new RegExp("^\\s*" + DATE_CANDIDATE_RE.source, "i"));
  if (m) {
    const parsed = parseDateExpression(m[0]);
    if (parsed) return { dateRaw: m[0].trim(), matchStart: m.index, matchEnd: m[0].length, parsed, mode: "start" };
  }
  // 2) entre parenthèses (avec éventuel "?" final signalant une date incertaine)
  const parenRe = /\(([^)]+)\)/g;
  let pm;
  while ((pm = parenRe.exec(line))) {
    const inner = pm[1];
    const im = inner.match(new RegExp("^\\s*" + DATE_CANDIDATE_RE.source + "\\s*$", "i"));
    if (im) {
      const parsed = parseDateExpression(im[0]);
      if (parsed) return { dateRaw: im[0].trim(), matchStart: pm.index, matchEnd: pm.index + pm[0].length, parsed, mode: "paren", fullParenMatch: pm[0] };
    }
  }
  // 3) juste avant ":"
  const colonIdx = line.indexOf(":");
  if (colonIdx > -1) {
    const before = line.slice(0, colonIdx);
    const cm = before.match(new RegExp(DATE_CANDIDATE_RE.source + "\\s*$", "i"));
    if (cm) {
      const parsed = parseDateExpression(cm[0]);
      if (parsed) return { dateRaw: cm[0].trim(), matchStart: before.length - cm[0].length, matchEnd: colonIdx, parsed, mode: "colon" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extraction du texte associé (annotation, catégorie, gras/italique/souligné)
// ---------------------------------------------------------------------------
function parseLabelSegments(text) {
  // gras **..**, italique _.._, souligné ++..++
  const segments = [];
  const re = /(\*\*(.+?)\*\*|_(.+?)_|\+\+(.+?)\+\+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index) });
    if (m[2] !== undefined) segments.push({ text: m[2], bold: true });
    else if (m[3] !== undefined) segments.push({ text: m[3], italic: true });
    else if (m[4] !== undefined) segments.push({ text: m[4], underline: true });
    last = re.lastIndex;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments.filter(s => s.text.length);
}

function extractCategory(text) {
  let category = null;
  let m = text.match(/^\s*#([^\s#]+)\s*/);
  if (m) { category = m[1]; text = text.slice(m[0].length); }
  else {
    m = text.match(/\s*#([^\s#]+)\s*$/);
    if (m) { category = m[1]; text = text.slice(0, m.index); }
  }
  return { category, text };
}

function extractAnnotation(text) {
  const m = text.match(/\(([^)]+)\)\s*$/);
  if (m) return { annotation: m[1].trim(), text: text.slice(0, m.index).trim() };
  return { annotation: null, text: text.trim() };
}

// couleur déterministe à partir du nom de catégorie
const PALETTE = ["#2C4A6E", "#9A4B2E", "#4B7B4B", "#7A4B9A", "#B08900", "#3A6E6E", "#A34B6E", "#5B5B5B"];
function colorForCategory(cat, catColorMap) {
  if (!cat) return null;
  if (catColorMap && catColorMap[cat]) return catColorMap[cat];
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// ---------------------------------------------------------------------------
// Découpe le texte source en entrées (une par date)
// ---------------------------------------------------------------------------
function splitEntries(raw) {
  return raw
    .split(/\r?\n|(?:^|\s)\\(?:\s|$)/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Point d'entrée principal
// ---------------------------------------------------------------------------
function parseTimelineText(raw, options = {}) {
  const opts = Object.assign({
    allBC: false, hideBC: false, abbreviate: false, splitMultiEvents: false, catColors: {}
  }, options);

  const entries = splitEntries(raw);
  const events = [];
  const warnings = [];

  entries.forEach((line, idx) => {
    const found = findDateInLine(line);
    if (!found) {
      warnings.push({ line, reason: "Aucune date reconnue sur cette ligne." });
      return;
    }
    let rest = extractRestForLine(line, found);

    let parsedDate = found.parsed;
    if (opts.allBC && !parsedDate.isBC) {
      parsedDate = markAsBC(parsedDate);
    }

    // sous-événements multiples à la même date : | ou — dans l'étiquette
    let labels = [rest];
    if (opts.splitMultiEvents && /[|—]/.test(rest)) {
      labels = rest.split(/\s*[|—]\s*/).map(s => s.trim()).filter(Boolean);
      if (labels.length < 2) labels = [rest];
    }

    labels.forEach((labelRaw, subIdx) => {
      // Si ce sous-événement porte lui-même une date reconnaissable (ex.
      // "Pisistrate tyran (561)" au sein d'un groupe "557 - 530 : ... | ..."),
      // on l'utilise à sa place plutôt que d'hériter de la date du groupe.
      let ownDate = null, effectiveLabel = labelRaw;
      if (labels.length > 1) {
        const ownFound = findDateInLine(labelRaw);
        if (ownFound) {
          ownDate = ownFound.parsed;
          if (ownFound.mode === "paren") {
            effectiveLabel = (labelRaw.slice(0, ownFound.matchStart) + " " + labelRaw.slice(ownFound.matchEnd)).trim();
          } else if (ownFound.mode === "start") {
            effectiveLabel = labelRaw.slice(ownFound.matchEnd).replace(/^\s*(:|\t|—|--)\s*/, "").trim();
          } else {
            effectiveLabel = (labelRaw.slice(0, ownFound.matchStart) + " " + labelRaw.slice(ownFound.matchEnd + 1)).trim();
          }
        }
      }
      const effectiveDate = ownDate || parsedDate;

      const { category, text: t1 } = extractCategory(effectiveLabel);
      const { annotation, text: t2 } = extractAnnotation(t1);
      const segments = parseLabelSegments(t2);
      events.push({
        id: `e${idx}_${subIdx}`,
        order: idx,
        rawLine: line,
        date: effectiveDate,
        dateDisplay: formatDateDisplay(effectiveDate, opts),
        category,
        color: colorForCategory(category, opts.catColors),
        annotation,
        segments,
        plainText: segments.map(s => s.text).join(""),
        groupKey: `${effectiveDate.type}:${effectiveDate.year.toFixed(4)}:${effectiveDate.display}`
      });
    });
  });

  events.sort((a, b) => a.date.year - b.date.year || a.order - b.order);
  return { events, warnings };
}

function markAsBC(parsedDate) {
  const p = Object.assign({}, parsedDate);
  p.isBC = true;
  p.year = -Math.abs(p.year);
  if (p.yearEnd !== undefined) p.yearEnd = -Math.abs(p.yearEnd);
  if (!/av\.?\s*j/i.test(p.display) && !/^-/.test(p.display)) {
    p.display = "-" + p.display;
  }
  return p;
}

// Mois en toutes lettres -> abrégés (règle d'affichage systématique, non
// liée à la case "Abréger").
function abbreviateMonths(text) {
  return text
    .replace(/\bjanvier\b/gi, "janv.")
    .replace(/\bf[ée]vrier\b/gi, "fév.")
    .replace(/\bavril\b/gi, "avr.")
    .replace(/\bjuillet\b/gi, "juil.")
    .replace(/\bseptembre\b/gi, "sept.")
    .replace(/\boctobre\b/gi, "oct.")
    .replace(/\bnovembre\b/gi, "nov.")
    .replace(/\bd[ée]cembre\b/gi, "déc.");
}

function formatDateDisplay(parsedDate, opts) {
  let d = abbreviateMonths(parsedDate.display);
  if (opts.hideBC) {
    d = d.replace(/\s*av\.?\s*j\.?-?\s*c\.?/gi, "").replace(/^-\s*/, "");
  } else if (opts.abbreviate) {
    d = d.replace(/\s*av\.?\s*j\.?-?\s*c\.?/gi, "");
    if (!/^-/.test(d) && parsedDate.isBC) d = "-" + d;
  }
  if (opts.abbreviate) {
    d = d.replace(/\bann[ée]es?\s+(\d+)/gi, "$1s");
  }
  // marqueur d'approximation : jamais pour "entre X et Y", qui porte déjà
  // l'incertitude dans sa formulation.
  if (parsedDate.isApprox && parsedDate.type !== "range") {
    const word = parsedDate.approxWord;
    if (word === "?") {
      d = d + "?";
    } else if (opts.abbreviate) {
      d = "~" + d; // en mode "Abréger", "vers"/"environ" deviennent aussi "~"
    } else if (word === "vers" || word === "environ") {
      d = word + " " + d;
    } else {
      d = "~" + d; // "~" et "±" restent compacts, sans espace
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// Reformatage canonique d'une ligne : "[date] : [reste]" — plus de
// tabulation/tiret comme séparateur, plus de date en fin de ligne entre
// parenthèses (elle est ramenée en tête), périodes avec espaces autour du
// tiret (déjà géré par le "display" du type "period").
// ---------------------------------------------------------------------------
function extractRestForLine(line, found) {
  if (found.mode === "start") {
    return line.slice(found.matchEnd).replace(/^\s*(:|\t|—|--|-)\s*/, "").trim();
  } else if (found.mode === "paren") {
    return (line.slice(0, found.matchStart) + " " + line.slice(found.matchEnd)).replace(/\s+/g, " ").trim();
  } else {
    let rest = line.slice(found.matchEnd + 1).trim();
    const before = line.slice(0, found.matchStart).trim();
    if (before) rest = (before + " " + rest).trim();
    return rest.replace(/\s+/g, " ");
  }
}

function canonicalizeAndSort(raw, opts) {
  const entries = splitEntries(raw);
  const dated = [], undated = [];
  entries.forEach((line, i) => {
    const found = findDateInLine(line);
    if (!found) { undated.push(line); return; }
    const rest = extractRestForLine(line, found);
    const canonicalDate = formatDateDisplay(found.parsed, opts);
    const rebuilt = rest ? `${canonicalDate} : ${rest}` : canonicalDate;
    dated.push({ line: rebuilt, y: found.parsed.year, i });
  });
  dated.sort((a, b) => a.y - b.y || a.i - b.i);
  return dated.map(d => d.line).concat(undated).join("\n");
}

// ---------------------------------------------------------------------------
// Retri chronologique du texte brut (appelé à la sortie du champ de saisie)
// Les lignes sans date reconnue sont conservées à la fin, dans leur ordre
// d'origine, plutôt que d'être perdues.
// ---------------------------------------------------------------------------
function sortRawText(raw) {
  const entries = splitEntries(raw);
  const dated = [], undated = [];
  entries.forEach((line, i) => {
    const found = findDateInLine(line);
    if (found) dated.push({ line, y: found.parsed.year, i });
    else undated.push(line);
  });
  dated.sort((a, b) => a.y - b.y || a.i - b.i);
  return dated.map(d => d.line).concat(undated).join("\n");
}

// expose globalement (pas de bundler : simple <script> classiques)
window.TimelineParser = {
  sortRawText, canonicalizeAndSort,
  parseTimelineText, parseDateExpression, parseSingleDateAtom,
  romanToInt, intToRoman, centuryRange, colorForCategory, PALETTE,
  parseLabelSegments, extractCategory, extractAnnotation, formatDateDisplay
};
