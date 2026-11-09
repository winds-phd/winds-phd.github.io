/**
 * WiNDS Lab Research Tracking — backend for the GitHub Pages site.
 *
 * Stores everything in a Google Sheet in YOUR Google Drive ("WiNDS Lab Research Tracking — data").
 * The website (on GitHub Pages) talks to this script; students never need Google accounts.
 *
 * One-time setup (details in README.md):
 *   1. Paste this file into a new Apps Script project (script.google.com).
 *   2. Run  init  once (Run ▶). Approve access. The log shows your SETUP KEY.
 *   3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → copy the URL.
 *   4. Put that URL in assets/config.js on the website.
 *
 * Forgot a password? Use "Forgot?" on the sign-in page: a reset link is emailed (data is kept).
 * Email notifications (feedback, meeting reminders, due dates): run  setupNotifications  once.
 * Last resort for the supervisor: run  newSetupKey  and do the supervisor sign-up again on the site.
 */

const DEFAULT_CLASS_CODE = "67890";
const SITE_URL = "https://winds-phd.github.io/";   // reset links in emails point here
const RESET_MINUTES = 60;                           // how long an emailed reset link works
const TZ = "Asia/Kolkata";                          // all dates and times on the site are Indian time
const MEETING_NOTICE_MIN = 17;                      // with a 5-minute check, the email lands about 15 minutes before
const DUE_REMINDER_HOUR = 9;                        // task due-date reminders go out from 9 AM the day before
const AUTO_REMARKS = ["Task assigned", "Assigned in meeting", "Paper added", "Marked as done", "Marked as not done by supervisor"];
const SESSION_DAYS = 14;
const HASH_ROUNDS = 1000;
const MAX_DOC_CHARS = 45000;           // a Google Sheets cell holds up to 50,000 characters
const SEGMENT = /^[A-Za-z0-9_.\-]{1,120}$/;

/* ================================================================ setup (run from the editor) */

function init() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const id = props.getProperty("SHEET_ID");
  if (id) ss = SpreadsheetApp.openById(id);
  else { ss = SpreadsheetApp.create("WiNDS Lab Research Tracking — data"); props.setProperty("SHEET_ID", ss.getId()); }
  ensureSheet_(ss, "users", ["login", "role", "name", "salt", "hash", "created"]);
  ensureSheet_(ss, "sessions", ["tokenHash", "login", "expires"]);
  ensureSheet_(ss, "docs", ["path", "parent", "data", "updated"]);
  const extra = ss.getSheetByName("Sheet1"); if (extra && ss.getSheets().length > 1) ss.deleteSheet(extra);
  if (!getDoc_("private/join")) putDoc_("private/join", { code: DEFAULT_CLASS_CODE, updatedAt: Date.now() });
  bumpRev_();
  if (!supervisorExists_() && !props.getProperty("SETUP_KEY")) props.setProperty("SETUP_KEY", randomCode_(10));
  Logger.log("Data sheet: " + ss.getUrl());
  if (!supervisorExists_()) Logger.log("SETUP KEY (needed once to create the supervisor account on the site): " + props.getProperty("SETUP_KEY"));
  else Logger.log("Supervisor account already exists. Run newSetupKey if you need to replace it.");
}

/** Replaces the supervisor login (e.g. forgotten password). All data is kept. */
function newSetupKey() {
  const props = PropertiesService.getScriptProperties();
  const sh = sheet_("users"), v = sh.getDataRange().getValues();
  for (let r = v.length - 1; r >= 1; r--) if (v[r][1] === "supervisor") sh.deleteRow(r + 1);
  usersChanged_();
  props.setProperty("SETUP_KEY", randomCode_(10));
  Logger.log("Supervisor login removed. Open the site and create it again with SETUP KEY: " + props.getProperty("SETUP_KEY"));
}

function ensureSheet_(ss, name, header) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(header);
  sh.getRange(1, 1, sh.getMaxRows(), header.length).setNumberFormat("@");   // keep everything as plain text
  sh.setFrozenRows(1);
}

/* ================================================================ web app entry points */

function doGet() {
  return ContentService.createTextOutput("WiNDS Lab Research Tracking backend is running. Open the website to use it.");
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    out = Object.assign({ ok: true }, handle_(req));
  } catch (err) {
    if (err && err.apiCode) out = { ok: false, code: err.apiCode, error: err.message };
    else { console.error(err && err.stack || err); out = { ok: false, code: "internal", error: "Something went wrong on the server. Try again." }; }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) { const e = new Error(message); e.apiCode = code; throw e; }

const WRITE_ACTIONS = { resetWithToken: 1, setup: 1, register: 1, resetSecret: 1, set: 1, update: 1, delete: 1, add: 1, login: 1, logout: 1 };

function handle_(req) {
  const action = String(req.action || "");
  let lock = null;
  if (WRITE_ACTIONS[action]) { lock = LockService.getScriptLock(); lock.waitLock(25000); }
  try { return dispatch_(action, req); }
  finally { if (lock) { SpreadsheetApp.flush(); lock.releaseLock(); } }
}

function dispatch_(action, req) {
  switch (action) {
    case "status": return { setupNeeded: !supervisorExists_() };

    case "setup": {
      if (supervisorExists_()) fail_("already-exists", "A supervisor account already exists.");
      const key = PropertiesService.getScriptProperties().getProperty("SETUP_KEY");
      if (!key || String(req.setupKey || "").trim() !== key) fail_("permission-denied", "That setup key isn't right. It is shown in the Apps Script log after running init.");
      const email = String(req.email || "").trim().toLowerCase(), pw = String(req.password || "");
      if (email.indexOf("@") < 1 || pw.length < 8) fail_("invalid-argument", "Enter a valid email and a password of at least 8 characters.");
      createUser_(email, "supervisor", String(req.name || "Supervisor").trim().slice(0, 80), pw);
      PropertiesService.getScriptProperties().deleteProperty("SETUP_KEY");
      return newSession_(findUser_(email));
    }

    case "login": {
      const ident = String(req.id || "").trim(), secret = String(req.secret || "");
      const login = ident.indexOf("@") >= 0 ? ident.toLowerCase() : "student:" + admKey_(ident);
      if (tooMany_(login)) fail_("too-many-requests", "Too many attempts. Wait 10 minutes and try again.");
      const u = findUser_(login);
      if (!u || hashSecret_(secret, u.salt) !== u.hash) {
        noteFailure_(login);
        fail_("invalid-credential", "Those details don't match an account. Check your admission number (or email) and password.");
      }
      return newSession_(u);
    }

    case "logout": { if (req.token) endSession_(req.token); return {}; }

    case "me": return { user: publicUser_(requireUser_(req)) };

    case "register": {
      const adm = String(req.adm || "").trim(), key = admKey_(adm), name = String(req.name || "").trim().slice(0, 80);
      const login = "student:" + key;
      if (tooMany_("reg:" + key)) fail_("too-many-requests", "Too many attempts. Wait 10 minutes and try again.");
      const lab = getDoc_("private/join") || {};
      if (!lab.code || String(req.code || "").trim() !== String(lab.code)) { noteFailure_("reg:" + key); fail_("wrong-code", "That lab code isn't right. Ask your supervisor for the WiNDS Lab code."); }
      if (key.length < 3 || !SEGMENT.test(key)) fail_("invalid-argument", "Check your admission number.");
      if (String(req.secret || "").length < 6) fail_("invalid-argument", "Your password must be at least 6 characters.");
      if (!name) fail_("invalid-argument", "Enter your name.");
      const email = String(req.email || "").trim().toLowerCase().slice(0, 120);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail_("invalid-argument", "Enter a valid email address. It's used if you ever forget your password.");
      if (findUser_(login)) fail_("already-exists", "This admission number is already registered. Sign in, or ask your supervisor to reset your password.");
      createUser_(login, "student", name, String(req.secret));
      if (!getDoc_("students/" + key)) {
        putDoc_("students/" + key, {
          name: name, email: email, admissionNo: adm.toUpperCase().slice(0, 40), topic: String(req.topic || "").trim().slice(0, 200),
          year: String(req.year || "").slice(0, 4), stage: String(req.stage || "").slice(0, 60), createdAt: Date.now()
        });
        bumpRev_();
      }
      return newSession_(findUser_(login));
    }

    case "forgot": {
      // Always answer the same way, so nobody can find out which admission numbers or emails exist.
      const ident = String(req.id || "").trim();
      const login = ident.indexOf("@") >= 0 ? ident.toLowerCase() : "student:" + admKey_(ident);
      const u = findUser_(login);
      const cache = CacheService.getScriptCache(), rk = "m:" + login, sent = Number(cache.get(rk) || 0);
      if (u && sent < 3) {
        const to = u.role === "supervisor" ? u.login : String((getDoc_("students/" + login.slice(8)) || {}).email || "").trim();
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
          const token = Utilities.getUuid() + Utilities.getUuid();
          cache.put("r:" + sha_(token), login, RESET_MINUTES * 60);
          cache.put(rk, String(sent + 1), 3600);
          const link = SITE_URL + "reset.html?t=" + encodeURIComponent(token);
          const who = "password";
          MailApp.sendEmail({
            to: to, name: "WiNDS Lab Research Tracking",
            subject: "Reset your WiNDS Lab Research Tracking " + who,
            body: "Hello " + (u.name || "") + ",\n\nSomeone asked to reset the " + who + " for your WiNDS Lab Research Tracking account. Open this link within " + RESET_MINUTES + " minutes to choose a new one:\n\n" + link +
                  "\n\nYour tasks, papers and meetings are not affected.\nIf you didn't ask for this, ignore this email; nothing changes.",
            htmlBody: "<p>Hello " + escapeHtml_(u.name || "") + ",</p><p>Someone asked to reset the " + who + " for your <b>WiNDS Lab Research Tracking</b> account. Open this link within " + RESET_MINUTES + " minutes to choose a new one:</p>" +
                      "<p><a href=\"" + link + "\" style=\"display:inline-block;padding:10px 16px;background:#1f5f6b;color:#fff;border-radius:6px;text-decoration:none\">Choose a new " + who + "</a></p>" +
                      "<p>Your tasks, papers and meetings are not affected.<br>If you didn't ask for this, ignore this email; nothing changes.</p>"
          });
        }
      }
      return {};
    }

    case "resetWithToken": {
      const th = sha_(String(req.token || "")), cache = CacheService.getScriptCache();
      const login = req.token ? cache.get("r:" + th) : null;
      const u = login ? findUser_(login) : null;
      if (!u) fail_("expired", "This reset link has expired or was already used. Ask for a new one.");
      const secret = String(req.secret || ""), min = u.role === "supervisor" ? 8 : 6;
      if (secret.length < min) fail_("invalid-argument", "Choose at least " + min + " characters.");
      setSecret_(u.login, secret);
      cache.remove("r:" + th);   // a link works once
      return newSession_(findUser_(u.login));
    }

    case "resetSecret": {
      const u = requireUser_(req);
      if (u.role !== "supervisor") fail_("permission-denied", "Only the supervisor can reset passwords.");
      const secret = String(req.secret || "");
      if (secret.length < 6) fail_("invalid-argument", "The new password must be at least 6 characters.");
      const login = "student:" + admKey_(req.key);
      if (!findUser_(login)) fail_("not-found", "That student has no login yet. They can register on the registration page.");
      setSecret_(login, secret);
      return {};
    }

    case "sync": {
      const u = requireUser_(req);
      const rev = currentRev_();
      if (req.rev && req.rev === rev) return { unchanged: true, rev: rev };
      const docs = loadDocs_().list.filter(d => canSee_(u, d.path.split("/")));
      return { rev: rev, docs: docs.map(d => ({ path: d.path, data: d.data })) };
    }

    case "get": {
      const u = requireUser_(req), segs = docPath_(req.path);
      if (!canSee_(u, segs)) fail_("permission-denied", "You don't have access to this record.");
      const d = getDoc_(segs.join("/"));
      return { exists: !!d, data: d || null };
    }

    case "set": case "update": {
      const u = requireUser_(req), segs = docPath_(req.path), path = segs.join("/");
      if (!canSee_(u, segs)) fail_("permission-denied", "You don't have access to this record.");
      let data = req.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) fail_("invalid-argument", "A record must be an object.");
      const cur = getDoc_(path), prevRev = currentRev_();
      if (segs[0] === "conferences" && u.role !== "supervisor" && cur && cur.createdBy !== u.login) fail_("permission-denied", "You can only change conference entries you added.");
      if (action === "update") { if (!cur) fail_("not-found", "That record no longer exists."); data = Object.assign({}, cur, data); }
      putDoc_(path, data); const rev = bumpRev_();
      if (u.role === "supervisor" && segs[0] === "students" && segs.length === 4 && (segs[2] === "tasks" || segs[2] === "papers")) safely_(() => notifyFeedback_(segs[1], segs[2], cur, data));
      return { prevRev: prevRev, rev: rev };
    }

    case "delete": {
      const u = requireUser_(req), segs = docPath_(req.path), path = segs.join("/");
      if (!canSee_(u, segs)) fail_("permission-denied", "You don't have access to this record.");
      if (u.role === "student" && segs[0] === "students" && segs.length === 2) fail_("permission-denied", "Only the supervisor can remove a student.");
      if (u.role === "student" && segs[0] === "students" && segs[2] === "tasks") fail_("permission-denied", "Only the supervisor can delete tasks.");
      if (segs[0] === "conferences" && u.role !== "supervisor" && (getDoc_(path) || {}).createdBy !== u.login) fail_("permission-denied", "You can only remove conference entries you added.");
      const prevRev = currentRev_();
      deleteDoc_(path);
      if (u.role === "supervisor" && segs.length === 2 && segs[0] === "students") {
        deletePrefix_(path + "/");
        deleteUser_("student:" + segs[1]);
      }
      return { prevRev: prevRev, rev: bumpRev_() };
    }

    case "add": {
      const u = requireUser_(req), segs = colPath_(req.path);
      if (!canSee_(u, segs)) fail_("permission-denied", "You don't have access to these records.");
      const data = req.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) fail_("invalid-argument", "A record must be an object.");
      if (segs[0] === "conferences") data.createdBy = u.login;   // record who added it, so only they (or the supervisor) can remove it
      const want = String(req.id || "");
      const id = SEGMENT.test(want) && want.length <= 40 ? want : Utilities.getUuid().replace(/-/g, "").slice(0, 20);
      if (getDoc_(segs.join("/") + "/" + id)) return { id: id, prevRev: currentRev_(), rev: currentRev_() };   // already saved: a repeated click or retry
      const prevRev = currentRev_();
      putDoc_(segs.join("/") + "/" + id, data); const rev = bumpRev_();
      if (u.role === "supervisor" && segs[0] === "students" && segs[2] === "meetings") safely_(() => notifyMeeting_(segs[1], data));
      return { id: id, prevRev: prevRev, rev: rev };
    }
  }
  fail_("invalid-argument", "Unknown action.");
}

/* ================================================================ access rules */

/** Supervisor: everything. Student: only students/<their admission key> and what's under it,
 *  plus the shared "conferences" list, which everyone in the group can read and add to. */
function canSee_(u, segs) {
  if (u.role === "supervisor") return true;
  if (segs[0] === "conferences") return true;
  return segs.length >= 2 && segs[0] === "students" && segs[1] === u.login.slice("student:".length);
}
function splitPath_(p) {
  const segs = String(p || "").replace(/^\/+|\/+$/g, "").split("/");
  if (!segs.length || !segs.every(s => SEGMENT.test(s) && s !== "." && s !== "..")) fail_("invalid-argument", "Invalid path.");
  return segs;
}
function docPath_(p) { const s = splitPath_(p); if (s.length % 2) fail_("invalid-argument", "A record path needs an even number of parts."); return s; }
function colPath_(p) { const s = splitPath_(p); if (!(s.length % 2)) fail_("invalid-argument", "A list path needs an odd number of parts."); return s; }

/* ================================================================ storage: the "docs" sheet */

let DOCS_ = null, SS_ = null, SHEETS_ = {};
function sheet_(name) {
  if (SHEETS_[name]) return SHEETS_[name];
  if (!SS_) {
    const id = PropertiesService.getScriptProperties().getProperty("SHEET_ID");
    if (!id) fail_("not-set-up", "The backend isn't set up yet. Run init in the Apps Script editor.");
    SS_ = SpreadsheetApp.openById(id);
  }
  return (SHEETS_[name] = SS_.getSheetByName(name));
}
function loadDocs_() {
  if (DOCS_) return DOCS_;
  const v = sheet_("docs").getDataRange().getValues(), list = [], index = {};
  for (let r = 1; r < v.length; r++) {
    if (!v[r][0]) continue;
    let data; try { data = JSON.parse(v[r][2]); } catch (e) { continue; }
    const d = { path: String(v[r][0]), data: data, row: r + 1 };
    index[d.path] = d; list.push(d);
  }
  DOCS_ = { list: list, index: index };
  return DOCS_;
}
function getDoc_(path) { const d = loadDocs_().index[path]; return d ? d.data : null; }
function putDoc_(path, data) {
  const json = JSON.stringify(data);
  if (json.length > MAX_DOC_CHARS) fail_("invalid-argument", "That entry is too long to save. Shorten the text (for example the abstract or notes).");
  const sh = sheet_("docs"), parent = path.slice(0, path.lastIndexOf("/")), existing = loadDocs_().index[path];
  const row = [path, parent, json, new Date().toISOString()];
  if (existing) { sh.getRange(existing.row, 1, 1, 4).setValues([row]); existing.data = data; }
  else { sh.appendRow(row); DOCS_ = null; }
}
function deleteDoc_(path) {
  const d = loadDocs_().index[path];
  if (d) { sheet_("docs").deleteRow(d.row); DOCS_ = null; }
}
function deletePrefix_(prefix) {
  const rows = loadDocs_().list.filter(d => d.path.indexOf(prefix) === 0).map(d => d.row).sort((a, b) => b - a);
  const sh = sheet_("docs");
  rows.forEach(r => sh.deleteRow(r));
  DOCS_ = null;
}
function currentRev_() { return PropertiesService.getScriptProperties().getProperty("REV") || "0"; }
function bumpRev_() { const r = Date.now() + "-" + Math.floor(Math.random() * 1e6); PropertiesService.getScriptProperties().setProperty("REV", r); return r; }

/* ================================================================ accounts and sessions */

function admKey_(adm) { return String(adm || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function escapeHtml_(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function hex_(bytes) { return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join(""); }
function sha_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function hashSecret_(secret, salt) { let h = salt + ":" + secret; for (let i = 0; i < HASH_ROUNDS; i++) h = sha_(h + ":" + salt); return h; }
function randomCode_(n) { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }

let USERS_ = null;
function users_() {
  if (USERS_) return USERS_;
  const cache = CacheService.getScriptCache(), hit = cache.get("users");
  if (hit) { try { return (USERS_ = JSON.parse(hit)); } catch (e) { /* rebuild */ } }
  const v = sheet_("users").getDataRange().getValues(), out = [];
  for (let r = 1; r < v.length; r++) if (v[r][0]) out.push({ login: String(v[r][0]), role: v[r][1], name: v[r][2], salt: String(v[r][3]), hash: String(v[r][4]), row: r + 1 });
  const json = JSON.stringify(out);
  if (json.length < 90000) cache.put("users", json, 600);
  return (USERS_ = out);
}
function usersChanged_() { USERS_ = null; CacheService.getScriptCache().remove("users"); }
function findUser_(login) { return users_().filter(u => u.login === login)[0] || null; }
function supervisorExists_() { try { return users_().some(u => u.role === "supervisor"); } catch (e) { return false; } }
function createUser_(login, role, name, secret) {
  const salt = Utilities.getUuid().replace(/-/g, "");
  sheet_("users").appendRow([login, role, name, salt, hashSecret_(secret, salt), new Date().toISOString()]);
  usersChanged_();
}
function setSecret_(login, secret) {
  const u = findUser_(login), salt = Utilities.getUuid().replace(/-/g, "");
  sheet_("users").getRange(u.row, 4, 1, 2).setValues([[salt, hashSecret_(secret, salt)]]);
  usersChanged_();
  endSessionsFor_(login);
}
function deleteUser_(login) {
  const u = findUser_(login);
  if (u) { sheet_("users").deleteRow(u.row); usersChanged_(); }
  endSessionsFor_(login);
}
function publicUser_(u) {
  return { uid: u.login, role: u.role, key: u.role === "student" ? u.login.slice(8) : null, displayName: u.name || "", email: u.role === "supervisor" ? u.login : null };
}
function newSession_(u) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  const expires = Date.now() + SESSION_DAYS * 864e5;
  const sh = sheet_("sessions");
  sh.appendRow([sha_(token), u.login, String(expires)]);
  cleanSessions_(sh);
  return { token: token, user: publicUser_(u) };
}
function cleanSessions_(sh) {
  const v = sh.getDataRange().getValues(), now = Date.now();
  for (let r = v.length - 1; r >= 1; r--) if (Number(v[r][2]) < now) sh.deleteRow(r + 1);
}
function requireUser_(req) {
  const token = String(req.token || "");
  if (!token) fail_("unauthenticated", "Please sign in again.");
  const th = sha_(token), cache = CacheService.getScriptCache();
  let login = cache.get("s:" + th);
  if (!login) {
    const v = sheet_("sessions").getDataRange().getValues(), now = Date.now();
    for (let r = 1; r < v.length; r++) if (v[r][0] === th && Number(v[r][2]) > now) { login = String(v[r][1]); break; }
    if (login) cache.put("s:" + th, login, 1800);
  }
  const u = login ? findUser_(login) : null;
  if (!u) fail_("unauthenticated", "Please sign in again.");
  return u;
}
function endSession_(token) {
  const th = sha_(token), sh = sheet_("sessions"), v = sh.getDataRange().getValues();
  for (let r = v.length - 1; r >= 1; r--) if (v[r][0] === th) sh.deleteRow(r + 1);
  CacheService.getScriptCache().remove("s:" + th);
}
function endSessionsFor_(login) {
  const sh = sheet_("sessions"), v = sh.getDataRange().getValues(), cache = CacheService.getScriptCache();
  for (let r = v.length - 1; r >= 1; r--) if (v[r][1] === login) { cache.remove("s:" + v[r][0]); sh.deleteRow(r + 1); }
}

/* ================================================================ brute-force guard */

function tooMany_(id) { return Number(CacheService.getScriptCache().get("f:" + id) || 0) >= 10; }
function noteFailure_(id) { const c = CacheService.getScriptCache(), k = "f:" + id; c.put(k, String(Number(c.get(k) || 0) + 1), 600); }


/* ================================================================ email notifications
 *  • Feedback: sent the moment the supervisor saves a remark on a task or paper, or logs a meeting.
 *  • Meetings: one email about 15 minutes before each scheduled meeting (students and supervisor).
 *  • Due dates: one email the day before a task is due (from 9 AM), to whoever the task belongs to.
 *  Emails go to students' recovery emails and to the supervisor's sign-in email.
 *  Switch on the timed part once by running  setupNotifications  in the editor.
 */

function setupNotifications() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === "sendScheduledEmails") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendScheduledEmails").timeBased().everyMinutes(5).create();
  Logger.log("Notifications are on: meeting reminders and task due-date reminders are checked every 5 minutes.");
  Logger.log("Emails left today on this account: " + MailApp.getRemainingDailyQuota());
}

/** Sends a test email to the supervisor, to check that emails arrive (look in spam the first time). */
function sendTestEmail() {
  const to = supervisorEmail_();
  if (!to) { Logger.log("No supervisor account yet."); return; }
  sendMail_(to, "Test email", "Supervisor", ["Email notifications from WiNDS Lab Research Tracking are working."], null);
  Logger.log("Test email sent to " + to);
}

function safely_(fn) { try { fn(); } catch (e) { console.error("notification failed: " + (e && e.stack || e)); } }
function isSupEntry_(x) { return x && (x.byRole === "supervisor" || x.byName === "Supervisor"); }
function supervisorEmail_() { const u = users_().filter(x => x.role === "supervisor")[0]; return u ? u.login : ""; }
function studentEmail_(key) { const e = String((getDoc_("students/" + key) || {}).email || "").trim(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : ""; }
function studentName_(key) { return (getDoc_("students/" + key) || {}).name || "Student"; }

function sendMail_(to, subject, greetingName, lines, button) {
  if (!to) return false;
  if (MailApp.getRemainingDailyQuota() < 1) { console.warn("Daily email limit reached; skipped: " + subject); return false; }
  const text = "Hello " + greetingName + ",\n\n" + lines.join("\n") + (button ? "\n\n" + button.text + ": " + button.url : "") + "\n\n— WiNDS Lab Research Tracking";
  const html = "<p>Hello " + escapeHtml_(greetingName) + ",</p>" + lines.map(l => "<p style=\"margin:0 0 8px\">" + escapeHtml_(l).replace(/\n/g, "<br>") + "</p>").join("") +
    (button ? "<p style=\"margin-top:16px\"><a href=\"" + button.url + "\" style=\"display:inline-block;padding:10px 16px;background:#1f5f6b;color:#fff;border-radius:6px;text-decoration:none\">" + escapeHtml_(button.text) + "</a></p>" : "") +
    "<p style=\"color:#5b686e;font-size:12px;margin-top:20px\">WiNDS Lab Research Tracking</p>";
  MailApp.sendEmail({ to: to, name: "WiNDS Lab Research Tracking", subject: subject, body: text, htmlBody: html });
  return true;
}
const STUDENT_LINK_ = () => ({ text: "Open my page", url: SITE_URL + "student-login.html" });
const SUP_LINK_ = () => ({ text: "Open dashboard", url: SITE_URL + "supervisor-login.html" });

/** New supervisor remarks on a task or paper (not those made through a meeting log, which has its own email). */
function notifyFeedback_(key, kind, before, after) {
  const old = (before && before.history || []).length;
  const fresh = (after.history || []).slice(old).filter(x => isSupEntry_(x) && x.remark && AUTO_REMARKS.indexOf(x.remark) < 0 && x.via !== "meeting");
  if (!fresh.length) return;
  const to = studentEmail_(key); if (!to) return;
  const what = kind === "tasks" ? "task" : "paper";
  const lines = ["Your supervisor added feedback on your " + what + " \"" + (after.title || "") + "\":"]
    .concat(fresh.map(x => "“" + x.remark + "”" + (x.status ? "  (status: " + (x.status === "Currently writing" ? "Draft" : x.status) + (kind === "tasks" ? ", " + (x.progress || 0) + "%" : "") + ")" : "")));
  sendMail_(to, "Supervisor feedback on your " + what + ": " + (after.title || ""), studentName_(key), lines, STUDENT_LINK_());
}

/** A meeting logged by the supervisor: notes, task-wise and paper-wise remarks, new tasks. */
function notifyMeeting_(key, m) {
  const remarks = (m.updates || []).filter(u => u.remark).map(u => "• " + u.title + ": " + u.remark)
    .concat((m.paperUpdates || []).filter(u => u.remark).map(u => "• " + u.title + ": " + u.remark));
  const newTasks = (m.newTasks || []).map(t => "• " + t.title + (t.due ? " (due " + t.due + ")" : ""));
  if (!m.notes && !remarks.length && !newTasks.length) return;
  const to = studentEmail_(key); if (!to) return;
  const lines = ["Your supervisor recorded the meeting of " + m.date + "."];
  if (m.notes) lines.push("Notes:\n" + m.notes);
  if (remarks.length) lines.push("Feedback:\n" + remarks.join("\n"));
  if (newTasks.length) lines.push("New tasks:\n" + newTasks.join("\n"));
  if (m.next) lines.push("Next meeting: " + m.next);
  sendMail_(to, "Meeting notes and feedback (" + m.date + ")", studentName_(key), lines, STUDENT_LINK_());
}

function istDate_(date, time) { return Utilities.parseDate(date + " " + (time || "00:00"), TZ, "yyyy-MM-dd HH:mm"); }
function istToday_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"); }
function istHour_() { return Number(Utilities.formatDate(new Date(), TZ, "H")); }
function plusDays_(date, n) { return Utilities.formatDate(new Date(istDate_(date, "12:00").getTime() + n * 864e5), TZ, "yyyy-MM-dd"); }
function niceWhen_(date, time) { return Utilities.formatDate(istDate_(date, time || "00:00"), TZ, time ? "EEE d MMM yyyy, h:mm a" : "EEE d MMM yyyy"); }

/** Runs every 5 minutes (see setupNotifications). */
function sendScheduledEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    DOCS_ = null;
    const now = Date.now(), today = istToday_(), tomorrow = plusDays_(today, 1), hour = istHour_();
    const sup = supervisorEmail_(), cache = CacheService.getScriptCache();
    let changed = false, sent = 0;
    const MAX_PER_RUN = 40;
    const docs = loadDocs_().list.slice();

    for (const d of docs) {
      if (sent >= MAX_PER_RUN) break;
      const segs = d.path.split("/"), x = d.data;

      // 1) scheduled meetings: each student's copy, plus one email to the supervisor per meeting
      if (segs[0] === "students" && segs[2] === "schedule" && x.date && x.time && !x.reminderSent) {
        const mins = (istDate_(x.date, x.time).getTime() - now) / 60000;
        if (mins > 0 && mins <= MEETING_NOTICE_MIN) {
          const lines = [(x.kind === "group" ? "Group meeting" : "Meeting with your supervisor") + " starts at " + niceWhen_(x.date, x.time) + "."];
          if (x.agenda) lines.push("Agenda:\n" + x.agenda);
          if (x.location) lines.push("Place: " + x.location);
          const btn = x.link ? { text: "Join meeting", url: x.link } : STUDENT_LINK_();
          if (sendMail_(studentEmail_(segs[1]), "Reminder: meeting in 15 minutes", studentName_(segs[1]), lines, btn)) sent++;
          x.reminderSent = true; putDoc_(d.path, x); changed = true;
          const gk = "supmeet:" + (x.groupId || d.path);
          if (sup && !cache.get(gk)) {
            cache.put(gk, "1", 21600);
            const who = x.kind === "group" ? "Group meeting with " + (x.attendees || []).map(studentName_).join(", ") : "Meeting with " + studentName_(segs[1]);
            if (sendMail_(sup, "Reminder: meeting in 15 minutes", "Supervisor", [who + " at " + niceWhen_(x.date, x.time) + "."].concat(x.agenda ? ["Agenda:\n" + x.agenda] : []), x.link ? { text: "Join meeting", url: x.link } : SUP_LINK_())) sent++;
          }
        }
      }

      // 2) the supervisor's own reminders (with a time): 15 minutes before
      if (segs[0] === "supervisor" && segs[2] === "items" && x.kind === "reminder" && !x.done && x.date && x.time && !x.reminderSent) {
        const mins = (istDate_(x.date, x.time).getTime() - now) / 60000;
        if (mins > 0 && mins <= MEETING_NOTICE_MIN) {
          if (sendMail_(sup, "Reminder: " + x.title + " in 15 minutes", "Supervisor", [x.title + " at " + niceWhen_(x.date, x.time) + "."].concat(x.location ? ["Place: " + x.location] : [], x.notes ? [x.notes] : []), x.link ? { text: "Join", url: x.link } : SUP_LINK_())) sent++;
          x.reminderSent = true; putDoc_(d.path, x); changed = true;
        }
      }

      // 3) one reminder the day before a task is due (from 9 AM), to whoever the task belongs to
      if (hour >= DUE_REMINDER_HOUR) {
        if (segs[0] === "students" && segs[2] === "tasks" && x.due === tomorrow && x.status !== "Done" && x.dueReminded !== x.due) {
          const forSup = x.owner === "supervisor";
          const lines = [(forSup ? "Your task for " + studentName_(segs[1]) : "Your task") + " \"" + x.title + "\" is due tomorrow (" + niceWhen_(x.due) + ").",
            "Current status: " + (x.status || "Not started") + ", " + (x.progress || 0) + "% done."];
          if (sendMail_(forSup ? sup : studentEmail_(segs[1]), "Due tomorrow: " + x.title, forSup ? "Supervisor" : studentName_(segs[1]), lines, forSup ? SUP_LINK_() : STUDENT_LINK_())) sent++;
          x.dueReminded = x.due; putDoc_(d.path, x); changed = true;
        }
        if (segs[0] === "supervisor" && segs[2] === "items" && x.kind === "task" && !x.done && x.date === tomorrow && x.dueReminded !== x.date) {
          if (sendMail_(sup, "Due tomorrow: " + x.title, "Supervisor", ["Your task \"" + x.title + "\" is due tomorrow (" + niceWhen_(x.date, x.time) + ")."].concat(x.notes ? [x.notes] : []), SUP_LINK_())) sent++;
          x.dueReminded = x.date; putDoc_(d.path, x); changed = true;
        }
      }
    }
    if (changed) bumpRev_();
  } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}
