(function () {
"use strict";
/* ============================================================================
   app.js — orchestration de l'interface
   ========================================================================= */

// garde-fou : si ce script venait à être exécuté une deuxième fois dans la
// même page (rechargement partiel, service worker, outil de live-reload...),
// on n'initialise l'application qu'une seule fois pour éviter les écouteurs
// d'événements et les instances de base de données dupliqués.
if (window.__frisesAppBooted) {
  console.warn("app.js exécuté plusieurs fois : initialisation ignorée la 2e fois.");
  return;
}
window.__frisesAppBooted = true;


const { loadDB, saveDB, newTimeline, uid, exportTimeline, exportAll } = window.TimelineStorage;
const { parseTimelineText, sortRawText, canonicalizeAndSort, colorForCategory } = window.TimelineParser;
const { renderHorizontal, renderVertical, renderLegend, renderHorizontalPrintPages } = window.TimelineRender;

let db = loadDB();
let currentView = "horizontal"; // horizontal | vertical
let debounceTimer = null;
let categoryFilter = "";

const el = (id) => document.getElementById(id);

function activeTimeline() {
  return db.timelines.find(t => t.id === db.activeTimelineId) || null;
}

// ---------------------------------------------------------------------------
// Sidebar : dossiers + frises
// ---------------------------------------------------------------------------
function renderSidebar() {
  const container = el("folderList");
  container.innerHTML = "";
  db.folders.forEach(folder => {
    const folderEl = document.createElement("div");
    folderEl.className = "folder-block";

    const head = document.createElement("div");
    head.className = "folder-item";
    head.innerHTML = `<span>📁 ${escapeHtml(folder.name)}</span>`;
    const actions = document.createElement("span");
    if (db.folders.length > 1) {
      const del = document.createElement("button");
      del.className = "tiny-btn"; del.textContent = "✕"; del.title = "Supprimer ce dossier (les frises seront déplacées vers Général)";
      del.onclick = (ev) => { ev.stopPropagation(); deleteFolder(folder.id); };
      actions.appendChild(del);
    }
    head.appendChild(actions);
    head.ondragover = (ev) => { ev.preventDefault(); head.classList.add("dragover"); };
    head.ondragleave = () => head.classList.remove("dragover");
    head.ondrop = (ev) => {
      ev.preventDefault(); head.classList.remove("dragover");
      const tid = ev.dataTransfer.getData("text/plain");
      const t = db.timelines.find(x => x.id === tid);
      if (t) { t.folderId = folder.id; saveDB(db); renderSidebar(); }
    };
    folderEl.appendChild(head);

    db.timelines.filter(t => t.folderId === folder.id).forEach(t => {
      const item = document.createElement("div");
      item.className = "timeline-item" + (t.id === db.activeTimelineId ? " active" : "");
      item.draggable = true;
      item.ondragstart = (ev) => ev.dataTransfer.setData("text/plain", t.id);
      item.innerHTML = `<span class="tl-name">${escapeHtml(t.name)}</span>`;
      const del = document.createElement("button");
      del.className = "tiny-btn"; del.textContent = "✕"; del.title = "Supprimer";
      del.onclick = (ev) => { ev.stopPropagation(); deleteTimeline(t.id); };
      item.appendChild(del);
      item.onclick = () => selectTimeline(t.id);
      item.ondblclick = () => renameTimeline(t.id);
      folderEl.appendChild(item);
    });

    container.appendChild(folderEl);
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function deleteFolder(id) {
  const general = db.folders[0];
  db.timelines.forEach(t => { if (t.folderId === id) t.folderId = general.id; });
  db.folders = db.folders.filter(f => f.id !== id);
  saveDB(db); renderSidebar();
}

function deleteTimeline(id) {
  if (!confirm("Supprimer définitivement cette frise ?")) return;
  db.timelines = db.timelines.filter(t => t.id !== id);
  if (db.activeTimelineId === id) db.activeTimelineId = db.timelines[0] ? db.timelines[0].id : null;
  saveDB(db); renderSidebar(); loadActiveIntoEditor();
}

function renameTimeline(id) {
  const t = db.timelines.find(x => x.id === id);
  const name = prompt("Nouveau nom de la frise :", t.name);
  if (name && name.trim()) { t.name = name.trim(); saveDB(db); renderSidebar(); }
}

function selectTimeline(id) {
  db.activeTimelineId = id;
  saveDB(db);
  renderSidebar();
  loadActiveIntoEditor();
  closeMenu();
}

// ---------------------------------------------------------------------------
// Menu déroulant (déclenché par "✦ Frises")
// ---------------------------------------------------------------------------
function openMenu() { el("headerMenu").classList.add("open"); el("btnMenuToggle").classList.add("open"); }
function closeMenu() { el("headerMenu").classList.remove("open"); el("btnMenuToggle").classList.remove("open"); }
el("btnMenuToggle").onclick = (ev) => {
  ev.stopPropagation();
  el("headerMenu").classList.contains("open") ? closeMenu() : openMenu();
};
document.addEventListener("click", (ev) => {
  const menu = el("headerMenu");
  if (menu.classList.contains("open") && !menu.contains(ev.target) && ev.target !== el("btnMenuToggle")) closeMenu();
});

// ---------------------------------------------------------------------------
// Éditeur
// ---------------------------------------------------------------------------
function loadActiveIntoEditor() {
  const t = activeTimeline();
  const ta = el("editor");
  const opts = el("optionsPanel");
  if (!t) {
    ta.value = ""; ta.disabled = true;
    opts.style.opacity = 0.4;
    el("timelineNameLabel").textContent = "Aucune frise sélectionnée";
    renderViewFromEvents([], {});
    return;
  }
  ta.disabled = false;
  opts.style.opacity = 1;
  ta.value = t.rawText;
  el("timelineNameLabel").textContent = t.name;
  syncOptionInputs(t.settings);
  reparseAndRender();
}

function syncOptionInputs(settings) {
  el("optAllBC").checked = !!settings.allBC;
  el("optHideBC").checked = !!settings.hideBC;
  el("optAbbreviate").checked = !!settings.abbreviate;
  el("optSplitMulti").checked = !!settings.splitMultiEvents;
  el("optFontSize").value = settings.fontSize || 13;
  el("optLaneGap").value = settings.laneGap || 58;
  el("optMaxLabelWidth").value = settings.maxLabelWidth || 170;
  el("optGraduation").value = settings.graduationStep || "";

  // La case "tout convertir en av. J.-C." n'a de sens que si toutes les
  // dates saisies sont déjà après J.-C.
  const t = activeTimeline();
  const hasBC = /av\.?\s*j\.?-?\s*c\.?|(^|\s)-\d/i.test(t ? t.rawText : "");
  el("optAllBCWrap").style.display = hasBC ? "none" : "flex";
}

function currentSettings() {
  const t = activeTimeline();
  return t ? t.settings : {};
}

function reparseAndRender() {
  const t = activeTimeline();
  if (!t) return;
  const { events, warnings } = parseTimelineText(t.rawText, t.settings);
  populateCategoryFilter(events);
  const filtered = categoryFilter ? events.filter(e => e.category === categoryFilter) : events;
  renderViewFromEvents(filtered, t.settings);
  const wbox = el("warningsBox");
  if (warnings.length) {
    wbox.style.display = "block";
    wbox.innerHTML = warnings.map(w => `⚠ « ${escapeHtml(w.line)} » — ${w.reason}`).join("<br>");
  } else {
    wbox.style.display = "none";
  }
}

function populateCategoryFilter(events) {
  const sel = el("categoryFilter");
  const cats = Array.from(new Set(events.map(e => e.category).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const prev = sel.value;
  sel.innerHTML = '<option value="">Toutes les catégories</option>' +
    cats.map(c => `<option value="${escapeHtml(c)}">#${escapeHtml(c)}</option>`).join("");
  sel.value = cats.includes(prev) ? prev : "";
  categoryFilter = sel.value;
}
el("categoryFilter").addEventListener("change", () => {
  categoryFilter = el("categoryFilter").value;
  reparseAndRender();
});

function renderViewFromEvents(events, settings) {
  const canvas = el("canvas");
  if (currentView === "horizontal") renderHorizontal(canvas, events, settings);
  else renderVertical(canvas, events, settings);
  renderLegend(el("legendBar"), events, settings.catColors);
}

// saisie -> debounce -> reparse
el("editor").addEventListener("input", () => {
  const t = activeTimeline();
  if (!t) return;
  t.rawText = el("editor").value;
  t.updatedAt = Date.now();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { saveDB(db); reparseAndRender(); }, 250);
});

// reformatage canonique + retri chronologique à la sortie du champ (voir
// canonicalizeAndSort dans parser.js : séparateur uniformisé " : ", plus de
// date en fin de ligne entre parenthèses, "~" pour l'approximation, etc.)
el("editor").addEventListener("blur", () => {
  const t = activeTimeline();
  if (!t) return;
  const rebuilt = canonicalizeAndSort(t.rawText, t.settings);
  if (rebuilt !== t.rawText) {
    t.rawText = rebuilt;
    el("editor").value = rebuilt;
    saveDB(db);
  }
  reparseAndRender();
});

// ---------------------------------------------------------------------------
// Raccourcis clavier dans l'éditeur : Ctrl+B / Ctrl+I / Ctrl+U / Maj+Alt+K
// (le textarea étant du texte brut, on entoure la sélection des marqueurs)
// ---------------------------------------------------------------------------
function wrapSelection(ta, before, after) {
  const start = ta.selectionStart, end = ta.selectionEnd;
  const val = ta.value;
  const selected = val.slice(start, end);
  const already = val.slice(start - before.length, start) === before && val.slice(end, end + after.length) === after;
  let newVal, newStart, newEnd;
  if (already) {
    newVal = val.slice(0, start - before.length) + selected + val.slice(end + after.length);
    newStart = start - before.length; newEnd = end - before.length;
  } else {
    newVal = val.slice(0, start) + before + selected + after + val.slice(end);
    newStart = start + before.length; newEnd = end + before.length;
  }
  ta.value = newVal;
  ta.setSelectionRange(newStart, newEnd);
  ta.dispatchEvent(new Event("input"));
}

el("editor").addEventListener("keydown", (ev) => {
  const ta = ev.target;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === "b") { ev.preventDefault(); wrapSelection(ta, "**", "**"); }
  else if (mod && ev.key.toLowerCase() === "i") { ev.preventDefault(); wrapSelection(ta, "_", "_"); }
  else if (mod && ev.key.toLowerCase() === "u") { ev.preventDefault(); wrapSelection(ta, "++", "++"); }
  else if (ev.shiftKey && ev.altKey && ev.key.toLowerCase() === "k") {
    // insertion rapide du symbole d'approximation "~" devant le curseur
    ev.preventDefault();
    const start = ta.selectionStart;
    ta.value = ta.value.slice(0, start) + "~" + ta.value.slice(start);
    ta.setSelectionRange(start + 1, start + 1);
    ta.dispatchEvent(new Event("input"));
  }
});

el("btnBold").onclick = () => wrapSelection(el("editor"), "**", "**");
el("btnItalic").onclick = () => wrapSelection(el("editor"), "_", "_");
el("btnUnderline").onclick = () => wrapSelection(el("editor"), "++", "++");
el("btnApprox").onclick = () => {
  const ta = el("editor");
  const start = ta.selectionStart;
  ta.value = ta.value.slice(0, start) + "~" + ta.value.slice(start);
  ta.setSelectionRange(start + 1, start + 1);
  ta.dispatchEvent(new Event("input"));
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
function bindOption(id, prop, isNumber) {
  el(id).addEventListener("change", () => {
    const t = activeTimeline();
    if (!t) return;
    const raw = el(id).type === "checkbox" ? el(id).checked : el(id).value;
    t.settings[prop] = isNumber ? (raw === "" ? null : Number(raw)) : raw;
    saveDB(db);
    reparseAndRender();
  });
}
bindOption("optAllBC", "allBC");
bindOption("optHideBC", "hideBC");
bindOption("optAbbreviate", "abbreviate");
bindOption("optSplitMulti", "splitMultiEvents");
bindOption("optFontSize", "fontSize", true);
bindOption("optLaneGap", "laneGap", true);
bindOption("optMaxLabelWidth", "maxLabelWidth", true);
bindOption("optGraduation", "graduationStep", true);

// ---------------------------------------------------------------------------
// Vue horizontale / verticale / plein écran
// ---------------------------------------------------------------------------
el("tabHorizontal").onclick = () => { switchView("horizontal"); closeMenu(); };
el("tabVertical").onclick = () => { switchView("vertical"); closeMenu(); };
function switchView(v) {
  currentView = v;
  el("tabHorizontal").classList.toggle("active", v === "horizontal");
  el("tabVertical").classList.toggle("active", v === "vertical");
  reparseAndRender();
}

el("btnFullscreen").onclick = () => {
  closeMenu();
  const pane = el("viewPane");
  if (!document.fullscreenElement) pane.requestFullscreen?.();
  else document.exitFullscreen?.();
};

el("btnPrint").onclick = () => {
  closeMenu();
  const t = activeTimeline();
  const printContainer = el("printCanvas");
  if (t && currentView === "horizontal") {
    const { events } = parseTimelineText(t.rawText, t.settings);
    const filtered = categoryFilter ? events.filter(e => e.category === categoryFilter) : events;
    renderHorizontalPrintPages(printContainer, filtered, t.settings);
    document.body.classList.add("printing-paginated");
  } else {
    printContainer.innerHTML = "";
    document.body.classList.remove("printing-paginated");
  }
  window.print();
};

// ---------------------------------------------------------------------------
// Nouvelle frise / nouveau dossier
// ---------------------------------------------------------------------------
el("btnNewTimeline").onclick = () => {
  const folderId = db.folders[0].id;
  const t = newTimeline(folderId);
  db.timelines.push(t);
  db.activeTimelineId = t.id;
  saveDB(db);
  renderSidebar();
  loadActiveIntoEditor();
  closeMenu();
  el("editor").focus();
};

el("btnNewFolder").onclick = () => {
  const name = prompt("Nom du nouveau dossier :");
  if (name && name.trim()) {
    db.folders.push({ id: uid(), name: name.trim() });
    saveDB(db);
    renderSidebar();
  }
};

// ---------------------------------------------------------------------------
// Export / import JSON
// ---------------------------------------------------------------------------
el("btnExportOne").onclick = () => { const t = activeTimeline(); if (t) exportTimeline(t); };
el("btnExportAll").onclick = () => exportAll(db);

el("importFile").addEventListener("change", (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.folders && data.timelines) {
        // import complet : fusion (les id existants sont conservés, les nouveaux ajoutés)
        const existingIds = new Set(db.timelines.map(t => t.id));
        data.folders.forEach(f => { if (!db.folders.some(x => x.id === f.id)) db.folders.push(f); });
        data.timelines.forEach(t => { if (!existingIds.has(t.id)) db.timelines.push(t); });
      } else if (data.id && data.rawText !== undefined) {
        // import d'une frise unique
        data.id = uid(); // évite les collisions
        data.folderId = db.folders[0].id;
        db.timelines.push(data);
        db.activeTimelineId = data.id;
      } else {
        alert("Fichier JSON non reconnu.");
        return;
      }
      saveDB(db);
      renderSidebar();
      loadActiveIntoEditor();
    } catch (e) {
      alert("Impossible de lire ce fichier JSON : " + e.message);
    }
  };
  reader.readAsText(file);
  ev.target.value = "";
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------
window.addEventListener("resize", () => reparseAndRender());
window.addEventListener("orientationchange", () => setTimeout(reparseAndRender, 200));

if (!db.activeTimelineId && db.timelines.length) db.activeTimelineId = db.timelines[0].id;
renderSidebar();
loadActiveIntoEditor();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

})();
