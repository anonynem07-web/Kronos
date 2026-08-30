(function () {
"use strict";
/* ============================================================================
   storage.js — persistance locale (localStorage) : dossiers + frises
   ========================================================================= */

const DB_KEY = "frises_db_v1";

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return freshDB();
    const db = JSON.parse(raw);
    if (!db.folders || !db.timelines) return freshDB();
    return db;
  } catch (e) {
    console.error("Lecture du stockage impossible :", e);
    return freshDB();
  }
}

function freshDB() {
  const generalId = uid();
  return {
    folders: [{ id: generalId, name: "Général" }],
    timelines: [],
    activeTimelineId: null
  };
}

function saveDB(db) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    return true;
  } catch (e) {
    console.error("Écriture du stockage impossible :", e);
    return false;
  }
}

function newTimeline(folderId, name = "Nouvelle frise") {
  return {
    id: uid(),
    folderId,
    name,
    rawText: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: {
      allBC: false,
      hideBC: false,
      abbreviate: false,
      splitMultiEvents: false,
      scale: null,
      graduationStep: null,
      fontSize: 13,
      laneGap: 58,
      maxLabelWidth: 170,
      catColors: {}
    }
  };
}

function exportTimeline(t) {
  const blob = new Blob([JSON.stringify(t, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(t.name || "frise").replace(/[^\w\-À-ÿ ]/g, "_")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportAll(db) {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `frises_export_complet.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

window.TimelineStorage = { loadDB, saveDB, freshDB, newTimeline, uid, exportTimeline, exportAll };

})();
