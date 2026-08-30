(function () {
"use strict";
/* ============================================================================
   render.js — dessin de la frise (vue horizontale proportionnelle en SVG,
   vue verticale non proportionnelle pensée mobile)
   ========================================================================= */

const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * 0.54;
}

function wrapText(text, maxWidth, fontSize) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  words.forEach(w => {
    const test = cur ? cur + " " + w : w;
    if (estimateTextWidth(test, fontSize) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  });
  if (cur) lines.push(cur);
  return lines;
}

function niceStep(range, targetTicks) {
  const raw = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / mag;
  let step;
  if (norm < 1.5) step = 1; else if (norm < 3.5) step = 2; else if (norm < 7.5) step = 5; else step = 10;
  return step * mag;
}

function yearTickLabel(y, opts) {
  const isBC = y < 0;
  const v = Math.round(Math.abs(y));
  if (opts.hideBC) return String(v);
  if (isBC) return opts.abbreviate ? `-${v}` : `${v} av. J.-C.`;
  return String(v);
}

// ---------------------------------------------------------------------------
// Regroupe les événements consécutifs (déjà triés) qui partagent exactement
// la même date en une seule "entrée visuelle" : la date n'est écrite qu'une
// fois, et les sous-événements sont séparés par une petite barre colorée
// (couleur de la catégorie de chacun), plutôt que de répéter la date.
// ---------------------------------------------------------------------------
function buildItems(events) {
  const items = [];
  let cur = null;
  events.forEach(e => {
    if (cur && cur.key === e.groupKey) cur.subs.push(e);
    else { cur = { key: e.groupKey, date: e.date, dateDisplay: e.dateDisplay, subs: [e] }; items.push(cur); }
  });
  items.forEach(it => { it.color = (it.subs.find(s => s.color) || {}).color || null; });
  return items;
}

// construit, pour un item, la liste de "blocs" de texte à empiler
// (un bloc par sous-événement : ses lignes + son éventuelle annotation),
// avec la couleur de séparation à utiliser avant chaque bloc (sauf le 1er)
function layoutSubBlocks(item, maxWidth, fontSize) {
  return item.subs.map((s, i) => {
    const lines = wrapText(s.plainText || "(sans titre)", maxWidth, fontSize);
    return {
      sub: s, lines,
      annotation: s.annotation,
      separatorColor: i > 0 ? (s.color || "var(--muted)") : null,
      height: lines.length * (fontSize + 3) + (s.annotation ? fontSize + 2 : 0) + (i > 0 ? 8 : 0)
    };
  });
}

function drawStackedBlocks(group, blocks, x, startY, fontSize, textAnchor, widthForBar) {
  let y = startY;
  blocks.forEach((b, i) => {
    if (b.separatorColor) {
      const barW = Math.min(widthForBar, 46);
      const barX = textAnchor === "middle" ? x - barW / 2 : (textAnchor === "end" ? x - barW : x);
      group.appendChild(svgEl("rect", { x: barX, y: y - fontSize + 2, width: barW, height: 2.5, fill: b.separatorColor, rx: 1.2 }));
      y += 8;
    }
    b.lines.forEach((line, li) => {
      const t = svgEl("text", { x, y: y + li * (fontSize + 3), "text-anchor": textAnchor, class: "event-label" });
      renderSegmentsIntoText(t, b.sub.segments, line);
      group.appendChild(t);
    });
    y += b.lines.length * (fontSize + 3);
    if (b.annotation) {
      const t = svgEl("text", { x, y, "text-anchor": textAnchor, class: "event-annotation" });
      t.textContent = b.annotation;
      group.appendChild(t);
      y += fontSize + 2;
    }
  });
  return y;
}

function blocksHeight(blocks) { return blocks.reduce((s, b) => s + b.height, 0); }

// ---------------------------------------------------------------------------
// Calcule la disposition horizontale (positions, voies, dimensions) sans
// rien dessiner — réutilisé à la fois par l'affichage écran et par la
// pagination d'impression A4.
// ---------------------------------------------------------------------------
function layoutHorizontal(events, settings, availableWidth) {
  const fontSize = settings.fontSize || 13;
  const marginLeft = 60, marginRight = 60;
  const axisY = 280;
  const laneGap = settings.laneGap || 58;
  const pxPerUnit = settings.scale || null;
  const maxLabelWidth = settings.maxLabelWidth || 170;

  const items = buildItems(events);

  let minY = Math.min(...items.map(it => it.date.year));
  let maxY = Math.max(...items.map(it => (it.date.yearEnd !== undefined ? it.date.yearEnd : it.date.year)));
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const pad = (maxY - minY) * 0.06;
  minY -= pad; maxY += pad;

  const scale = pxPerUnit || (availableWidth / (maxY - minY));
  const totalWidth = (maxY - minY) * scale + marginLeft + marginRight;
  const xOf = (y) => marginLeft + (y - minY) * scale;

  const prepared = items.map(it => {
    const isPeriod = it.date.type === "period";
    const x1 = xOf(it.date.year);
    const x2 = isPeriod ? xOf(it.date.yearEnd) : x1;
    const cx = (x1 + x2) / 2;
    const blocks = layoutSubBlocks(it, maxLabelWidth, fontSize);
    const labelWidth = Math.max(estimateTextWidth(it.dateDisplay, fontSize - 1), ...blocks.flatMap(b => b.lines.map(l => estimateTextWidth(l, fontSize))));
    const barWidth = isPeriod ? (x2 - x1) : 0;
    const footprintWidth = Math.max(labelWidth, Math.min(barWidth, 400));
    return { it, isPeriod, x1, x2, cx, blocks, labelWidth, barWidth, footprintWidth };
  });

  const placed = [];
  prepared.forEach(p => {
    const half = p.footprintWidth / 2;
    let lane = 0, found = false;
    for (let tier = 0; tier < 40 && !found; tier++) {
      for (const s of [1, -1]) {
        const laneId = s * (tier + 1);
        const overlap = placed.some(pl => pl.lane === laneId && !(p.cx + half < pl.x1 - 8 || p.cx - half > pl.x2 + 8));
        if (!overlap) { lane = laneId; found = true; break; }
      }
    }
    placed.push({ x1: p.cx - half, x2: p.cx + half, lane });
    p.lane = lane;
  });

  const maxTier = Math.max(1, ...placed.map(p => Math.abs(p.lane)));
  const totalHeight = axisY + maxTier * laneGap + 100;
  const step = settings.graduationStep || niceStep(maxY - minY, 10);

  return { prepared, minY, maxY, scale, totalWidth, totalHeight, axisY, step, marginLeft, marginRight, fontSize, laneGap };
}

// Dessine le contenu (axe, graduations, items) dans un <svg> "monde", à
// l'échelle naturelle — sert de base à la fois à l'aperçu écran et aux
// pages d'impression (qui n'en affichent chacune qu'une fenêtre).
function paintHorizontalWorld(layout, settings) {
  const { prepared, minY, maxY, scale, totalWidth, totalHeight, axisY, step, marginLeft, marginRight } = layout;
  const xOf = (y) => marginLeft + (y - minY) * scale;
  const svg = svgEl("svg", { viewBox: `0 0 ${totalWidth} ${totalHeight}`, width: totalWidth, height: totalHeight, class: "timeline-svg" });

  svg.appendChild(svgEl("line", { x1: marginLeft - 20, y1: axisY, x2: totalWidth - marginRight + 30, y2: axisY, stroke: "var(--axis)", "stroke-width": 2 }));
  svg.appendChild(svgEl("polygon", { points: `${totalWidth - marginRight + 30},${axisY} ${totalWidth - marginRight + 14},${axisY - 7} ${totalWidth - marginRight + 14},${axisY + 7}`, fill: "var(--axis)" }));

  for (let g = Math.ceil(minY / step) * step; g <= maxY; g += step) {
    const gx = xOf(g);
    svg.appendChild(svgEl("line", { x1: gx, y1: axisY - 6, x2: gx, y2: axisY + 6, stroke: "var(--axis)", "stroke-width": 1 }));
    const t = svgEl("text", { x: gx, y: axisY + 22, "text-anchor": "middle", class: "tick-label" });
    t.textContent = yearTickLabel(g, settings);
    svg.appendChild(t);
  }

  prepared.forEach(p => {
    const it = p.it;
    const color = it.color || "var(--accent)";
    const y = axisY - p.lane * layout.laneGap;
    const group = svgEl("g", { class: "event-group" });

    if (p.isPeriod) {
      if (p.lane !== 0) {
        group.appendChild(svgEl("line", { x1: p.x1, y1: axisY, x2: p.x1, y2: y, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "3,3" }));
        group.appendChild(svgEl("line", { x1: p.x2, y1: axisY, x2: p.x2, y2: y, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "3,3" }));
      }
      group.appendChild(svgEl("line", { x1: p.x1, y1: y, x2: p.x2, y2: y, stroke: color, "stroke-width": 4, "stroke-linecap": "round" }));
      group.appendChild(svgEl("circle", { cx: p.x1, cy: y, r: 3, fill: color }));
      group.appendChild(svgEl("circle", { cx: p.x2, cy: y, r: 3, fill: color }));
    } else if (it.date.isDecadeLike) {
      group.appendChild(svgEl("line", { x1: p.x1, y1: y, x2: p.x1 + 14, y2: y, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "3,3" }));
    } else {
      if (p.lane !== 0) group.appendChild(svgEl("line", { x1: p.x1, y1: axisY, x2: p.x1, y2: y, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "3,3" }));
      group.appendChild(svgEl("circle", { cx: p.x1, cy: axisY, r: 4.5, fill: color, stroke: "var(--bg)", "stroke-width": 1.5 }));
    }

    const dateText = svgEl("text", { x: p.cx, y: y - 6, "text-anchor": "middle", class: "event-date" + (it.date.isApprox ? " approx" : ""), style: `fill:${color}` });
    dateText.textContent = it.dateDisplay;
    group.appendChild(dateText);

    drawStackedBlocks(group, p.blocks, p.cx, y + 14, layout.fontSize, "middle", p.labelWidth);

    svg.appendChild(group);
  });

  return svg;
}

// ---------------------------------------------------------------------------
// VUE HORIZONTALE — échelle proportionnelle, flèche + graduations + étiquettes
// ---------------------------------------------------------------------------
let lastHorizontalScale = null;

function renderHorizontal(container, events, settings) {
  container.innerHTML = "";
  if (!events.length) { container.innerHTML = '<p class="empty-hint">Aucun événement à afficher pour l’instant.</p>'; return; }
  const availableWidth = Math.max((container.clientWidth || 900) - 120, 600);
  const layout = layoutHorizontal(events, settings, availableWidth);
  lastHorizontalScale = layout.scale;
  const svg = paintHorizontalWorld(layout, settings);
  container.appendChild(svg);
}

// ---------------------------------------------------------------------------
// IMPRESSION A4 PAYSAGE — au lieu de réduire toute la frise (et donc le
// texte) pour la faire tenir sur une seule page, on garde une taille de
// texte lisible et on découpe la frise en plusieurs feuilles A4 alignées
// horizontalement. Si la hauteur (nombre de "voies" empilées) dépasse une
// page, on réduit modérément la taille du texte jusqu'à ce que ça rentre en
// hauteur — la largeur, elle, se pagine plutôt que de rétrécir le texte.
// ---------------------------------------------------------------------------
function renderHorizontalPrintPages(container, events, settings) {
  container.innerHTML = "";
  if (!events.length) return;

  const DPI = 96;
  const mm = (v) => (v / 25.4) * DPI;
  const pageW = mm(297) - mm(20); // A4 paysage, marges ~10mm de chaque côté
  const pageH = mm(210) - mm(20);
  const MAX_PAGES = 12;

  const baseFontSize = settings.fontSize || 13;

  // L'échelle utilisée à l'écran est volontairement resserrée pour tenir
  // dans la fenêtre ; pour l'impression on part au contraire d'une échelle
  // "naturelle" qu'on élargit tant que la frise reste trop entassée
  // (trop de voies empilées), plutôt que de rétrécir le texte pour tout
  // faire tenir sur une seule page.
  let layout = layoutHorizontal(events, settings, pageW - 120);
  let scale = layout.scale;
  let pages = Math.max(1, Math.ceil(layout.totalWidth / pageW));
  let maxTier = Math.round((layout.totalHeight - layout.axisY - 100) / layout.laneGap) || 1;
  let iterations = 0;
  while (maxTier > 2 && pages < MAX_PAGES && iterations < 20) {
    scale *= 1.35;
    layout = layoutHorizontal(events, Object.assign({}, settings, { scale }), pageW);
    pages = Math.max(1, Math.ceil(layout.totalWidth / pageW));
    maxTier = Math.round((layout.totalHeight - layout.axisY - 100) / layout.laneGap) || 1;
    iterations++;
  }

  // si, malgré tout, la hauteur dépasse une page A4, on réduit modérément
  // le texte (jamais sous 8px) plutôt que de laisser déborder verticalement
  let printSettings = Object.assign({}, settings, { scale });
  let fs = baseFontSize;
  while (layout.totalHeight > pageH && fs > 8) {
    fs -= 1;
    const ratio = fs / baseFontSize;
    printSettings = Object.assign({}, settings, {
      scale,
      fontSize: fs,
      laneGap: Math.max(28, Math.round((settings.laneGap || 58) * ratio))
    });
    layout = layoutHorizontal(events, printSettings, pageW);
  }

  const worldSvg = paintHorizontalWorld(layout, printSettings);
  const numPages = Math.max(1, Math.ceil(layout.totalWidth / pageW));

  for (let i = 0; i < numPages; i++) {
    const offsetX = i * pageW;
    const pageSvg = svgEl("svg", {
      viewBox: `${offsetX} 0 ${pageW} ${layout.totalHeight}`,
      width: pageW, height: Math.min(layout.totalHeight, pageH),
      class: "timeline-svg print-page-svg"
    });
    Array.from(worldSvg.children).forEach(child => pageSvg.appendChild(child.cloneNode(true)));
    const pageDiv = document.createElement("div");
    pageDiv.className = "print-page";
    pageDiv.appendChild(pageSvg);
    const caption = document.createElement("div");
    caption.className = "print-page-caption";
    caption.textContent = `Page ${i + 1} / ${numPages}`;
    pageDiv.appendChild(caption);
    container.appendChild(pageDiv);
  }
}

function renderSegmentsIntoText(textEl, segments, lineStr) {
  if (!segments || segments.length <= 1) { textEl.textContent = lineStr; return; }
  let remaining = lineStr;
  segments.forEach(seg => {
    if (!remaining.length) return;
    const chunkLen = Math.min(seg.text.length, remaining.length);
    const chunk = remaining.slice(0, chunkLen);
    remaining = remaining.slice(chunkLen);
    if (!chunk) return;
    const tspan = svgEl("tspan", {});
    if (seg.bold) tspan.setAttribute("font-weight", "700");
    if (seg.italic) tspan.setAttribute("font-style", "italic");
    if (seg.underline) tspan.setAttribute("text-decoration", "underline");
    tspan.textContent = chunk;
    textEl.appendChild(tspan);
  });
  if (remaining) textEl.appendChild(document.createTextNode(remaining));
}

// ---------------------------------------------------------------------------
// VUE VERTICALE — pensée mobile : espacement régulier (pas proportionnel au
// temps), extensible si le texte l'exige ; dates d'un côté, libellés de
// l'autre. Les périodes longent l'axe (barre verticale) au lieu d'une simple
// marque ponctuelle, de façon à couvrir visuellement les lignes concernées.
// ---------------------------------------------------------------------------
function renderVertical(container, events, settings) {
  container.innerHTML = "";
  if (!events.length) { container.innerHTML = '<p class="empty-hint">Aucun événement à afficher pour l’instant.</p>'; return; }

  const fontSize = settings.fontSize || 14;
  const baseGap = 40;
  const colWidth = Math.max(280, Math.min(container.clientWidth || 380, 480));
  const centerX = Math.round(colWidth / 2);
  const maxLabelWidth = Math.max(90, centerX - 46);

  const items = buildItems(events);

  let y = 30;
  const rows = items.map((it) => {
    const blocks = layoutSubBlocks(it, maxLabelWidth, fontSize);
    const textH = blocksHeight(blocks) + 22;
    const blockHeight = Math.max(baseGap, textH);
    const row = { it, y: y + blockHeight / 2, blocks, blockHeight };
    y += blockHeight;
    return row;
  });

  const totalHeight = y + 30;
  const svg = svgEl("svg", { viewBox: `0 0 ${colWidth} ${totalHeight}`, width: colWidth, height: totalHeight, class: "timeline-svg vertical" });

  // mapping année -> position y, par interpolation entre les lignes déjà
  // placées (permet de positionner la FIN d'une période même si elle ne
  // correspond à aucune ligne existante)
  function yForYear(year) {
    if (!rows.length) return 0;
    if (year <= rows[0].it.date.year) return rows[0].y;
    for (let i = 0; i < rows.length - 1; i++) {
      const r1 = rows[i], r2 = rows[i + 1];
      const y1v = r1.it.date.year, y2v = r2.it.date.year;
      if (year >= y1v && year <= y2v) {
        const span = (y2v - y1v) || 1;
        const t = (year - y1v) / span;
        return r1.y + t * (r2.y - r1.y);
      }
    }
    return rows[rows.length - 1].y;
  }

  // -- barres de période, dessinées en premier (sous les points/textes),
  // le long de l'axe, pour couvrir visuellement les lignes concernées --
  rows.forEach(r => {
    if (r.it.date.type !== "period") return;
    const endY = yForYear(r.it.date.yearEnd);
    const y1 = Math.min(r.y, endY), y2 = Math.max(r.y, endY);
    svg.appendChild(svgEl("rect", {
      x: centerX - 3, y: y1, width: 6, height: Math.max(6, y2 - y1),
      fill: r.it.color || "var(--accent)", opacity: 0.35, rx: 3
    }));
  });

  svg.appendChild(svgEl("line", { x1: centerX, y1: 10, x2: centerX, y2: totalHeight - 20, stroke: "var(--axis)", "stroke-width": 2 }));
  svg.appendChild(svgEl("polygon", { points: `${centerX},${totalHeight - 20} ${centerX - 7},${totalHeight - 34} ${centerX + 7},${totalHeight - 34}`, fill: "var(--axis)" }));

  rows.forEach(r => {
    const it = r.it;
    const color = it.color || "var(--accent)";
    const group = svgEl("g", {});

    if (!it.date.isDecadeLike) {
      group.appendChild(svgEl("circle", { cx: centerX, cy: r.y, r: 4.5, fill: color, stroke: "var(--bg)", "stroke-width": 1.5 }));
    } else {
      group.appendChild(svgEl("line", { x1: centerX, y1: r.y, x2: centerX + 14, y2: r.y, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "3,3" }));
    }

    const dateX = centerX + 16;
    const dateText = svgEl("text", { x: dateX, y: r.y + 4, "text-anchor": "start", class: "event-date" + (it.date.isApprox ? " approx" : ""), style: `fill:${color}` });
    dateText.textContent = it.dateDisplay;
    group.appendChild(dateText);

    const labelX = centerX - 16;
    const totalTextH = blocksHeight(r.blocks);
    const startY = r.y - totalTextH / 2 + fontSize / 2;
    drawStackedBlocks(group, r.blocks, labelX, startY, fontSize, "end", maxLabelWidth);

    svg.appendChild(group);
  });

  container.appendChild(svg);
}

function renderLegend(container, events, catColorMap) {
  container.innerHTML = "";
  const cats = {};
  events.forEach(e => { if (e.category) cats[e.category] = e.color; });
  const keys = Object.keys(cats);
  if (!keys.length) { container.style.display = "none"; return; }
  container.style.display = "flex";
  keys.forEach(k => {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `<span class="legend-swatch" style="background:${cats[k]}"></span><span>${k}</span>`;
    container.appendChild(item);
  });
}

window.TimelineRender = { renderHorizontal, renderVertical, renderLegend, buildItems, renderHorizontalPrintPages };

})();
