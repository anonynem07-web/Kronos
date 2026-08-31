'use strict';
/* ============================================================================
   KRONOS — application de frises chronologiques
   Fichier unique : moteur de dates, parseur de lignes, stockage, rendu, UI.
   ========================================================================== */

/* ---------------------------------------------------------------------------
   1. MOTEUR DE DATES
   ------------------------------------------------------------------------- */
const DateEngine = (() => {
  const MONTHS = [
    { full: 'janvier', abbr: 'janv.', n: 1 }, { full: 'février', abbr: 'fév.', n: 2 },
    { full: 'mars', abbr: 'mars', n: 3 }, { full: 'avril', abbr: 'avr.', n: 4 },
    { full: 'mai', abbr: 'mai', n: 5 }, { full: 'juin', abbr: 'juin', n: 6 },
    { full: 'juillet', abbr: 'juil.', n: 7 }, { full: 'août', abbr: 'août', n: 8 },
    { full: 'septembre', abbr: 'sept.', n: 9 }, { full: 'octobre', abbr: 'oct.', n: 10 },
    { full: 'novembre', abbr: 'nov.', n: 11 }, { full: 'décembre', abbr: 'déc.', n: 12 },
  ];
  const MONTH_RE = MONTHS.map(m => m.full).concat(MONTHS.map(m => m.abbr.replace('.', '\\.?'))).join('|');
  const SEASONS = { 'printemps': 3, 'été': 6, 'automne': 9, 'hiver': 12 };
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
  function intToRoman(num) {
    const map = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
    let res = '';
    for (const [v, s] of map) { while (num >= v) { res += s; num -= v; } }
    return res;
  }
  const ORDINAL_WORDS = {
    '1':'première','1ere':'première','1ère':'première','1re':'première','premiere':'première','première':'première',
    '2':'deuxième','2e':'deuxième','2eme':'deuxième','2ème':'deuxième','deuxieme':'deuxième','deuxième':'deuxième','seconde':'deuxième',
    '3':'troisième','3e':'troisième','3eme':'troisième','3ème':'troisième','troisieme':'troisième','troisième':'troisième',
    '4':'dernière','derniere':'dernière','dernière':'dernière','dernier':'dernière',
  };
  function normalizeOrdinal(word) { return ORDINAL_WORDS[word.toLowerCase().trim()] || word.toLowerCase().trim(); }

  function centuryBounds(n, isBC) {
    if (!isBC) return { start: (n - 1) * 100 + 1, end: n * 100 };
    return { start: -(n * 100), end: -((n - 1) * 100 + 1) };
  }
  function centuryFraction(n, isBC, frac) {
    const { start, end } = centuryBounds(n, isBC);
    const span = end - start;
    let pos;
    switch (frac) {
      case 'debut': pos = start + Math.round(span * 0.10); break;
      case 'milieu': pos = start + Math.round(span * 0.50); break;
      case 'fin': pos = start + Math.round(span * 0.90); break;
      case 'moitie1': pos = start + Math.round(span * 0.25); break;
      case 'moitie2': pos = start + Math.round(span * 0.75); break;
      case 'tiers1': pos = start + Math.round(span * 0.17); break;
      case 'tiers2': pos = start + Math.round(span * 0.50); break;
      case 'tiers3': pos = start + Math.round(span * 0.83); break;
      default: pos = start + Math.round(span * 0.50);
    }
    return pos;
  }

  const BC_SUFFIX_RE = /\s*(av\.?\s*j\.?-?c\.?|avant\s+j\.?-?c\.?)\s*$/i;
  function stripBC(str) {
    let isBC = false, s = str.trim();
    if (BC_SUFFIX_RE.test(s)) { isBC = true; s = s.replace(BC_SUFFIX_RE, '').trim(); }
    if (/^-\d/.test(s)) { isBC = true; s = s.replace(/^-\s*/, ''); }
    return { s, isBC };
  }
  // "vers", "environ", "env.", "~", "±"
  const APPROX_RE = /^(vers|environ|env\.?|~|±)\s*/i;
  function stripApprox(str) {
    let approx = false, s = str.trim();
    if (APPROX_RE.test(s)) { approx = true; s = s.replace(APPROX_RE, '').trim(); }
    return { s, approx };
  }
  // Point d'interrogation final ("465 ?", "vers 396 ?") : incertitude affichée,
  // mais sans effet sur le positionnement (la valeur numérique reste inchangée).
  const TRAILING_Q_RE = /\s*\?\s*$/;
  function stripTrailingQ(str) {
    let uncertain = false, s = str;
    if (TRAILING_Q_RE.test(s)) { uncertain = true; s = s.replace(TRAILING_Q_RE, ''); }
    return { s, uncertain };
  }

  const MOITIE_RE = /(premi[eè]re|1(?:ere|ère|re)?|deuxi[eè]me|2(?:e|eme|ème)?|seconde)\s+moiti[ée]\s+(?:du\s+)?/i;
  const TIERS_RE = /(premi[eè]re?|1(?:er|ere|ère)?|deuxi[eè]me|2(?:e|eme|ème)?|troisi[eè]me|3(?:e|eme|ème)?|dernier|derni[eè]re|4(?:e|eme|ème)?)\s+tiers\s+(?:du\s+)?/i;
  // "mi" est une abréviation courante de "milieu" ("mi VIe s.")
  const FRAC_WORDS_RE = /(fin|d[ée]but|milieu|mi)\s+/i;
  const ROMAN_RE = '(?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))';
  // Lettres (accentuées incluses) considérées comme "caractères de mot" pour la
  // détection de limite : évite qu'un nom propre comme "Xénophane" ou "Cézanne"
  // (lettre romaine suivie d'une lettre accentuée) soit pris pour un siècle,
  // piège que \b (ASCII uniquement) ne détecte pas.
  const WC = 'A-Za-zÀ-ÖØ-öø-ÿ';
  // Chiffre romain en MAJUSCULES uniquement (évite toute confusion avec "mi" = milieu),
  // suivi de "e" ou "er" (ex. Ier), éventuellement suivi de "s." / "siècle".
  const CENTURY_RE = new RegExp(`(?<![${WC}])((?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})))(er|e)?(?:\\s*(?:si[eè]cle|[sS]\\.))?(?![${WC}])`);

  function parseCenturyToken(raw) {
    let s = raw.trim();
    const { s: s1, isBC } = stripBC(s);
    s = s1;
    let frac = null, m;
    if ((m = MOITIE_RE.exec(s))) {
      const ord = normalizeOrdinal(m[1]);
      frac = ord === 'première' ? 'moitie1' : 'moitie2';
      s = s.slice(m.index + m[0].length);
    } else if ((m = TIERS_RE.exec(s))) {
      const ord = normalizeOrdinal(m[1]);
      frac = ord === 'première' ? 'tiers1' : (ord === 'deuxième' ? 'tiers2' : 'tiers3');
      s = s.slice(m.index + m[0].length);
    } else if ((m = FRAC_WORDS_RE.exec(s))) {
      const w = m[1].toLowerCase();
      frac = w.startsWith('milieu') || w === 'mi' ? 'milieu' : w.startsWith('fin') ? 'fin' : 'debut';
      s = s.slice(m.index + m[0].length);
    }
    const cm = CENTURY_RE.exec(s.trim());
    if (!cm) return null;
    if (cm[0].trim() !== s.trim()) return null; // le token doit être ENTIÈREMENT le siècle (pas un mot qui le contient)
    const n = romanToInt(cm[1]);
    if (!n || n <= 0 || n > 40) return null;
    const value = centuryFraction(n, isBC, frac);
    return { value, isBC, n, frac };
  }

  // Format "fin Ier-IIe s." / "Ier-IIe siècle" : période entre deux siècles
  // collés par un tiret sans espaces, avec un seul suffixe "s."/"siècle" final.
  const CENTURY_PERIOD_RE = new RegExp(`^(?:(fin|d[ée]but|milieu|mi)\\s+)?((?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})))(er|e)?\\s*-\\s*((?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})))(er|e)?\\s*(si[eè]cle|s\\.)$`);
  function parseCenturyPeriodToken(raw) {
    const { s, isBC } = stripBC(raw.trim());
    const m = CENTURY_PERIOD_RE.exec(s);
    if (!m) return null;
    const frac = m[1] ? (m[1].toLowerCase() === 'mi' ? 'milieu' : m[1].toLowerCase()) : null;
    const n1 = romanToInt(m[2]), n2 = romanToInt(m[4]);
    if (!n1 || !n2) return null;
    // "fin"/"début"/"milieu" ne qualifie que le PREMIER siècle de la paire
    // ("fin Ier-IIe s." = fin du Ier siècle -> (tout le) IIe siècle).
    const v1 = centuryFraction(n1, isBC, frac);
    const v2 = centuryFraction(n2, isBC, null);
    const startTok = { kind: 'century', value: v1, isBC, century: n1, frac, attached: false, raw: raw.trim() };
    const endTok = { kind: 'century', value: v2, isBC, century: n2, frac: null, attached: false, raw: raw.trim() };
    return { kind: 'period', value: v1, endValue: v2, approx: false, attached: false, raw: raw.trim(), startTok, endTok };
  }

  // "(Ier s. avant et IIe s. après J.-C.)" : période siècle av. J.-C. -> siècle apr. J.-C.
  const AVANT_APRES_RE = new RegExp(`^(?:(fin|d[ée]but|milieu|mi)\\s+)?((?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})))(er|e)?\\s*s(?:i[eè]cle|\\.)?\\s+avant\\s+(?:et\\s+)?(?:(fin|d[ée]but|milieu|mi)\\s+)?((?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})))(er|e)?\\s*s(?:i[eè]cle|\\.)?\\s+apr[eè]s\\s+j\\.?-?c\\.?$`, 'i');
  function parseAvantApresToken(raw) {
    const m = AVANT_APRES_RE.exec(raw.trim());
    if (!m) return null;
    const frac1 = m[1] ? (m[1].toLowerCase() === 'mi' ? 'milieu' : m[1].toLowerCase()) : null;
    const frac2 = m[4] ? (m[4].toLowerCase() === 'mi' ? 'milieu' : m[4].toLowerCase()) : null;
    const n1 = romanToInt(m[2]), n2 = romanToInt(m[5]);
    if (!n1 || !n2) return null;
    const v1 = centuryFraction(n1, true, frac1);
    const v2 = centuryFraction(n2, false, frac2);
    const startTok = { kind: 'century', value: v1, isBC: true, century: n1, frac: frac1, attached: false, raw: raw.trim() };
    const endTok = { kind: 'century', value: v2, isBC: false, century: n2, frac: frac2, attached: false, raw: raw.trim() };
    return { kind: 'period', value: v1, endValue: v2, approx: false, attached: false, raw: raw.trim(), startTok, endTok };
  }

  const DECADE_RE = /^(?:ann[ée]es\s+)?(-?\d{3,4})s?$/i;
  function parseDecadeToken(raw) {
    const s = raw.trim();
    if (!/ann[ée]es\s+\d/i.test(s) && !/\d+s$/i.test(s)) return null;
    const m = DECADE_RE.exec(s);
    if (!m) return null;
    return { value: parseInt(m[1], 10) };
  }

  function parseNumericDate(s) {
    s = s.trim();
    let m;
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(-?\d{1,4})$/.exec(s))) return { day: +m[1], month: +m[2], year: +m[3] };
    if ((m = /^(\d{1,2})\/(-?\d{1,4})$/.exec(s))) return { month: +m[1], year: +m[2] };
    if ((m = /^-?\d{1,4}$/.exec(s))) return { year: +s };
    return null;
  }
  function parseMonthNameDate(s) {
    s = s.trim();
    const re = new RegExp(`^(?:(\\d{1,2})\\s+)?(${MONTH_RE})\\s+(-?\\d{1,4})$`, 'i');
    const m = re.exec(s);
    if (!m) return null;
    const w = m[2].toLowerCase().replace('.', '');
    const mo = MONTHS.find(x => x.full === w || x.abbr.replace('.', '').toLowerCase() === w);
    if (!mo) return null;
    return { day: m[1] ? +m[1] : undefined, month: mo.n, year: +m[3] };
  }
  function parseSeasonDate(s) {
    s = s.trim();
    const m = /^(printemps|été|ete|automne|hiver)\s+(-?\d{1,4})$/i.exec(s);
    if (!m) return null;
    const key = m[1].toLowerCase().replace('ete', 'été');
    return { month: SEASONS[key], year: +m[2], seasonLabel: key };
  }
  function ymdToValue({ year, month, day }) {
    let v = year;
    const sign = year < 0 ? -1 : 1;
    if (month) v += sign * (month - 0.5) / 12;
    if (day && month) v += sign * (day / 31) / 12 * 0.9;
    return v;
  }

  function parseSingleDateToken(rawInput) {
    let raw = rawInput.trim();
    if (!raw) return null;
    const { s: sQ, uncertain } = stripTrailingQ(raw);
    raw = sQ.trim();
    const { s: sA, approx } = stripApprox(raw);
    raw = sA;
    if (!raw) return null;

    const cent = parseCenturyToken(raw);
    // "fin" (attaché à la flèche pour un simple point mais PAS pour un siècle/décennie, cf. item 8)
    if (cent) return { kind: 'century', value: cent.value, isBC: cent.isBC, century: cent.n, frac: cent.frac, approx, uncertain, attached: false, raw: rawInput.trim() };

    const dec = parseDecadeToken(raw);
    if (dec) return { kind: 'decade', value: dec.value, approx, uncertain, attached: false, raw: rawInput.trim() };

    const { s: sBC, isBC } = stripBC(raw);
    const dmy = parseNumericDate(sBC) || parseMonthNameDate(sBC) || parseSeasonDate(sBC);
    if (!dmy) return null;
    let { year, month, day, seasonLabel } = dmy;
    if (isBC) year = -Math.abs(year);
    const value = ymdToValue({ year, month, day });
    return { kind: 'point', value, year, month, day, isBC, approx, uncertain, seasonLabel, attached: true, raw: rawInput.trim() };
  }

  // Essaie de scinder `raw` en une période "A - B" : le tiret peut être entouré
  // d'espaces ("A - B", pour distinguer du "-" négatif collé d'une date av. J.-C.)
  // ou collé sans espace ("85-175", "342-env. 292"), tant que les deux membres
  // obtenus sont chacun une date valide. On essaie chaque occurrence de tiret,
  // de gauche à droite, en ignorant un tiret en toute première position (qui
  // signale alors une date av. J.-C. négative, pas un séparateur de période).
  function trySplitPeriod(raw) {
    const re = /[-–]/g;
    let m;
    while ((m = re.exec(raw))) {
      const idx = m.index;
      if (idx === 0) continue;
      const left = raw.slice(0, idx).trim();
      const right = raw.slice(idx + 1).trim();
      if (!left || !right) continue;
      const a = parseSingleDateToken(left);
      if (!a) continue;
      const b = parseSingleDateToken(right);
      if (!b) continue;
      return { a, b };
    }
    return null;
  }

  function parseDateExpression(rawInput) {
    let raw = (rawInput || '').trim();
    if (!raw) return null;

    let m = /^entre\s+(.+?)\s+et\s+(.+)$/i.exec(raw);
    if (m) {
      const a = parseSingleDateToken(m[1]), b = parseSingleDateToken(m[2]);
      if (a && b) return { kind: 'range-approx', value: (a.value + b.value) / 2, approx: true, attached: true, display: raw, raw: rawInput.trim(), a, b };
    }

    // "(Ier s. avant et IIe s. après J.-C.)"
    const avApr = parseAvantApresToken(raw);
    if (avApr) return avApr;

    // "fin Ier-IIe s."
    const centPer = parseCenturyPeriodToken(raw);
    if (centPer) return centPer;

    m = /^(-?\d[^\s/]*)\s*\/\s*(-?\d[^\s/]*)$/.exec(raw);
    if (m && !parseNumericDate(raw)) {
      const a = parseSingleDateToken(m[1]), b = parseSingleDateToken(m[2]);
      if (a && b) return { kind: 'range-uncertain', value: (a.value + b.value) / 2, approx: false, attached: true, display: `${m[1]}/${m[2]}`, raw: rawInput.trim(), a, b };
    }

    // Deux (ou plusieurs) dates incertaines séparées par un simple espace,
    // chacune marquée "?" : "465 ? 462 ?" -> moyenne des deux, affichage inchangé.
    if ((raw.match(/\?/g) || []).length >= 2 && !/[-–]/.test(raw)) {
      const parts = raw.split('?').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const toks = parts.map(p => parseSingleDateToken(p));
        if (toks.every(Boolean)) {
          const avg = toks.reduce((s, t) => s + t.value, 0) / toks.length;
          return { kind: 'range-uncertain', value: avg, approx: false, uncertain: true, attached: true, display: raw, raw: rawInput.trim() };
        }
      }
    }

    const per = trySplitPeriod(raw);
    if (per) {
      const { a, b } = per;
      return { kind: 'period', value: a.value, endValue: b.value, approx: a.approx || b.approx, attached: true, raw: rawInput.trim(), startTok: a, endTok: b };
    }

    return parseSingleDateToken(raw);
  }

  return { parseDateExpression, parseSingleDateToken, romanToInt, intToRoman, MONTHS, centuryFraction, centuryBounds };
})();

/* ---------------------------------------------------------------------------
   2. PARSEUR DE LIGNES
   ------------------------------------------------------------------------- */
const LineParser = (() => {
  const SEP_RE = /:|\t|—/;
  const CAT_START_RE = /^#(\S+)\s*/;
  const CAT_END_RE = /\s*#(\S+)$/;

  function stripMarkers(s) { return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/_(.+?)_/g, '$1').trim(); }

  function findParenDate(text) {
    const re = /\(([^()]+)\)(\??)/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[2] === '?') continue;
      const content = m[1].trim();
      const parsed = DateEngine.parseDateExpression(content);
      if (parsed) return { date: parsed, before: text.slice(0, m.index), after: text.slice(m.index + m[0].length), raw: m[1] };
    }
    return null;
  }
  // Plusieurs #catégories peuvent être attribuées à un même événement, en
  // début et/ou en fin de ligne. La première rencontrée sert de couleur ;
  // toutes comptent pour le filtre par catégorie.
  function extractCategories(text) {
    let s = text;
    const cats = [];
    let m;
    while ((m = CAT_START_RE.exec(s))) { cats.push(m[1]); s = s.slice(m[0].length); }
    const trailing = [];
    while ((m = CAT_END_RE.exec(s))) { trailing.unshift(m[1]); s = s.slice(0, s.length - m[0].length); }
    cats.push(...trailing);
    return { text: s, categories: cats };
  }
  function findColonDate(text) {
    const idx = text.indexOf(':');
    if (idx === -1) return null;
    const after = text.slice(idx + 1).trim();
    const parsed = DateEngine.parseDateExpression(after);
    if (parsed) return { date: parsed, before: text.slice(0, idx), after: '' };
    return null;
  }
  // Repli : un simple espace sépare la date de la description ("1789 Prise de
  // la Bastille"). On cherche la plus longue séquence de mots en tête de ligne
  // qui forme une date valide. Un nombre isolé à moins de 3 chiffres est
  // ignoré seul (trop ambigu : "3 personnes moururent" ne doit pas être pris
  // pour l'an 3).
  function findSpaceSeparatedDate(text) {
    const words = text.trim().split(/\s+/);
    for (let count = words.length - 1; count >= 1; count--) {
      const candidate = words.slice(0, count).join(' ');
      const rest = words.slice(count).join(' ');
      if (!rest) continue;
      const d = DateEngine.parseDateExpression(candidate);
      if (!d) continue;
      if (count === 1 && d.kind === 'point' && !d.month && !d.approx && Math.abs(d.year) < 100) continue;
      return { date: d, description: rest };
    }
    return null;
  }

  function parseEventLine(rawLine) {
    let line = rawLine.trim();
    if (!line) return null;
    const { text: noCat, categories } = extractCategories(line);
    line = noCat.trim();
    const category = categories[0] || null;

    let date = null, annotation = '', description = '';
    const sepMatch = SEP_RE.exec(line);
    if (sepMatch) {
      const head = line.slice(0, sepMatch.index).trim();
      const tail = line.slice(sepMatch.index + 1).trim();
      const parenInHead = findParenDate(head);
      if (parenInHead) {
        const d = DateEngine.parseDateExpression(parenInHead.before.trim());
        if (d) { date = d; annotation = stripMarkers(parenInHead.raw); description = tail; }
      }
      if (!date) {
        const d = DateEngine.parseDateExpression(head);
        if (d) { date = d; description = tail; }
      }
    }
    if (!date) {
      const pd = findParenDate(line);
      if (pd) { date = pd.date; description = (pd.before + ' ' + pd.after).replace(/\s+/g, ' ').trim(); }
    }
    if (!date) {
      const cd = findColonDate(line);
      if (cd) { date = cd.date; description = cd.before.trim(); }
    }
    if (!date && !sepMatch) {
      const sd = findSpaceSeparatedDate(line);
      if (sd) { date = sd.date; description = sd.description; }
    }
    if (!date) return { unparsed: true, raw: rawLine, category, categories };
    return { unparsed: false, date, annotation: annotation.trim(), description: description.trim(), category, categories, raw: rawLine };
  }

  function splitSubEvents(event) {
    if (event.unparsed) return [event];
    const parts = event.description.split(/\s*[\\|]\s*|\s+—\s+/).map(p => p.trim()).filter(Boolean);
    if (parts.length <= 1) return [event];
    const results = [], grouped = [];
    for (const part of parts) {
      const pd = findParenDate(part);
      if (pd) {
        results.push({ unparsed: false, date: pd.date, annotation: event.annotation,
          description: (pd.before + ' ' + pd.after).replace(/\s+/g, ' ').trim(),
          category: event.category, categories: event.categories, raw: part, isSubSplit: true });
      } else grouped.push(part);
    }
    if (grouped.length) {
      results.unshift({ unparsed: false, date: event.date, annotation: event.annotation,
        description: grouped, category: event.category, categories: event.categories, raw: event.raw, isSubSplit: true });
    }
    return results.length ? results : [event];
  }

  return { parseEventLine, splitSubEvents, stripMarkers };
})();

/* ---------------------------------------------------------------------------
   3. FORMATAGE (affichage + réécriture canonique de l'éditeur)
   ------------------------------------------------------------------------- */
const Fmt = (() => {
  const MONTH_ABBR = DateEngine.MONTHS.map(m => m.abbr);

  function romanCentury(n) { return DateEngine.intToRoman(n) + (n === 1 ? 'er' : 'e'); }

  function fracLabel(frac) {
    switch (frac) {
      case 'debut': return 'début ';
      case 'fin': return 'fin ';
      case 'milieu': return 'milieu ';
      case 'moitie1': return 'première moitié du ';
      case 'moitie2': return 'deuxième moitié du ';
      case 'tiers1': return 'premier tiers du ';
      case 'tiers2': return 'deuxième tiers du ';
      case 'tiers3': return 'dernier tiers du ';
      default: return '';
    }
  }

  // Formate un point de date simple (année/mois/jour + BC) pour l'affichage,
  // sans le préfixe d'approximation ni le "?" d'incertitude.
  function pointToText(tok, opts) {
    if (tok.kind === 'century') {
      let s = fracLabel(tok.frac) + romanCentury(tok.century) + (opts.abbreviate ? '' : ' s.');
      if (tok.isBC) s += opts.hideBC ? '' : (opts.abbreviate ? ' -' : ' av. J.-C.');
      return s;
    }
    if (tok.kind === 'decade') {
      const y = Math.abs(tok.value);
      return opts.abbreviate ? `${y}s` : `années ${y}${tok.value < 0 ? ' av. J.-C.' : ''}`;
    }
    let y = tok.year;
    let isBC = tok.isBC || (opts.allBC && y > 0);
    let ay = Math.abs(Math.round(y));
    let s = '';
    if (tok.day && tok.month) s = `${tok.day} ${MONTH_ABBR[tok.month - 1]} ${ay}`;
    else if (tok.month) s = `${MONTH_ABBR[tok.month - 1]} ${ay}`;
    else s = String(ay);
    if (isBC && !opts.hideBC) s += opts.abbreviate ? ' -' : ' av. J.-C.';
    return s;
  }

  // Ajoute le préfixe d'approximation ("vers "/"~") et le "?" d'incertitude
  // autour du texte de base d'un token de date.
  function formatToken(tok, opts) {
    let s = pointToText(tok, opts);
    if (tok.approx) s = (opts.abbreviate ? '~' : 'vers ') + s;
    if (tok.uncertain) s += ' ?';
    return s;
  }

  // Construit le texte affiché pour la date d'un événement (selon réglages).
  function displayDate(date, opts) {
    opts = opts || {};
    if (date.kind === 'range-approx') return date.display;
    if (date.kind === 'range-uncertain') return date.display;
    if (date.kind === 'period') {
      return formatToken(date.startTok, opts) + ' - ' + formatToken(date.endTok, opts);
    }
    return formatToken(date, opts);
  }

  // Réécrit une ligne source dans la forme canonique demandée :
  // "[date/période] : [description]" (sans tabulation/tiret, BC explicite, etc.)
  function canonicalizeLine(rawLine) {
    const ev = LineParser.parseEventLine(rawLine);
    if (!ev || ev.unparsed) return rawLine; // ligne non reconnue : inchangée
    let dateTxt = displayDate(ev.date, { abbreviate: false, hideBC: false, allBC: false });
    let head = dateTxt;
    if (ev.annotation) head += ` (${ev.annotation})`;
    let cats = (ev.categories && ev.categories.length ? ev.categories : (ev.category ? [ev.category] : []));
    let cat = cats.length ? ' ' + cats.map(c => '#' + c).join(' ') : '';
    let desc = Array.isArray(ev.description) ? ev.description.join(' | ') : ev.description;
    return `${head} : ${desc}${cat}`.trim();
  }

  // Convertit **gras** et _italique_ en HTML (échappé au préalable).
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function markupToHtml(s) {
    let h = escapeHtml(s);
    h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    h = h.replace(/_(.+?)_/g, '<i>$1</i>');
    return h;
  }

  return { displayDate, canonicalizeLine, markupToHtml, pointToText, formatToken };
})();

/* ---------------------------------------------------------------------------
   4. STOCKAGE (localStorage)
   ------------------------------------------------------------------------- */
const Store = (() => {
  const KEY = 'kronos-store-v1';
  // Palette nuancée terracotta / pastel (item 21)
  const PALETTE = ['#c96f4a', '#7d9b76', '#c9a15a', '#8393b8', '#b17a9e', '#5f9e94', '#c0777d', '#a08a5e'];

  function uid() { return 'id' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  function defaultSettings() {
    return {
      orientation: 'horizontal', scale: 'auto', gradStep: 'auto', showLegend: true,
      allBC: false, hideBC: false, abbreviate: false, splitSubEvents: false,
    };
  }
  function newTimeline(name) {
    return { id: uid(), name: name || 'Nouvelle frise', text: '', settings: defaultSettings(), categoryColors: {} };
  }
  function newFolder(name) {
    return { id: uid(), name: name || 'Nouveau dossier', open: true, timelines: [] };
  }
  function defaultState() {
    const f = newFolder('Mes frises');
    const t = newTimeline('Nouvelle frise');
    f.timelines.push(t);
    return { folders: [f], currentTimelineId: t.id };
  }

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      if (!parsed.folders || !parsed.folders.length) return defaultState();
      return parsed;
    } catch (e) { return defaultState(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* quota etc. */ }
  }

  function allTimelines() {
    const out = [];
    for (const f of state.folders) for (const t of f.timelines) out.push(t);
    return out;
  }
  function findTimeline(id) {
    for (const f of state.folders) for (const t of f.timelines) if (t.id === id) return t;
    return null;
  }
  function findTimelineFolder(id) {
    for (const f of state.folders) for (const t of f.timelines) if (t.id === id) return f;
    return null;
  }
  function currentTimeline() {
    let t = findTimeline(state.currentTimelineId);
    if (!t) { t = allTimelines()[0]; if (t) state.currentTimelineId = t.id; }
    return t;
  }
  function colorForCategory(timeline, cat) {
    if (!cat) return null;
    if (!timeline.categoryColors[cat]) {
      const used = Object.values(timeline.categoryColors);
      const next = PALETTE[used.length % PALETTE.length];
      timeline.categoryColors[cat] = next;
      save();
    }
    return timeline.categoryColors[cat];
  }

  return {
    get state() { return state; }, set state(v) { state = v; },
    load, save, uid, newTimeline, newFolder, defaultSettings,
    allTimelines, findTimeline, findTimelineFolder, currentTimeline, colorForCategory, PALETTE,
  };
})();

/* ---------------------------------------------------------------------------
   5. CONSTRUCTION DE LA LISTE D'ÉVÉNEMENTS À PARTIR DU TEXTE SOURCE
   ------------------------------------------------------------------------- */
const EventsBuilder = (() => {
  function buildAll(timeline) {
    const lines = timeline.text.split('\n');
    const events = [];
    let warnings = 0;
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const ev = LineParser.parseEventLine(raw);
      if (!ev) continue;
      if (ev.unparsed) { warnings++; continue; }
      const parts = timeline.settings.splitSubEvents ? LineParser.splitSubEvents(ev) : [ev];
      for (const p of parts) events.push(p);
    }
    // attribue les couleurs de catégorie (et les enregistre dans la frise) :
    // toutes les catégories obtiennent une couleur (pour les puces de filtre),
    // mais seule la PREMIÈRE de chaque événement colore sa date sur la frise.
    for (const ev of events) {
      const cats = ev.categories && ev.categories.length ? ev.categories : (ev.category ? [ev.category] : []);
      for (const c of cats) Store.colorForCategory(timeline, c);
      ev.color = ev.category ? Store.colorForCategory(timeline, ev.category) : null;
    }
    // tri chronologique (les dates av. J.-C. étant déjà des valeurs négatives
    // correctement ordonnées après la correction du moteur de dates)
    events.sort((a, b) => a.date.value - b.date.value);
    return { events, warnings, total: lines.filter(l => l.trim()).length };
  }

  // Regroupe les événements consécutifs qui partagent EXACTEMENT la même date
  // (même valeur ET même borne de fin pour une période) en un seul "cluster" :
  // la date n'est écrite qu'une fois, chaque élément est séparé par une petite
  // barre de la couleur de sa propre catégorie (item 22).
  function cluster(events) {
    const out = [];
    for (const ev of events) {
      const last = out[out.length - 1];
      const sameDate = last && last.date.value === ev.date.value &&
        (last.date.endValue || null) === (ev.date.endValue || null) && last.date.kind === ev.date.kind;
      const subItems = (Array.isArray(ev.description) ? ev.description : [ev.description]).map(t => ({ text: t, color: ev.color }));
      if (sameDate) {
        last.items.push(...subItems);
        if (last.annotation !== ev.annotation) last.annotation = ''; // annotations divergentes -> on n'affiche rien
      } else {
        out.push({ date: ev.date, annotation: ev.annotation, items: subItems, color: ev.color, category: ev.category });
      }
    }
    return out;
  }
  return { buildAll, cluster };
})();

/* ---------------------------------------------------------------------------
   6. RENDU — VUE HORIZONTALE (SVG)
   ------------------------------------------------------------------------- */
const RenderHorizontal = (() => {
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function niceStep(range) {
    const candidates = [1,2,5,10,20,25,50,100,200,250,500,1000,2000,2500,5000,10000];
    for (const c of candidates) if (range / c <= 10) return c;
    return candidates[candidates.length - 1];
  }

  function estimateLines(text, widthPx, fontPx) {
    const charW = fontPx * 0.52;
    const perLine = Math.max(6, Math.floor(widthPx / charW));
    const words = String(text).split(/\s+/);
    let lines = 1, cur = 0;
    for (const w of words) {
      const wl = w.length + 1;
      if (cur + wl > perLine) { lines++; cur = wl; } else cur += wl;
    }
    return Math.max(1, lines);
  }

  function boxMetrics(cluster, boxWidth) {
    let h = 20; // date
    if (cluster.annotation) h += 14;
    const items = cluster.items;
    for (const it of items) h += estimateLines(it.text, boxWidth - 10, 12.5) * 15 + (items.length > 1 ? 6 : 0);
    h += 8;
    return { w: boxWidth, h };
  }

  // Trace une ligne verticale en l'interrompant lorsqu'elle traverse un
  // "obstacle" (boîte d'un autre événement, barre de période) : elle
  // disparaît sous celui-ci et reprend juste après (item 18).
  function segmentedVLine(cx, y1, y2, obstacles, attrs) {
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    if (hi - lo < 0.5) return '';
    let blocked = [];
    for (const o of obstacles) {
      if (cx < o.x0 - 1 || cx > o.x1 + 1) continue;
      const oLo = Math.max(o.y0, lo), oHi = Math.min(o.y1, hi);
      if (oHi > oLo) blocked.push([oLo, oHi]);
    }
    blocked.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const b of blocked) {
      if (merged.length && b[0] <= merged[merged.length - 1][1] + 0.5) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b[1]);
      else merged.push(b.slice());
    }
    let segs = [], cur = lo;
    for (const [bLo, bHi] of merged) { if (bLo > cur) segs.push([cur, bLo]); cur = Math.max(cur, bHi); }
    if (cur < hi) segs.push([cur, hi]);
    let svg = '';
    for (const [a, b] of segs) { if (b - a >= 1) svg += `<line ${attrs} x1="${cx}" y1="${a}" x2="${cx}" y2="${b}"/>`; }
    return svg;
  }

  function packLanes(items, gapPx) {
    // items: [{x0,x1,h,side}] side fixed per item. Retourne lane index par item, par côté.
    const lanesAbove = [], lanesBelow = [];
    const laneH = [];
    for (const it of items) {
      const lanes = it.side === 'above' ? lanesAbove : lanesBelow;
      let placed = -1;
      for (let li = 0; li < lanes.length; li++) {
        const intervals = lanes[li];
        let overlap = false;
        for (const iv of intervals) { if (it.x0 - gapPx < iv[1] && it.x1 + gapPx > iv[0]) { overlap = true; break; } }
        if (!overlap) { placed = li; intervals.push([it.x0, it.x1]); break; }
      }
      if (placed === -1) { lanes.push([[it.x0, it.x1]]); placed = lanes.length - 1; }
      it.lane = placed;
    }
    return { aboveCount: lanesAbove.length, belowCount: lanesBelow.length };
  }

  function render(container, timeline, built, opts) {
    const clusters = EventsBuilder.cluster(built.events);
    if (!clusters.length) {
      container.innerHTML = `<div class="empty-state"><h2>Aucun événement pour l'instant</h2><p>Ajoutez des lignes dans l'éditeur, par&nbsp;ex. « 1789&nbsp;: Prise de la Bastille »</p></div>`;
      return;
    }
    const cW = Math.max(container.clientWidth || 900, 320);
    const scaleFactor = timeline.settings.scale === 'compact' ? 0.6 : timeline.settings.scale === 'large' ? 1.7 : 1;

    let minV = Infinity, maxV = -Infinity;
    for (const c of clusters) {
      minV = Math.min(minV, c.date.value);
      maxV = Math.max(maxV, c.date.value);
      if (c.date.kind === 'period') { minV = Math.min(minV, c.date.endValue); maxV = Math.max(maxV, c.date.endValue); }
    }
    if (minV === maxV) { minV -= 5; maxV += 5; }
    const rawRange = maxV - minV;
    const pad = Math.max(rawRange * 0.06, rawRange < 1 ? 1 : 2);
    minV -= pad; maxV += pad;
    const range = maxV - minV;

    const boxWidth = 150;
    const minPxPerBox = 96;
    const idealWidth = Math.max(cW - 60, clusters.length * minPxPerBox * scaleFactor);
    const width = Math.max(cW - 20, idealWidth);
    const marginX = 70;
    const innerW = width - marginX * 2;
    const x = (v) => marginX + ((v - minV) / range) * innerW;

    // --- Préparation des items à empiler (lanes) ---
    const items = clusters.map((c, i) => {
      const isPeriod = c.date.kind === 'period';
      const x0raw = isPeriod ? x(Math.min(c.date.value, c.date.endValue)) : x(c.date.value) - boxWidth / 2;
      const x1raw = isPeriod ? x(Math.max(c.date.value, c.date.endValue)) : x(c.date.value) + boxWidth / 2;
      const m = boxMetrics(c, boxWidth);
      const boxX0 = x(c.date.value) - boxWidth / 2;
      const boxX1 = boxX0 + boxWidth;
      const x0 = Math.min(x0raw, boxX0);
      const x1 = Math.max(x1raw, boxX1);
      return { c, i, side: i % 2 === 0 ? 'above' : 'below', x0, x1, h: m.h, boxWidth, isPeriod };
    });
    packLanes(items, 16);

    function laneOffsets(side) {
      const maxLane = Math.max(-1, ...items.filter(it => it.side === side).map(it => it.lane));
      const heights = new Array(maxLane + 1).fill(0);
      for (const it of items) if (it.side === side) heights[it.lane] = Math.max(heights[it.lane], it.h);
      const offsets = [];
      let acc = 26;
      for (let li = 0; li <= maxLane; li++) { offsets.push(acc); acc += heights[li] + 22; }
      return { offsets, total: acc };
    }
    const aboveInfo = laneOffsets('above');
    const belowInfo = laneOffsets('below');
    const tickStrip = timeline.settings.gradStep === 'off' ? 6 : 26;
    const axisY = aboveInfo.total + 20;
    const height = axisY + tickStrip + belowInfo.total + 30;

    for (const it of items) {
      it.boxY = it.side === 'above' ? axisY - (aboveInfo.offsets[it.lane] + it.h) : axisY + tickStrip + belowInfo.offsets[it.lane];
      it.boxLeft = it.isPeriod
        ? (x(Math.min(it.c.date.value, it.c.date.endValue)) + x(Math.max(it.c.date.value, it.c.date.endValue))) / 2 - it.boxWidth / 2
        : x(it.c.date.value) - it.boxWidth / 2;
      if (it.isPeriod) it.barY = it.side === 'above' ? it.boxY + it.h - 6 : it.boxY + 6;
    }

    // --- Obstacles (pour interrompre les traits qui passent sous une boîte/barre — item 18) ---
    const obstacles = [];
    for (const it of items) {
      obstacles.push({ x0: it.boxLeft, x1: it.boxLeft + it.boxWidth, y0: it.boxY, y1: it.boxY + it.h });
      if (it.isPeriod) {
        const bx0 = x(Math.min(it.c.date.value, it.c.date.endValue)), bx1 = x(Math.max(it.c.date.value, it.c.date.endValue));
        obstacles.push({ x0: bx0, x1: bx1, y0: it.barY - 3, y1: it.barY + 3 });
      }
    }

    // --- Graduations ---
    let ticksSvg = '';
    if (timeline.settings.gradStep !== 'off') {
      const stepMul = timeline.settings.gradStep === 'fine' ? 0.5 : timeline.settings.gradStep === 'coarse' ? 2 : 1;
      const step = niceStep(range) * stepMul || 1;
      const first = Math.ceil(minV / step) * step;
      for (let v = first; v <= maxV; v += step) {
        const tx = x(v);
        const label = Fmt.pointToText({ kind: 'point', year: Math.round(v), isBC: v < 0 }, { abbreviate: timeline.settings.abbreviate, hideBC: timeline.settings.hideBC, allBC: timeline.settings.allBC });
        ticksSvg += `<line class="tick" x1="${tx}" y1="${axisY - 4}" x2="${tx}" y2="${axisY + 4}"/>`;
        ticksSvg += `<text class="tick-label" x="${tx}" y="${axisY + 17}" text-anchor="middle">${esc(label)}</text>`;
      }
    }

    // --- Axe + flèche ---
    let axisSvg = `<line class="axis-line" x1="${marginX - 20}" y1="${axisY}" x2="${width - marginX + 30}" y2="${axisY}" stroke="var(--text-ink)"/>`;
    axisSvg += `<polygon points="${width - marginX + 30},${axisY - 7} ${width - marginX + 46},${axisY} ${width - marginX + 30},${axisY + 7}" fill="var(--text-ink)"/>`;

    // --- Événements ---
    let evSvg = '';
    for (const it of items) {
      const c = it.c, d = c.date;
      const color = c.color || 'var(--text-ink)';
      const cx = x(d.value);
      const boxLeft = it.boxLeft;

      if (it.isPeriod) {
        // item 7 : pas de rattachement physique à la flèche pour une période
        const bx0 = x(Math.min(d.value, d.endValue)), bx1 = x(Math.max(d.value, d.endValue));
        const by = it.barY;
        evSvg += `<line class="period-bar" x1="${bx0}" y1="${by}" x2="${bx1}" y2="${by}" stroke="${color}"/>`;
        evSvg += `<line x1="${bx0}" y1="${by - 5}" x2="${bx0}" y2="${by + 5}" stroke="${color}" stroke-width="2"/>`;
        evSvg += `<line x1="${bx1}" y1="${by - 5}" x2="${bx1}" y2="${by + 5}" stroke="${color}" stroke-width="2"/>`;
      } else {
        const attached = d.attached !== false; // item 8 : siècle/décennie -> non rattaché
        evSvg += `<circle class="event-dot" cx="${cx}" cy="${axisY}" r="4" fill="${color}"/>`;
        if (attached) {
          const connY2 = it.side === 'above' ? it.boxY + it.h : it.boxY;
          const otherObstacles = obstacles.filter(o => !(o.x0 === boxLeft && o.x1 === boxLeft + it.boxWidth && o.y0 === it.boxY));
          evSvg += segmentedVLine(cx, axisY, connY2, otherObstacles, `class="connector" stroke="${color}"`);
        }
      }

      const dateLabel = Fmt.displayDate(d, timeline.settings);
      let fy = it.boxY + 12;
      evSvg += `<text class="event-date" x="${boxLeft}" y="${fy}" fill="${color}">${esc(dateLabel)}</text>`;
      fy += 14;
      if (c.annotation) { evSvg += `<text class="event-annotation" x="${boxLeft}" y="${fy}">${esc(c.annotation)}</text>`; fy += 14; }
      evSvg += `<foreignObject x="${boxLeft}" y="${fy - 11}" width="${it.boxWidth}" height="${it.boxY + it.h - fy + 14}">`;
      evSvg += `<div xmlns="http://www.w3.org/1999/xhtml" class="event-desc">`;
      if (c.items.length > 1) {
        evSvg += c.items.map((sub, idx) => `<div style="${idx > 0 ? `border-top:2px solid ${sub.color || 'var(--paper-line)'};margin-top:4px;padding-top:4px` : ''}">${Fmt.markupToHtml(sub.text)}</div>`).join('');
      } else {
        evSvg += Fmt.markupToHtml(c.items[0] ? c.items[0].text : '');
      }
      evSvg += `</div></foreignObject>`;
    }

    // --- Légende (catégories PRINCIPALES uniquement — item 4) ---
    let legendSvg = '';
    if (timeline.settings.showLegend) {
      const cats = Object.entries(timeline.categoryColors);
      if (cats.length) {
        let lx = marginX;
        legendSvg += `<g transform="translate(0,${height - 6})">`;
        for (const [cat, col] of cats) {
          legendSvg += `<rect class="legend-swatch" x="${lx}" y="-12" width="11" height="11" rx="2" fill="${col}"/>`;
          legendSvg += `<text x="${lx + 15}" y="-3" font-size="11" class="legend-text">${esc(cat)}</text>`;
          lx += 15 + cat.length * 6.2 + 16;
        }
        legendSvg += `</g>`;
      }
    }
    const totalHeight = height + (timeline.settings.showLegend && Object.keys(timeline.categoryColors).length ? 22 : 6);

    const svg = `<svg class="frise" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">${axisSvg}${ticksSvg}${evSvg}${legendSvg}</svg>`;
    container.innerHTML = svg;
  }

  return { render };
})();

/* ---------------------------------------------------------------------------
   7. RENDU — VUE VERTICALE (DOM)
   ------------------------------------------------------------------------- */
const RenderVertical = (() => {
  function render(container, timeline, built) {
    const clusters = EventsBuilder.cluster(built.events);
    if (!clusters.length) {
      container.innerHTML = `<div class="empty-state"><h2>Aucun événement pour l'instant</h2><p>Ajoutez des lignes dans l'éditeur, par&nbsp;ex. « 1789&nbsp;: Prise de la Bastille »</p></div>`;
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'v-timeline';
    const axis = document.createElement('div');
    axis.className = 'v-axis';
    wrap.appendChild(axis);

    for (const c of clusters) {
      const d = c.date;
      const isPeriod = d.kind === 'period';
      const row = document.createElement('div');
      row.className = 'v-item ' + (isPeriod ? 'period' : 'point');

      const sideDates = document.createElement('div');
      sideDates.className = 'v-side dates';
      const sidePeriods = document.createElement('div');
      sidePeriods.className = 'v-side periods';

      const dateLabel = Fmt.displayDate(d, timeline.settings);
      const dateEl = document.createElement('div');
      dateEl.className = 'v-date';
      dateEl.style.color = c.color || 'inherit';
      dateEl.textContent = dateLabel;

      const box = document.createElement('div');
      box.appendChild(dateEl);
      if (c.annotation) {
        const a = document.createElement('div'); a.className = 'v-annotation'; a.textContent = c.annotation; box.appendChild(a);
      }
      const descEl = document.createElement('div');
      descEl.className = 'v-desc' + (c.items.length > 1 ? ' multi' : '');
      for (const sub of c.items) {
        const p = document.createElement('div');
        if (c.items.length > 1) p.style.borderTopColor = sub.color || 'var(--paper-line)';
        p.innerHTML = Fmt.markupToHtml(sub.text);
        descEl.appendChild(p);
      }
      box.appendChild(descEl);

      (isPeriod ? sidePeriods : sideDates).appendChild(box);
      const gap = document.createElement('div');
      gap.className = 'v-gap';
      // item 6 : figuré distinct pour une période (barre) vs un point (pastille)
      const dot = document.createElement('div');
      dot.className = isPeriod ? 'v-dot v-dot-period' : 'v-dot';
      dot.style.background = c.color || 'var(--brass-light)';
      gap.appendChild(dot);

      row.appendChild(sideDates); row.appendChild(gap); row.appendChild(sidePeriods);
      wrap.appendChild(row);
    }
    container.innerHTML = '';
    container.appendChild(wrap);
  }
  return { render };
})();

/* ---------------------------------------------------------------------------
   8. IMPRESSION — pagination A4 (horizontale) / page unique (verticale)
   ------------------------------------------------------------------------- */
const PrintPager = (() => {
  const PAGE_PX = { w: 1030, h: 700 }; // A4 paysage utile @ ~96dpi, marges 10mm déduites

  function ensurePageStyle(orientation) {
    let tag = document.getElementById('printPageStyle');
    if (!tag) { tag = document.createElement('style'); tag.id = 'printPageStyle'; document.head.appendChild(tag); }
    tag.textContent = `@page{ size: A4 ${orientation === 'horizontal' ? 'landscape' : 'portrait'}; margin: 10mm; }`;
  }

  function preparePrint(container, timeline) {
    ensurePageStyle(timeline.settings.orientation);
    const old = document.getElementById('printPages');
    if (old) old.remove();
    const holder = document.createElement('div');
    holder.id = 'printPages';

    if (timeline.settings.orientation === 'horizontal') {
      const svg = container.querySelector('svg.frise');
      if (!svg) { document.body.appendChild(holder); return holder; }
      const totalW = parseFloat(svg.getAttribute('width'));
      const totalH = parseFloat(svg.getAttribute('height'));
      const pages = Math.max(1, Math.ceil(totalW / PAGE_PX.w));
      for (let p = 0; p < pages; p++) {
        const pageDiv = document.createElement('div');
        pageDiv.className = 'print-page';
        pageDiv.style.cssText = `width:${PAGE_PX.w}px; height:${totalH + 22}px;`;
        const clip = document.createElement('div');
        clip.style.cssText = `width:${PAGE_PX.w}px; height:${totalH}px; overflow:hidden; position:relative;`;
        const clone = svg.cloneNode(true);
        clone.style.cssText = `position:absolute; left:${-p * PAGE_PX.w}px; top:0;`;
        clip.appendChild(clone);
        pageDiv.appendChild(clip);
        const label = document.createElement('div');
        label.style.cssText = 'font-size:10px; color:#999; text-align:right; padding:2px 4px;';
        label.textContent = `Page ${p + 1} / ${pages}`;
        pageDiv.appendChild(label);
        holder.appendChild(pageDiv);
      }
    } else {
      const src = container.querySelector('.v-timeline');
      const pageDiv = document.createElement('div');
      pageDiv.className = 'print-page';
      if (src) pageDiv.appendChild(src.cloneNode(true));
      holder.appendChild(pageDiv);
    }
    document.body.appendChild(holder);
    return holder;
  }
  return { preparePrint };
})();

/* ---------------------------------------------------------------------------
   9. APPLICATION — état, rendu de l'UI, câblage des événements
   ------------------------------------------------------------------------- */
const App = (() => {
  const $ = (sel) => document.querySelector(sel);
  const els = {};
  let catFilter = new Set(); // item 2 : sélection multiple de catégories
  let renderTimer = null;

  function init() {
    cacheEls();
    bindEvents();
    initDarkMode();
    renderFolderList();
    loadTimelineIntoUI(Store.currentTimeline());
    window.addEventListener('resize', () => scheduleRender(0));
  }

  function cacheEls() {
    ['frisesBtn','panel','timelineTitle','btnOrientation','btnFullscreen','btnPrint','btnDarkMode',
     'folderList','btnNewFolder','btnNewTimeline','selOrientation','selScale','selGrad',
     'chkLegend','chkAllBC','chkHideBC','chkAbbr','chkSplitSub','allBCHint',
     'catColorList','catEmptyHint','btnExportOne','btnExportAll','btnImport','fileImport',
     'btnDupTimeline','btnDeleteTimeline','catFilterBar','editor','editorFoot','lineCount',
     'parseWarnings','viewPane','timelineContainer','mobileTabs','tabEdit','tabView',
     'fsExitBtn','toast','app'
    ].forEach(id => els[id] = document.getElementById(id));
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  /* ---------- Panneau Frises (dossiers/frises) ---------- */
  function renderFolderList() {
    els.folderList.innerHTML = '';
    for (const folder of Store.state.folders) {
      const fd = document.createElement('div');
      fd.className = 'folder';
      const head = document.createElement('div');
      head.className = 'folder-head';
      head.innerHTML = `<span>${folder.open ? '▾' : '▸'}</span><span class="name">${Fmt.markupToHtml(folder.name)}</span>`;
      head.title = 'Cliquer pour renommer / replier';
      head.addEventListener('click', (e) => {
        if (e.detail === 2) { renameFolder(folder); return; }
        folder.open = !folder.open; Store.save(); renderFolderList();
      });
      fd.appendChild(head);
      if (folder.open) {
        const list = document.createElement('div');
        list.className = 'folder-timelines';
        for (const t of folder.timelines) {
          const item = document.createElement('div');
          item.className = 'tl-item' + (t.id === Store.state.currentTimelineId ? ' active' : '');
          item.innerHTML = `<span style="flex:1">${Fmt.markupToHtml(t.name)}</span><span class="x" title="Supprimer">✕</span>`;
          item.addEventListener('click', (e) => {
            if (e.target.classList.contains('x')) {
              e.stopPropagation();
              if (confirm(`Supprimer la frise « ${t.name} » ?`)) deleteTimeline(t.id);
              return;
            }
            Store.state.currentTimelineId = t.id; Store.save();
            loadTimelineIntoUI(t); renderFolderList(); closePanel();
          });
          list.appendChild(item);
        }
        if (!folder.timelines.length) {
          const empty = document.createElement('div'); empty.className = 'mini'; empty.style.padding = '4px 7px';
          empty.textContent = 'Vide.'; list.appendChild(empty);
        }
        fd.appendChild(list);
      }
      els.folderList.appendChild(fd);
    }
  }

  function renameFolder(folder) {
    const name = prompt('Nom du dossier :', folder.name);
    if (name && name.trim()) { folder.name = name.trim(); Store.save(); renderFolderList(); }
  }

  function deleteTimeline(id) {
    const folder = Store.findTimelineFolder(id);
    if (!folder) return;
    folder.timelines = folder.timelines.filter(t => t.id !== id);
    if (!Store.allTimelines().length) {
      const nf = Store.newFolder('Mes frises');
      const nt = Store.newTimeline('Nouvelle frise');
      nf.timelines.push(nt); Store.state.folders.push(nf);
    }
    if (Store.state.currentTimelineId === id) Store.state.currentTimelineId = Store.allTimelines()[0].id;
    Store.save(); renderFolderList(); loadTimelineIntoUI(Store.currentTimeline());
  }

  /* ---------- Chargement d'une frise dans l'UI ---------- */
  function loadTimelineIntoUI(t) {
    if (!t) return;
    catFilter.clear();
    els.timelineTitle.value = t.name;
    els.editor.value = t.text;
    els.selOrientation.value = t.settings.orientation;
    els.selScale.value = t.settings.scale;
    els.selGrad.value = t.settings.gradStep;
    els.chkLegend.checked = t.settings.showLegend;
    els.chkAllBC.checked = t.settings.allBC;
    els.chkHideBC.checked = t.settings.hideBC;
    els.chkAbbr.checked = t.settings.abbreviate;
    els.chkSplitSub.checked = t.settings.splitSubEvents;
    applyOrientationToDOM(t.settings.orientation);
    renderCategoryPanel(t);
    scheduleRender(0);
  }

  function currentTimeline() { return Store.currentTimeline(); }

  /* ---------- Mode nuit (item 1) ---------- */
  function initDarkMode() {
    let dark = false;
    try { dark = localStorage.getItem('kronos-dark') === '1'; } catch (e) {}
    applyDarkMode(dark);
  }
  function applyDarkMode(on) {
    document.documentElement.setAttribute('data-theme', on ? 'dark' : 'light');
    if (els.btnDarkMode) { els.btnDarkMode.textContent = on ? '☀' : '☾'; els.btnDarkMode.title = on ? 'Mode jour' : 'Mode nuit'; }
    try { localStorage.setItem('kronos-dark', on ? '1' : '0'); } catch (e) {}
  }
  function toggleDarkMode() {
    applyDarkMode(document.documentElement.getAttribute('data-theme') !== 'dark');
  }

  /* ---------- Rendu principal (debounced) ---------- */
  function scheduleRender(delay) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(doRender, delay === undefined ? 180 : delay);
  }

  function doRender() {
    const t = currentTimeline();
    if (!t) return;
    const built = EventsBuilder.buildAll(t);
    renderCatFilterBar(t, built);
    renderCategoryPanel(t);

    let events = built.events;
    if (catFilter.size) {
      events = events.filter(e => {
        const cats = e.categories && e.categories.length ? e.categories : (e.category ? [e.category] : []);
        return cats.some(c => catFilter.has(c));
      });
    }
    const filteredBuilt = { events, warnings: built.warnings, total: built.total };

    els.lineCount.textContent = `${built.total} ligne${built.total > 1 ? 's' : ''}`;
    els.parseWarnings.textContent = built.warnings ? `⚠ ${built.warnings} ligne${built.warnings > 1 ? 's' : ''} non reconnue${built.warnings > 1 ? 's' : ''}` : '';

    const allAD = built.events.length > 0 && built.events.every(e => {
      const d = e.date;
      const vals = d.kind === 'period' ? [d.startTok, d.endTok] : [d];
      return vals.every(v => !v.isBC && (v.value === undefined || v.value >= 0));
    });
    els.allBCHint.style.display = allAD ? 'block' : 'none';

    if (t.settings.orientation === 'vertical') {
      els.timelineContainer.className = 'vertical';
      RenderVertical.render(els.timelineContainer, t, filteredBuilt);
    } else {
      els.timelineContainer.className = 'horizontal';
      RenderHorizontal.render(els.timelineContainer, t, filteredBuilt, t.settings);
    }
  }

  /* ---------- Catégories : filtre (multi-sélection, item 2) + couleurs ---------- */
  function renderCatFilterBar(t, built) {
    const cats = [...new Set(built.events.flatMap(e => (e.categories && e.categories.length ? e.categories : (e.category ? [e.category] : []))))];
    els.catFilterBar.innerHTML = '';
    if (!cats.length) { els.catFilterBar.style.display = 'none'; return; }
    els.catFilterBar.style.display = 'flex';
    const allChip = document.createElement('button');
    allChip.className = 'chip' + (catFilter.size === 0 ? ' active' : '');
    allChip.textContent = 'Toutes';
    allChip.addEventListener('click', () => { catFilter.clear(); doRender(); });
    els.catFilterBar.appendChild(allChip);
    for (const c of cats) {
      const chip = document.createElement('button');
      const active = catFilter.has(c);
      chip.className = 'chip' + (active ? ' active' : '');
      chip.textContent = '#' + c;
      chip.style.borderColor = t.categoryColors[c] || '';
      if (active) chip.style.background = t.categoryColors[c] || '';
      chip.addEventListener('click', () => {
        if (catFilter.has(c)) catFilter.delete(c); else catFilter.add(c);
        doRender();
      });
      els.catFilterBar.appendChild(chip);
    }
  }

  function renderCategoryPanel(t) {
    const cats = Object.keys(t.categoryColors);
    els.catColorList.innerHTML = '';
    els.catEmptyHint.style.display = cats.length ? 'none' : 'block';
    for (const c of cats) {
      const row = document.createElement('div'); row.className = 'cat-row';
      const sw = document.createElement('input');
      sw.type = 'color'; sw.value = t.categoryColors[c];
      sw.addEventListener('input', () => { t.categoryColors[c] = sw.value; Store.save(); scheduleRender(0); });
      const label = document.createElement('span'); label.textContent = '#' + c; label.style.flex = '1';
      row.appendChild(sw); row.appendChild(label);
      els.catColorList.appendChild(row);
    }
  }

  /* ---------- Orientation / plein écran / onglets mobile ---------- */
  function applyOrientationToDOM(orientation) {
    els.btnOrientation.textContent = orientation === 'horizontal' ? '↔' : '↕';
    els.btnOrientation.title = orientation === 'horizontal' ? 'Passer en vue verticale' : 'Passer en vue horizontale';
  }

  function setOrientation(o) {
    const t = currentTimeline(); if (!t) return;
    t.settings.orientation = o; Store.save();
    els.selOrientation.value = o;
    applyOrientationToDOM(o);
    scheduleRender(0);
  }

  function toggleFullscreen() {
    els.app.classList.toggle('fullscreen');
    scheduleRender(0);
  }

  function setMobileTab(tab) {
    els.app.classList.remove('tab-edit', 'tab-view');
    els.app.classList.add('tab-' + tab);
    els.tabEdit.classList.toggle('active', tab === 'edit');
    els.tabView.classList.toggle('active', tab === 'view');
    if (tab === 'view') scheduleRender(0);
  }

  /* ---------- Panneau ✦ Frises ---------- */
  function togglePanel() { els.panel.classList.toggle('open'); }
  function closePanel() { els.panel.classList.remove('open'); }

  /* ---------- Éditeur : saisie, mise en forme, tri ---------- */
  function wrapSelection(marker) {
    const ta = els.editor;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    if (s === e) return;
    const before = value.slice(0, s), sel = value.slice(s, e), after = value.slice(e);
    ta.value = before + marker + sel + marker + after;
    ta.selectionStart = s + marker.length; ta.selectionEnd = e + marker.length;
    onEditorInput();
  }

  function onEditorInput() {
    const t = currentTimeline(); if (!t) return;
    t.text = els.editor.value;
    Store.save();
    scheduleRender();
  }

  function onEditorBlur() {
    const t = currentTimeline(); if (!t) return;
    const lines = els.editor.value.split('\n');
    const rewritten = lines.map(l => l.trim() === '' ? l : Fmt.canonicalizeLine(l));
    // tri chronologique des lignes reconnues ; les lignes non reconnues et vides gardent leur position relative en fin de liste
    const parsedLines = [], others = [];
    rewritten.forEach((l, idx) => {
      if (!l.trim()) return;
      const ev = LineParser.parseEventLine(l);
      if (ev && !ev.unparsed) parsedLines.push({ l, v: ev.date.value });
      else others.push(l);
    });
    parsedLines.sort((a, b) => a.v - b.v);
    const finalText = parsedLines.map(x => x.l).concat(others).join('\n');
    els.editor.value = finalText;
    t.text = finalText;
    Store.save();
    scheduleRender(0);
  }

  /* ---------- Export / Import ---------- */
  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function exportOne() {
    const t = currentTimeline(); if (!t) return;
    download(`${t.name || 'frise'}.kronos.json`, JSON.stringify(t, null, 2), 'application/json');
    toast('Frise exportée');
  }
  function exportAll() {
    download('kronos-export.json', JSON.stringify(Store.state, null, 2), 'application/json');
    toast('Export complet effectué');
  }
  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.folders && Array.isArray(data.folders)) {
          // export complet : fusion
          for (const f of data.folders) {
            f.id = Store.uid();
            for (const t of f.timelines) t.id = Store.uid();
            Store.state.folders.push(f);
          }
          Store.state.currentTimelineId = data.folders[0]?.timelines[0]?.id || Store.state.currentTimelineId;
        } else if (data.text !== undefined) {
          // frise unique
          data.id = Store.uid();
          data.categoryColors = data.categoryColors || {};
          data.settings = Object.assign(Store.defaultSettings(), data.settings || {});
          let folder = Store.state.folders[0];
          if (!folder) { folder = Store.newFolder('Mes frises'); Store.state.folders.push(folder); }
          folder.timelines.push(data);
          Store.state.currentTimelineId = data.id;
        } else {
          throw new Error('format inconnu');
        }
        Store.save();
        renderFolderList();
        loadTimelineIntoUI(Store.currentTimeline());
        toast('Import réussi');
      } catch (err) {
        alert('Import impossible : fichier JSON invalide.');
      }
    };
    reader.readAsText(file);
  }

  /* ---------- Impression (item 16) ---------- */
  function doPrint() {
    const t = currentTimeline(); if (!t) return;
    const holder = PrintPager.preparePrint(els.timelineContainer, t);
    const cleanup = () => { if (holder) holder.remove(); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    window.print();
    setTimeout(cleanup, 4000); // filet de sécurité si "afterprint" n'est pas déclenché
  }

  /* ---------- Câblage des événements ---------- */
  function bindEvents() {
    els.frisesBtn.addEventListener('click', togglePanel);
    els.timelineTitle.addEventListener('input', () => {
      const t = currentTimeline(); if (!t) return;
      t.name = els.timelineTitle.value || 'Sans titre'; Store.save(); renderFolderList();
    });
    els.btnOrientation.addEventListener('click', () => {
      const t = currentTimeline(); setOrientation(t.settings.orientation === 'horizontal' ? 'vertical' : 'horizontal');
    });
    els.btnFullscreen.addEventListener('click', toggleFullscreen);
    els.fsExitBtn.addEventListener('click', toggleFullscreen);
    els.btnPrint.addEventListener('click', doPrint);
    if (els.btnDarkMode) els.btnDarkMode.addEventListener('click', toggleDarkMode);

    els.btnNewFolder.addEventListener('click', () => {
      const name = prompt('Nom du nouveau dossier :', 'Nouveau dossier');
      if (name === null) return;
      const f = Store.newFolder(name.trim() || 'Nouveau dossier');
      Store.state.folders.push(f); Store.save(); renderFolderList();
    });
    els.btnNewTimeline.addEventListener('click', () => {
      const folder = Store.findTimelineFolder(Store.state.currentTimelineId) || Store.state.folders[0];
      const t = Store.newTimeline('Nouvelle frise');
      folder.timelines.push(t);
      Store.state.currentTimelineId = t.id; Store.save();
      renderFolderList(); loadTimelineIntoUI(t);
    });
    els.btnDupTimeline.addEventListener('click', () => {
      const t = currentTimeline(); if (!t) return;
      const folder = Store.findTimelineFolder(t.id);
      const copy = JSON.parse(JSON.stringify(t));
      copy.id = Store.uid(); copy.name = t.name + ' (copie)';
      folder.timelines.push(copy);
      Store.state.currentTimelineId = copy.id; Store.save();
      renderFolderList(); loadTimelineIntoUI(copy);
      toast('Frise dupliquée');
    });
    els.btnDeleteTimeline.addEventListener('click', () => {
      const t = currentTimeline(); if (!t) return;
      if (confirm(`Supprimer définitivement « ${t.name} » ?`)) deleteTimeline(t.id);
    });

    els.selOrientation.addEventListener('change', () => setOrientation(els.selOrientation.value));
    els.selScale.addEventListener('change', () => { currentTimeline().settings.scale = els.selScale.value; Store.save(); scheduleRender(0); });
    els.selGrad.addEventListener('change', () => { currentTimeline().settings.gradStep = els.selGrad.value; Store.save(); scheduleRender(0); });
    els.chkLegend.addEventListener('change', () => { currentTimeline().settings.showLegend = els.chkLegend.checked; Store.save(); scheduleRender(0); });
    els.chkAllBC.addEventListener('change', () => { currentTimeline().settings.allBC = els.chkAllBC.checked; Store.save(); scheduleRender(0); });
    els.chkHideBC.addEventListener('change', () => { currentTimeline().settings.hideBC = els.chkHideBC.checked; Store.save(); scheduleRender(0); });
    els.chkAbbr.addEventListener('change', () => { currentTimeline().settings.abbreviate = els.chkAbbr.checked; Store.save(); scheduleRender(0); });
    els.chkSplitSub.addEventListener('change', () => { currentTimeline().settings.splitSubEvents = els.chkSplitSub.checked; Store.save(); scheduleRender(0); });

    els.btnExportOne.addEventListener('click', exportOne);
    els.btnExportAll.addEventListener('click', exportAll);
    els.btnImport.addEventListener('click', () => els.fileImport.click());
    els.fileImport.addEventListener('change', () => { if (els.fileImport.files[0]) importFile(els.fileImport.files[0]); els.fileImport.value = ''; });

    els.editor.addEventListener('input', onEditorInput);
    els.editor.addEventListener('blur', onEditorBlur);
    els.editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (e.key.toLowerCase() === 'b') { e.preventDefault(); wrapSelection('**'); }
        else if (e.key.toLowerCase() === 'i') { e.preventDefault(); wrapSelection('_'); }
        else if (e.key.toLowerCase() === 'u') { e.preventDefault(); wrapSelection('__'); }
      }
    });

    els.tabEdit.addEventListener('click', () => setMobileTab('edit'));
    els.tabView.addEventListener('click', () => setMobileTab('view'));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.app.classList.contains('fullscreen')) toggleFullscreen();
      if (e.key === 'Escape' && els.panel.classList.contains('open')) closePanel();
    });
    document.addEventListener('click', (e) => {
      if (els.panel.classList.contains('open') && !els.panel.contains(e.target) && e.target !== els.frisesBtn) closePanel();
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
