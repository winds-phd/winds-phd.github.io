// Talks to the Google Apps Script backend (data lives in a Google Sheet in the supervisor's Drive).
// Provides sign-in helpers and a small live data layer used by every page.
import { API_URL } from "./config.js?v=20261109-2200";

export const configured = !String(API_URL).startsWith("PASTE_") && /^https:\/\//.test(API_URL);
const TOKEN_KEY = "phdlog.token";
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* storage blocked */ }
function saveToken(t) { token = t; try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }

async function call(action, payload = {}) {
  if (!configured) { const e = new Error("The site isn't connected to Google Drive yet."); e.code = "not-configured"; throw e; }
  let r;
  // text/plain keeps this a "simple" request, which Apps Script accepts from another website.
  try { r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action, token, ...payload }), redirect: "follow" }); }
  catch (e) { const err = new Error("Can't reach the server. Check your internet connection. If it keeps happening, the supervisor should check that the Google Apps Script is deployed with access for \"Anyone\"."); err.code = "network"; throw err; }
  let j; try { j = await r.json(); } catch (e) { const err = new Error("The server sent an unexpected reply. Check the Web app URL in assets/config.js and that it's deployed for \"Anyone\"."); err.code = "bad-reply"; throw err; }
  if (!j.ok) {
    const err = new Error(j.error || "Something went wrong."); err.code = j.code || "error";
    if (err.code === "unauthenticated") saveToken(null);
    throw err;
  }
  return j;
}

/* ---------- identity ---------- */
export function admKey(adm) { return String(adm || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
export function isSupervisor(u) { return !!u && u.role === "supervisor"; }
export function keyFromUser(u) { return u && u.role === "student" ? u.key : null; }
export async function currentUser() { if (!token) return null; try { return (await call("me")).user; } catch (e) { return null; } }
export const getStatus = () => call("status");
async function withSession(p) { const j = await p; saveToken(j.token); return j.user; }
export const setupSupervisor = (setupKey, email, password, name) => withSession(call("setup", { setupKey, email, password, name }));
/** One sign-in for everyone: an email means the supervisor, anything else is an admission number. */
export const signIn = (id, secret) => withSession(call("login", { id, secret }));
export const registerStudent = data => withSession(call("register", data));
export const resetStudentSecret = (key, secret) => call("resetSecret", { key, secret });
export const requestReset = id => call("forgot", { id });
export const resetWithToken = (token, secret) => withSession(call("resetWithToken", { token, secret }));
export async function signOut() { try { await call("logout"); } catch (e) { /* already signed out */ } saveToken(null); location.href = "index.html"; }
export function authMessage(e) { return (e && e.message) || "Something went wrong. Try again."; }

/* ---------- live data layer ----------
   Everything this person may see arrives in one "sync" call and is kept in a local cache.
   db.doc(path) / db.collection(path) read from that cache; changes go to the server and then re-sync. */
const cache = new Map();
let rev = null, synced = false, syncing = null, pollTimer = null;
const watchers = new Set();
const POLL_MS = 10000;

function emit() { for (const w of watchers) w.check(); }
let again = false;
async function sync() {
  if (syncing) { again = true; return syncing; }
  syncing = (async () => {
    try {
      const j = await call("sync", { rev });
      if (!j.unchanged) { cache.clear(); for (const d of j.docs) cache.set(d.path, d.data); rev = j.rev; applyPending(); }
      synced = true;
      for (const w of watchers) w.ok();
      emit();
    } catch (e) {
      if (e.code === "unauthenticated") { location.href = "index.html"; return; }
      for (const w of watchers) w.fail(e);
    } finally { syncing = null; if (again) { again = false; sync(); } }
  })();
  return syncing;
}
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { if (!document.hidden) sync(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
}
function subscribe(view, next, err) {
  let last;
  const w = {
    failed: false,
    check() { if (!synced) return; const v = view(); const s = JSON.stringify(v.key); if (s !== last) { last = s; next(v.snap); } },
    ok() { w.failed = false; },
    fail(e) { if (!w.failed && err) err(e); w.failed = true; }
  };
  watchers.add(w); startPolling();
  if (synced) setTimeout(() => w.check(), 0); else sync();
  return () => watchers.delete(w);
}
const meta = { fromCache: false, hasPendingWrites: false };
function docSnap(path) { const d = cache.get(path); return { id: path.split("/").pop(), exists: d !== undefined, data: () => d, metadata: meta }; }
function childrenOf(col) {
  const depth = col.split("/").length + 1, out = [];
  for (const [p, d] of cache) if (p.startsWith(col + "/") && p.split("/").length === depth) out.push({ id: p.split("/").pop(), path: p, d });
  return out.sort((a, b) => a.id < b.id ? -1 : 1);
}
/* Saving: the change shows on screen at once ("optimistic"), then goes to the server.
   Until the server confirms it, a background refresh can't make it disappear. */
const pending = new Map();   // path -> { op: "put", data } | { op: "del" }
function applyPending() {
  for (const [p, x] of pending) {
    if (x.op === "put") cache.set(p, x.data);
    else { cache.delete(p); for (const k of [...cache.keys()]) if (k.startsWith(p + "/")) cache.delete(k); }
  }
}
async function change(action, payload, paths) {
  const mine = Symbol();
  for (const [p, x] of paths) pending.set(p, { ...x, mine });
  applyPending(); emit();
  try {
    const j = await call(action, payload);
    // Nothing else changed on the server in between: our copy is now exactly the server's, no reload needed.
    if (j.prevRev && j.prevRev === rev) rev = j.rev; else { rev = null; }
    return j;
  } catch (e) {
    rev = null;   // undo: fetch the true state again
    throw e;
  } finally {
    for (const [p] of paths) if (pending.get(p) && pending.get(p).mine === mine) pending.delete(p);
    if (rev === null) sync(); else emit();
  }
}
function newId() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

export const db = {
  doc(path) {
    return {
      id: path.split("/").pop(), path,
      get: async () => { if (synced) return docSnap(path); const j = await call("get", { path }); return { id: path.split("/").pop(), exists: j.exists, data: () => j.data, metadata: meta }; },
      set: data => change("set", { path, data }, [[path, { op: "put", data: structuredClone(data) }]]),
      update: data => change("update", { path, data }, [[path, { op: "put", data: { ...(cache.get(path) || {}), ...structuredClone(data) } }]]),
      delete: () => change("delete", { path }, [[path, { op: "del" }]]),
      onSnapshot: (next, err) => subscribe(() => ({ key: cache.get(path) ?? null, snap: docSnap(path) }), next, err)
    };
  },
  collection(path) {
    return {
      path,
      add: async data => { const id = newId(); await change("add", { path, id, data }, [[path + "/" + id, { op: "put", data: structuredClone(data) }]]); return { id }; },
      onSnapshot: (next, err) => subscribe(() => {
        const kids = childrenOf(path);
        const docs = kids.map(k => ({ id: k.id, exists: true, data: () => k.d, metadata: meta }));
        return { key: kids.map(k => [k.id, k.d]), snap: { docs, size: docs.length, empty: !docs.length, metadata: meta } };
      }, next, err)
    };
  }
};

/** Shown when assets/config.js still has the placeholder URL. */
export function setupNotice(el) {
  el.innerHTML = "";
  const box = document.createElement("div"); box.className = "empty";
  const h = document.createElement("h3"); h.textContent = "Not connected to Google Drive yet";
  const p = document.createElement("p"); p.textContent = "Paste your Google Apps Script Web app URL into assets/config.js, commit it, and reload. README.md has the steps.";
  box.append(h, p); el.append(box);
}
