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
  // "ap. J.-C.", "apr. J.-C.", "après J.-C." (ou préfixe "+") : ère EXPLICITEMENT
  // après J.-C. Le réglage « tout convertir en av. J.-C. » n'y touche pas (item 13).
  const AD_SUFFIX_RE = /\s*(apr?\.?\s*j\.?-?c\.?|apr[eè]s\s+j\.?-?c\.?)\s*$/i;
  function stripBC(str) {
    let isBC = false, isAD = false, s = str.trim();
    if (BC_SUFFIX_RE.test(s)) { isBC = true; s = s.replace(BC_SUFFIX_RE, '').trim(); }
    else if (AD_SUFFIX_RE.test(s)) { isAD = true; s = s.replace(AD_SUFFIX_RE, '').trim(); }
    if (/^-\d/.test(s)) { isBC = true; isAD = false; s = s.replace(/^-\s*/, ''); }
    else if (/^\+\s*\d/.test(s)) { isAD = true; isBC = false; s = s.replace(/^\+\s*/, ''); }
    return { s, isBC, isAD };
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
  const FRAC_WORDS_RE = /^(fin|d[ée]but|milieu|mi)\s+/i;
  const ROMAN_RE = '(?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))';
  // Lettres (accentuées incluses) considérées comme "caractères de mot" pour la
  // détection de limite : évite qu'un nom propre comme "Xénophane" ou "Cézanne"
  // (lettre romaine suivie d'une lettre accentuée) soit pris pour un siècle,
  // piège que \b (ASCII uniquement) ne détecte pas.
  const WC = 'A-Za-zÀ-ÖØ-öø-ÿ';
  // Chiffre romain en MAJUSCULES uniquement (évite toute confusion avec "mi" = milieu),
  // suivi de "e" ou "er" (ex. Ier), éventuellement suivi de "s." / "siècle".
  const ROMAN_BODY = '(?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))';
  // Item 10 : les siècles sont reconnus aussi en minuscules (« vie siècle », « xiie s. »).
  // Le drapeau « i » rend la détection insensible à la casse ; la validation ci-dessous
  // rejette les cas ambigus (voir checkRoman).
  const CENTURY_RE = new RegExp(`(?<![${WC}])(${ROMAN_BODY})(er|e)?(\\s*(?:si[eè]cles?|s\\.))?(?![${WC}])`, 'i');

  // Valide un chiffre romain capté par une regex insensible à la casse.
  //  - la casse ne doit pas être mélangée (« Vi » = début de phrase, pas un siècle) ;
  //  - le suffixe « e »/« er » doit être en minuscules (« VIE » n'est pas « VIe ») ;
  //  - en minuscules, un siècle exige « e »/« er » ou « s. »/« siècle » (évite « vi », « xi »…),
  //    et « vie » nu reste le mot « vie » (il faut « vie siècle » ou « vie s. »).
  function checkRoman(rom, suffix, hasSec) {
    if (!rom) return null;
    const upper = rom === rom.toUpperCase(), lower = rom === rom.toLowerCase();
    if (!upper && !lower) return null;
    if (suffix && suffix !== suffix.toLowerCase()) return null;
    if (lower) {
      if (!suffix && !hasSec) return null;
      if (!hasSec && (rom + (suffix || '')) === 'vie') return null;
    }
    return romanToInt(rom);
  }

  // `raw` ne contient déjà plus la mention av./ap. J.-C. (retirée par stripBC en amont)
  function parseCenturyToken(raw, isBC) {
    let s = raw.trim();
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
    if (cm[0].trim() !== s.trim()) return null; // le token doit être ENTIÈREMENT le siècle
    const n = checkRoman(cm[1], cm[2], !!cm[3]);
    if (!n || n <= 0 || n > 40) return null;
    return { value: centuryFraction(n, isBC, frac), isBC, n, frac };
  }

  // Format "fin Ier-IIe s." / "Ier-IIe siècles" : période entre deux siècles
  // collés par un tiret, avec un seul suffixe "s."/"siècle(s)" final.
  const CENTURY_PERIOD_RE = new RegExp(`^(?:(fin|d[ée]but|milieu|mi)\\s+)?(${ROMAN_BODY})(er|e)?\\s*[-–]\\s*(${ROMAN_BODY})(er|e)?\\s*(si[eè]cles?|s\\.)$`, 'i');
  function parseCenturyPeriodToken(raw) {
    const { s, isBC, isAD } = stripBC(raw.trim());
    const m = CENTURY_PERIOD_RE.exec(s);
    if (!m) return null;
    const frac = m[1] ? (m[1].toLowerCase() === 'mi' ? 'milieu' : m[1].toLowerCase()) : null;
    const n1 = checkRoman(m[2], m[3], true), n2 = checkRoman(m[4], m[5], true);
    if (!n1 || !n2 || n1 > 40 || n2 > 40) return null;
    // "fin"/"début"/"milieu" ne qualifie que le PREMIER siècle de la paire
    // ("fin Ier-IIe s." = fin du Ier siècle -> (tout le) IIe siècle).
    const v1 = centuryFraction(n1, isBC, frac);
    const v2 = centuryFraction(n2, isBC, null);
    const startTok = { kind: 'century', value: v1, isBC, isAD, century: n1, frac, attached: false, raw: raw.trim() };
    const endTok = { kind: 'century', value: v2, isBC, isAD, century: n2, frac: null, attached: false, raw: raw.trim() };
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

  const DECADE_RE = /^(?:(mi|milieu)\s+)?(?:ann[ée]es\s+)?(-?\d{3,4})s?$/i;
  function parseDecadeToken(raw, isBC) {
    const s = raw.trim();
    if (!/ann[ée]es\s+\d/i.test(s) && !/\d+s$/i.test(s)) return null;
    const m = DECADE_RE.exec(s);
    if (!m) return null;
    let value = parseInt(m[2], 10);
    if (isBC) value = -Math.abs(value);
    if (m[1]) value += value < 0 ? -5 : 5; // "mi 1950s" -> milieu de la décennie
    return { value };
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
    let q = stripTrailingQ(raw);
    raw = q.s.trim();
    let uncertain = q.uncertain;
    const { s: sA, approx } = stripApprox(raw);
    raw = sA;
    if (!raw) return null;
    const era = stripBC(raw);
    raw = era.s;
    // "369 ? av. J.-C." : le « ? » peut précéder la mention d'ère
    if (!uncertain) { q = stripTrailingQ(raw); if (q.uncertain) { uncertain = true; raw = q.s.trim(); } }
    if (!raw) return null;
    const { isBC, isAD } = era;

    const cent = parseCenturyToken(raw, isBC);
    // "fin" (attaché à la flèche pour un simple point mais PAS pour un siècle/décennie, cf. item 8)
    if (cent) return { kind: 'century', value: cent.value, isBC, isAD, century: cent.n, frac: cent.frac, approx, uncertain, attached: false, raw: rawInput.trim() };

    const dec = parseDecadeToken(raw, isBC);
    if (dec) return { kind: 'decade', value: dec.value, isBC: isBC || dec.value < 0, isAD, approx, uncertain, attached: false, raw: rawInput.trim() };

    const dmy = parseNumericDate(raw) || parseMonthNameDate(raw) || parseSeasonDate(raw);
    if (!dmy) return null;
    let { year, month, day, seasonLabel } = dmy;
    let bc = isBC;
    if (bc) year = -Math.abs(year); else if (year < 0) bc = true;
    const value = ymdToValue({ year, month, day });
    return { kind: 'point', value, year, month, day, isBC: bc, isAD, approx, uncertain, seasonLabel, attached: true, raw: rawInput.trim() };
  }

  /* ---- Ère (av./ap. J.-C.) : application, lecture, propagation ---- */

  // Moyenne des membres d'une date composée (« A ou B », « A et B », « entre A et B »…)
  function recomputeCompound(tok) {
    tok.value = tok.toks.reduce((sum, t) => sum + t.value, 0) / tok.toks.length;
    tok.isBC = tok.toks.every(t => t.isBC);
  }
  function makeCompound(kind, toks, sep, extra) {
    const t = Object.assign({ kind, toks, sep, approx: false, uncertain: false, attached: true }, extra || {});
    recomputeCompound(t);
    return t;
  }

  // Applique l'ère 'BC' (convertit la valeur en négatif) ou 'AD' (simple marquage explicite)
  // à tout token, y compris composé ou période. Les tokens dont l'ère est DÉJÀ déterminée
  // (« av. J.-C. », « ap. J.-C. », « + », « - ») ne sont jamais modifiés (item 13).
  function applyEra(tok, era) {
    if (!tok) return;
    if (tok.kind === 'period') {
      applyEra(tok.startTok, era); applyEra(tok.endTok, era);
      tok.value = tok.startTok.value; tok.endValue = tok.endTok.value;
      return;
    }
    if (tok.toks) { tok.toks.forEach(t => applyEra(t, era)); recomputeCompound(tok); return; }
    if (tok.isBC || tok.isAD) return;
    if (era === 'AD') { tok.isAD = true; return; }
    tok.isBC = true;
    if (tok.kind === 'point') { tok.year = -Math.abs(tok.year); tok.value = ymdToValue({ year: tok.year, month: tok.month, day: tok.day }); }
    else if (tok.kind === 'century') tok.value = centuryFraction(tok.century, true, tok.frac);
    else if (tok.kind === 'decade') tok.value = -Math.abs(tok.value);
  }
  function eraOf(tok) {
    if (!tok) return null;
    if (tok.toks) return eraOf(tok.toks[tok.toks.length - 1]);
    if (tok.kind === 'period') return eraOf(tok.endTok);
    return tok.isBC ? 'BC' : tok.isAD ? 'AD' : null;
  }
  function lacksEra(tok) {
    if (tok.toks) return tok.toks.every(lacksEra);
    return !tok.isBC && !tok.isAD;
  }
  // "557 - 530 av. J.-C." : la mention portée par le dernier membre vaut pour ceux qui n'en ont pas
  function propagateEra(list) {
    for (let i = list.length - 2; i >= 0; i--) {
      const e = eraOf(list[i + 1]);
      if (e && lacksEra(list[i])) applyEra(list[i], e);
    }
  }

  /* ---- Dates alternatives : « A ou B », « A (ou B ?) », « A/B », « A et B », « A ? B ? » ---- */

  // Item 12 : « VIe et Ve siècles » = « VIe - Ve siècles » (siècles ou décennies consécutifs)
  function consecutivePeriod(a, b, raw) {
    let ok = false;
    if (a.kind === 'century' && b.kind === 'century' && !!a.isBC === !!b.isBC && Math.abs(a.century - b.century) === 1) ok = true;
    else if (a.kind === 'decade') {
      if (b.kind === 'point' && !b.month && !b.day && !b.approx && !b.isBC && !b.isAD) {
        b = { kind: 'decade', value: b.year, isBC: false, isAD: false, approx: false, uncertain: b.uncertain, attached: false, raw: b.raw };
      }
      if (b.kind === 'decade' && Math.abs(a.value - b.value) === 10) ok = true;
    }
    if (!ok) return null;
    return { kind: 'period', value: a.value, endValue: b.value, approx: a.approx || b.approx, attached: false, raw, startTok: a, endTok: b };
  }

  function parseAltList(rawInput) {
    const raw = rawInput.trim();
    if (!raw) return null;

    // Item 11 : "360 (ou 357 ?)" [av. J.-C.]
    let m = /^(.+?)\s*\(\s*ou\s+([^()]+?)\s*\)\s*(.*)$/i.exec(raw);
    if (m) {
      const a = parseSingleDateToken(m[1]), b = parseSingleDateToken(m[2]);
      if (!a || !b) return null;
      const rest = m[3].trim();
      if (rest) {
        const e = stripBC(rest);
        if (e.s !== '' || (!e.isBC && !e.isAD)) return null;
        applyEra(a, e.isBC ? 'BC' : 'AD'); applyEra(b, e.isBC ? 'BC' : 'AD');
      }
      propagateEra([a, b]);
      return makeCompound('range-uncertain', [a, b], 'ou', { paren: true, raw });
    }

    let sep = null, parts = null, tail = null;
    if (/\s+ou\s+/i.test(raw)) { sep = 'ou'; parts = raw.split(/\s+ou\s+/i); }
    else if (/\s+et\s+/i.test(raw)) { sep = 'et'; parts = raw.split(/\s+et\s+/i); }
    else if (raw.includes('/')) {
      if (parseNumericDate(stripBC(raw).s)) return null; // 14/07/1789, 07/1789 : vraies dates
      sep = '/'; parts = raw.split('/');
    } else if ((raw.match(/\?/g) || []).length >= 2 && !/[-–]/.test(raw)) {
      // "465 ? 462 ?" : plusieurs dates incertaines séparées par un simple espace
      tail = stripBC(raw);
      parts = tail.s.split('?').map(p => p.trim()).filter(Boolean);
      sep = '?';
    }
    if (!parts || parts.length < 2) return null;
    parts = parts.map(p => p.trim());
    // "1789/90", "370/69" : seconde année abrégée -> complétée
    if ((sep === '/' || sep === 'ou') && parts.length === 2 && /^\d{3,4}$/.test(parts[0]) && /^\d{1,3}$/.test(parts[1]) && parts[1].length < parts[0].length) {
      parts[1] = parts[0].slice(0, parts[0].length - parts[1].length) + parts[1];
    }
    // "vie et ve siècles" : le suffixe « siècles »/« s. » du dernier membre vaut pour les précédents
    if (sep !== '?' && /(si[eè]cles?|s\.)/i.test(parts[parts.length - 1])) {
      for (let i = 0; i < parts.length - 1; i++) {
        if (/^(?:(?:fin|d[ée]but|milieu|mi)\s+)?[ivxlcdm]+(?:er|e)?$/i.test(parts[i])) parts[i] += ' s.';
      }
    }
    const toks = parts.map(p => parseSingleDateToken(p));
    if (toks.some(t => !t)) return null;
    if (sep === '?') {
      toks.forEach(t => { t.uncertain = true; });
      if (tail.isBC) toks.forEach(t => applyEra(t, 'BC'));
      else if (tail.isAD) toks.forEach(t => applyEra(t, 'AD'));
    }
    propagateEra(toks);
    if (sep === 'et' && toks.length === 2) {
      const per = consecutivePeriod(toks[0], toks[1], raw);
      if (per) return per;
    }
    return makeCompound('range-uncertain', toks, sep, { raw });
  }

  // Un « atome » de date : date simple OU date alternative (pas une période)
  function parseAtom(str) {
    const alt = parseAltList(str);
    if (alt && alt.kind !== 'period') return alt;
    return parseSingleDateToken(str);
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
      const a = parseAtom(left);
      if (!a) continue;
      const b = parseAtom(right);
      if (!b) continue;
      propagateEra([a, b]); // "557 - 530 av. J.-C." : les deux sont av. J.-C.
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
      if (a && b) {
        propagateEra([a, b]);
        return makeCompound('range-approx', [a, b], 'et', { approx: true, prefix: 'entre ', raw: rawInput.trim() });
      }
    }

    // "(Ier s. avant et IIe s. après J.-C.)"
    const avApr = parseAvantApresToken(raw);
    if (avApr) return avApr;

    // "fin Ier-IIe s."
    const centPer = parseCenturyPeriodToken(raw);
    if (centPer) return centPer;

    // "370/369", "370 ou 369", "370 et 369", "360 (ou 357 ?)", "465 ? 462 ?", "VIe et Ve siècles"
    const alt = parseAltList(raw);
    if (alt) return alt;

    // Borne de fin inconnue : "vers 440- ?" -> période de durée minimale,
    // affiche "?" pour la fin sans influencer sa position (item 13).
    m = /^(.+?)\s*-\s*\?$/.exec(raw);
    if (m) {
      const a = parseAtom(m[1]);
      if (a) {
        const epsilon = a.kind === 'century' ? 5 : a.kind === 'decade' ? 5 : 1;
        const endTok = Object.assign({}, a, { value: a.value + epsilon, openEnded: true, approx: false, uncertain: false });
        return { kind: 'period', value: a.value, endValue: endTok.value, approx: a.approx, attached: true, raw: rawInput.trim(), startTok: a, endTok };
      }
    }

    const per = trySplitPeriod(raw);
    if (per) {
      const { a, b } = per;
      return { kind: 'period', value: a.value, endValue: b.value, approx: a.approx || b.approx, attached: true, raw: rawInput.trim(), startTok: a, endTok: b };
    }

    return parseSingleDateToken(raw);
  }

  return { parseDateExpression, parseSingleDateToken, romanToInt, intToRoman, MONTHS, centuryFraction, centuryBounds, ymdToValue, applyEra };
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
      if (count === 1 && d.kind === 'point' && !d.month && !d.approx && Math.abs(d.year) < 10) continue;
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

  // Item 11 : "/" est la version abrégée de "ou". true : un "/" saisi s'affiche « ou »
  // quand l'abréviation est désactivée (comme "~" s'affiche « vers »). Mettre false pour
  // conserver le "/" tel que saisi quand l'abréviation est désactivée.
  const EXPAND_SLASH_TO_OU = true;

  function isBCTok(tok) {
    return !!tok.isBC || (tok.kind === 'decade' && tok.value < 0) || (tok.kind === 'point' && tok.year < 0);
  }
  // Mention d'ère d'un point/siècle/décennie. L'ère « ap. J.-C. » n'est écrite que si
  // elle a été donnée explicitement ET qu'elle est utile (tout converti en av. J.-C.,
  // ou réécriture de la ligne dans l'éditeur, option keepAD) — item 13.
  function eraSuffix(tok, opts) {
    if (isBCTok(tok)) return opts.hideBC ? '' : (opts.abbreviate ? ' -' : ' av. J.-C.');
    if (tok.isAD && (opts.allBC || opts.keepAD) && !opts.hideBC) return opts.abbreviate ? ' +' : ' ap. J.-C.';
    return '';
  }
  function eraKey(tok) { return isBCTok(tok) ? 'BC' : tok.isAD ? 'AD' : 'none'; }

  // Formate un point de date simple (année/mois/jour/siècle/décennie + ère) pour
  // l'affichage, sans le préfixe d'approximation ni le "?" d'incertitude.
  // opts.noEra : n'écrit pas l'ère ; opts.noSec : n'écrit pas le " s." d'un siècle.
  function pointToText(tok, opts) {
    let base;
    if (tok.kind === 'century') {
      base = fracLabel(tok.frac) + romanCentury(tok.century) + ((opts.abbreviate || opts.noSec) ? '' : ' s.');
    } else if (tok.kind === 'decade') {
      const y = Math.abs(tok.value);
      base = opts.abbreviate ? `${y}s` : `années ${y}`;
    } else {
      const ay = Math.abs(Math.round(tok.year));
      if (tok.day && tok.month) base = `${tok.day} ${MONTH_ABBR[tok.month - 1]} ${ay}`;
      else if (tok.month) base = `${MONTH_ABBR[tok.month - 1]} ${ay}`;
      else base = String(ay);
    }
    return opts.noEra ? base : base + eraSuffix(tok, opts);
  }

  // Ajoute le préfixe d'approximation ("vers "/"~") et le "?" d'incertitude
  // autour du texte de base d'un token de date. Une borne ouverte (« - ? »)
  // s'affiche simplement "?" (item 13).
  function formatToken(tok, opts) {
    if (tok.openEnded) return '?';
    if (tok.toks) return formatCompound(tok, opts);
    let s = pointToText(tok, opts);
    if (tok.approx) s = (opts.abbreviate ? '~' : 'vers ') + s;
    if (tok.uncertain) s += ' ?';
    return s;
  }

  // Dates composées (« A ou B », « A (ou B ?) », « A/B », « A et B », « A ? B ? »,
  // « entre A et B »). Le séparateur est CONSERVÉ : « et » reste « et » même abrégé ;
  // « ou » devient "/" en version abrégée. Si tous les membres ont la même ère, elle
  // n'est écrite qu'une fois, à la fin (« 370 ou 369 av. J.-C. »).
  function formatCompound(tok, opts) {
    const toks = tok.toks, n = toks.length, abbr = !!opts.abbreviate;
    const e0 = eraKey(toks[0]);
    const shared = toks.every(t => eraKey(t) === e0);
    const base = shared ? Object.assign({}, opts, { noEra: true }) : opts;
    const f = toks.map((t, i) => formatToken(t, i < n - 1 ? Object.assign({}, base, { noSec: true }) : base));
    let sepStr;
    if (tok.sep === 'et') sepStr = ' et ';
    else if (tok.sep === '?') sepStr = ' ';
    else sepStr = (abbr || (tok.sep === '/' && !EXPAND_SLASH_TO_OU)) ? '/' : ' ou ';
    let body = (tok.paren && tok.sep === 'ou' && !abbr && n === 2) ? `${f[0]} (ou ${f[1]})` : f.join(sepStr);
    if (shared) body += eraSuffix(toks[n - 1], opts);
    return (tok.prefix || '') + body;
  }

  // Construit le texte affiché pour la date d'un événement (selon réglages).
  function displayDate(date, opts) {
    opts = opts || {};
    if (date.kind === 'period') return formatToken(date.startTok, opts) + ' - ' + formatToken(date.endTok, opts);
    return formatToken(date, opts);
  }

  // Réécrit une ligne source dans la forme canonique demandée :
  // "[date/période] : [description]" (sans tabulation/tiret, BC explicite, etc.)
  function canonicalizeLine(rawLine) {
    const ev = LineParser.parseEventLine(rawLine);
    if (!ev || ev.unparsed) return rawLine; // ligne non reconnue : inchangée
    let dateTxt = displayDate(ev.date, { abbreviate: false, hideBC: false, allBC: false, keepAD: true });
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
  // Item 14 : palette douce (tons « poudrés ») mais lisible. Chaque teinte est générée
  // avec une saturation modérée et une luminance relative FIXE (~0,20) : le contraste
  // reste ≥ 3,5:1 aussi bien sur le papier clair que sur le fond du mode nuit, pour que
  // les dates colorées restent lisibles quelle que soit la teinte.
  const SOFT_LUM = 0.2, SOFT_SAT = 0.36;
  function hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    if (s === 0) return [l, l, l].map(v => Math.round(v * 255));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255));
  }
  function relLuminance(rgb) {
    const c = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function softColor(hue) {
    let lo = 0.15, hi = 0.85;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (relLuminance(hslToRgb(hue, SOFT_SAT, mid)) < SOFT_LUM) lo = mid; else hi = mid;
    }
    return '#' + hslToRgb(hue, SOFT_SAT, (lo + hi) / 2).map(v => v.toString(16).padStart(2, '0')).join('');
  }
  // bleu ardoise, terre cuite, vert sauge, mauve, ocre, sarcelle, rose ancien, indigo doux, olive, vert mousse
  const PALETTE = [212, 12, 100, 285, 38, 172, 340, 250, 62, 145].map(softColor);

  function uid() { return 'id' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  function defaultSettings() {
    return {
      orientation: 'horizontal', scale: 'auto', gradStep: 'auto', showLegend: true,
      allBC: false, hideBC: false, abbreviate: false, splitSubEvents: false,
      scaleCustom: 100, gradCustom: 0, arrowPeriods: 'off',
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
  function hslColor(index) {
    // Rotation à l'angle d'or : teintes bien réparties au-delà de la palette de base
    // (même saturation/luminance douces ; renvoie un #rrggbb utilisable par <input type=color>).
    return softColor((index * 137.508) % 360);
  }
  function colorForCategory(timeline, cat) {
    if (!cat) return null;
    if (!timeline.categoryColors[cat]) {
      const used = Object.keys(timeline.categoryColors).length;
      const next = used < PALETTE.length ? PALETTE[used] : hslColor(used);
      timeline.categoryColors[cat] = next;
      save();
    }
    return timeline.categoryColors[cat];
  }
  // Réattribue la palette douce par défaut aux catégories données (dans l'ordre)
  function resetCategoryColors(timeline, cats) {
    timeline.categoryColors = {};
    for (const c of cats) colorForCategory(timeline, c);
    save();
  }

  return {
    get state() { return state; }, set state(v) { state = v; },
    load, save, uid, newTimeline, newFolder, defaultSettings,
    allTimelines, findTimeline, findTimelineFolder, currentTimeline, colorForCategory, resetCategoryColors, PALETTE,
  };
})();

/* ---------------------------------------------------------------------------
   5. CONSTRUCTION DE LA LISTE D'ÉVÉNEMENTS À PARTIR DU TEXTE SOURCE
   ------------------------------------------------------------------------- */
const EventsBuilder = (() => {
  // Applique le réglage « tout convertir en av. J.-C. » aux dates SANS détermination
  // d'ère (item 13 : « ap. J.-C. » ou « + » explicites restent après J.-C.). Recalcule la
  // valeur (pas seulement l'affichage) pour que le tri et le positionnement restent
  // corrects — y compris pour les dates composées (« 370/369 », « 370 et 369 »…) (item 2).
  function applyAllBC(date) { DateEngine.applyEra(date, 'BC'); }

  function catsOf(ev) { return ev.categories && ev.categories.length ? ev.categories : (ev.category ? [ev.category] : []); }

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
    if (timeline.settings.allBC) { for (const ev of events) applyAllBC(ev.date); }
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
    // catégories réellement présentes dans le texte actuel (pas de mémoire
    // fantôme des catégories supprimées — item 5)
    const presentCategories = [...new Set(events.flatMap(e => (e.categories && e.categories.length ? e.categories : (e.category ? [e.category] : []))))];
    const hasUntagged = events.some(e => !catsOf(e).length);
    return { events, warnings, total: lines.filter(l => l.trim()).length, presentCategories, hasUntagged };
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
  return { buildAll, cluster, catsOf };
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

  // Géométrie d'un bloc d'événement (valeurs en px)
  const DATE_H = 15;   // ligne de date
  const ANN_H = 13;    // ligne d'annotation
  const PAD_B = 4;     // petit espace sous le texte
  const BAND = 12;     // bande dédiée à la barre de période (item 7 : était 16)
  const ARROW_ROW_H = 36; // hauteur d'une rangée de période dans la flèche épaisse (item 9)

  // m : mesures RÉELLES du texte rendu (2e passe) ; sinon estimation.
  function boxMetrics(cluster, boxWidth, isPeriod, m) {
    const band = isPeriod ? BAND : 0;
    if (m && m.descH > 0) {
      const textH = DATE_H + (cluster.annotation ? ANN_H : 0) + m.descH + PAD_B;
      return { w: boxWidth, h: textH + band, textH };
    }
    let h = 18; // date
    if (cluster.annotation) h += ANN_H;
    const items = cluster.items;
    for (const it of items) h += estimateLines(it.text, boxWidth - 10, 12.5) * 14.5 + (items.length > 1 ? 5 : 0);
    h += 6;
    return { w: boxWidth, h: h + band, textH: h };
  }

  // Demi-largeur du texte réellement occupé (le bloc fait 150 px, mais un texte court est
  // bien plus étroit : un trait voisin n'a pas à disparaître sous la zone vide) — item 4.
  function halfTextWidth(cluster, dateLabel, boxWidth, m) {
    if (m && m.descH > 0) return Math.max(m.descW, m.dateW, m.annW) / 2;
    let w = dateLabel.length * 7.4;
    if (cluster.annotation) w = Math.max(w, cluster.annotation.length * 5.6);
    for (const it of cluster.items) {
      const plain = String(it.text);
      w = Math.max(w, estimateLines(plain, boxWidth - 10, 12.5) > 1 ? boxWidth - 10 : plain.length * 6.5);
    }
    return Math.min(boxWidth, w) / 2;
  }

  // Trace une ligne verticale en l'interrompant lorsqu'elle traverse un
  // "obstacle" (texte d'un autre événement, barre de période) : elle
  // disparaît sous celui-ci et reprend juste après (item 18).
  function segmentedVLine(cx, y1, y2, obstacles, attrs) {
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    if (hi - lo < 0.5) return '';
    let blocked = [];
    for (const o of obstacles) {
      if (cx < o.x0 || cx > o.x1) continue;
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

  // Étendue horizontale réelle des lignes de texte d'un bloc (les <div> imbriqués
  // occupent toute la largeur : on mesure donc les nœuds texte, pas les blocs).
  function textExtent(div) {
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let l = Infinity, r = -Infinity, n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue.trim()) continue;
      range.selectNodeContents(n);
      for (const rc of range.getClientRects()) { if (rc.width < 0.5) continue; l = Math.min(l, rc.left); r = Math.max(r, rc.right); }
    }
    return r > l ? r - l : 0;
  }
  // Mesure les hauteurs/largeurs réellement rendues (items 4 et 7).
  function measureAll(container) {
    const out = {};
    container.querySelectorAll('.event-desc[data-ci]').forEach(div => {
      const i = +div.getAttribute('data-ci');
      out[i] = { descH: div.getBoundingClientRect().height, descW: textExtent(div), dateW: 0, annW: 0 };
    });
    container.querySelectorAll('text[data-ci]').forEach(t => {
      const i = +t.getAttribute('data-ci');
      if (!out[i]) return;
      const w = t.getBBox().width;
      if (t.classList.contains('event-date')) out[i].dateW = w; else out[i].annW = w;
    });
    return out;
  }

  let lastInfo = { step: null, width: null };

  function render(container, timeline, built, opts, presentCategories, measured) {
    const S = timeline.settings;
    const all = built.events;

    // Item 9 : périodes inscrites dans la flèche (toutes, ou seulement celles d'un tag)
    const arrowSel = S.arrowPeriods || 'off';
    const inArrow = (ev) => {
      if (arrowSel === 'off' || ev.date.kind !== 'period') return false;
      if (arrowSel === 'all') return true;
      if (arrowSel.startsWith('tag:')) return EventsBuilder.catsOf(ev).includes(arrowSel.slice(4));
      return false;
    };
    const arrowEvents = all.filter(inArrow);
    const clusters = EventsBuilder.cluster(all.filter(e => !inArrow(e)));
    if (!clusters.length && !arrowEvents.length) {
      container.innerHTML = `<div class="empty-state"><h2>Aucun événement pour l'instant</h2><p>Ajoutez des lignes dans l'éditeur, par&nbsp;ex. « 1789&nbsp;: Prise de la Bastille »</p></div>`;
      return;
    }
    const cW = Math.max(container.clientWidth || 900, 320);

    let minV = Infinity, maxV = -Infinity;
    for (const ev of all) {
      minV = Math.min(minV, ev.date.value);
      maxV = Math.max(maxV, ev.date.value);
      if (ev.date.kind === 'period') { minV = Math.min(minV, ev.date.endValue); maxV = Math.max(maxV, ev.date.endValue); }
    }
    if (minV === maxV) { minV -= 5; maxV += 5; }
    const rawRange = maxV - minV;
    const pad = Math.max(rawRange * 0.06, rawRange < 1 ? 1 : 2);
    minV -= pad; maxV += pad;
    const range = maxV - minV;

    const boxWidth = 150;
    const minPxPerBox = 96;
    // Item 5 : échelle prédéfinie OU saisie libre (100 % = largeur automatique)
    let width;
    if (S.scale === 'custom' && S.scaleCustom > 0) {
      const autoW = Math.max(cW - 20, clusters.length * minPxPerBox);
      width = Math.max(320, Math.round(autoW * Math.min(S.scaleCustom, 3000) / 100));
    } else {
      const scaleFactor = S.scale === 'compact' ? 0.6 : S.scale === 'large' ? 1.7 : 1;
      const idealWidth = Math.max(cW - 60, clusters.length * minPxPerBox * scaleFactor);
      width = Math.max(cW - 20, idealWidth);
    }
    const marginX = 70;
    const innerW = width - marginX * 2;
    const x = (v) => marginX + ((v - minV) / range) * innerW;

    // --- Préparation des items à empiler (lanes) ---
    const items = clusters.map((c, i) => {
      const m = measured && measured[i];
      const isPeriod = c.date.kind === 'period';
      const x0raw = isPeriod ? x(Math.min(c.date.value, c.date.endValue)) : x(c.date.value) - boxWidth / 2;
      const x1raw = isPeriod ? x(Math.max(c.date.value, c.date.endValue)) : x(c.date.value) + boxWidth / 2;
      const dateLabel = Fmt.displayDate(c.date, S);
      const bm = boxMetrics(c, boxWidth, isPeriod, m);
      const boxX0 = x(c.date.value) - boxWidth / 2;
      const boxX1 = boxX0 + boxWidth;
      const x0 = Math.min(x0raw, boxX0);
      const x1 = Math.max(x1raw, boxX1);
      return { c, i, m, side: i % 2 === 0 ? 'above' : 'below', x0, x1, h: bm.h, textH: bm.textH, half: halfTextWidth(c, dateLabel, boxWidth, m), dateLabel, boxWidth, isPeriod };
    });
    packLanes(items, 12);

    // item 4 : lanes plus condensées (moins d'espace vertical perdu)
    function laneOffsets(side) {
      const maxLane = Math.max(-1, ...items.filter(it => it.side === side).map(it => it.lane));
      const heights = new Array(maxLane + 1).fill(0);
      for (const it of items) if (it.side === side) heights[it.lane] = Math.max(heights[it.lane], it.h);
      const offsets = [];
      let acc = 18;
      for (let li = 0; li <= maxLane; li++) { offsets.push(acc); acc += heights[li] + 12; }
      return { offsets, total: acc };
    }
    const aboveInfo = laneOffsets('above');
    const belowInfo = laneOffsets('below');

    // --- Flèche épaisse (item 9) : périodes sur plusieurs rangées si elles se chevauchent ---
    const segs = arrowEvents.map(ev => {
      const a = x(Math.min(ev.date.value, ev.date.endValue)), b = x(Math.max(ev.date.value, ev.date.endValue));
      return { ev, a, b: Math.max(b, a + 6) };
    }).sort((p, q) => p.a - q.a);
    const rowEnds = [];
    for (const sg of segs) {
      let r = rowEnds.findIndex(end => sg.a >= end - 0.5);
      if (r < 0) { r = rowEnds.length; rowEnds.push(-Infinity); }
      sg.row = r; rowEnds[r] = sg.b;
    }
    const arrowH = segs.length ? rowEnds.length * ARROW_ROW_H + 6 : 0;
    const half = arrowH / 2;

    const tickStrip = S.gradStep === 'off' ? 6 : 26;
    const axisY = aboveInfo.total + 16 + half;
    const edgeTop = axisY - half, edgeBot = axisY + half; // = axisY quand la flèche est fine
    const height = edgeBot + tickStrip + belowInfo.total + 24;

    for (const it of items) {
      it.boxY = it.side === 'above' ? edgeTop - (aboveInfo.offsets[it.lane] + it.h) : edgeBot + tickStrip + belowInfo.offsets[it.lane];
      it.boxLeft = it.isPeriod
        ? (x(Math.min(it.c.date.value, it.c.date.endValue)) + x(Math.max(it.c.date.value, it.c.date.endValue))) / 2 - it.boxWidth / 2
        : x(it.c.date.value) - it.boxWidth / 2;
      it.boxCenterX = it.boxLeft + it.boxWidth / 2;
      // item 3/7 : la barre de période occupe une bande dédiée, collée au texte
      // (au-dessus de la flèche : juste sous le texte ; en dessous : juste au-dessus)
      it.textTop = (it.isPeriod && it.side === 'below') ? it.boxY + BAND : it.boxY;
      if (it.isPeriod) it.barY = it.side === 'above' ? it.boxY + it.textH + BAND / 2 : it.boxY + BAND / 2;
    }

    // --- Obstacles (pour interrompre les traits qui passent sous un texte/une barre — item 4) ---
    // Seule la zone réellement occupée par le texte compte (largeur et hauteur mesurées),
    // pas tout le bloc de 150 px : plus de grands blancs inutiles autour des traits.
    const obstacles = [];
    for (const it of items) {
      const hw = it.half + 3;
      obstacles.push({ id: it.i, x0: it.boxCenterX - hw, x1: it.boxCenterX + hw, y0: it.textTop - 1, y1: it.textTop + it.textH - PAD_B + 1 });
      if (it.isPeriod) {
        const bx0 = x(Math.min(it.c.date.value, it.c.date.endValue)), bx1 = x(Math.max(it.c.date.value, it.c.date.endValue));
        obstacles.push({ id: it.i, x0: bx0, x1: bx1, y0: it.barY - 3, y1: it.barY + 3 });
      }
    }

    // --- Graduations (item 5 : pas libre) ---
    let ticksSvg = '';
    let effStep = null;
    if (S.gradStep !== 'off') {
      let step;
      if (S.gradStep === 'custom' && S.gradCustom > 0) step = S.gradCustom;
      else {
        const stepMul = S.gradStep === 'fine' ? 0.5 : S.gradStep === 'coarse' ? 2 : 1;
        step = niceStep(range) * stepMul || 1;
      }
      if (range / step > 400) step = Math.ceil(range / 400); // garde-fou : pas trop de graduations
      effStep = step;
      const first = Math.ceil(minV / step) * step;
      let lastYear = null;
      for (let k = 0; ; k++) {
        const v = first + k * step;
        if (v > maxV) break;
        const tx = x(v);
        const yr = Math.round(v);
        // l'ère se lit sur la position réelle (négatif = av. J.-C.), jamais sur le réglage
        const label = Fmt.pointToText({ kind: 'point', year: yr, isBC: v < 0 }, { abbreviate: S.abbreviate, hideBC: S.hideBC });
        const y1 = half ? edgeBot : axisY - 4, y2 = half ? edgeBot + 6 : axisY + 4;
        ticksSvg += `<line class="tick" x1="${tx}" y1="${y1}" x2="${tx}" y2="${y2}"/>`;
        if (yr !== lastYear) ticksSvg += `<text class="tick-label" x="${tx}" y="${edgeBot + 17}" text-anchor="middle">${esc(label)}</text>`;
        lastYear = yr;
      }
    }

    // --- Axe + flèche ---
    let axisSvg;
    if (half) {
      const xs = marginX - 20, xe = width - marginX + 30, tip = xe + 26, hd = 9;
      axisSvg = `<path d="M${xs},${edgeTop} L${xe},${edgeTop} L${xe},${edgeTop - hd} L${tip},${axisY} L${xe},${edgeBot + hd} L${xe},${edgeBot} L${xs},${edgeBot} Z" fill="var(--paper-2)" stroke="var(--text-ink)" stroke-width="2.5" stroke-linejoin="round"/>`;
    } else {
      axisSvg = `<line class="axis-line" x1="${marginX - 20}" y1="${axisY}" x2="${width - marginX + 30}" y2="${axisY}" stroke="var(--text-ink)"/>`;
      axisSvg += `<polygon points="${width - marginX + 30},${axisY - 7} ${width - marginX + 46},${axisY} ${width - marginX + 30},${axisY + 7}" fill="var(--text-ink)"/>`;
    }
    // périodes inscrites dans la flèche : segments séparés, une rangée par chevauchement
    segs.forEach((sg, idx) => {
      const ev = sg.ev;
      const w = sg.b - sg.a;
      const rowTop = edgeTop + 3 + sg.row * ARROW_ROW_H;
      const descArr = Array.isArray(ev.description) ? ev.description : [ev.description];
      const plain = descArr.map(d => LineParser.stripMarkers(String(d))).join(' · ');
      const html = descArr.map(d => Fmt.markupToHtml(String(d))).join(' · ');
      const dl = Fmt.displayDate(ev.date, S);
      const fill = ev.color || 'var(--paper-line)';
      const op = ev.color ? 0.42 : (idx % 2 ? 0.35 : 0.6);
      axisSvg += `<g class="arrow-period"><title>${esc(plain)} (${esc(dl)})</title>`;
      axisSvg += `<rect x="${sg.a}" y="${rowTop}" width="${w}" height="${ARROW_ROW_H - 2}" rx="3" fill="${fill}" fill-opacity="${op}" stroke="var(--text-ink)" stroke-opacity="0.6" stroke-width="1"/>`;
      if (w >= 34) {
        axisSvg += `<foreignObject x="${sg.a + 3}" y="${rowTop + 1}" width="${w - 6}" height="${ARROW_ROW_H - 4}"><div xmlns="http://www.w3.org/1999/xhtml" class="arrow-seg"><div class="arrow-name">${html}</div><div class="arrow-dates">${esc(dl)}</div></div></foreignObject>`;
      }
      axisSvg += `</g>`;
    });

    // --- Événements ---
    let evSvg = '';
    for (const it of items) {
      const c = it.c, d = c.date;
      const color = c.color || 'var(--text-ink)';
      const cx = x(d.value);
      const boxLeft = it.boxLeft;
      const textX = it.boxCenterX; // item 9 : texte centré sur le point d'accroche
      const textTop = it.textTop;

      if (it.isPeriod) {
        const bx0 = x(Math.min(d.value, d.endValue)), bx1 = x(Math.max(d.value, d.endValue));
        const by = it.barY;
        evSvg += `<line class="period-bar" x1="${bx0}" y1="${by}" x2="${bx1}" y2="${by}" stroke="${color}"/>`;
        evSvg += `<line x1="${bx0}" y1="${by - 5}" x2="${bx0}" y2="${by + 5}" stroke="${color}" stroke-width="2"/>`;
        evSvg += `<line x1="${bx1}" y1="${by - 5}" x2="${bx1}" y2="${by + 5}" stroke="${color}" stroke-width="2"/>`;
      } else {
        const attached = d.attached !== false; // item 8 : siècle/décennie -> non rattaché
        const dotY = it.side === 'above' ? edgeTop : edgeBot;
        evSvg += `<circle class="event-dot" cx="${cx}" cy="${dotY}" r="4" fill="${color}"/>`;
        if (attached) {
          const connY2 = it.side === 'above' ? it.boxY + it.h : it.boxY;
          const others = obstacles.filter(o => o.id !== it.i);
          evSvg += segmentedVLine(cx, dotY, connY2, others, `class="connector" stroke="${color}"`);
        }
      }

      let fy = textTop + 12;
      evSvg += `<text class="event-date" data-ci="${it.i}" x="${textX}" y="${fy}" text-anchor="middle" fill="${color}">${esc(it.dateLabel)}</text>`;
      fy += 13;
      if (c.annotation) { evSvg += `<text class="event-annotation" data-ci="${it.i}" x="${textX}" y="${fy}" text-anchor="middle">${esc(c.annotation)}</text>`; fy += 13; }
      const descH = it.m && it.m.descH > 0 ? it.m.descH + 2 : Math.max(14, it.textH - (fy - 10 - textTop) + 2);
      evSvg += `<foreignObject x="${boxLeft}" y="${fy - 10}" width="${it.boxWidth}" height="${descH}">`;
      evSvg += `<div xmlns="http://www.w3.org/1999/xhtml" class="event-desc" data-ci="${it.i}">`;
      if (c.items.length > 1) {
        evSvg += c.items.map((sub, idx) => `<div style="${idx > 0 ? `border-top:2px solid ${sub.color || 'var(--paper-line)'};margin-top:3px;padding-top:3px` : ''}">${Fmt.markupToHtml(sub.text)}</div>`).join('');
      } else {
        evSvg += Fmt.markupToHtml(c.items[0] ? c.items[0].text : '');
      }
      evSvg += `</div></foreignObject>`;
    }

    // --- Légende (catégories réellement présentes et principales — items 4/5) ---
    let legendSvg = '';
    if (S.showLegend) {
      const cats = (presentCategories || []).filter(c => timeline.categoryColors[c]).map(c => [c, timeline.categoryColors[c]]);
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
    const totalHeight = height + (S.showLegend && Object.keys(timeline.categoryColors).length ? 22 : 6);

    const svg = `<svg class="frise" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">${axisSvg}${ticksSvg}${evSvg}${legendSvg}</svg>`;
    container.innerHTML = svg;
    lastInfo = { step: effStep, width: Math.round(width) };

    // 2e passe : on mesure le texte réellement rendu (hauteur, largeur) puis on remet en
    // page avec ces valeurs exactes — barres de période collées à leur texte (item 7) et
    // traits qui ne disparaissent que sous le texte lui-même (item 4).
    if (!measured && clusters.length && typeof container.querySelectorAll === 'function' && container.offsetParent !== null) {
      let m = null;
      try { m = measureAll(container); } catch (e) { m = null; }
      if (m && Object.keys(m).length === clusters.length && Object.values(m).every(v => v.descH > 0)) {
        return render(container, timeline, built, opts, presentCategories, m);
      }
    }
  }

  return { render, get info() { return lastInfo; } };
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
/* ---------------------------------------------------------------------------
   8bis. IMPRESSION (item 15) — on n'intervient plus : le navigateur imprime
   la frise telle quelle (pagination/mise à l'échelle natives).
   ------------------------------------------------------------------------- */
const PrintPager = (() => {
  function preparePrint() { /* volontairement vide : aucune intervention */ }
  return { preparePrint };
})();


/* ---------------------------------------------------------------------------
   9. APPLICATION — état, rendu de l'UI, câblage des événements
   ------------------------------------------------------------------------- */
const App = (() => {
  const $ = (sel) => document.querySelector(sel);
  const els = {};
  const UNTAGGED = '__sans_tag__'; // pastille « sans tag » du filtre (item 6)
  let catFilter = new Set(); // item 2 : sélection multiple de catégories (+ UNTAGGED)
  let editorFilterActive = false; // item 2 : l'éditeur reflète le filtre actif
  let editorFilterNonMatching = []; // lignes mises de côté pendant le filtrage
  let renderTimer = null;

  function init() {
    cacheEls();
    bindEvents();
    initDarkMode();
    renderFolderList();
    loadTimelineIntoUI(Store.currentTimeline());
    window.addEventListener('resize', () => scheduleRender(0));
    // les polices web changent la largeur du texte : on remet en page une fois chargées
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => scheduleRender(0));
  }

  function cacheEls() {
    ['frisesBtn','panel','timelineTitle','btnOrientation','btnFullscreen','btnPrint','btnDarkMode',
     'folderList','btnNewFolder','btnNewTimeline','selOrientation','selScale','selGrad',
     'chkLegend','chkAllBC','chkHideBC','chkAbbr','chkSplitSub','allBCHint',
     'catColorList','catEmptyHint','btnExportOne','btnExportAll','btnImport','fileImport',
     'btnDupTimeline','btnDeleteTimeline','catFilterBar','editor','editorFoot','lineCount',
     'parseWarnings','viewPane','timelineContainer','mobileTabs','tabEdit','tabView',
     'fsExitBtn','toast','app','inpScale','inpGrad','selArrow','btnResetColors'
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
    editorFilterActive = false;
    editorFilterNonMatching = [];
    // frises enregistrées avant l'ajout de nouveaux réglages : on complète les valeurs manquantes
    t.settings = Object.assign(Store.defaultSettings(), t.settings || {});
    els.timelineTitle.value = t.name;
    els.editor.value = t.text;
    els.selOrientation.value = t.settings.orientation;
    els.selScale.value = t.settings.scale;
    els.inpScale.value = t.settings.scale === 'custom' ? t.settings.scaleCustom : '';
    els.selGrad.value = t.settings.gradStep;
    els.inpGrad.value = t.settings.gradStep === 'custom' && t.settings.gradCustom > 0 ? t.settings.gradCustom : '';
    els.chkLegend.checked = t.settings.showLegend;
    els.chkAllBC.checked = t.settings.allBC;
    els.chkHideBC.checked = t.settings.hideBC;
    els.chkAbbr.checked = t.settings.abbreviate;
    els.chkSplitSub.checked = t.settings.splitSubEvents;
    applyOrientationToDOM(t.settings.orientation);
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
    renderCategoryPanel(t, built);

    // Items 6 et 8 — filtre par #tag :
    //  - aucune pastille active : tout est affiché ;
    //  - sinon, seuls les événements portant au moins un tag sélectionné sont affichés ;
    //    la pastille « sans tag » y ajoute (ou affiche seule) les événements sans tag.
    //  - un événement à plusieurs tags s'affiche dans la couleur d'un tag NON sélectionné
    //    (le tag sélectionné est déjà l'objet du filtre) ; à défaut, couleur du 1er tag.
    const catsOf = EventsBuilder.catsOf;
    const realSel = [...catFilter].filter(c => c !== UNTAGGED);
    let events = built.events.filter(e => {
      if (catFilter.size === 0) return true;
      const cats = catsOf(e);
      if (!cats.length) return catFilter.has(UNTAGGED);
      return cats.some(c => catFilter.has(c));
    });
    if (realSel.length) {
      for (const e of events) {
        const cats = catsOf(e);
        if (cats.length < 2) continue;
        const other = cats.find(c => !catFilter.has(c));
        if (other) e.color = Store.colorForCategory(t, other);
      }
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
      RenderHorizontal.render(els.timelineContainer, t, filteredBuilt, t.settings, built.presentCategories);
      // les champs numériques montrent la valeur effectivement utilisée tant qu'ils sont vides
      const info = RenderHorizontal.info || {};
      els.inpGrad.placeholder = info.step ? String(info.step) : 'auto';
    }
  }

  /* ---------- Catégories : filtre (multi-sélection, item 2) + couleurs ---------- */
  function renderCatFilterBar(t, built) {
    const cats = built.presentCategories;
    // une sélection ne conserve que les catégories encore présentes
    for (const c of [...catFilter]) {
      if (c === UNTAGGED ? !(built.hasUntagged && cats.length) : !cats.includes(c)) catFilter.delete(c);
    }
    els.catFilterBar.innerHTML = '';
    if (!cats.length) { els.catFilterBar.style.display = 'none'; return; }
    els.catFilterBar.style.display = 'flex';
    const allChip = document.createElement('button');
    allChip.className = 'chip' + (catFilter.size === 0 ? ' active' : '');
    allChip.textContent = 'Toutes';
    allChip.addEventListener('click', () => { catFilter.clear(); onCategoryFilterChanged(); });
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
        onCategoryFilterChanged();
      });
      els.catFilterBar.appendChild(chip);
    }
    // item 6 : pastille « sans tag » (affichée seulement s'il existe des événements sans tag)
    if (built.hasUntagged) {
      const chip = document.createElement('button');
      chip.className = 'chip untagged' + (catFilter.has(UNTAGGED) ? ' active' : '');
      chip.textContent = 'sans tag';
      chip.title = 'Inclure les événements sans tag dans la sélection';
      chip.addEventListener('click', () => {
        if (catFilter.has(UNTAGGED)) catFilter.delete(UNTAGGED); else catFilter.add(UNTAGGED);
        onCategoryFilterChanged();
      });
      els.catFilterBar.appendChild(chip);
    }
  }

  // item 5 : n'affiche QUE les catégories réellement présentes dans le texte
  // (plus de mémoire fantôme des catégories supprimées de l'éditeur).
  function renderCategoryPanel(t, built) {
    const cats = built.presentCategories;
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
    refreshArrowSelect(t, cats);
  }

  // item 9 : options « périodes dans la flèche » (Non / Toutes / une par tag présent)
  function refreshArrowSelect(t, cats) {
    const cur = (t.settings && t.settings.arrowPeriods) || 'off';
    const opts = [['off', 'Non (flèche fine)'], ['all', 'Toutes les périodes']];
    for (const c of cats) opts.push(['tag:' + c, 'Périodes #' + c]);
    if (!opts.some(o => o[0] === cur)) opts.push([cur, cur.startsWith('tag:') ? 'Périodes #' + cur.slice(4) : cur]);
    els.selArrow.innerHTML = '';
    for (const [v, label] of opts) {
      const o = document.createElement('option'); o.value = v; o.textContent = label; els.selArrow.appendChild(o);
    }
    els.selArrow.value = cur;
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

  // item 2 : quand le filtre par #catégorie change, l'éditeur n'affiche (et ne
  // trie) que les lignes correspondantes ; les autres sont mises de côté puis
  // refusionnées telles quelles quand le filtre est levé.
  function lineMatchesFilter(line) {
    if (!line.trim()) return false;
    const ev = LineParser.parseEventLine(line);
    if (!ev || ev.unparsed) return false;
    const cats = ev.categories && ev.categories.length ? ev.categories : (ev.category ? [ev.category] : []);
    if (!cats.length) return catFilter.has(UNTAGGED);
    return cats.some(c => catFilter.has(c));
  }
  function mergeFilteredEditorBack(t) {
    if (!editorFilterActive) return;
    t.text = editorFilterNonMatching.concat(els.editor.value.split('\n')).join('\n');
    Store.save();
  }
  function enterOrUpdateEditorFilter(t) {
    mergeFilteredEditorBack(t);
    const lines = t.text.split('\n');
    const matching = [], nonMatching = [];
    for (const l of lines) { if (l.trim() && lineMatchesFilter(l)) matching.push(l); else nonMatching.push(l); }
    const sorted = matching
      .map(l => ({ l, ev: LineParser.parseEventLine(l) }))
      .sort((a, b) => a.ev.date.value - b.ev.date.value)
      .map(x => x.l);
    editorFilterNonMatching = nonMatching;
    editorFilterActive = true;
    els.editor.value = sorted.join('\n');
  }
  function exitEditorFilter(t) {
    mergeFilteredEditorBack(t);
    editorFilterActive = false;
    editorFilterNonMatching = [];
    els.editor.value = t.text;
  }
  function onCategoryFilterChanged() {
    const t = currentTimeline();
    if (!t) { doRender(); return; }
    if (catFilter.size > 0) enterOrUpdateEditorFilter(t); else exitEditorFilter(t);
    doRender();
  }

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

  function writeEditorTextBack(t) {
    t.text = editorFilterActive
      ? editorFilterNonMatching.concat(els.editor.value.split('\n')).join('\n')
      : els.editor.value;
  }

  function onEditorInput() {
    const t = currentTimeline(); if (!t) return;
    writeEditorTextBack(t);
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
    writeEditorTextBack(t);
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
    // item 15 : aucune intervention — impression native du navigateur.
    window.print();
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
    // item 5 : échelle et graduations réglables par un nombre
    els.selScale.addEventListener('change', () => {
      const st = currentTimeline().settings;
      st.scale = els.selScale.value;
      if (st.scale === 'custom') { if (!(st.scaleCustom > 0)) st.scaleCustom = 100; els.inpScale.value = st.scaleCustom; }
      else els.inpScale.value = '';
      Store.save(); scheduleRender(0);
    });
    els.inpScale.addEventListener('input', () => {
      const st = currentTimeline().settings;
      const v = parseFloat(els.inpScale.value.replace(',', '.'));
      if (isFinite(v) && v > 0) { st.scale = 'custom'; st.scaleCustom = Math.min(3000, Math.max(10, v)); }
      else if (els.inpScale.value.trim() === '') st.scale = 'auto';
      else return;
      els.selScale.value = st.scale;
      Store.save(); scheduleRender(250);
    });
    els.selGrad.addEventListener('change', () => {
      const st = currentTimeline().settings;
      st.gradStep = els.selGrad.value;
      if (st.gradStep === 'custom') {
        if (!(st.gradCustom > 0)) st.gradCustom = parseFloat(els.inpGrad.placeholder) || 50;
        els.inpGrad.value = st.gradCustom;
      } else els.inpGrad.value = '';
      Store.save(); scheduleRender(0);
    });
    els.inpGrad.addEventListener('input', () => {
      const st = currentTimeline().settings;
      const v = parseFloat(els.inpGrad.value.replace(',', '.'));
      if (isFinite(v) && v > 0) { st.gradStep = 'custom'; st.gradCustom = Math.max(1, v); }
      else if (els.inpGrad.value.trim() === '') st.gradStep = 'auto';
      else return;
      els.selGrad.value = st.gradStep;
      Store.save(); scheduleRender(250);
    });
    els.selArrow.addEventListener('change', () => { currentTimeline().settings.arrowPeriods = els.selArrow.value; Store.save(); scheduleRender(0); });
    els.btnResetColors.addEventListener('click', () => {
      const t = currentTimeline(); if (!t) return;
      const built = EventsBuilder.buildAll(t);
      Store.resetCategoryColors(t, built.presentCategories);
      scheduleRender(0);
      toast('Couleurs par défaut rétablies');
    });
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
