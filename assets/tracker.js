import { db, configured, currentUser, isSupervisor, keyFromUser, signOut, setupNotice, resetStudentSecret } from "./core.js?v=20261109-1610";

const COURSES = ["PhD", "Masters", "B-Tech"];
function courseOf(s) { return s.course || (COURSES.includes(s.stage) ? s.stage : "PhD"); }
const STATUSES = ["Not started", "In progress", "Under review", "Blocked", "Done"];
const STATUS_CLASS = { "Not started": "plain", "In progress": "", "Under review": "warn", "Blocked": "bad", "Done": "good" };
const PSTATUS = ["Currently writing", "Submitted", "Under review", "Revision", "Accepted", "Published", "Rejected"];
const PSTATUS_CLASS = { "Currently writing": "plain", "Submitted": "", "Under review": "warn", "Revision": "warn", "Accepted": "good", "Published": "good", "Rejected": "bad" };
// earlier versions used finer steps; show them under the new names
const LEGACY_PSTATUS = { "Idea": "Currently writing", "Drafting": "Currently writing", "Internal review": "Currently writing", "Major revision": "Revision", "Minor revision": "Revision" };
function stageOf(p) { const s = normStatus(p.status); return PSTAGES.findIndex(([, , t]) => t(s)); }
function pubCounts(list) { const c = [0, 0, 0, 0]; list.forEach(p => { const i = stageOf(p); if (i >= 0) c[i]++; }); return { draft: c[0], submitted: c[1], accepted: c[2], rejected: c[3] }; }
function pubCounters(list) {
  const c = pubCounts(list);
  return h("div", { class: "pub-counters" },
    h("div", { class: "pc pc-draft" }, h("b", { text: c.draft }), h("span", { text: "Draft" })),
    h("div", { class: "pc pc-sub" }, h("b", { text: c.submitted }), h("span", { text: "Submitted" })),
    h("div", { class: "pc pc-acc" }, h("b", { text: c.accepted }), h("span", { text: "Accepted" })),
    c.rejected ? h("div", { class: "pc pc-rej" }, h("b", { text: c.rejected }), h("span", { text: "Rejected" })) : null);
}
function normStatus(s) { return LEGACY_PSTATUS[s] || s || "Currently writing"; }
const PSTAGES = [
  ["writing", "Draft (currently writing)", s => s === "Currently writing"],
  ["review", "Submitted / under review", s => ["Submitted", "Under review", "Revision"].includes(s)],
  ["accepted", "Accepted / published", s => ["Accepted", "Published"].includes(s)],
  ["rejected", "Rejected", s => s === "Rejected"]];
const PTYPES = ["Journal article", "Conference paper", "Review article", "Book chapter", "Patent", "Preprint"];
const INDEXING = ["SCI / SCIE", "Scopus", "ESCI", "UGC-CARE", "Web of Science", "Not indexed", "Not yet known"];
const QUARTILES = ["—", "Q1", "Q2", "Q3", "Q4"];
const NCOLL = 4;
const S = { mine: [], schedule: [], isOwner: false, myRole: "student", confs: [], refs: [], papers: [], tab: "tasks", openPapers: new Set(), dirtyPapers: new Set(), sample: null, students: [], meetings: [], tasks: [], sel: null, loaded: 0, db: null, user: null, canWrite: true, uid: null, timer: null, openTasks: new Set(), filter: "all" };

function h(tag, props, ...kids) {
  const el = document.createElement(tag); let val;
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "value") val = v;
    else if (k === "checked") el.checked = !!v;
    else if (k === "open") el.open = !!v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; el.append(c instanceof Node ? c : document.createTextNode(String(c))); }
  if (val !== undefined) el.value = val;
  if (tag === "form") el.noValidate = true;
  return el;
}
/* ---------- dates & task metrics ---------- */
function todayStr() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function parseD(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function diff(a, b) { return Math.round((parseD(b) - parseD(a)) / 86400000); }
function fmtD(s) { return s ? parseD(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"; }
function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
function isDone(t) { return t.status === "Done"; }
function statusOf(t) { return t.status || "Not started"; }
function startOf(t) { return t.assigned || (t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 10) : todayStr()); }
function metrics(t) {
  const start = startOf(t), today = todayStr();
  if (isDone(t) && t.doneAt) {
    const taken = Math.max(0, diff(start, t.doneAt));
    const late = t.due ? diff(t.due, t.doneAt) : null;
    return { done: true, taken, late, label: taken === 0 ? "Finished same day" : "Finished in " + plural(taken, "day"),
      cls: late != null && late > 0 ? "bad" : "good", timing: late == null ? "No due date" : late > 0 ? plural(late, "day") + " late" : late === 0 ? "On the due date" : plural(-late, "day") + " early" };
  }
  const elapsed = Math.max(0, diff(start, today));
  const left = t.due ? diff(today, t.due) : null;
  return { done: false, elapsed, left, label: "Day " + (elapsed + 1) + " (" + plural(elapsed, "day") + " elapsed)",
    cls: left != null && left < 0 ? "bad" : "", timing: left == null ? "No due date" : left < 0 ? plural(-left, "day") + " overdue" : left === 0 ? "Due today" : plural(left, "day") + " left" };
}
function isOverdue(t) { return !isDone(t) && t.due && diff(todayStr(), t.due) < 0; }
function statusChip(s) { return h("span", { class: "chip " + (STATUS_CLASS[s] ?? ""), text: s }); }
function ownerChip(t) { return h("span", { class: "chip plain", text: t.owner === "supervisor" ? "Supervisor's task" : "Student's task" }); }
function timingChip(t) {
  const m = metrics(t);
  if (m.done) return h("span", { class: "chip " + (m.late > 0 ? "bad" : "good"), text: m.timing });
  if (m.left == null) return h("span", { class: "chip plain", text: "No due date" });
  return h("span", { class: "chip " + (m.left < 0 ? "bad" : m.left <= 7 ? "warn" : "plain"), text: m.timing });
}
function progBar(p) { p = Math.max(0, Math.min(100, Number(p) || 0)); return h("div", { class: "prog", title: p + "% complete" }, h("div", { class: "bar" }, h("i", { style: "width:" + p + "%" })), h("span", { text: p + "%" })); }
function studentName(id) { const s = S.students.find(x => x.id === id); return s ? s.name : "Removed student"; }
function lastMeeting(sid) { return S.meetings.filter(m => m.studentId === sid).map(m => m.date).sort().pop() || null; }
function tasksOf(sid) { return S.tasks.filter(t => !sid || t.studentId === sid); }
function sortTasks(a, b) { const ad = a.due || "9999", bd = b.due || "9999"; return ad < bd ? -1 : ad > bd ? 1 : (a.createdAt || 0) - (b.createdAt || 0); }
function avgDays(list) { const d = list.filter(t => isDone(t) && t.doneAt).map(t => metrics(t).taken); return d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null; }

let statusT;
function say(msg) { const el = document.getElementById("status"); el.textContent = msg; el.hidden = false; clearTimeout(statusT); statusT = setTimeout(() => el.hidden = true, 4000); }
async function write(fn, okMsg) {
  if (!S.db) { say("Saving isn't available in this view."); return false; }
  try { await fn(S.db); if (okMsg) say(okMsg); return true; }
  catch (e) {
    if (e && e.code === "permission-denied") say("You don't have permission to change this record. Try signing out and in again.");
    else if (e && e.code === "resource-exhausted") say("The database quota is used up for today. Try again tomorrow.");
    else if (e && e.code === "unauthenticated") { location.href = "index.html"; }
    else if (e && e.code === "network") say(e.message);
    else say("Couldn't save. Check your connection and try again.");
    return false;
  }
}

/* ---------- header + roster ---------- */
function stat(n, label, alert) { return h("div", { class: "stat" + (alert ? " alert" : "") }, h("b", { text: n }), h("span", { class: "label", text: label })); }
function renderStats() {
  if (!S.isOwner) { document.getElementById("stats").replaceChildren(); return; }
  const all = tasksOf(), open = all.filter(t => !isDone(t)), done = all.filter(isDone), od = open.filter(isOverdue);
  const stale = S.students.filter(s => { const l = lastMeeting(s.id); return !l || diff(l, todayStr()) > 30; });
  const avg = avgDays(all);
  document.getElementById("stats").replaceChildren(
    stat(S.students.length, "Students"), stat(open.length, "Open tasks"), stat(od.length, "Overdue", od.length),
    stat(done.length, "Completed"), stat(pubCounts(S.papers).draft, "Draft papers"), stat(pubCounts(S.papers).submitted, "Submitted"), stat(pubCounts(S.papers).accepted, "Accepted"), stat(avg == null ? "—" : avg + "d", "Avg. time to finish"), stat(stale.length, "Not met in 30 days", stale.length));
}
function renderRoster() {
  const items = [h("button", { class: "r-item", type: "button", "aria-current": S.sel === null ? "true" : "false", onclick: () => select(null) },
    h("span", { class: "nm", text: "Group overview" }), h("span", { class: "meta", text: "All tasks and recent meetings" })),
    h("button", { class: "r-item r-mine", type: "button", "aria-current": S.sel === "__mine" ? "true" : "false", onclick: () => select("__mine") },
      h("span", { class: "nm", text: "My tasks & reminders" }),
      h("span", { class: "meta" }, ...mineMeta())),
    h("button", { class: "r-item r-conf", type: "button", "aria-current": S.sel === "__confs" ? "true" : "false", onclick: () => select("__confs") },
      h("span", { class: "nm", text: "Upcoming conferences" }),
      h("span", { class: "meta", text: (() => { const n = (S.confs || []).filter(c => !c.deadline || diff(todayStr(), c.deadline) >= 0).length; return n ? plural(n, "upcoming deadline") : "Add and view conference deadlines"; })() })),
    h("button", { class: "r-item r-sched", type: "button", "aria-current": S.sel === "__sched" ? "true" : "false", onclick: () => select("__sched") },
      h("span", { class: "nm", text: "Scheduled meetings" }),
      h("span", { class: "meta", text: (() => { const n = upcomingSched().length; return n ? plural(n, "upcoming meeting") : "Plan group or individual meetings"; })() })),
    h("div", { class: "roster-sep label", text: "Students" })];
  for (const s of [...S.students].sort((a, b) => a.name.localeCompare(b.name))) {
    const l = lastMeeting(s.id), mine = tasksOf(s.id), open = mine.filter(t => !isDone(t)), od = open.filter(isOverdue).length;
    items.push(h("button", { class: "r-item", type: "button", "aria-current": S.sel === s.id ? "true" : "false", onclick: () => select(s.id) },
      h("span", { class: "nm", text: s.name }),
      h("span", { class: "meta", text: (s.admissionNo ? s.admissionNo + " · " : "") + courseOf(s) }),
      h("span", { class: "meta" },
        h("span", { text: l ? "Met " + (diff(l, todayStr()) === 0 ? "today" : diff(l, todayStr()) + "d ago") : "No meetings yet" }),
        h("span", { text: open.length + " open · " + (mine.length - open.length) + " done" }),
        od ? h("span", { class: "chip bad", text: od + " overdue" }) : null)));
  }
  document.getElementById("roster").replaceChildren(...items);
}

/* ---------- overview ---------- */
function renderOverview() {
  const d = document.getElementById("detail");
  if (S.loaded < NCOLL) { d.replaceChildren(h("div", { class: "empty" }, h("h3", { text: "Loading the group…" }), h("p", { id: "loadnote", text: "Fetching students, tasks and meetings." }))); return; }
  if (!S.students.length) {
    d.replaceChildren(h("div", { class: "empty" },
      h("h3", { text: "No students have registered yet" }),
      h("p", { text: "Each student gets a task register and a meeting log. Every task records its status, progress, assigned date, due date and how many days it took. At each meeting you update every open task in one place, and that update is kept in both the meeting record and the task's own history." }),
      h("p", null, "Send students the sign-up link and the lab code shown on the left. Each student creates their own account with their admission number and a password, and appears here straight away.")));
    return;
  }
  const open = tasksOf().filter(t => !isDone(t)).sort(sortTasks);
  const openPanel = h("section", { class: "panel sec-tasks" },
    h("div", { class: "panel-head" }, h("h3", { text: "Open tasks across the group" }), h("span", { class: "muted", text: open.length + " open" })),
    open.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Student", "Task", "Status", "Progress", "Assigned", "Days so far", "Due"].map(x => h("th", { text: x })))),
      h("tbody", null, open.map(t => { const m = metrics(t); return h("tr", null,
        h("td", null, h("button", { class: "linkish", type: "button", text: studentName(t.studentId), onclick: () => select(t.studentId, t.id) })),
        h("td", { text: t.title }), h("td", null, statusChip(statusOf(t))), h("td", null, progBar(t.progress)),
        h("td", { class: "num", text: fmtD(startOf(t)) }), h("td", { class: "num", text: m.elapsed }), h("td", null, timingChip(t))); }))))
      : h("p", { class: "note", text: "No current tasks." }));
  const done = tasksOf().filter(t => isDone(t)).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || "")).slice(0, 12);
  const donePanel = h("section", { class: "panel sec-tasks" },
    h("div", { class: "panel-head" }, h("h3", { text: "Recently completed" }), h("span", { class: "muted", text: avgDays(tasksOf()) == null ? "" : "Average " + plural(avgDays(tasksOf()), "day") + " to finish" })),
    done.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Student", "Task", "Assigned", "Finished", "Days taken", "Against due date"].map(x => h("th", { text: x })))),
      h("tbody", null, done.map(t => { const m = metrics(t); return h("tr", null,
        h("td", null, h("button", { class: "linkish", type: "button", text: studentName(t.studentId), onclick: () => select(t.studentId, t.id) })),
        h("td", { text: t.title }), h("td", { class: "num", text: fmtD(startOf(t)) }), h("td", { class: "num", text: fmtD(t.doneAt) }),
        h("td", { class: "num", text: m.taken }), h("td", null, timingChip(t))); }))))
      : h("p", { class: "note", text: "Completed tasks will appear here with the number of days each one took." }));
  const recent = [...S.meetings].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 6);
  const meetPanel = h("section", { class: "panel sec-meet" },
    h("div", { class: "panel-head" }, h("h3", { text: "Recent meetings" })),
    recent.length ? h("ul", { class: "meetings" }, recent.map(m => h("li", { class: "meeting" },
      h("div", { class: "m-top" }, h("button", { class: "linkish", type: "button", text: studentName(m.studentId), onclick: () => select(m.studentId) }), h("span", { class: "m-date", text: fmtD(m.date) })),
      h("p", { class: "note", text: plural((m.updates || []).length, "task update") + " · " + plural((m.newTasks || []).length, "new task") + (m.notes ? " · " + (m.notes.length > 140 ? m.notes.slice(0, 140) + "…" : m.notes) : "") }))))
      : h("p", { class: "note", text: "No meetings logged yet. Pick a student on the left to log one." }));
  const pp = [...S.papers].sort((a, b) => stageOf(a) - stageOf(b) || studentName(a.studentId).localeCompare(studentName(b.studentId)));
  const papPanel = h("section", { class: "panel sec-pubs" },
    h("div", { class: "panel-head" }, h("h3", { text: "Publications" }), pubCounters(S.papers)),
    pp.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Student", "Paper", "Venue", "Status", "Review time", "Overleaf"].map(x => h("th", { text: x })))),
      h("tbody", null, pp.flatMap((p, i) => { const m = pMetrics(p);
        const head = (i === 0 || stageOf(pp[i - 1]) !== stageOf(p)) ? [h("tr", { class: "stage-row" }, h("td", { colspan: "6", text: PSTAGES[stageOf(p)][1] + " · " + pp.filter(x => stageOf(x) === stageOf(p)).length }))] : [];
        return [...head, h("tr", null,
        h("td", null, h("button", { class: "linkish", type: "button", text: studentName(p.studentId), onclick: () => { select(p.studentId); focusPaper(p.id); } })),
        h("td", { text: p.title }),
        h("td", { text: p.venue || "—" }),
        h("td", null, pChip(pStatus(p))), h("td", { class: "num", text: m.review == null ? "—" : m.review + "d" }),
        h("td", null, p.overleaf ? h("a", { class: "ext", href: p.overleaf, target: "_blank", rel: "noopener", text: "Overleaf ↗" }) : h("span", { class: "muted", text: "—" })))]; }))))
      : h("p", { class: "note", text: "Papers added on a student's Publications tab appear here with their status and review time." }));
  d.replaceChildren(...[todayPanel(), openPanel, papPanel, donePanel, meetPanel].filter(Boolean));
}

/* ---------- publications ---------- */
function P(kind, item) { return "students/" + item.studentId + "/" + kind + "/" + item.id; }
function C(kind, sid) { return "students/" + sid + "/" + kind; }
function papersOf(sid) { return S.papers.filter(p => !sid || p.studentId === sid); }
function pStatus(p) { return normStatus(p.status); }
function pActive(p) { return !["Published", "Rejected"].includes(pStatus(p)); }
function inReview(p) { return ["Submitted", "Under review", "Revision"].includes(pStatus(p)); }
function pLabel(s) { return s === "Currently writing" ? "Draft (currently writing)" : s; }
function pChip(s) { s = normStatus(s); return h("span", { class: "chip " + (PSTATUS_CLASS[s] ?? ""), text: s === "Currently writing" ? "Draft" : s }); }
function pMetrics(p) {
  const today = todayStr(), st = pStatus(p);
  const last = (p.history || []).map(x => x.date).filter(Boolean).sort().pop() || p.statusSince || today;
  const inStatus = Math.max(0, diff(last, today));
  let review = null, reviewLabel = st === "Currently writing" ? "Writing for " + plural(Math.max(0, diff(p.statusSince || last || startOfPaper(p), today)), "day") : "Not submitted yet";
  if (p.submittedOn) {
    const end = p.acceptedOn || (st === "Rejected" ? p.decisionOn : null) || today;
    review = Math.max(0, diff(p.submittedOn, end));
    reviewLabel = p.acceptedOn ? "Accepted after " + plural(review, "day") : st === "Rejected" ? "Rejected after " + plural(review, "day") : "In review for " + plural(review, "day");
  }
  const firstDecision = p.submittedOn && p.firstDecisionOn ? Math.max(0, diff(p.submittedOn, p.firstDecisionOn)) : null;
  return { inStatus, review, reviewLabel, firstDecision, last };
}
function startOfPaper(p) { return p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : todayStr(); }
function stampDates(p, status, date) {
  const patch = {};
  if (status === "Submitted" && !p.submittedOn) patch.submittedOn = date;
  if (["Revision", "Accepted", "Rejected"].includes(status) && p.submittedOn && !p.firstDecisionOn) patch.firstDecisionOn = date;
  if (status === "Accepted" && !p.acceptedOn) patch.acceptedOn = date;
  if (status === "Published") { if (!p.publishedOn) patch.publishedOn = date; if (!p.acceptedOn && p.submittedOn) patch.acceptedOn = date; }
  if (status === "Rejected") patch.decisionOn = date;
  return patch;
}
function cleanUrl(u) { u = (u || "").trim(); if (!u) return ""; if (!/^https?:\/\//i.test(u)) u = "https://" + u; return u; }
function doiHref(d) { d = (d || "").trim(); if (!d) return null; if (/^https?:\/\//i.test(d)) return d; return "https://doi.org/" + d.replace(/^doi:\s*/i, ""); }

function paperCard(p) {
  const m = pMetrics(p), st = pStatus(p), sm = p.summary || {};
  const card = h("details", { class: "task paper" + (st === "Published" ? " done" : ""), id: "paper-" + p.id, open: S.openPapers.has(p.id),
      ontoggle: e => { e.target.open ? S.openPapers.add(p.id) : S.openPapers.delete(p.id); } },
    h("summary", null,
      h("div", { style: "min-width:0" },
        h("div", { class: "t-title", text: p.title }),
        h("div", { class: "t-sub" }, pChip(st), h("span", { class: "chip plain", text: p.type || "Journal article" }),
          p.venue ? h("span", { class: "p-venue", text: (st === "Currently writing" ? "Target: " : "") + p.venue }) : h("span", { class: "muted", text: st === "Currently writing" ? "Target venue not set" : "Venue not set" }),
          p.authors ? h("span", { class: "who", text: p.authors }) : null),
        latestFeedback(p)),
      h("div", { class: "t-right" },
        h("span", { class: "days" + (inReview(p) && m.review > 180 ? " bad" : p.acceptedOn ? " good" : ""), text: m.reviewLabel }),
        h("span", { class: "who", text: plural(m.inStatus, "day") + " in current status" }),
        p.overleaf ? h("a", { class: "btn small overleaf", href: p.overleaf, target: "_blank", rel: "noopener", text: "Overleaf ↗", onclick: e => e.stopPropagation() })
          : (st === "Currently writing" ? h("span", { class: "chip warn", text: "No Overleaf link" }) : null))));
  const hist = (p.history || []).map((x, i) => [x, i]).sort((a, b) => (b[0].date || "").localeCompare(a[0].date || "") || b[1] - a[1]).map(p => p[0]);
  const body = h("div", { class: "t-body" },
    h("div", { class: "linkbtns" },
      p.overleaf ? h("a", { class: "btn small overleaf", href: p.overleaf, target: "_blank", rel: "noopener", text: "Open draft in Overleaf ↗" })
        : h("span", { class: "note", text: "No Overleaf link yet. Add it under \"Edit paper details\"." })),
    h("p", { class: "note", text: [p.type || "Journal article", p.venue ? (pStatus(p) === "Currently writing" ? "Target venue: " : "Venue: ") + p.venue : null, p.authors ? "Authors: " + p.authors : null].filter(Boolean).join("  ·  ") }),
    h("div", { style: "display:grid;gap:8px" }, h("div", { class: "label", text: "Status timeline" }),
      hist.length ? h("ol", { class: "hist" }, hist.map(x => h("li", null,
        h("div", { class: "h-top" }, h("span", { class: "h-date", text: fmtD(x.date) }), pChip(x.status),
          h("span", { class: "who", text: x.via === "meeting" ? "Meeting update" : x.via === "added" ? "Added" : "Direct update" }), h("span", { class: "who", text: x.byName ? "by " + x.byName : "" })),
        remarkEl(x)))) : h("p", { class: "note", text: "No status changes yet." })),
    S.canWrite ? paperStatusForm(p) : null,
    S.canWrite ? h("details", { class: "sub" }, h("summary", { text: "Edit paper details" }), paperEditForm(p)) : null);
  card.append(body);
  return card;
}
function paperStatusForm(p) {
  const id = p.id, sel = h("select", { id: "pst-" + id }, PSTATUS.map(x => h("option", { value: x, text: pLabel(x) })));
  sel.value = pStatus(p);
  return h("form", { class: "edit-box", onsubmit: async e => {
      e.preventDefault();
      const status = sel.value, date = val("psd-" + id) || todayStr(), remark = val("psr-" + id).trim();
      if (status === pStatus(p) && !remark) { say("Change the status or add a remark."); return; }
      const patch = { status, statusSince: date, ...(status !== pStatus(p) ? stampDates(p, status, date) : {}), history: [...(p.history || []), { date, status, remark, via: "edit", by: S.uid, byName: S.myName, byRole: S.myRole }] };
      await write(db => db.doc(P("papers", p)).update(patch), "Paper updated");
    } },
    h("h4", { text: "Update status" }),
    h("div", { class: "row" }, h("label", { class: "fieldlabel" }, "New status", sel), h("label", { class: "fieldlabel" }, "As of", h("input", { type: "date", id: "psd-" + id, value: todayStr() }))),
    h("label", { class: "fieldlabel" }, S.isOwner ? "Supervisor feedback (highlighted for the student)" : "Remark", h("input", { id: "psr-" + id, maxlength: "500", placeholder: "e.g. Reviewer 2 asked for comparison with baseline X" })),
    h("div", null, h("button", { class: "btn", type: "submit", text: "Save status" })));
}
function paperFields(prefix, p) {
  p = p || {}; const sm = p.summary || {};
  const sel = (id, opts, v) => { const s = h("select", { id }, opts.map(x => h("option", { value: x, text: x }))); s.value = v || opts[0]; return s; };
  return [
    h("label", { class: "fieldlabel" }, "Title", h("input", { id: prefix + "title", maxlength: "400", value: p.title || "" })),
    h("label", { class: "fieldlabel" }, "Overleaf link (the working draft)", h("input", { id: prefix + "overleaf", type: "text", inputmode: "url", autocomplete: "off", maxlength: "300", value: p.overleaf || "", placeholder: "https://www.overleaf.com/project/…  (Share → link sharing)" })),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Venue: journal or conference (target, if still writing)", h("input", { id: prefix + "venue", maxlength: "300", value: p.venue || "", placeholder: "e.g. IEEE Transactions on Power Systems" })),
      h("label", { class: "fieldlabel" }, "Type", sel(prefix + "type", PTYPES, p.type))),
    h("label", { class: "fieldlabel" }, "Authors (in order)", h("input", { id: prefix + "authors", maxlength: "500", value: p.authors || "", placeholder: "P. Sharma, A. Kalita, …" })),
];
}
function readPaperFields(prefix) {
  return { title: val(prefix + "title").trim(), authors: val(prefix + "authors").trim(), type: val(prefix + "type"),
    venue: val(prefix + "venue").trim(), overleaf: cleanUrl(val(prefix + "overleaf")) };
}
function paperEditForm(p) {
  const prefix = "pe-" + p.id + "-";
  return h("form", { class: "edit-box", style: "margin-top:8px", oninput: () => S.dirtyPapers.add(p.id), onsubmit: async e => {
      e.preventDefault(); const d = readPaperFields(prefix); if (!d.title) { say("The paper needs a title."); return; }
      const ok = await write(db => db.doc(P("papers", p)).update(d), "Paper details saved");
      if (ok) { S.dirtyPapers.delete(p.id); const s = S.students.find(x => x.id === S.sel); if (s) refreshStudent(s); }
    } }, paperFields(prefix, p),
    h("div", { class: "row", style: "align-items:center" }, h("div", null, h("button", { class: "btn", type: "submit", text: "Save details" })), h("div", { style: "text-align:right" }, delPaperBtn(p))));
}
function delPaperBtn(p) {
  let armed = null; const b = h("button", { class: "x", type: "button", text: "Delete paper" });
  b.onclick = () => { if (!armed) { b.textContent = "Confirm delete"; armed = setTimeout(() => { armed = null; b.textContent = "Delete paper"; }, 4000); return; }
    clearTimeout(armed); S.openPapers.delete(p.id); write(db => db.doc(P("papers", p)).delete(), "Paper deleted"); };
  return b;
}
function paperAddForm(s) {
  const prefix = "np-";
  const sel = h("select", { id: "np-status" }, PSTATUS.map(x => h("option", { value: x, text: pLabel(x) }))); sel.value = "Currently writing";
  return h("form", { class: "edit-box", hidden: !S.canWrite, onsubmit: async e => {
      e.preventDefault(); const d = readPaperFields(prefix); if (!d.title) { say("The paper needs a title."); return; }
      const status = sel.value, date = val("np-date") || todayStr();
      const base = { ...d, studentId: s.id, status, statusSince: date, createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole,
        history: [{ date, status, remark: "Paper added", via: "added", by: S.uid, byName: S.myName, byRole: S.myRole }] };
      Object.assign(base, stampDates({}, status, date));
          const ok = await write(db => db.collection(C("papers", s.id)).add(base), "Paper added");
      if (ok) { e.target.reset(); document.getElementById("np-date").value = todayStr(); sel.value = "Currently writing"; e.target.closest("details").open = false; }
    } },
    h("div", { class: "row" }, h("label", { class: "fieldlabel" }, "Where is this paper now?", sel),
      h("label", { class: "fieldlabel" }, "Since (started / submitted / accepted on)", h("input", { type: "date", id: "np-date", value: todayStr() }))),
    paperFields(prefix, null),
    h("div", null, h("button", { class: "btn", type: "submit", text: "Add paper" })));
}

/* ---------- student page ---------- */
function buildStudent(s) {
  const d = document.getElementById("detail");
  const stageSel = h("select", { id: "course-" + s.id, "aria-label": "Course", disabled: !S.canWrite, onchange: e => write(db => db.doc("students/" + s.id).update({ course: e.target.value }), "Course updated") },
    COURSES.map(x => h("option", { value: x, text: x })));
  stageSel.value = courseOf(s);
  const rm = h("button", { class: "btn danger small", type: "button", text: "Remove student", hidden: !S.isOwner });
  let armed = null;
  rm.onclick = async () => {
    if (!armed) { rm.classList.add("armed"); rm.textContent = "Confirm: delete student and all records"; armed = setTimeout(() => { armed = null; rm.classList.remove("armed"); rm.textContent = "Remove student"; }, 5000); return; }
    clearTimeout(armed);
    const ok = await write(async db => {
      for (const t of S.tasks.filter(t => t.studentId === s.id)) await db.doc(P("tasks", t)).delete();
      for (const m of S.meetings.filter(m => m.studentId === s.id)) await db.doc(P("meetings", m)).delete();
      for (const p of S.papers.filter(p => p.studentId === s.id)) await db.doc(P("papers", p)).delete();
      await db.doc("students/" + s.id).delete();
    }, s.name + " removed");
    if (ok) select(null);
  };
  const head = h("section", { class: "panel" },
    h("div", { class: "s-head" },
      h("div", { style: "min-width:0" },
        h("div", { class: "label", text: [s.admissionNo ? "Adm. no. " + s.admissionNo : "", s.year ? "Admitted " + s.year : ""].filter(Boolean).join(" · ") || "Student" }),
        h("h2", { id: "s-name", text: s.name }),
        s.topic ? h("p", { class: "topic", text: s.topic }) : null,
        S.canWrite ? emailRow(s) : null),
      h("div", { class: "s-controls" }, h("label", { class: "fieldlabel" }, "Course", stageSel), S.isOwner ? resetBox(s) : null, rm)),
    h("div", { id: "next-banner" }),
    h("div", { class: "s-figs", id: "s-figs" }));

  /* new task */
  const taskForm = h("form", { hidden: !S.canWrite, class: "edit-box", onsubmit: async e => {
      e.preventDefault(); const title = val("nt-title").trim(); if (!title) return;
      const assigned = val("nt-assigned") || todayStr();
      const ok = await write(db => db.collection(C("tasks", s.id)).add({ studentId: s.id, title, details: val("nt-details").trim(), owner: val("nt-owner"), assigned, due: val("nt-due"),
        status: "Not started", progress: 0, doneAt: "", createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole,
        history: [{ date: assigned, status: "Not started", progress: 0, remark: "Task assigned", via: "assigned", by: S.uid, byName: S.myName, byRole: S.myRole }] }), "Task added");
      if (ok) { ["nt-title", "nt-details", "nt-due"].forEach(id => document.getElementById(id).value = ""); document.getElementById("nt-assigned").value = todayStr(); }
    } },
    h("h4", { text: "Add a task" }),
    h("input", { id: "nt-title", placeholder: "Task, e.g. Complete literature review for chapter 2", maxlength: "300", "aria-label": "Task title" }),
    h("textarea", { id: "nt-details", rows: "2", placeholder: "Details: scope, expected output, references (optional)", "aria-label": "Task details" }),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Assigned on", h("input", { id: "nt-assigned", type: "date", value: todayStr() })),
      h("label", { class: "fieldlabel" }, "Due by", h("input", { id: "nt-due", type: "date" })),
      h("label", { class: "fieldlabel" }, "Responsible", h("select", { id: "nt-owner" }, h("option", { value: "student", text: "Student" }), h("option", { value: "supervisor", text: "Supervisor" })))),
    h("div", null, h("button", { class: "btn", type: "submit", text: "Add task" })));
  const filters = h("div", { class: "filters", id: "task-filters" }, [["open", "Current"], ["done", "Completed"], ["all", "All"]].map(([k, l]) =>
    h("button", { type: "button", "data-f": k, "aria-pressed": S.filter === k ? "true" : "false", text: l, onclick: () => { S.filter = k; refreshStudent(s); } })));
  const tasks = h("section", { class: "panel" },
    taskForm,
    h("div", { class: "panel-head" }, h("h3", { text: "Task register" }), filters),
    h("div", { class: "tasks", id: "task-list" }));

  /* meeting form: task-wise */
  const meetForm = h("form", { hidden: !S.canWrite, onsubmit: e => { e.preventDefault(); submitMeeting(s, e.target); } },
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Meeting date", h("input", { id: "nm-date", type: "date", value: todayStr() })),
      h("label", { class: "fieldlabel" }, "Next meeting (optional)", h("input", { id: "nm-next", type: "date" }))),
    h("label", { class: "fieldlabel" }, "General discussion", h("textarea", { id: "nm-notes", rows: "3", placeholder: "Overall progress, results discussed, decisions, concerns…" })),
    h("div", { class: "label", text: "Task-wise update" }),
    h("div", { class: "upd-list", id: "upd-list" }),
    h("div", { class: "label", text: "Paper-wise update" }),
    h("div", { class: "upd-list", id: "pupd-list" }),
    h("label", { class: "fieldlabel" }, "New tasks assigned in this meeting, one per line", h("textarea", { id: "nm-actions", rows: "3", placeholder: "Rerun simulation with new boundary conditions\nDraft abstract for conference submission" })),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "New tasks due by", h("input", { id: "nm-due", type: "date" })),
      h("div", { style: "display:flex;align-items:end" }, h("button", { class: "btn", type: "submit", text: "Save meeting" }))));
  const meetPanel = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Log a meeting" }), h("span", { class: "muted", text: "Updates each task and keeps the record" })), meetForm,
    S.canWrite ? null : h("p", { class: "note", text: "You have view-only access." }));
  const logPanel = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Meeting log" }), h("span", { class: "muted", id: "meet-count" })),
    h("ul", { class: "meetings", id: "meet-list" }));

  const papersPanel = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Publications" }), h("div", { id: "paper-count" })),
    h("div", { class: "tasks", id: "paper-list" }),
    S.canWrite ? h("details", { class: "sub", id: "paper-add" }, h("summary", { text: "+ Add a paper: currently writing, submitted or accepted" }), h("div", { style: "margin-top:10px" }, paperAddForm(s))) : null);

  const refForm = h("form", { class: "edit-box", hidden: !S.canWrite, onsubmit: async e => {
      e.preventDefault(); const title = val("nr-title").trim(); let link = val("nr-link").trim();
      if (!title) { say("Add the paper's title."); return; }
      if (link && !/^https?:\/\//i.test(link)) link = /^10\.\d{4,}\//.test(link) ? "https://doi.org/" + link : "https://" + link;
      const ok = await write(db => db.collection(C("refs", s.id)).add({ studentId: s.id, title, link, note: val("nr-note").trim(), added: todayStr(), createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole }), "Paper added to the list");
      if (ok) { ["nr-title", "nr-link", "nr-note"].forEach(id => document.getElementById(id).value = ""); }
    } },
    h("h4", { text: "Add a paper" }),
    h("label", { class: "fieldlabel" }, "Title", h("input", { id: "nr-title", maxlength: "400", placeholder: "e.g. Attention Is All You Need" })),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Link (URL or DOI)", h("input", { id: "nr-link", maxlength: "500", placeholder: "https://… or 10.xxxx/…" })),
      h("label", { class: "fieldlabel" }, "Note (optional)", h("input", { id: "nr-note", maxlength: "300", placeholder: "Why it matters, which chapter" }))),
    h("div", null, h("button", { class: "btn", type: "submit", text: "Add paper" })));
  const refsPanel = h("section", { class: "panel sec-refs" },
    h("div", { class: "panel-head" }, h("h3", { text: "Paper details" }), h("span", { class: "muted", id: "ref-count" })),
    h("p", { class: "note", text: "Papers to read or cite, with their links. The supervisor and the student can both add to this list." }),
    h("ul", { class: "refs", id: "ref-list" }), refForm);

  tasks.classList.add("sec-tasks"); papersPanel.classList.add("sec-pubs"); meetPanel.classList.add("sec-meet"); logPanel.classList.add("sec-meet");
  const panes = {
    tasks: h("div", { class: "tabpane", "data-pane": "tasks" }, tasks),
    refs: h("div", { class: "tabpane", "data-pane": "refs" }, refsPanel),
    confs: S.isOwner ? null : h("div", { class: "tabpane", "data-pane": "confs" }, confPanelEl()),
    papers: h("div", { class: "tabpane", "data-pane": "papers" }, papersPanel),
    meetings: h("div", { class: "tabpane", "data-pane": "meetings" },
      h("section", { class: "panel sec-meet" }, h("div", { class: "panel-head" }, h("h3", { text: "Scheduled meetings" }), h("span", { class: "muted", id: "stu-sched-count" })),
        h("ul", { class: "refs", id: "stu-sched" })),
      h("div", { class: "cols" }, meetPanel, logPanel)) };
  const tabBtn = (k, l) => h("button", { type: "button", role: "tab", "data-tab": k, class: "tab-" + k, "aria-selected": S.tab === k ? "true" : "false",
    onclick: () => { S.tab = k; showTab(); } }, l, h("span", { class: "n", id: "tabn-" + k }));
  const tabs = h("div", { class: "tabs", role: "tablist" }, tabBtn("tasks", "Tasks"), tabBtn("papers", "Publications"), tabBtn("refs", "Paper details"), S.isOwner ? null : tabBtn("confs", "Conferences"), tabBtn("meetings", "Meetings"));
  if (S.isOwner && S.tab === "confs") S.tab = "tasks";
  d.replaceChildren(...[head, tabs, panes.tasks, panes.papers, panes.refs, panes.confs, panes.meetings].filter(Boolean));
  showTab();
  updSig = null; pupdSig = null;
}
/** Recovery email, used for "Forgot your password?" links. Editable by the student and the supervisor. */
function emailRow(s) {
  const input = h("input", { id: "em-" + s.id, type: "email", maxlength: "120", value: s.email || "", placeholder: "name@example.com", "aria-label": "Recovery email", style: "max-width:280px" });
  const warn = h("span", { class: "chip warn", hidden: !!s.email, text: "Add an email so the password can be reset" });
  const form = h("form", { class: "email-row", onsubmit: async e => {
      e.preventDefault(); const v = input.value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { say("Enter a valid email address."); return; }
      if (await write(db => db.doc("students/" + s.id).update({ email: v }), "Recovery email saved")) warn.hidden = true;
    } }, h("span", { class: "label", text: "Recovery email" }), input, h("button", { class: "btn ghost small", type: "submit", text: "Save" }), warn);
  return form;
}
function resetBox(s) {
  const input = h("input", { id: "rs-" + s.id, type: "text", minlength: "6", maxlength: "64", placeholder: "New password", autocomplete: "off", "aria-label": "New password for " + s.name });
  const form = h("form", { class: "row", hidden: true, style: "flex-basis:100%", onsubmit: async e => {
      e.preventDefault(); const v = input.value.trim();
      if (v.length < 6) { say("Use at least 6 characters."); return; }
      try { await resetStudentSecret(s.id, v); say("Password reset. Tell " + s.name + " the new password: " + v); input.value = ""; form.hidden = true; }
      catch (err) { say(err.message || "Couldn't reset the password."); }
    } }, input, h("button", { class: "btn small", type: "submit", text: "Set password" }));
  const btn = h("button", { class: "btn ghost small", type: "button", text: "Reset password", onclick: () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); } });
  return h("div", { style: "display:flex;flex-wrap:wrap;gap:8px;align-items:end" }, btn, form);
}
function val(id) { const el = document.getElementById(id); return el ? el.value : ""; }

/* task card */
function taskCard(t) {
  const m = metrics(t), st = statusOf(t);
  const card = h("details", { class: "task" + (isDone(t) ? " done" : ""), open: S.openTasks.has(t.id), id: "task-" + t.id,
      ontoggle: e => { e.target.open ? S.openTasks.add(t.id) : S.openTasks.delete(t.id); } },
    // Closed: just the title and a + button. Everything else is inside.
    h("summary", { class: "task-min", title: "Show details" },
      h("span", { class: "t-title", text: t.title }),
      h("span", { class: "plus", "aria-hidden": "true" })));
  const top = h("div", { class: "task-top" },
      h("div", { class: "daybox " + (m.done ? (m.late > 0 ? "bad" : "good") : m.cls), title: m.done ? "Days taken to finish" : "Days since the task was assigned" },
        h("b", { text: m.done ? m.taken : m.elapsed }), h("span", { text: m.done ? "days taken" : "days so far" })),
      h("div", { style: "min-width:0" },
        h("div", { class: "t-sub", style: "margin-top:0" }, statusChip(st), ownerChip(t), h("span", { text: "Assigned " + fmtD(startOf(t)) }), h("span", { text: "Due " + fmtD(t.due) }), timingChip(t)),
        latestFeedback(t)),
      h("div", { class: "t-right" }, progBar(isDone(t) ? 100 : t.progress), h("span", { class: "days " + m.cls, text: m.label }), quickToggle(t)));
  const facts = h("dl", { class: "facts" },
    [["Status", st], ["Progress", (isDone(t) ? 100 : (t.progress || 0)) + "%"], ["Assigned", fmtD(startOf(t))], ["Due", fmtD(t.due)],
     ["Completed", isDone(t) ? fmtD(t.doneAt) : "Not yet"], [m.done ? "Days taken" : "Days elapsed", String(m.done ? m.taken : m.elapsed)],
     ["Against due date", m.timing], ["Updates logged", String((t.history || []).length)]].map(([k, v]) => h("div", null, h("dt", { text: k }), h("dd", { text: v }))));
  const hist = (t.history || []).map((x, i) => [x, i]).sort((a, b) => (b[0].date || "").localeCompare(a[0].date || "") || b[1] - a[1]).map(p => p[0]);
  const histEl = hist.length ? h("ol", { class: "hist" }, hist.map(x => h("li", null,
      h("div", { class: "h-top" }, h("span", { class: "h-date", text: fmtD(x.date) }), statusChip(x.status || "Not started"), h("span", { class: "mono", text: (x.progress || 0) + "%" }),
        h("span", { class: "who", text: x.via === "meeting" ? "Meeting update" : x.via === "assigned" ? "Assigned" : "Direct update" }),
        h("span", { class: "who", text: x.byName ? "by " + x.byName : "" })),
      remarkEl(x))))
    : h("p", { class: "note", text: "No updates yet." });
  const body = h("div", { class: "t-body" }, top, facts,
    t.details ? h("div", null, h("div", { class: "label", text: "Details" }), h("p", { class: "t-details", text: t.details })) : null,
    h("div", { style: "display:grid;gap:8px" }, h("div", { class: "label", text: "Progress history" }), histEl),
    S.canWrite ? editForm(t) : null);
  card.append(body);
  return card;
}
/** One-click Done / Not done. Students can mark a task done; only the supervisor can mark a finished task as not done. */
function quickToggle(t) {
  if (!S.canWrite) return null;
  if (isDone(t) && !S.isOwner) return null;
  const btn = h("button", { type: "button", class: "btn small " + (isDone(t) ? "danger" : "ghost"), text: isDone(t) ? "Mark as not done" : "Mark as done" });
  btn.onclick = async e => {
    e.preventDefault(); e.stopPropagation();   // don't open/close the card
    const date = todayStr();
    if (isDone(t)) {
      // back to where it was before it was marked done
      const before = (t.history || []).filter(x => x.status && x.status !== "Done").pop();
      const progress = before && before.progress < 100 ? before.progress : 90;
      await write(db => db.doc(P("tasks", t)).update({ status: "In progress", progress, doneAt: "",
        history: [...(t.history || []), { date, status: "In progress", progress, remark: "Marked as not done by supervisor", via: "edit", by: S.uid, byName: S.myName, byRole: S.myRole }] }), "Task reopened: marked as not done");
    } else {
      await write(db => db.doc(P("tasks", t)).update({ status: "Done", progress: 100, doneAt: date,
        history: [...(t.history || []), { date, status: "Done", progress: 100, remark: "Marked as done", via: "edit", by: S.uid, byName: S.myName, byRole: S.myRole }] }), "Task marked as done");
    }
  };
  return btn;
}
function editForm(t) {
  const id = t.id, st = statusOf(t);
  const out = h("output", { text: (isDone(t) ? 100 : (t.progress || 0)) + "%" });
  const range = h("input", { type: "range", id: "ep-" + id, min: "0", max: "100", step: "5", value: String(isDone(t) ? 100 : (t.progress || 0)), oninput: e => out.textContent = e.target.value + "%" });
  const sel = h("select", { id: "es-" + id, onchange: e => { if (e.target.value === "Done") { range.value = "100"; out.textContent = "100%"; } } }, STATUSES.map(x => h("option", { value: x, text: x })));
  sel.value = st;
  let armed = null;
  const del = h("button", { class: "x", type: "button", text: "Delete task" });
  del.onclick = () => {
    if (!armed) { del.textContent = "Confirm delete"; armed = setTimeout(() => { armed = null; del.textContent = "Delete task"; }, 4000); return; }
    clearTimeout(armed); S.openTasks.delete(id); write(db => db.doc(P("tasks", t)).delete(), "Task deleted");
  };
  return h("form", { class: "edit-box", onsubmit: async e => {
      e.preventDefault();
      const status = sel.value, progress = status === "Done" ? 100 : Number(range.value), date = val("ed-" + id) || todayStr(), remark = val("er-" + id).trim();
      const due = val("eu-" + id), details = val("et-" + id).trim();
      const entry = { date, status, progress, remark, via: "edit", by: S.uid, byName: S.myName, byRole: S.myRole };
      const changedProgress = status !== st || progress !== (t.progress || 0) || remark;
      const patch = { status, progress, due, details, doneAt: status === "Done" ? (isDone(t) && t.doneAt ? t.doneAt : date) : "" };
      if (changedProgress) patch.history = [...(t.history || []), entry];
      await write(db => db.doc(P("tasks", t)).update(patch), "Task updated");
    } },
    h("h4", { text: "Update this task" }),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Status", sel),
      h("label", { class: "fieldlabel" }, "Progress", h("div", { class: "u-prog", style: "display:flex;gap:8px;align-items:center" }, range, out)),
      h("label", { class: "fieldlabel" }, "As of", h("input", { type: "date", id: "ed-" + id, value: todayStr() }))),
    h("label", { class: "fieldlabel" }, S.isOwner ? "Supervisor feedback (highlighted for the student)" : "Remark", h("input", { id: "er-" + id, maxlength: "500", placeholder: "What was done, what's pending" })),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Due date", h("input", { type: "date", id: "eu-" + id, value: t.due || "" })),
      h("label", { class: "fieldlabel" }, "Details", h("input", { id: "et-" + id, value: t.details || "", maxlength: "2000" }))),
    h("div", { class: "row", style: "align-items:center" }, h("div", null, h("button", { class: "btn", type: "submit", text: "Save update" })), h("div", { style: "text-align:right" }, S.isOwner ? del : null)));
}

/* task-wise rows in the meeting form; rebuilt only when the set of open tasks changes, keeping typed values */
let updSig = null;
function refreshUpdRows(s) {
  const open = tasksOf(s.id).filter(t => !isDone(t)).sort(sortTasks);
  const sig = open.map(t => t.id).join(",");
  if (sig === updSig) return; updSig = sig;
  const keep = {};
  document.querySelectorAll("#upd-list [data-tid]").forEach(r => { const id = r.dataset.tid; keep[id] = { s: val("us-" + id), p: val("up-" + id), r: val("ur-" + id), touched: r.dataset.touched }; });
  const list = document.getElementById("upd-list"); if (!list) return;
  if (!open.length) { list.replaceChildren(h("p", { class: "note", text: "No open tasks to update. Add new tasks below." })); return; }
  list.replaceChildren(...open.map(t => {
    const k = keep[t.id], cur = isDone(t) ? 100 : (t.progress || 0);
    const pv = k && k.touched ? k.p : String(cur);
    const out = h("output", { text: pv + "%" });
    const row = h("div", { class: "upd", "data-tid": t.id });
    const mark = () => row.dataset.touched = "1";
    const range = h("input", { type: "range", id: "up-" + t.id, min: "0", max: "100", step: "5", value: pv, "aria-label": "Progress for " + t.title, oninput: e => { out.textContent = e.target.value + "%"; mark(); } });
    const sel = h("select", { id: "us-" + t.id, "aria-label": "Status for " + t.title, onchange: e => { mark(); if (e.target.value === "Done") { range.value = "100"; out.textContent = "100%"; } } }, STATUSES.map(x => h("option", { value: x, text: x })));
    sel.value = k && k.touched ? k.s : statusOf(t);
    if (k && k.touched) row.dataset.touched = "1";
    row.append(
      h("div", { class: "m-top" }, h("span", { class: "u-title", text: t.title }), h("span", { class: "who", text: "Day " + (metrics(t).elapsed + 1) + " · " + statusOf(t) + " · " + cur + "% · " + metrics(t).timing })),
      h("div", { class: "u-grid" }, sel, h("div", { class: "u-prog" }, range, out)),
      h("input", { id: "ur-" + t.id, placeholder: "Remark for this task", maxlength: "500", value: k ? k.r : "", oninput: mark, "aria-label": "Remark for " + t.title }));
    return row;
  }));
}
function showTab() {
  document.querySelectorAll(".tabs [data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === S.tab ? "true" : "false"));
  document.querySelectorAll("[data-pane]").forEach(p => p.hidden = p.dataset.pane !== S.tab);
}
let pupdSig = null;
function refreshPaperRows(s) {
  const act = papersOf(s.id).filter(pActive);
  const sig = act.map(p => p.id).join(",");
  if (sig === pupdSig) return; pupdSig = sig;
  const keep = {};
  document.querySelectorAll("#pupd-list [data-pid]").forEach(r => { const id = r.dataset.pid; keep[id] = { s: val("mps-" + id), r: val("mpr-" + id), touched: r.dataset.touched }; });
  const list = document.getElementById("pupd-list"); if (!list) return;
  if (!act.length) { list.replaceChildren(h("p", { class: "note", text: "No papers in progress. Add papers in the Publications tab." })); return; }
  list.replaceChildren(...act.map(p => {
    const k = keep[p.id], row = h("div", { class: "upd", "data-pid": p.id }), mark = () => row.dataset.touched = "1";
    const sel = h("select", { id: "mps-" + p.id, "aria-label": "Status for " + p.title, onchange: mark }, PSTATUS.map(x => h("option", { value: x, text: pLabel(x) })));
    sel.value = k && k.touched ? k.s : pStatus(p);
    if (k && k.touched) row.dataset.touched = "1";
    row.append(
      h("div", { class: "m-top" }, h("span", { class: "u-title", text: p.title }), h("span", { class: "who", text: (pStatus(p) === "Currently writing" ? "Draft" : pStatus(p)) + " · " + pMetrics(p).reviewLabel })),
      h("div", { class: "u-grid" }, sel, h("input", { id: "mpr-" + p.id, placeholder: "Remark, e.g. revision plan agreed", maxlength: "500", value: k ? k.r : "", oninput: mark, "aria-label": "Remark for " + p.title })));
    return row;
  }));
}
async function submitMeeting(s, f) {
  const date = val("nm-date") || todayStr(), notes = val("nm-notes").trim(), next = val("nm-next");
  const open = tasksOf(s.id).filter(t => !isDone(t));
  const updates = [];
  for (const t of open) {
    const status = val("us-" + t.id) || statusOf(t), progress = status === "Done" ? 100 : Number(val("up-" + t.id) || t.progress || 0), remark = val("ur-" + t.id).trim();
    if (status !== statusOf(t) || progress !== (t.progress || 0) || remark)
      updates.push({ taskId: t.id, title: t.title, prevStatus: statusOf(t), status, prevProgress: t.progress || 0, progress, remark, day: Math.max(0, diff(startOf(t), date)), t });
  }
  const pupdates = [];
  for (const p of papersOf(s.id).filter(pActive)) {
    const status = val("mps-" + p.id) || pStatus(p), remark = val("mpr-" + p.id).trim();
    if (status !== pStatus(p) || remark) pupdates.push({ paperId: p.id, title: p.title, prevStatus: pStatus(p), status, remark, p });
  }
  const actions = val("nm-actions").split("\n").map(x => x.trim()).filter(Boolean), due = val("nm-due");
  if (!notes && !updates.length && !pupdates.length && !actions.length) { say("Add notes, a task or paper update, or a new task first."); return; }
  const ok = await write(async db => {
    const newTasks = [];
    for (const a of actions) {
      const ref = await db.collection(C("tasks", s.id)).add({ studentId: s.id, title: a, details: "", owner: "student", assigned: date, due, status: "Not started", progress: 0, doneAt: "",
        createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole, fromMeeting: date, history: [{ date, status: "Not started", progress: 0, remark: "Assigned in meeting", via: "assigned", by: S.uid, byName: S.myName, byRole: S.myRole }] });
      newTasks.push({ taskId: ref.id, title: a, due });
    }
    for (const u of updates) {
      const t = u.t;
      await db.doc(P("tasks", t)).update({ status: u.status, progress: u.progress, doneAt: u.status === "Done" ? date : "",
        history: [...(t.history || []), { date, status: u.status, progress: u.progress, remark: u.remark, via: "meeting", by: S.uid, byName: S.myName, byRole: S.myRole }] });
    }
    for (const u of pupdates) {
      const p = u.p;
      await db.doc(P("papers", p)).update({ status: u.status, ...(u.status !== u.prevStatus ? { statusSince: date, ...stampDates(p, u.status, date) } : {}),
        history: [...(p.history || []), { date, status: u.status, remark: u.remark, via: "meeting", by: S.uid, byName: S.myName, byRole: S.myRole }] });
    }
    await db.collection(C("meetings", s.id)).add({ studentId: s.id, date, next, notes, createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole,
      updates: updates.map(({ t, ...u }) => u), paperUpdates: pupdates.map(({ p, ...u }) => u), newTasks });
  }, "Meeting saved: " + plural(updates.length, "task update") + ", " + plural(pupdates.length, "paper update") + ", " + plural(actions.length, "new task"));
  if (ok) {
    pupdSig = null; document.getElementById("pupd-list").replaceChildren(); refreshPaperRows(s);
    ["nm-notes", "nm-actions", "nm-due", "nm-next"].forEach(id => document.getElementById(id).value = "");
    document.getElementById("nm-date").value = todayStr();
    updSig = null; document.getElementById("upd-list").replaceChildren(); refreshUpdRows(s);
  }
}

function meetingItem(m) {
  const ups = m.updates || [], nts = m.newTasks || [];
  return h("li", { class: "meeting" },
    h("div", { class: "m-top" }, h("span", { class: "m-date", text: fmtD(m.date) }),
      h("span", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap" }, m.next ? h("span", { class: "chip plain", text: "Next: " + fmtD(m.next) }) : null,
        h("span", { class: "who", text: m.byName ? "by " + m.byName : "" }),
        S.canWrite ? h("button", { class: "x", type: "button", text: "Delete", "aria-label": "Delete meeting record", onclick: () => write(db => db.doc(P("meetings", m)).delete(), "Meeting record deleted") }) : null)),
    m.notes ? (bySup(m) ? h("div", { class: "fb" }, h("span", { class: "fb-tag", text: "Supervisor feedback" }), h("p", { class: "notes", text: m.notes })) : h("p", { class: "notes", text: m.notes })) : null,
    ups.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Task", "Day", "Status", "Progress", "Remark"].map(x => h("th", { text: x })))),
      h("tbody", null, ups.map(u => h("tr", null,
        h("td", null, S.tasks.some(t => t.id === u.taskId) ? h("button", { class: "linkish", type: "button", text: u.title, onclick: () => focusTask(u.taskId) }) : h("span", { text: u.title })),
        h("td", { class: "num", text: u.day != null ? String(u.day) : "—" }),
        h("td", null, u.prevStatus !== u.status ? [statusChip(u.prevStatus), h("span", { class: "arrow", text: "→" })] : null, statusChip(u.status)),
        h("td", { class: "num", text: (u.prevProgress !== u.progress ? u.prevProgress + "% → " : "") + u.progress + "%" }),
        h("td", { class: bySup(m) && u.remark ? "fb-cell" : "", text: u.remark || "—" })))))) : null,
    (m.paperUpdates || []).length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Paper", "Status", "Remark"].map(x => h("th", { text: x })))),
      h("tbody", null, m.paperUpdates.map(u => h("tr", null,
        h("td", null, S.papers.some(p => p.id === u.paperId) ? h("button", { class: "linkish", type: "button", text: u.title, onclick: () => focusPaper(u.paperId) }) : h("span", { text: u.title })),
        h("td", null, u.prevStatus !== u.status ? [pChip(u.prevStatus), h("span", { class: "arrow", text: "→" })] : null, pChip(u.status)),
        h("td", { class: bySup(m) && u.remark ? "fb-cell" : "", text: u.remark || "—" })))))) : null,
    nts.length ? h("div", null, h("div", { class: "label", text: "New tasks assigned" }),
      h("ul", { style: "margin:4px 0 0;padding-left:18px" }, nts.map(n => h("li", null, n.title, n.due ? h("span", { class: "who", text: " · due " + fmtD(n.due) }) : null)))) : null);
}
/* ---------- upcoming conferences (shared by the whole group) ---------- */
let confPanel = null;
function confPanelEl() {
  if (confPanel) return confPanel;
  const form = h("form", { class: "edit-box", onsubmit: async e => {
      e.preventDefault();
      const name = val("nc-name").trim(); let url = val("nc-url").trim(); const deadline = val("nc-deadline");
      if (!name || !deadline) { say("Add the conference name and its deadline."); return; }
      if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
      const ok = await write(db => db.collection("conferences").add({ name, url, deadline, note: val("nc-note").trim(), createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole }), "Conference added for everyone");
      if (ok) ["nc-name", "nc-url", "nc-deadline", "nc-note"].forEach(id => document.getElementById(id).value = "");
    } },
    h("h4", { text: "Add a conference" }),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Conference name", h("input", { id: "nc-name", maxlength: "200", placeholder: "e.g. IEEE ICASSP 2027" })),
      h("label", { class: "fieldlabel" }, "Submission deadline", h("input", { id: "nc-deadline", type: "date" }))),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Website (URL)", h("input", { id: "nc-url", maxlength: "500", placeholder: "https://…" })),
      h("label", { class: "fieldlabel" }, "Note (optional)", h("input", { id: "nc-note", maxlength: "300", placeholder: "Location, dates, who plans to submit" }))),
    h("div", null, h("button", { class: "btn", type: "submit", text: "Add conference" })));
  confPanel = h("section", { class: "panel sec-conf" },
    h("div", { class: "panel-head" }, h("h3", { text: "Upcoming conferences" }), h("span", { class: "muted", id: "conf-count" })),
    h("p", { class: "note", text: "Shared with everyone in the group. Anyone can add a conference; you can remove the ones you added." }),
    h("ul", { class: "refs", id: "conf-list" }), form);
  return confPanel;
}
function confItem(c) {
  const left = c.deadline ? diff(todayStr(), c.deadline) : null;
  const chip = left == null ? h("span", { class: "chip plain", text: "No deadline" })
    : left < 0 ? h("span", { class: "chip plain", text: "Deadline passed" })
    : h("span", { class: "chip " + (left <= 7 ? "bad" : left <= 30 ? "warn" : "good"), text: left === 0 ? "Due today" : plural(left, "day") + " left" });
  let host = ""; try { host = c.url ? new URL(c.url).hostname.replace(/^www\./, "") : ""; } catch (e) { host = ""; }
  const canDelete = S.isOwner || c.createdBy === S.uid;
  let armed = null;
  const del = canDelete ? h("button", { class: "x", type: "button", text: "Remove" }) : null;
  if (del) del.onclick = () => { if (!armed) { del.textContent = "Confirm remove"; armed = setTimeout(() => { armed = null; del.textContent = "Remove"; }, 4000); return; } clearTimeout(armed); write(db => db.doc("conferences/" + c.id).delete(), "Conference removed"); };
  return h("li", { class: "ref conf" + (left != null && left < 0 ? " past" : "") },
    h("div", { class: "conf-date" }, h("b", { text: c.deadline ? parseD(c.deadline).getDate() : "—" }), h("span", { text: c.deadline ? parseD(c.deadline).toLocaleDateString("en-IN", { month: "short", year: "numeric" }) : "" })),
    h("div", { style: "min-width:0;flex:1" },
      c.url ? h("a", { class: "ref-title", href: c.url, target: "_blank", rel: "noopener", text: c.name }) : h("span", { class: "ref-title", text: c.name }),
      h("div", { class: "t-sub" }, chip, host ? h("span", { class: "mono", text: host }) : null, h("span", { class: "who", text: c.byName ? "added by " + c.byName : "" })),
      c.note ? h("p", { class: "ref-note", text: c.note }) : null),
    del);
}
/* ---------- scheduled meetings (supervisor plans; each invited student gets a copy in their own record) ---------- */
function nowKey() { const d = new Date(); return todayStr() + "T" + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function schedKey(x) { return (x.date || "") + "T" + (x.time || "23:59"); }
/** One entry per meeting (the copies share a groupId); optionally only those that include one student. */
function allSched(sid) {
  const by = new Map();
  for (const x of S.schedule || []) { if (sid && x.studentId !== sid) continue; const k = x.groupId || x.id; if (!by.has(k)) by.set(k, { ...x, copies: [] }); by.get(k).copies.push(x); }
  return [...by.values()].sort((a, b) => schedKey(a).localeCompare(schedKey(b)));
}
function upcomingSched(sid) { const now = nowKey(); return allSched(sid).filter(x => schedKey(x) >= now); }
function fmtTime(t) { if (!t) return ""; const [hh, mm] = t.split(":").map(Number); const ap = hh >= 12 ? "PM" : "AM"; return ((hh % 12) || 12) + ":" + String(mm).padStart(2, "0") + " " + ap; }
function whenText(x) { const d = diff(todayStr(), x.date); return (d === 0 ? "Today" : d === 1 ? "Tomorrow" : parseD(x.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })) + (x.time ? ", " + fmtTime(x.time) : ""); }
function nextBanner(x) {
  return h("div", { class: "next-meet" },
    h("div", null, h("div", { class: "label", text: "Next meeting" + (x.kind === "group" ? " · group" : "") }), h("b", { text: whenText(x) }), x.agenda ? h("div", { class: "ref-note", text: x.agenda.split("\n")[0] }) : null),
    x.link ? h("a", { class: "btn small", href: x.link, target: "_blank", rel: "noopener", text: "Join ↗" }) : null);
}
function schedItem(x, showPeople) {
  const names = (x.attendees || []).map(k => studentName(k));
  let armed = null;
  const cancel = S.isOwner ? h("button", { class: "x", type: "button", text: "Cancel meeting" }) : null;
  if (cancel) cancel.onclick = () => {
    if (!armed) { cancel.textContent = "Confirm cancel"; armed = setTimeout(() => { armed = null; cancel.textContent = "Cancel meeting"; }, 4000); return; }
    clearTimeout(armed);
    write(async db => { for (const c of x.copies) await db.doc("students/" + c.studentId + "/schedule/" + c.id).delete(); }, "Meeting cancelled");
  };
  const d = diff(todayStr(), x.date);
  return h("li", { class: "ref sched" + (schedKey(x) < nowKey() ? " past" : "") },
    h("div", { class: "conf-date sched-date" }, h("b", { text: parseD(x.date).getDate() }), h("span", { text: parseD(x.date).toLocaleDateString("en-IN", { month: "short" }) + (x.time ? " · " + fmtTime(x.time) : "") })),
    h("div", { style: "min-width:0;flex:1" },
      h("div", { class: "t-sub", style: "margin-top:0" }, h("span", { class: "chip " + (x.kind === "group" ? "" : "plain"), text: x.kind === "group" ? "Group meeting" : "Individual meeting" }),
        d >= 0 && d <= 1 ? h("span", { class: "chip warn", text: d === 0 ? "Today" : "Tomorrow" }) : null,
        x.location ? h("span", { class: "who", text: x.location }) : null),
      x.agenda ? h("p", { class: "sched-agenda", text: x.agenda }) : h("p", { class: "note", text: "No agenda given." }),
      showPeople ? h("div", { class: "who", text: "With: " + (x.everyone ? "all students" : names.join(", ")) }) : null),
    h("div", { style: "display:grid;gap:6px;justify-items:end" },
      x.link ? h("a", { class: "btn small", href: x.link, target: "_blank", rel: "noopener", text: "Join ↗" }) : null, cancel));
}
/* ---------- supervisor's own tasks and reminders (stored under supervisor/me, never shown to students) ---------- */
function itemKey(x) { return (x.date || "9999-12-31") + "T" + (x.time || "23:59"); }
function mineBuckets() {
  const now = nowKey(), today = todayStr();
  // the supervisor's own items, plus upcoming meetings scheduled with students (read-only)
  const sched = upcomingSched().map(x => ({ ...x, id: "s-" + (x.groupId || x.id), kind: "meeting", title: (x.kind === "group" ? "Group meeting" : "Meeting with " + (x.attendees || []).map(studentName).join(", ")), fromSchedule: true }));
  const open = [...(S.mine || []).filter(x => !x.done), ...sched].sort((a, b) => itemKey(a).localeCompare(itemKey(b)));
  return {
    overdue: open.filter(x => x.date && (x.time ? itemKey(x) < now : x.date < today) && !x.fromSchedule),
    today: open.filter(x => x.date === today && !(x.time && itemKey(x) < now && !x.fromSchedule)),
    upcoming: open.filter(x => x.date && x.date > today),
    nodate: open.filter(x => !x.date),
    done: (S.mine || []).filter(x => x.done).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""))
  };
}
function mineMeta() {
  const b = mineBuckets();
  if (!b.overdue.length && !b.today.length) return [h("span", { text: (S.mine || []).filter(x => !x.done).length ? "Nothing due today" : "Your own to-do list" })];
  return [b.today.length ? h("span", { class: "chip warn", text: b.today.length + " today" }) : null, b.overdue.length ? h("span", { class: "chip bad", text: b.overdue.length + " overdue" }) : null];
}
function mineItem(x) {
  const isRem = x.kind === "reminder", isMeet = x.kind === "meeting";
  const when = x.date ? whenText(x) : "No date";
  const tick = isMeet ? h("span", { class: "mine-icon", text: "◷", title: "Scheduled meeting" }) : h("input", { type: "checkbox", class: "mine-tick", checked: !!x.done, "aria-label": "Mark done",
    onchange: e => write(db => db.doc("supervisor/me/items/" + x.id).update({ done: e.target.checked, doneAt: e.target.checked ? todayStr() : "" }), e.target.checked ? "Done" : "Moved back to open") });
  let armed = null;
  const del = isMeet ? null : h("button", { class: "x", type: "button", text: "Delete" });
  if (del) del.onclick = () => { if (!armed) { del.textContent = "Confirm delete"; armed = setTimeout(() => { armed = null; del.textContent = "Delete"; }, 4000); return; } clearTimeout(armed); write(db => db.doc("supervisor/me/items/" + x.id).delete(), "Deleted"); };
  return h("li", { class: "mine" + (x.done ? " is-done" : "") + (isRem ? " is-rem" : "") + (isMeet ? " is-meet" : "") },
    tick,
    h("div", { style: "min-width:0;flex:1" },
      h("div", { class: "mine-title", text: x.title }),
      h("div", { class: "t-sub" }, h("span", { class: "chip " + (isRem ? "warn" : isMeet ? "" : "plain"), text: isRem ? "Reminder" : isMeet ? "Scheduled meeting" : "Task" }), h("span", { class: "mono", text: when }),
        x.location ? h("span", { class: "who", text: x.location }) : null),
      (x.notes || x.agenda) ? h("p", { class: "ref-note", text: x.notes || x.agenda }) : null),
    h("div", { style: "display:grid;gap:6px;justify-items:end" },
      x.link ? h("a", { class: "btn small", href: x.link, target: "_blank", rel: "noopener", text: "Join ↗" }) : null, del));
}
let mineEl = null;
function minePage() {
  if (mineEl) return mineEl;
  const kind = h("select", { id: "nm2-kind", onchange: e => { mineEl.querySelector("#nm2-link-row").hidden = e.target.value !== "reminder"; } },
    h("option", { value: "task", text: "Task (something to do)" }), h("option", { value: "reminder", text: "Reminder (a meeting or event to attend)" }));
  const form = h("form", { class: "edit-box", onsubmit: async e => {
      e.preventDefault();
      const title = val("nm2-title").trim(), k = kind.value, date = val("nm2-date"), time = val("nm2-time");
      let link = val("nm2-link").trim(); if (link && !/^https?:\/\//i.test(link)) link = "https://" + link;
      if (!title) { say("Write what the task or reminder is."); return; }
      if (k === "reminder" && !date) { say("A reminder needs a date (and usually a time)."); return; }
      const ok = await write(db => db.collection("supervisor/me/items").add({ kind: k, title, date, time, link: k === "reminder" ? link : "", location: val("nm2-loc").trim(), notes: val("nm2-notes").trim(), done: false, doneAt: "", createdAt: Date.now() }),
        k === "reminder" ? "Reminder added" : "Task added");
      if (ok) ["nm2-title", "nm2-time", "nm2-link", "nm2-loc", "nm2-notes"].forEach(id => document.getElementById(id).value = "");
    } },
    h("h4", { text: "Add a task or reminder" }),
    h("div", { class: "row" }, h("label", { class: "fieldlabel" }, "Type", kind),
      h("label", { class: "fieldlabel" }, "Date", h("input", { id: "nm2-date", type: "date", value: todayStr() })),
      h("label", { class: "fieldlabel" }, "Time (optional)", h("input", { id: "nm2-time", type: "time" }))),
    h("label", { class: "fieldlabel" }, "What", h("input", { id: "nm2-title", maxlength: "300", placeholder: "e.g. Review Priya's chapter 3 · Attend faculty meeting · Send DC report" })),
    h("div", { class: "row", id: "nm2-link-row", hidden: true },
      h("label", { class: "fieldlabel" }, "Meeting link (optional)", h("input", { id: "nm2-link", type: "text", inputmode: "url", maxlength: "500", placeholder: "https://meet.google.com/…" })),
      h("label", { class: "fieldlabel" }, "Room / place (optional)", h("input", { id: "nm2-loc", maxlength: "120", placeholder: "e.g. Senate Hall" }))),
    h("label", { class: "fieldlabel" }, "Notes (optional)", h("input", { id: "nm2-notes", maxlength: "500" })),
    h("div", null, h("button", { class: "btn", type: "submit", text: "Add" })));
  mineEl = h("div", { class: "tabpane" },
    h("section", { class: "panel sec-mine" },
      h("div", { class: "panel-head" }, h("h3", { text: "My tasks & reminders" }), h("span", { class: "muted", id: "mine-count" })),
      h("p", { class: "note", text: "Only you can see this list. Meetings you've scheduled with students are included automatically." }),
      form, h("div", { id: "mine-list", class: "mine-groups" })));
  return mineEl;
}
function refreshMine() {
  const box = document.getElementById("mine-list"); if (!box) return;
  const b = mineBuckets();
  const group = (label, list, cls) => list.length ? [h("div", { class: "task-group mine-head " + (cls || ""), }, h("span", { text: label }), h("span", { class: "mono", text: String(list.length) })), h("ul", { class: "refs" }, list.map(mineItem))] : [];
  const parts = [...group("Overdue", b.overdue, "bad"), ...group("Today", b.today, "warn"), ...group("Upcoming", b.upcoming), ...group("No date", b.nodate)];
  if (b.done.length) parts.push(h("details", { class: "sub" }, h("summary", { text: plural(b.done.length, "completed item") }), h("ul", { class: "refs", style: "margin-top:8px" }, b.done.slice(0, 50).map(mineItem))));
  box.replaceChildren(...(parts.length ? parts : [h("p", { class: "note", text: "Nothing yet. Add a task or reminder above." })]));
  document.getElementById("mine-count").textContent = (b.today.length ? b.today.length + " today · " : "") + (b.upcoming.length + b.nodate.length) + " upcoming";
}
/** Group overview: what needs attention today. */
function todayPanel() {
  const b = mineBuckets(), list = [...b.overdue, ...b.today];
  if (!list.length) return null;
  return h("section", { class: "panel sec-mine today-box" },
    h("div", { class: "panel-head" }, h("h3", { text: "Today" }), h("button", { class: "linkish", type: "button", text: "Open my tasks & reminders →", onclick: () => select("__mine") })),
    h("ul", { class: "refs" }, list.slice(0, 8).map(mineItem)));
}
let schedEl = null;
function schedPage() {
  if (schedEl) { refreshPicker(); return schedEl; }
  const kind = h("select", { id: "ns-kind", onchange: () => refreshPicker() }, h("option", { value: "individual", text: "Individual (one student)" }), h("option", { value: "group", text: "Group (several or all students)" }));
  const form = h("form", { class: "edit-box", onsubmit: async e => {
      e.preventDefault();
      const k = kind.value, date = val("ns-date"), time = val("ns-time"), agenda = val("ns-agenda").trim(), location = val("ns-loc").trim();
      let link = val("ns-link").trim(); if (link && !/^https?:\/\//i.test(link)) link = "https://" + link;
      const everyone = k === "group" && document.getElementById("ns-all").checked;
      const people = k === "individual" ? [val("ns-one")].filter(Boolean) : everyone ? S.students.map(s => s.id) : [...document.querySelectorAll("#ns-people input:checked")].map(i => i.value);
      if (!date || !time) { say("Choose the date and time."); return; }
      if (!people.length) { say(k === "individual" ? "Choose the student." : "Choose at least one student, or tick All students."); return; }
      if (k === "group" && !everyone && people.length < 2) { say("A group meeting needs two or more students. Use Individual for one student."); return; }
      const groupId = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const data = { groupId, kind: k, everyone, attendees: people, date, time, agenda, link, location, createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole };
      const ok = await write(async db => { for (const sid of people) await db.doc("students/" + sid + "/schedule/" + groupId).set({ ...data, studentId: sid }); },
        (k === "group" ? "Group meeting" : "Meeting") + " scheduled. " + (people.length === 1 ? "The student sees it" : plural(people.length, "student") + " see it") + " on their page.");
      if (ok) { ["ns-agenda", "ns-link", "ns-loc", "ns-time"].forEach(id => document.getElementById(id).value = ""); }
    } },
    h("h4", { text: "Schedule a meeting" }),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Meeting type", kind),
      h("label", { class: "fieldlabel" }, "Date", h("input", { id: "ns-date", type: "date", value: todayStr() })),
      h("label", { class: "fieldlabel" }, "Time", h("input", { id: "ns-time", type: "time" }))),
    h("div", { id: "ns-who" }),
    h("label", { class: "fieldlabel" }, "Agenda", h("textarea", { id: "ns-agenda", rows: "3", maxlength: "2000", placeholder: "1. Progress on chapter 3\n2. Conference submission plan\n3. Any other business" })),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Online meeting link (Google Meet, Zoom, Teams)", h("input", { id: "ns-link", type: "text", inputmode: "url", maxlength: "500", placeholder: "https://meet.google.com/…" })),
      h("label", { class: "fieldlabel" }, "Room / place (optional)", h("input", { id: "ns-loc", maxlength: "120", placeholder: "e.g. Lab 204, or Online" }))),
    h("div", null, h("button", { class: "btn", type: "submit", text: "Schedule meeting" })));
  schedEl = h("div", { class: "tabpane" },
    h("section", { class: "panel sec-meet" },
      h("div", { class: "panel-head" }, h("h3", { text: "Scheduled meetings" }), h("span", { class: "muted", id: "sched-count" })),
      h("p", { class: "note", text: "Invited students see the date, time, agenda and Join link on their own page. Each student only sees meetings they're invited to." }),
      h("ul", { class: "refs", id: "sched-list" }), form));
  refreshPicker();
  return schedEl;
}
function refreshPicker() {
  const box = schedEl && schedEl.querySelector("#ns-who"); if (!box) return;
  const kind = val("ns-kind") || "individual", studs = [...S.students].sort((a, b) => a.name.localeCompare(b.name));
  if (box.dataset.sig === kind + "|" + studs.map(s => s.id).join(",")) return;
  box.dataset.sig = kind + "|" + studs.map(s => s.id).join(",");
  if (!studs.length) { box.replaceChildren(h("p", { class: "note", text: "No students yet. They appear here once they register." })); return; }
  if (kind === "individual") { box.replaceChildren(h("label", { class: "fieldlabel" }, "Student", h("select", { id: "ns-one" }, studs.map(s => h("option", { value: s.id, text: s.name + (s.admissionNo ? " (" + s.admissionNo + ")" : "") }))))); return; }
  const all = h("input", { type: "checkbox", id: "ns-all", checked: true, onchange: e => { box.querySelector("#ns-people").hidden = e.target.checked; } });
  box.replaceChildren(h("div", { class: "fieldlabel" }, "Students",
    h("label", { class: "check" }, all, " All students (" + studs.length + ")"),
    h("div", { id: "ns-people", class: "people", hidden: true }, studs.map(s => h("label", { class: "check" }, h("input", { type: "checkbox", value: s.id }), " " + s.name)))));
}
function refreshSched() {
  const list = document.getElementById("sched-list"); if (!list) return;
  refreshPicker();
  const all = allSched(), now = nowKey(), up = all.filter(x => schedKey(x) >= now), past = all.filter(x => schedKey(x) < now).reverse();
  document.getElementById("sched-count").textContent = up.length + " upcoming";
  list.replaceChildren(...(up.length ? up.map(x => schedItem(x, true)) : [h("li", null, h("p", { class: "note", text: "Nothing scheduled. Add a meeting below." }))]),
    ...(past.length ? [h("li", null, h("details", { class: "sub" }, h("summary", { text: plural(past.length, "past meeting") }), h("ul", { class: "refs", style: "margin-top:8px" }, past.slice(0, 30).map(x => schedItem(x, true)))))] : []));
}

function refreshConfs() {
  const list = document.getElementById("conf-list"); if (!list) return;
  const all = [...(S.confs || [])];
  const up = all.filter(c => !c.deadline || diff(todayStr(), c.deadline) >= 0).sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999"));
  const past = all.filter(c => c.deadline && diff(todayStr(), c.deadline) < 0).sort((a, b) => b.deadline.localeCompare(a.deadline));
  document.getElementById("conf-count").textContent = up.length + " upcoming" + (past.length ? " · " + past.length + " past" : "");
  list.replaceChildren(...(up.length ? up.map(confItem) : [h("li", null, h("p", { class: "note", text: "No upcoming conferences yet. Add one below." }))]),
    ...(past.length ? [h("li", null, h("details", { class: "sub" }, h("summary", { text: plural(past.length, "past conference") }), h("ul", { class: "refs", style: "margin-top:8px" }, past.map(confItem))))] : []));
  const n = document.getElementById("tabn-confs"); if (n) n.textContent = up.length;
}

function refItem(r) {
  let host = ""; try { host = r.link ? new URL(r.link).hostname.replace(/^www\./, "") : ""; } catch (e) { host = ""; }
  const canDelete = S.isOwner || r.createdBy === S.uid;
  let armed = null;
  const del = canDelete ? h("button", { class: "x", type: "button", text: "Remove" }) : null;
  if (del) del.onclick = () => { if (!armed) { del.textContent = "Confirm remove"; armed = setTimeout(() => { armed = null; del.textContent = "Remove"; }, 4000); return; } clearTimeout(armed); write(db => db.doc(P("refs", r)).delete(), "Removed from the list"); };
  return h("li", { class: "ref" + (bySup(r) ? " ref-sup" : "") },
    h("div", { style: "min-width:0" },
      r.link ? h("a", { class: "ref-title", href: r.link, target: "_blank", rel: "noopener", text: r.title }) : h("span", { class: "ref-title", text: r.title }),
      h("div", { class: "t-sub" }, host ? h("span", { class: "mono", text: host }) : h("span", { text: "No link" }), h("span", { text: "Added " + fmtD(r.added) }),
        h("span", { class: bySup(r) ? "chip fbchip" : "who", text: bySup(r) ? "Suggested by supervisor" : (r.byName ? "by " + r.byName : "") })),
      r.note ? h("p", { class: "ref-note", text: r.note }) : null),
    del);
}
function focusPaper(id) { S.openPapers.add(id); S.tab = "papers"; showTab(); const s = S.students.find(x => x.id === S.sel); if (s) refreshStudent(s); const el = document.getElementById("paper-" + id); if (el) { el.open = true; el.scrollIntoView({ block: "start" }); } }
function focusTask(id) { S.openTasks.add(id); S.tab = "tasks"; showTab(); const t = S.tasks.find(x => x.id === id); if (t && isDone(t) && S.filter === "open") S.filter = "all"; const s = S.students.find(x => x.id === S.sel); if (s) refreshStudent(s); const el = document.getElementById("task-" + id); if (el) { el.open = true; el.scrollIntoView({ block: "start" }); } }

function refreshStudent(s) {
  document.getElementById("s-name").textContent = s.name;
  const sel = document.getElementById("course-" + s.id); if (sel && document.activeElement !== sel) sel.value = courseOf(s);
  const mine = tasksOf(s.id), open = mine.filter(t => !isDone(t)), done = mine.filter(isDone), ms = S.meetings.filter(m => m.studentId === s.id);
  const avg = avgDays(mine), late = done.filter(t => metrics(t).late > 0).length, l = lastMeeting(s.id);
  const mySched = upcomingSched(s.id);
  const nextM = [...ms.map(m => m.next).filter(n => n && n >= todayStr()), ...mySched.map(x => x.date)].sort()[0];
  document.getElementById("next-banner").replaceChildren(...(mySched[0] ? [nextBanner(mySched[0])] : []));
  document.getElementById("stu-sched-count").textContent = mySched.length ? mySched.length + " upcoming" : "";
  document.getElementById("stu-sched").replaceChildren(...(mySched.length ? mySched.map(x => schedItem(x, false))
    : [h("li", null, h("p", { class: "note", text: S.isOwner ? "Nothing scheduled with this student. Use \"Scheduled meetings\" in the left column." : "No meetings scheduled. Your supervisor's invitations will appear here." }))]));
  document.getElementById("s-figs").replaceChildren(
    stat(open.length, "Open tasks"), stat(open.filter(isOverdue).length, "Overdue", open.filter(isOverdue).length), stat(done.length, "Completed"),
    stat(avg == null ? "—" : avg + "d", "Avg. days to finish"), stat(done.length ? (done.length - late) + "/" + done.length : "—", "Finished on time"),
    stat(pubCounts(papersOf(s.id)).draft, "Draft papers"), stat(pubCounts(papersOf(s.id)).submitted, "Submitted papers"), stat(pubCounts(papersOf(s.id)).accepted, "Accepted papers"),
    stat(ms.length, "Meetings"), stat(l ? diff(l, todayStr()) + "d" : "—", "Since last meeting"), stat(nextM ? fmtD(nextM) : "—", "Next meeting"));
  document.querySelectorAll("#task-filters button").forEach(b => b.setAttribute("aria-pressed", b.dataset.f === S.filter ? "true" : "false"));
  open.sort(sortTasks); done.sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));
  const groupHead = (label, n) => h("div", { class: "task-group" }, h("span", { text: label }), h("span", { class: "mono", text: String(n) }));
  let items;
  if (S.filter === "open") items = open.length ? open.map(taskCard) : [h("p", { class: "note", text: "No current tasks. Add one above or assign tasks in a meeting." })];
  else if (S.filter === "done") items = done.length ? done.map(taskCard) : [h("p", { class: "note", text: "No completed tasks yet." })];
  else items = [groupHead("Current", open.length), ...(open.length ? open.map(taskCard) : [h("p", { class: "note", text: "No current tasks." })]),
    groupHead("Completed", done.length), ...(done.length ? done.map(taskCard) : [h("p", { class: "note", text: "No completed tasks yet." })])];
  const tl = document.getElementById("task-list");
  const editing = tl.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (!editing) tl.replaceChildren(...items);
  refreshUpdRows(s);
  refreshPaperRows(s);
  const pp = papersOf(s.id).sort((a, b) => (pActive(b) - pActive(a)) || PSTATUS.indexOf(pStatus(b)) - PSTATUS.indexOf(pStatus(a)) || (b.createdAt || 0) - (a.createdAt || 0));
  const pl = document.getElementById("paper-list");
  const pEditing = pl.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (!pEditing && !S.dirtyPapers.size) {
    if (!pp.length) pl.replaceChildren(h("p", { class: "note", text: "No papers yet. Add the paper you're writing now with its Overleaf link, and any submitted or accepted papers with their venue." }));
    else pl.replaceChildren(...PSTAGES.flatMap(([k, label, test]) => {
      const g = pp.filter(p => test(pStatus(p)));
      if (!g.length && k === "rejected") return [];
      return [h("div", { class: "task-group pub-group pub-" + k }, h("span", { text: label }), h("span", { class: "mono", text: String(g.length) })),
        ...(g.length ? g.map(paperCard) : [h("p", { class: "note", text: k === "writing" ? "Nothing being written right now." : k === "review" ? "Nothing under review." : "None yet." })])];
    }));
  }
  const pub = pp.filter(p => pStatus(p) === "Published").length, rev = pp.filter(inReview).length;
  const writing = pp.filter(p => pStatus(p) === "Currently writing").length, acc = pp.filter(p => ["Accepted", "Published"].includes(pStatus(p))).length;
  document.getElementById("paper-count").replaceChildren(pubCounters(pp));
  const addBox = document.getElementById("paper-add"); if (addBox && !pp.length) addBox.open = true;
  document.getElementById("tabn-tasks").textContent = open.length;
  document.getElementById("tabn-papers").textContent = pp.length;
  document.getElementById("tabn-meetings").textContent = ms.length;
  const refs = (S.refs || []).filter(r => r.studentId === s.id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  document.getElementById("tabn-refs").textContent = refs.length;
  refreshConfs();
  document.getElementById("ref-count").textContent = plural(refs.length, "paper");
  document.getElementById("ref-list").replaceChildren(...(refs.length ? refs.map(refItem) : [h("li", null, h("p", { class: "note", text: "No papers listed yet. Add a title and link below." }))]));
  const sorted = ms.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
  document.getElementById("meet-count").textContent = plural(sorted.length, "meeting");
  document.getElementById("meet-list").replaceChildren(...(sorted.length ? sorted.map(meetingItem) : [h("li", null, h("p", { class: "note", text: "No meetings logged yet." }))]));
  resolveNames();
}
function resolveNames() { /* names are stored with each entry */ }
function bySup(x) { return !!x && (x.byRole === "supervisor" || x.byName === "Supervisor"); }
const AUTO_REMARKS = ["Task assigned", "Assigned in meeting", "Paper added", "Marked as done", "Marked as not done by supervisor"];
function remarkEl(x) {
  if (!x.remark) return null;
  if (bySup(x) && !AUTO_REMARKS.includes(x.remark)) return h("div", { class: "fb" }, h("span", { class: "fb-tag", text: "Supervisor feedback" }), h("p", { text: x.remark }));
  return h("p", { text: x.remark });
}
function latestFeedback(item) {
  const f = (item.history || []).filter(x => bySup(x) && x.remark && !AUTO_REMARKS.includes(x.remark)).sort((a, b) => (a.date || "").localeCompare(b.date || "")).pop();
  return f ? h("div", { class: "fb fb-inline" }, h("span", { class: "fb-tag", text: "Supervisor · " + fmtD(f.date) }), h("span", { text: f.remark })) : null;
}

let builtFor = null;
function renderDetail(force) {
  if (!S.isOwner && S.sel === null && S.loaded >= NCOLL && S.students.length) S.sel = S.students[0].id;
  if (S.sel === null) { builtFor = null; renderOverview(); return; }
  if (S.sel === "__mine") {
    if (builtFor !== "__mine" || force) { document.getElementById("detail").replaceChildren(minePage()); builtFor = "__mine"; }
    refreshMine(); return;
  }
  if (S.sel === "__sched") {
    if (builtFor !== "__sched" || force) { document.getElementById("detail").replaceChildren(schedPage()); builtFor = "__sched"; }
    refreshSched(); return;
  }
  if (S.sel === "__confs") {
    if (builtFor !== "__confs" || force) { document.getElementById("detail").replaceChildren(confPanelEl()); builtFor = "__confs"; }
    refreshConfs(); return;
  }
  const s = S.students.find(x => x.id === S.sel);
  if (!s) { if (S.loaded >= NCOLL) { S.sel = null; builtFor = null; renderOverview(); } return; }
  if (builtFor !== s.id || force) { buildStudent(s); builtFor = s.id; }
  refreshStudent(s);
}
function renderAll(force) {
  const y = window.scrollY, ae = document.activeElement && document.activeElement.id;
  renderStats(); renderRoster(); renderDetail(force);
  if (ae && document.activeElement && document.activeElement.id !== ae) { const el = document.getElementById(ae); if (el) el.focus({ preventScroll: true }); }
  if (Math.abs(window.scrollY - y) > 2) window.scrollTo({ top: y });
}
function select(id, taskId) { S.sel = id; builtFor = null; S.filter = "all"; renderAll(); window.scrollTo({ top: 0 }); if (taskId) focusTask(taskId); }

/* ---------- start-up: sign-in check, role, live data ---------- */
const subs = {};
function rebuildFlat() { for (const k of ["tasks", "meetings", "papers", "refs", "schedule"]) S[k] = Object.values(subs).flatMap(x => x.data[k] || []); }
function watchStudent(sid) {
  if (subs[sid]) return;
  const entry = subs[sid] = { data: {}, un: [] };
  for (const k of ["tasks", "meetings", "papers", "refs", "schedule"]) entry.un.push(S.db.collection(C(k, sid)).onSnapshot(snap => {
    entry.data[k] = snap.docs.map(doc => ({ ...doc.data(), id: doc.id, studentId: sid })); rebuildFlat(); renderAll();
  }, err => say("Couldn't load some " + k + ". Reload the page to try again.")));
}
function unwatchMissing() { for (const sid of Object.keys(subs)) if (!S.students.some(x => x.id === sid)) { subs[sid].un.forEach(u => u()); delete subs[sid]; rebuildFlat(); } }

export async function start(pageRole) {
  document.getElementById("signOutBtn").onclick = () => signOut();
  if (!configured) { S.loaded = NCOLL; setupNotice(document.getElementById("detail")); return; }
  const user = await currentUser();
  if (!user) { location.href = "index.html"; return; }
  const sup = isSupervisor(user);
  if (pageRole === "supervisor" && !sup) { location.href = "student.html"; return; }
  if (pageRole === "student" && sup) { location.href = "dashboard.html"; return; }
  S.db = db; S.uid = user.uid; S.isOwner = sup;
  S.myName = sup ? "Supervisor" : (user.displayName || "Student"); S.myRole = sup ? "supervisor" : "student";
  document.getElementById("whoami").textContent = sup ? "Signed in as supervisor (" + user.email + ")" : "Signed in as " + (user.displayName || "student");
  S.timer = setTimeout(() => { if (S.loaded < NCOLL) { const n = document.getElementById("loadnote"); if (n) n.textContent = "Can't reach the saved records yet. They'll appear when the connection returns."; } }, 10000);
  renderAll();
  db.collection("conferences").onSnapshot(snap => {
    S.confs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    const list = document.getElementById("conf-list");
    const typing = confPanel && confPanel.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (list && !typing) refreshConfs();
    if (S.isOwner) renderRoster();
  }, () => {});
  if (sup) {
    db.doc("private/join").onSnapshot(snap => { document.getElementById("joinShow").textContent = snap.exists && snap.data().code ? snap.data().code : "Not set"; },
      () => { document.getElementById("joinShow").textContent = "Can't read"; });
    document.getElementById("joinEditBtn").onclick = () => { document.getElementById("joinForm").hidden = false; document.getElementById("joinNew").focus(); };
    document.getElementById("joinCancel").onclick = () => { document.getElementById("joinForm").hidden = true; };
    document.getElementById("joinForm").onsubmit = async e => {
      e.preventDefault(); const code = val("joinNew").trim();
      if (!/^[A-Za-z0-9]{4,12}$/.test(code)) { say("Use 4 to 12 letters or digits."); return; }
      const btn = e.target.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "Saving…";
      const ok = await write(d => d.doc("private/join").set({ code, updatedAt: Date.now() }), "Lab code changed to " + code + ". Existing students aren't affected.");
      btn.disabled = false; btn.textContent = "Save code";
      if (ok) { document.getElementById("joinShow").textContent = code; e.target.reset(); e.target.hidden = true; }
    };
    const url = new URL("register.html", location.href).href;
    document.getElementById("signupUrl").textContent = url;
    document.getElementById("copySignup").onclick = async () => {
      try { await navigator.clipboard.writeText(url); say("Sign-up link copied"); }
      catch (e) { const r = document.createRange(); r.selectNodeContents(document.getElementById("signupUrl")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); say("Press Ctrl+C to copy the selected link"); }
    };
    db.collection("supervisor/me/items").onSnapshot(snap => {
      S.mine = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      const ae = document.activeElement;
      const typing = mineEl && mineEl.contains(ae) && /INPUT|SELECT|TEXTAREA/.test(ae.tagName) && ae.type !== "checkbox";
      if (!typing) renderAll();
    }, () => {});
    db.collection("students").onSnapshot(snap => {
      S.students = snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
      S.students.forEach(x => watchStudent(x.id)); unwatchMissing();
      if (!snap.metadata.fromCache) { S.loaded = NCOLL; clearTimeout(S.timer); }
      renderAll();
    }, err => { S.loaded = NCOLL; renderAll(); say("Couldn't load the student list (" + (err.code || "error") + "). Is the server still running?"); });
  } else {
    const key = keyFromUser(user);
    if (!key) { say("This account isn't a student account."); return; }
    db.doc("students/" + key).onSnapshot(snap => {
      if (!snap.exists) { say("Your record was removed by the supervisor."); setTimeout(signOut, 2500); return; }
      S.students = [{ ...snap.data(), id: key }];
      S.myName = snap.data().name || S.myName;
      watchStudent(key); S.sel = key;
      if (!snap.metadata.fromCache) { S.loaded = NCOLL; clearTimeout(S.timer); }
      renderAll();
    }, err => { S.loaded = NCOLL; renderAll(); say("Couldn't load your record (" + (err.code || "error") + ")."); });
  }
}
