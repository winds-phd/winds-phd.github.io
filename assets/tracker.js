import { db, configured, currentUser, isSupervisor, keyFromUser, signOut, setupNotice, resetStudentSecret, onActivity, labMembers, uploadFile, fileUrl, calendarFeed, act } from "./core.js?v=20261125-1715";

const COURSES = ["PhD", "Masters", "B-Tech"];
function courseOf(s) { return s.course || (COURSES.includes(s.stage) ? s.stage : "PhD"); }
/** Supervisor's course switch on the dashboard: "all" or one of COURSES. */
function inScope(sid) { if (!S.course || S.course === "all") return true; const s = S.students.find(x => x.id === sid); return !!s && courseOf(s) === S.course; }
function scopedStudents() { return S.students.filter(s => inScope(s.id)); }
function byCourse(list) { return COURSES.map(c => [c, list.filter(s => courseOf(s) === c).sort((a, b) => a.name.localeCompare(b.name))]).filter(([, l]) => l.length); }
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
const S = { course: "all", mine: [], schedule: [], isOwner: false, myRole: "student", confs: [], refs: [], papers: [], leaves: [], messages: [], msgstate: [], supPapers: [], supRefs: [], reviews: [], supTab: "tasks", groups: [], gmsgs: [], gseen: [], thread: "dm", sharedPapers: [], leaveYear: new Date().getFullYear(), tab: "tasks", openPapers: new Set(), openReviews: new Set(), dirtyPapers: new Set(), sample: null, students: [], meetings: [], tasks: [], sel: null, loaded: 0, db: null, user: null, canWrite: true, uid: null, timer: null, openTasks: new Set(), filter: "all" };

/** Wraps a form's submit handler: while it is saving, further clicks/Enter are ignored and the buttons are locked. */
function guardSubmit(handler) {
  return async function (e) {
    const form = e.currentTarget;
    if (form.dataset.busy) { e.preventDefault(); return; }
    form.dataset.busy = "1";
    const btns = [...form.querySelectorAll("button[type=submit], button:not([type])")];
    btns.forEach(b => { b.disabled = true; b.dataset.label = b.textContent; if (b.type === "submit") b.textContent = "Saving…"; });
    try { await handler(e); }
    finally { delete form.dataset.busy; btns.forEach(b => { b.disabled = false; if (b.dataset.label) b.textContent = b.dataset.label; }); }
  };
}
function h(tag, props, ...kids) {
  const el = document.createElement(tag); let val;
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "value") val = v;
    else if (k === "checked") el.checked = !!v;
    else if (k === "open") el.open = !!v;
    else if (k === "onsubmit") el.addEventListener("submit", guardSubmit(v));
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; el.append(c instanceof Node ? c : document.createTextNode(String(c))); }
  if (val !== undefined) el.value = val;
  if (tag === "form") el.noValidate = true;
  return el;
}
/* ---------- dates & task metrics ---------- */
function localDate(ms) { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function todayStr() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function parseD(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function diff(a, b) { return Math.round((parseD(b) - parseD(a)) / 86400000); }
function fmtD(s) { return s ? parseD(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"; }
function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
function isDone(t) { return t.status === "Done"; }
function statusOf(t) { return t.status || "Not started"; }
function startOf(t) { return t.assigned || (t.createdAt > 1e12 ? localDate(t.createdAt) : (t.history || []).map(x => x.date).filter(Boolean).sort()[0] || todayStr()); }
/** When a done task was finished: its recorded date, else the last "Done" entry in its history. */
function doneDateOf(t) { return t.doneAt || ((t.history || []).filter(x => x.status === "Done" && x.date).map(x => x.date).sort().pop()) || null; }
function metrics(t) {
  const start = startOf(t), today = todayStr();
  if (isDone(t)) {
    const fin = doneDateOf(t);
    if (!fin) return { done: true, taken: null, late: null, label: "Finished", cls: "good", timing: "Done" };
    const taken = Math.max(0, diff(start, fin));
    const late = t.due ? diff(t.due, fin) : null;
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
function avgDays(list) { const d = list.filter(isDone).map(t => metrics(t).taken).filter(x => x != null); return d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null; }

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
/** No meeting logged in the last 30 days (students who joined less than 30 days ago aren't counted yet). */
function isStale(s) {
  const l = lastMeeting(s.id);
  if (l) return diff(l, todayStr()) > 30;
  return s.createdAt > 1e12 ? diff(localDate(s.createdAt), todayStr()) > 30 : false;
}
function renderCourseBar() {
  const bar = document.getElementById("courseBar"); if (!bar) return;
  if (!S.isOwner || !S.students.length) { bar.replaceChildren(); return; }
  const opts = [["all", "All students", S.students.length], ...COURSES.map(c => [c, c, S.students.filter(s => courseOf(s) === c).length])];
  if (S.course !== "all" && !opts.some(([k, , n]) => k === S.course && n)) S.course = "all";
  bar.replaceChildren(h("span", { class: "label", text: "Showing" }),
    h("div", { class: "seg-chips", role: "group", "aria-label": "Show students by course" }, opts.filter(([k, , n]) => k === "all" || n).map(([k, label, n]) =>
      h("button", { type: "button", "aria-pressed": S.course === k ? "true" : "false", onclick: () => { S.course = k; try { localStorage.setItem("winds.course", k); } catch (e) {} renderAll(); } },
        label, h("span", { class: "n", text: String(n) })))));
}
function renderStats() {
  renderCourseBar();
  if (!S.isOwner) { document.getElementById("stats").replaceChildren(); return; }
  const all = tasksOf().filter(t => inScope(t.studentId)), open = all.filter(t => !isDone(t)), done = all.filter(isDone), od = open.filter(isOverdue);
  const stale = scopedStudents().filter(isStale);
  const avg = avgDays(all);
  document.getElementById("stats").replaceChildren(
    stat(scopedStudents().length, S.course === "all" ? "Students" : S.course + " students"), stat(open.length, "Open tasks"), stat(od.length, "Overdue", od.length),
    stat(done.length, "Completed"), stat(pubCounts(labPapers()).draft, "Draft papers"), stat(pubCounts(labPapers()).submitted, "Submitted"), stat(pubCounts(labPapers()).accepted, "Accepted"), stat(avg == null ? "—" : avg + "d", "Avg. time to finish"), stat(stale.length, "Not met in 30 days", stale.length),
    stat(pendingLeaves().length, "Leave requests", pendingLeaves().length));
}
function renderRoster() {
  const ae = document.activeElement; if (ae && ae.id === "studentPick") return;   // the drop-down is open: don't close it under the user
  const items = [h("button", { class: "r-item", type: "button", "aria-current": S.sel === null ? "true" : "false", onclick: () => select(null) },
    h("span", { class: "nm", text: "Group overview" }), h("span", { class: "meta", text: "All tasks and recent meetings" })),
    h("button", { class: "r-item r-mine", type: "button", "aria-current": S.sel === "__mine" ? "true" : "false", onclick: () => select("__mine") },
      h("span", { class: "nm", text: "Supervisor" }),
      h("span", { class: "meta" }, ...mineMeta())),
    h("button", { class: "r-item r-conf", type: "button", "aria-current": S.sel === "__confs" ? "true" : "false", onclick: () => select("__confs") },
      h("span", { class: "nm", text: "Upcoming conferences" }),
      h("span", { class: "meta", text: (() => { const n = (S.confs || []).filter(c => !c.deadline || diff(todayStr(), c.deadline) >= 0).length; return n ? plural(n, "upcoming deadline") : "Add and view conference deadlines"; })() })),
    h("button", { class: "r-item r-msg", type: "button", "aria-current": S.sel === "__msgs" || String(S.sel).startsWith("__g:") ? "true" : "false", onclick: () => select("__msgs") },
      h("span", { class: "nm" }, "Messages", allUnread() ? h("span", { class: "chip msg", style: "margin-left:8px", text: String(allUnread()) }) : null),
      h("span", { class: "meta", text: (() => { const n = S.students.filter(x => unreadOf(x.id).length).length + groupsMine().filter(g => gUnread(g.id)).length; return n ? "Unread in " + plural(n, "conversation") : groupsMine().length ? plural(groupsMine().length, "group") + " · private conversations" : "Groups and private conversations"; })() })),
  ];
  // Students: one drop-down (grouped by course) instead of a long list; alerts are written into each option.
  const flags = s => {
    const od = tasksOf(s.id).filter(t => !isDone(t) && isOverdue(t)).length, lv = pendingLeaves(s.id).length, un = unreadOf(s.id).length;
    return [od ? od + " overdue" : "", lv ? "leave request" : "", un ? plural(un, "new message") : ""].filter(Boolean);
  };
  const isStudent = S.students.some(x => x.id === S.sel);
  const pick = h("select", { id: "studentPick", class: "student-pick" + (isStudent ? " active" : ""), "aria-label": "Open a student's page",
      onchange: e => { if (e.target.value) select(e.target.value); } },
    h("option", { value: "", text: S.students.length ? "Choose a student… (" + S.students.length + ")" : "No students yet" }),
    ...byCourse(S.students).map(([course, list]) => h("optgroup", { label: course + " (" + list.length + ")" },
      list.map(x => h("option", { value: x.id, text: [x.name + (x.admissionNo ? " · " + x.admissionNo : ""), ...flags(x)].join(" · ") })))));
  pick.value = isStudent ? S.sel : "";
  items.push(h("label", { class: "roster-pick" }, h("span", { class: "label", text: "Students" }), pick));
  // A short "needs attention" strip, so overdue tasks, leave requests and unread messages stay visible
  const attn = S.students.filter(x => flags(x).length).sort((a, b) => a.name.localeCompare(b.name));
  if (attn.length) items.push(h("div", { class: "attn" }, h("span", { class: "label", text: "Needs attention" }),
    ...attn.map(x => h("button", { type: "button", class: "attn-item" + (S.sel === x.id ? " on" : ""), onclick: () => select(x.id) },
      h("span", { class: "nm", text: x.name }), h("span", { class: "meta", text: flags(x).join(" · ") })))));
  document.getElementById("roster").replaceChildren(...items);
}

/* ---------- overview ---------- */
function renderOverview() {
  const d = document.getElementById("detail");
  const typing = document.activeElement; if (typing && typing.id && typing.id.startsWith("lvr-") && d.contains(typing)) return;   // writing a note on a leave request
  if (S.loaded < NCOLL) { d.replaceChildren(h("div", { class: "empty" }, h("h3", { text: "Loading the group…" }), h("p", { id: "loadnote", text: "Fetching students, tasks and meetings." }))); return; }
  if (!S.students.length) {
    d.replaceChildren(h("div", { class: "empty" },
      h("h3", { text: "No students have registered yet" }),
      h("p", { text: "Each student gets a task register and a meeting log. Every task records its status, progress, assigned date, due date and how many days it took. At each meeting you update every open task in one place, and that update is kept in both the meeting record and the task's own history." }),
      h("p", null, "Send students the sign-up link and the lab code shown on the left. Each student creates their own account with their admission number and a password, and appears here straight away.")));
    return;
  }
  const studs = scopedStudents();
  const studentsPanel = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: S.course === "all" ? "Students by course" : S.course + " students" }), h("span", { class: "muted", text: plural(studs.length, "student") })),
    ...byCourse(studs).map(([course, list]) => h("div", { class: "course-block" },
      S.course === "all" ? h("div", { class: "task-group course-group" }, h("span", { text: course }), h("span", { class: "mono", text: String(list.length) })) : null,
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Student", "Adm. no.", "Current tasks", "Overdue", "Completed", "Papers (D / S / A)", "Last meeting", "Leave " + thisYear()].map(x => h("th", { text: x })))),
        h("tbody", null, list.map(s => {
          const mine = tasksOf(s.id), open = mine.filter(t => !isDone(t)), od = open.filter(isOverdue).length, pc = pubCounts(papersOf(s.id)), l = lastMeeting(s.id);
          return h("tr", null,
            h("td", null, h("button", { class: "linkish", type: "button", text: s.name, onclick: () => select(s.id) })),
            h("td", { class: "num", text: s.admissionNo || "—" }),
            h("td", { class: "num", text: String(open.length) }),
            h("td", null, od ? h("span", { class: "chip bad", text: String(od) }) : h("span", { class: "muted", text: "0" })),
            h("td", { class: "num", text: String(mine.length - open.length) }),
            h("td", { class: "num", text: pc.draft + " / " + pc.submitted + " / " + pc.accepted }),
            h("td", null, l ? h("span", { class: isStale(s) ? "chip warn" : "", text: fmtD(l) }) : h("span", { class: "muted", text: "None yet" })),
            h("td", null, h("button", { class: "linkish num", type: "button", title: "Open " + s.name + "'s profile and leave record", text: plural(leaveTotal(s.id, thisYear()), "day"), onclick: () => { S.tab = "profile"; select(s.id); } }),
              pendingLeaves(s.id).length ? h("span", { class: "chip warn", style: "margin-left:6px", text: pendingLeaves(s.id).length + " pending" }) : null));
        })))))));
  const open = tasksOf().filter(t => !isDone(t) && inScope(t.studentId)).sort(sortTasks);
  const openPanel = h("section", { class: "panel sec-tasks" },
    h("div", { class: "panel-head" }, h("h3", { text: "Open tasks across the group" }), h("span", { class: "muted", text: open.length + " open" })),
    open.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Student", "Task", "Status", "Progress", "Assigned", "Days so far", "Due"].map(x => h("th", { text: x })))),
      h("tbody", null, open.map(t => { const m = metrics(t); return h("tr", null,
        h("td", null, h("button", { class: "linkish", type: "button", text: studentName(t.studentId), onclick: () => select(t.studentId, t.id) })),
        h("td", { text: t.title }), h("td", null, statusChip(statusOf(t))), h("td", null, progBar(t.progress)),
        h("td", { class: "num", text: fmtD(startOf(t)) }), h("td", { class: "num", text: m.elapsed }), h("td", null, timingChip(t))); }))))
      : h("p", { class: "note", text: "No current tasks." }));
  const done = tasksOf().filter(t => isDone(t) && inScope(t.studentId)).sort((a, b) => (doneDateOf(b) || "").localeCompare(doneDateOf(a) || "")).slice(0, 12);
  const donePanel = h("section", { class: "panel sec-tasks" },
    h("div", { class: "panel-head" }, h("h3", { text: "Recently completed" }), h("span", { class: "muted", text: avgDays(tasksOf().filter(t => inScope(t.studentId))) == null ? "" : "Average " + plural(avgDays(tasksOf().filter(t => inScope(t.studentId))), "day") + " to finish" })),
    done.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Student", "Task", "Assigned", "Finished", "Days taken", "Against due date"].map(x => h("th", { text: x })))),
      h("tbody", null, done.map(t => { const m = metrics(t); return h("tr", null,
        h("td", null, h("button", { class: "linkish", type: "button", text: studentName(t.studentId), onclick: () => select(t.studentId, t.id) })),
        h("td", { text: t.title }), h("td", { class: "num", text: fmtD(startOf(t)) }), h("td", { class: "num", text: fmtD(doneDateOf(t)) }),
        h("td", { class: "num", text: m.taken == null ? "—" : String(m.taken) }), h("td", null, timingChip(t))); }))))
      : h("p", { class: "note", text: "Completed tasks will appear here with the number of days each one took." }));
  const recent = S.meetings.filter(m => inScope(m.studentId)).sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 6);
  const meetPanel = h("section", { class: "panel sec-meet" },
    h("div", { class: "panel-head" }, h("h3", { text: "Recent meetings" })),
    recent.length ? h("ul", { class: "meetings" }, recent.map(m => h("li", { class: "meeting" },
      h("div", { class: "m-top" }, h("button", { class: "linkish", type: "button", text: studentName(m.studentId), onclick: () => select(m.studentId) }), h("span", { class: "m-date", text: fmtD(m.date) })),
      h("p", { class: "note", text: plural((m.updates || []).length, "task update") + " · " + plural((m.newTasks || []).length, "new task") + (m.notes ? " · " + (m.notes.length > 140 ? m.notes.slice(0, 140) + "…" : m.notes) : "") }))))
      : h("p", { class: "note", text: "No meetings recorded yet. Open a student on the left to record one." }));
  const pp = S.papers.filter(p => inScope(p.studentId)).sort((a, b) => stageOf(a) - stageOf(b) || studentName(a.studentId).localeCompare(studentName(b.studentId)));
  const papPanel = h("section", { class: "panel sec-pubs" },
    h("div", { class: "panel-head" }, h("h3", { text: "Publications" }), pubCounters(pp)),
    pp.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Student", "Paper", "Venue", "Status", "Review time", "Overleaf"].map(x => h("th", { text: x })))),
      h("tbody", null, pp.flatMap((p, i) => { const m = pMetrics(p);
        const head = (i === 0 || stageOf(pp[i - 1]) !== stageOf(p)) ? [h("tr", { class: "stage-row" }, h("td", { colspan: "6", text: PSTAGES[stageOf(p)][1] + " · " + pp.filter(x => stageOf(x) === stageOf(p)).length }))] : [];
        return [...head, h("tr", null,
        h("td", null, h("button", { class: "linkish", type: "button", text: studentName(p.studentId), onclick: () => { select(p.studentId); focusPaper(p.id); } }),
          (p.coauthors || []).filter(nameOf).length ? h("div", { class: "muted", style: "font-size:0.8rem", text: "with " + (p.coauthors || []).map(nameOf).filter(Boolean).join(", ") }) : null),
        h("td", { text: p.title }),
        h("td", { text: p.venue || "—" }),
        h("td", null, pChip(pStatus(p))), h("td", { class: "num", text: m.review == null ? "—" : m.review + "d" }),
        h("td", null, p.overleaf ? h("a", { class: "ext", href: p.overleaf, target: "_blank", rel: "noopener", text: "Overleaf ↗" }) : h("span", { class: "muted", text: "—" })))]; }))))
      : h("p", { class: "note", text: "Papers added on a student's Publications tab appear here with their status and review time." }));
  d.replaceChildren(...[todayPanel(), pendingLeavePanel(), studentsPanel, openPanel, papPanel, donePanel, meetPanel].filter(Boolean));
}


/* ---------- profile & leave ---------- */
const LEAVE_TYPES = ["Personal", "Medical", "Academic (conference, workshop)", "Family / emergency", "Other"];
function thisYear() { return new Date().getFullYear(); }
/** Calendar days from the first to the last day, both included. Saturdays and Sundays count. */
function leaveDays(from, to) { return from && to && to >= from ? diff(from, to) + 1 : 0; }
function leavesOf(sid) { return (S.leaves || []).filter(l => !sid || l.studentId === sid); }
function pendingLeaves(sid) { return leavesOf(sid).filter(l => l.status === "Pending" && inScope(l.studentId)); }
/** Days of one leave that fall inside a calendar year (a leave over New Year is split between the two years). */
function daysInYear(l, y) {
  if (!l.from || !l.to) return 0;
  const a = l.from > y + "-01-01" ? l.from : y + "-01-01", b = l.to < y + "-12-31" ? l.to : y + "-12-31";
  return b >= a ? diff(a, b) + 1 : 0;
}
function leaveTotal(sid, y, status = "Approved") { return leavesOf(sid).filter(l => l.status === status).reduce((n, l) => n + daysInYear(l, y), 0); }
function leaveSpan(l) { return l.from === l.to ? fmtD(l.from) : fmtD(l.from) + " – " + fmtD(l.to); }
function leaveChip(st) { return h("span", { class: "chip " + ({ Pending: "warn", Approved: "good", Rejected: "bad" }[st] || "plain"), text: st === "Pending" ? "Waiting for approval" : st }); }
function leaveYears(sid) {
  const ys = new Set([thisYear()]);
  leavesOf(sid).forEach(l => { if (l.from) for (let y = Number(l.from.slice(0, 4)); y <= Number((l.to || l.from).slice(0, 4)); y++) ys.add(y); });
  return [...ys].sort((a, b) => b - a);
}
function setLeave(l, patch, msg) { return write(db => db.doc(P("leaves", l)).update(patch), msg); }

function profilePanel(s) {
  const f = (id, label, v, attrs = {}) => h("label", { class: "fieldlabel" }, label, h("input", { id, value: v || "", ...attrs }));
  const form = h("form", { class: "edit-box", onsubmit: async e => {
      e.preventDefault(); const name = val("pf-name").trim();
      if (!name) { say("The name can't be empty."); return; }
      const year = val("pf-year").trim();
      if (year && !/^(19|20)\d\d$/.test(year)) { say("Enter the year of admission as four digits, e.g. 2023."); return; }
      const labJoined = val("pf-joined");
      if (labJoined && labJoined > todayStr()) { say("The lab joined date can't be in the future."); return; }
      if (await write(db => db.doc("students/" + s.id).update({ name, topic: val("pf-topic").trim(), year, labJoined, phone: val("pf-phone").trim(), supervisorName: val("pf-sup").trim() }), "Profile saved")) e.target.closest("details").open = false;
    } },
    h("div", { class: "row" }, f("pf-name", "Full name", s.name, { maxlength: "80" }), f("pf-year", "Year of admission", s.year, { maxlength: "4", inputmode: "numeric", placeholder: "e.g. 2023" })),
    f("pf-topic", "Research topic", s.topic, { maxlength: "300" }),
    h("div", { class: "row" }, f("pf-joined", "Lab joined date", s.labJoined || (s.createdAt > 1e12 ? localDate(s.createdAt) : ""), { type: "date", max: todayStr() }), f("pf-phone", "Phone (optional)", s.phone, { maxlength: "20", inputmode: "tel" })),
    f("pf-sup", "Co-supervisor (optional)", s.supervisorName, { maxlength: "80" }),
    h("div", null, h("button", { class: "btn", type: "submit", text: "Save profile" })));
  return h("section", { class: "panel sec-profile" },
    h("div", { class: "panel-head" }, h("h3", { text: "Profile" })),
    h("dl", { class: "profile", id: "pf-view" }),
    S.canWrite ? h("details", { class: "sub" }, h("summary", { text: "Edit profile" }), h("div", { style: "margin-top:10px" }, form)) : null);
}
function refreshProfile(s) {
  const y = thisYear(), joined = s.labJoined ? fmtD(s.labJoined) : s.createdAt > 1e12 ? fmtD(localDate(s.createdAt)) + " (sign-up date; set the real date under Edit profile)" : "Not set";
  const rows = [["Name", s.name], ["Admission no.", s.admissionNo || s.id.toUpperCase()], ["Course", courseOf(s)], ["Year of admission", s.year || "—"],
    ["Research topic", s.topic || "—"], ["Co-supervisor", s.supervisorName || "—"], ["Email", s.email || "Not added"], ["Phone", s.phone || "—"],
    ["Lab joined date", joined], ["Leave taken in " + y, plural(leaveTotal(s.id, y), "day") + (leaveTotal(s.id, y, "Pending") ? " · " + plural(leaveTotal(s.id, y, "Pending"), "day") + " waiting for approval" : "")]];
  document.getElementById("pf-view").replaceChildren(...rows.map(([k, v]) => h("div", null, h("dt", { text: k }), h("dd", { text: v }))));
  refreshLeave(s);
}

function leavePanel(s) {
  const preview = h("span", { class: "lv-days", id: "lv-days", text: "1 day" });
  const upd = () => { const a = val("lv-from"), b = val("lv-to"); preview.textContent = !a || !b ? "" : b < a ? "The last day is before the first day" : plural(leaveDays(a, b), "day") + " (Saturdays and Sundays included)"; preview.classList.toggle("bad", !!a && !!b && b < a); };
  const form = h("form", { class: "edit-box", hidden: !S.canWrite, onsubmit: async e => {
      e.preventDefault();
      const from = val("lv-from"), to = val("lv-to") || from, reason = val("lv-reason").trim(), type = val("lv-type");
      if (!from) { say("Choose the first day of leave."); return; }
      if (to < from) { say("The last day of leave can't be before the first day."); return; }
      if (!reason) { say("Add a short reason for the leave."); return; }
      const clash = leavesOf(s.id).find(l => (l.status === "Pending" || l.status === "Approved") && l.from <= to && l.to >= from);
      if (clash) { say("These dates overlap the leave of " + leaveSpan(clash) + " (" + clash.status.toLowerCase() + "). Change the dates" + (S.isOwner ? "." : " or withdraw that request first.")); return; }
      const days = leaveDays(from, to);
      const data = { studentId: s.id, from, to, days, type, reason, status: S.isOwner ? "Approved" : "Pending", appliedOn: todayStr(), createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole };
      if (S.isOwner) Object.assign(data, { decidedOn: todayStr(), decidedAt: Date.now(), decidedBy: S.myName });
      const ok = await write(db => db.collection(C("leaves", s.id)).add(data), S.isOwner ? "Leave recorded: " + plural(days, "day") : "Leave request sent to your supervisor (" + plural(days, "day") + ")");
      if (ok) { ["lv-from", "lv-to", "lv-reason"].forEach(id => document.getElementById(id).value = ""); upd(); S.leaveYear = Number(from.slice(0, 4)); refreshLeave(s); }
    } },
    h("h4", { text: S.isOwner ? "Record leave for " + s.name : "Apply for leave" }),
    h("p", { class: "note", text: S.isOwner ? "Saved as approved straight away. " + s.name + " is notified." : "Your supervisor is notified and approves or rejects the request. Every day from the first to the last is counted, including Saturdays and Sundays." }),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "First day", h("input", { id: "lv-from", type: "date", oninput: () => { if (!val("lv-to") || val("lv-to") < val("lv-from")) document.getElementById("lv-to").value = val("lv-from"); upd(); } })),
      h("label", { class: "fieldlabel" }, "Last day", h("input", { id: "lv-to", type: "date", oninput: upd })),
      h("label", { class: "fieldlabel" }, "Type", h("select", { id: "lv-type" }, LEAVE_TYPES.map(x => h("option", { value: x, text: x }))))),
    h("label", { class: "fieldlabel" }, "Reason", h("textarea", { id: "lv-reason", rows: "2", maxlength: "1000", placeholder: S.isOwner ? "e.g. Attending IEEE INFOCOM in London" : "e.g. Going home for a family function" })),
    h("div", { class: "lv-submit" }, h("button", { class: "btn", type: "submit", text: S.isOwner ? "Record leave" : "Apply for leave" }), preview));
  preview.textContent = "";
  const yearSel = h("select", { id: "lv-year", "aria-label": "Year", onchange: e => { S.leaveYear = Number(e.target.value); refreshLeave(s); } });
  return h("section", { class: "panel sec-leave" },
    h("div", { class: "panel-head" }, h("h3", { text: "Leave" }), h("label", { class: "inline-label" }, "Year ", yearSel)),
    h("div", { class: "s-figs lv-figs", id: "lv-figs" }),
    h("p", { class: "note", id: "lv-types" }),
    form,
    h("div", { class: "task-group" }, h("span", { id: "lv-list-head", text: "Leave record" }), h("span", { class: "mono", id: "lv-n" })),
    h("ul", { class: "refs", id: "lv-list" }));
}
function refreshLeave(s) {
  const sel = document.getElementById("lv-year"); if (!sel) return;
  const years = leaveYears(s.id); if (!years.includes(S.leaveYear)) S.leaveYear = years[0];
  const y = S.leaveYear;
  if (sel.dataset.sig !== years.join(",")) { sel.replaceChildren(...years.map(v => h("option", { value: String(v), text: String(v) }))); sel.dataset.sig = years.join(","); }
  sel.value = String(y);
  const inYear = leavesOf(s.id).filter(l => daysInYear(l, y) > 0);
  const approved = leaveTotal(s.id, y), pending = leaveTotal(s.id, y, "Pending");
  document.getElementById("lv-figs").replaceChildren(
    stat(approved, "Days taken in " + y), stat(pending, "Days waiting for approval", pending),
    stat(inYear.filter(l => l.status === "Approved").length, "Approved leaves"), stat(inYear.filter(l => l.status === "Rejected").length, "Rejected"));
  const byType = LEAVE_TYPES.map(t => [t, inYear.filter(l => l.status === "Approved" && (l.type || "Other") === t).reduce((n, l) => n + daysInYear(l, y), 0)]).filter(([, n]) => n);
  document.getElementById("lv-types").textContent = byType.length ? "By type: " + byType.map(([t, n]) => t + " " + n + "d").join(" · ") + ". Saturdays and Sundays are counted." : "No approved leave in " + y + ". Saturdays and Sundays are counted as leave days.";
  document.getElementById("tabn-profile").textContent = pendingLeaves(s.id).length ? pendingLeaves(s.id).length + " pending" : "";
  document.getElementById("lv-list-head").textContent = "Leave record " + y;
  document.getElementById("lv-n").textContent = String(inYear.length);
  const list = document.getElementById("lv-list");
  if (list.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // typing a remark
  const order = { Pending: 0, Approved: 1, Rejected: 2, Withdrawn: 3 };
  inYear.sort((a, b) => order[a.status] - order[b.status] || b.from.localeCompare(a.from));
  list.replaceChildren(...(inYear.length ? inYear.map(l => leaveItem(l, false, y))
    : [h("li", null, h("p", { class: "note", text: S.isOwner ? "No leave in " + y + "." : "No leave in " + y + ". Use the form above to apply." }))]));
}
function leaveItem(l, showName, y) {
  const part = y && daysInYear(l, y) !== l.days ? " (" + daysInYear(l, y) + " in " + y + ")" : "";
  const actions = h("div", { class: "lv-actions" });
  if (S.isOwner && l.status === "Pending") {
    const remark = h("input", { id: "lvr-" + l.id, maxlength: "300", placeholder: "Note to the student (optional)", "aria-label": "Note for this leave decision" });
    const decide = st => setLeave(l, { status: st, remark: remark.value.trim(), decidedOn: todayStr(), decidedAt: Date.now(), decidedBy: S.myName }, "Leave " + st.toLowerCase());
    actions.append(remark, h("button", { class: "btn small", type: "button", text: "Approve", onclick: () => decide("Approved") }), h("button", { class: "btn ghost small", type: "button", text: "Reject", onclick: () => decide("Rejected") }));
  } else if (S.isOwner) {
    if (l.status !== "Withdrawn") actions.append(h("button", { class: "btn ghost small", type: "button", text: "Change decision", onclick: () => setLeave(l, { status: "Pending" }, "Leave moved back to waiting for approval") }));
    const del = h("button", { class: "btn danger small", type: "button", text: "Delete" }); let armed = null;
    del.onclick = () => { if (!armed) { del.textContent = "Confirm delete"; del.classList.add("armed"); armed = setTimeout(() => { armed = null; del.textContent = "Delete"; del.classList.remove("armed"); }, 4000); return; } clearTimeout(armed); write(db => db.doc(P("leaves", l)).delete(), "Leave record deleted"); };
    actions.append(del);
  } else if (l.status === "Pending" && S.canWrite) {
    const wd = h("button", { class: "btn ghost small", type: "button", text: "Withdraw request" }); let armed = null;
    wd.onclick = () => { if (!armed) { wd.textContent = "Confirm withdraw"; wd.classList.add("armed"); armed = setTimeout(() => { armed = null; wd.textContent = "Withdraw request"; wd.classList.remove("armed"); }, 4000); return; } clearTimeout(armed); setLeave(l, { status: "Withdrawn", withdrawnOn: todayStr() }, "Leave request withdrawn"); };
    actions.append(wd);
  }
  return h("li", { class: "ref leave lv-" + l.status.toLowerCase(), id: "leave-" + l.id },
    h("div", { class: "lv-main" },
      h("div", { class: "lv-top" },
        showName ? h("button", { class: "linkish", type: "button", text: studentName(l.studentId), onclick: () => { S.tab = "profile"; select(l.studentId); } }) : null,
        h("b", { text: leaveSpan(l) }), h("span", { class: "lv-count", text: plural(l.days || leaveDays(l.from, l.to), "day") + part }), leaveChip(l.status)),
      h("p", { class: "note", text: [l.type, (l.byRole === "supervisor" ? "Recorded by supervisor " : "Applied ") + fmtD(l.appliedOn), l.decidedOn && l.status !== "Pending" && l.byRole !== "supervisor" ? l.status + " " + fmtD(l.decidedOn) : "", l.status === "Withdrawn" && l.withdrawnOn ? "Withdrawn " + fmtD(l.withdrawnOn) : ""].filter(Boolean).join(" · ") }),
      l.reason ? h("p", { class: "lv-reason", text: l.reason }) : null,
      l.remark ? h("div", { class: "fb fb-inline" }, h("span", { class: "fb-tag", text: "Supervisor" + (l.decidedOn ? " · " + fmtD(l.decidedOn) : "") }), h("span", { text: l.remark })) : null),
    actions.childNodes.length ? actions : null);
}
function pendingLeavePanel() {
  const list = pendingLeaves().sort((a, b) => a.from.localeCompare(b.from));
  if (!list.length) return null;
  return h("section", { class: "panel sec-leave" },
    h("div", { class: "panel-head" }, h("h3", { text: "Leave requests waiting for you" }), h("span", { class: "muted", text: plural(list.length, "request") })),
    h("ul", { class: "refs" }, list.map(l => leaveItem(l, true))));
}


/* ---------- messages: private conversations (one per student) and groups made by the supervisor ---------- */
let msgSig = null, markedSeen = {}, stickBottom = true, chatT = null;
function myKey() { return S.isOwner ? "sup" : (S.students[0] || {}).id; }
function msgsOf(sid) { return (S.messages || []).filter(m => m.studentId === sid).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }
function msgState(sid) { return (S.msgstate || []).find(x => x.studentId === sid && x.id === "state") || {}; }
function isMine(m) { return m.createdBy ? m.createdBy === S.uid : (S.isOwner ? m.byRole === "supervisor" : m.byRole !== "supervisor"); }
/** Private messages from the other side not opened yet (every student when sid is empty, for the supervisor). */
function unreadOf(sid) {
  const ids = sid ? [sid] : S.students.map(x => x.id);
  return ids.flatMap(id => { const seen = Number(msgState(id)[S.isOwner ? "supSeen" : "stuSeen"]) || 0; return msgsOf(id).filter(m => !isMine(m) && (m.createdAt || 0) > seen); });
}
function groupsMine() { return (S.groups || []).filter(g => S.isOwner || (g.members || []).includes(myKey())).sort((a, b) => (a.name || "").localeCompare(b.name || "")); }
function gmsgsOf(gid) { return (S.gmsgs || []).filter(m => m.groupId === gid).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }
function gSeen(gid) { const x = (S.gseen || []).find(x => x.groupId === gid && x.id === myKey()); return Number(x && x.ts) || 0; }
function gUnread(gid) { const seen = gSeen(gid); return gmsgsOf(gid).filter(m => !isMine(m) && (m.createdAt || 0) > seen).length; }
function groupUnreadTotal() { return groupsMine().reduce((n, g) => n + gUnread(g.id), 0); }
/** Everything unread for this person: private conversations plus groups. */
function allUnread() { return unreadOf(S.isOwner ? "" : myKey()).length + groupUnreadTotal(); }
function memberNames(g) { return (g.members || []).map(k => (S.students.find(x => x.id === k) || {}).name).filter(Boolean); }
function msgTime(ts) { return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function msgDay(ts) { const d = localDate(ts), t = todayStr(); return d === t ? "Today" : diff(d, t) === 1 ? "Yesterday" : fmtD(d); }
function whenShort(ts) { return msgDay(ts) === "Today" ? msgTime(ts) : msgDay(ts); }
function initials(name) { return String(name || "?").replace(/^(dr|prof)\.?\s+/i, "").split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase(); }

/* A "thread" describes one conversation, so the same chat view serves private and group messages. */
function dmThread(s) {
  return { id: "dm:" + s.id, title: S.isOwner ? "Messages with " + s.name : "Your supervisor",
    note: S.isOwner ? "Private: only you and " + s.name + " can read this conversation." : "Private: only you and your supervisor can read this conversation.",
    placeholder: S.isOwner ? "Write to " + s.name + "…" : "Write to your supervisor…",
    empty: S.isOwner ? "No messages yet. Write the first one below. " + s.name + " sees it on their Messages tab and in the bell." : "No messages yet. Write to your supervisor below.",
    msgs: () => msgsOf(s.id), coll: C("messages", s.id), path: m => P("messages", m), extra: { studentId: s.id },
    unread: () => unreadOf(s.id).length, otherSeen: () => Number(msgState(s.id)[S.isOwner ? "stuSeen" : "supSeen"]) || 0,
    sender: m => m.byRole === "supervisor" ? "Supervisor" : m.byName || s.name,
    markSeen: ts => { const ref = "students/" + s.id + "/msgstate/state", v = { [S.isOwner ? "supSeen" : "stuSeen"]: ts };
      return write(db => (S.msgstate || []).some(x => x.studentId === s.id) ? db.doc(ref).update(v) : db.doc(ref).set(v)); } };
}
function groupThread(g) {
  const names = memberNames(g);
  return { id: "g:" + g.id, title: g.name, group: true,
    note: S.isOwner ? "Group · you and " + (names.length ? names.join(", ") : "no students yet") + ". Everyone in the group reads every message."
      : "Group · you, the supervisor" + ((g.members || []).length > 1 ? " and " + plural((g.members || []).length - 1, "other student") : "") + ". Everyone in the group reads every message.",
    placeholder: "Write to " + g.name + "…", empty: "No messages in this group yet." + (S.isOwner ? " Write the first one below; every member sees it." : ""),
    msgs: () => gmsgsOf(g.id), coll: "groups/" + g.id + "/messages", path: m => "groups/" + g.id + "/messages/" + m.id, extra: { groupId: g.id },
    unread: () => gUnread(g.id), otherSeen: () => 0, sender: m => m.byRole === "supervisor" ? "Supervisor" : m.byName || "Student",
    markSeen: ts => write(db => db.doc("groups/" + g.id + "/seen/" + myKey()).set({ ts })) };
}

/* Files waiting to be sent with the next message, and unsent text per conversation. */
let pendingFiles = [], drafts = {}, sendingMsg = false;
const ATTACH_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
/** Big phone photos are scaled down to at most 1920 px and saved as JPEG before upload (usually well under 1 MB). */
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 900 * 1024) return file;
  try {
    const url = URL.createObjectURL(file), img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
    const k = Math.min(1, 1920 / Math.max(img.width, img.height)), c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.85));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch (e) { return file; }
}
async function addFiles(list) {
  for (const f of list) {
    if (pendingFiles.length >= 5) { say("Up to 5 files per message."); break; }
    if (!ATTACH_TYPES.includes(f.type)) { say("“" + f.name + "” can't be attached. Use an image (JPG, PNG, GIF, WebP) or a PDF."); continue; }
    const small = await shrinkImage(f);
    if (small.size > 5 * 1024 * 1024) { say("“" + f.name + "” is " + fmtSize(small.size) + ". Files can be up to 5 MB."); continue; }
    pendingFiles.push({ file: small, url: small.type.startsWith("image/") ? URL.createObjectURL(small) : "" });
  }
  drawPending();
}
function drawPending() {
  const box = document.getElementById("msg-pending"); if (!box) return;
  box.hidden = !pendingFiles.length;
  box.replaceChildren(...pendingFiles.map((p, i) => h("span", { class: "pend" },
    p.url ? h("img", { src: p.url, alt: "" }) : h("span", { class: "pend-ico", "aria-hidden": "true", text: "PDF" }),
    h("span", { class: "pend-name", text: p.file.name }), h("span", { class: "muted", text: fmtSize(p.file.size) }),
    h("button", { type: "button", "aria-label": "Remove " + p.file.name, text: "×", disabled: sendingMsg, onclick: () => { if (p.url) URL.revokeObjectURL(p.url); pendingFiles.splice(i, 1); drawPending(); } }))));
}
/** Attachments inside a message bubble: image thumbnails and PDF cards, fetched privately through the script. */
function attachmentsEl(m) {
  if (!(m.files || []).length) return null;
  return h("div", { class: "msg-files" }, m.files.map(f => {
    const isImg = (f.mime || "").startsWith("image/");
    const a = h("a", { class: isImg ? "att-img loading" : "att-file loading", target: "_blank", rel: "noopener", title: "Open " + f.name, "aria-label": "Open " + f.name },
      isImg ? h("span", { class: "att-wait", text: "Loading image…" }) : h("span", { class: "att-ico", "aria-hidden": "true", text: "PDF" }),
      isImg ? null : h("span", { class: "att-meta" }, h("span", { class: "att-name", text: f.name }), h("span", { class: "muted", text: fmtSize(f.size || 0) + " · loading…" })));
    a.addEventListener("click", ev => { if (!a.href) { ev.preventDefault(); say("Still loading. Try again in a moment."); } });
    fileUrl(f.id).then(url => {
      a.href = url; a.classList.remove("loading");
      if (isImg) a.replaceChildren(h("img", { src: url, alt: f.name }));
      else a.querySelector(".att-meta .muted").textContent = fmtSize(f.size || 0) + " · click to open";
    }).catch(err => { a.classList.remove("loading"); a.classList.add("att-err"); a.replaceChildren(h("span", { text: (f.name || "File") + ": " + (err.message || "couldn't load") })); });
    return a;
  }));
}
function msgPreview(m) {
  const files = m.files || [], att = files.length ? "📎 " + (files.length === 1 ? files[0].name : files.length + " files") : "";
  return m.text ? m.text + (att ? "  " + att : "") : att;
}
function chatPanel(withBar) {
  const text = h("textarea", { id: "msg-text", rows: "2", maxlength: "4000", "aria-label": "Message",
    onkeydown: e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } },
    onpaste: e => { const fs = [...(e.clipboardData && e.clipboardData.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } },
    oninput: e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px"; if (chatT) drafts[chatT.id] = e.target.value; } });
  const picker = h("input", { type: "file", accept: ATTACH_TYPES.join(","), multiple: true, hidden: true, onchange: e => { addFiles([...e.target.files]); e.target.value = ""; } });
  const sendBtn = h("button", { class: "btn", type: "submit", text: "Send" });
  const form = h("form", { class: "msg-compose", onsubmit: async e => {
      e.preventDefault(); const t = text.value.trim(), T = chatT; if (!T || sendingMsg) return;
      if (!t && !pendingFiles.length) { say("Type a message or attach a file first."); text.focus(); return; }
      sendingMsg = true; sendBtn.disabled = true; drawPending();
      const files = [];
      try {
        for (let i = 0; i < pendingFiles.length; i++) {
          sendBtn.textContent = pendingFiles.length > 1 ? "Uploading " + (i + 1) + "/" + pendingFiles.length + "…" : "Uploading…";
          files.push(await uploadFile(T.coll, pendingFiles[i].file));
        }
      } catch (err) { say(err.message || "The file couldn't be uploaded."); sendingMsg = false; sendBtn.disabled = false; sendBtn.textContent = "Send"; drawPending(); return; }
      sendBtn.textContent = "Sending…";
      text.value = ""; text.style.height = ""; delete drafts[T.id];
      const ok = await write(db => db.collection(T.coll).add({ ...T.extra, text: t, files, createdAt: Date.now(), createdBy: S.uid, byRole: S.myRole, byName: S.myName }));
      sendingMsg = false; sendBtn.disabled = false; sendBtn.textContent = "Send";
      if (!ok) { text.value = t; drawPending(); return; }
      pendingFiles.forEach(p => p.url && URL.revokeObjectURL(p.url)); pendingFiles = []; drawPending();
      stickBottom = true; text.focus();
    } },
    h("button", { class: "btn ghost attach", type: "button", title: "Attach an image or PDF", "aria-label": "Attach an image or PDF", onclick: () => picker.click() },
      h("span", { "aria-hidden": "true", text: "📎" })), picker, text, sendBtn);
  const panel = h("section", { class: "panel sec-msg", ondragover: e => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); panel.classList.add("drop"); } },
      ondragleave: e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove("drop"); },
      ondrop: e => { e.preventDefault(); panel.classList.remove("drop"); addFiles([...e.dataTransfer.files]); } },
    withBar ? h("div", { class: "thread-bar", id: "thread-bar", role: "tablist", "aria-label": "Conversations" }) : null,
    h("div", { class: "panel-head" }, h("h3", { id: "chat-title" }), h("span", { class: "muted", id: "msg-count" })),
    h("p", { class: "note", id: "chat-note" }),
    h("div", { class: "msg-list", id: "msg-list", role: "log", "aria-live": "polite", onscroll: e => { const el = e.target; stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60; } }),
    h("div", { class: "msg-pending", id: "msg-pending", hidden: true }),
    form, h("p", { class: "note msg-hint", text: "Enter to send · Shift+Enter for a new line · 📎 or paste or drop images and PDFs (up to 5 MB each). Only the people in this conversation can open them." }));
  setTimeout(drawPending, 0);
  return panel;
}
/** Draws the current thread; marks it read when it's on screen. */
function refreshChat(force) {
  const list = document.getElementById("msg-list"), T = chatT; if (!list || !T) return;
  const ms = T.msgs(), otherSeen = T.otherSeen(), unread = T.unread();
  document.getElementById("chat-title").textContent = T.title;
  document.getElementById("chat-note").textContent = T.note;
  document.getElementById("msg-text").placeholder = T.placeholder;
  document.getElementById("msg-count").textContent = unread ? plural(unread, "unread message") : "";
  const sig = T.id + "|" + ms.map(m => m.id).join(",") + "|" + otherSeen;
  if (sig !== msgSig || force) {
    const switched = !msgSig || msgSig.split("|")[0] !== T.id;
    if (switched && document.getElementById("msg-text").dataset.thread !== T.id) {   // another conversation: bring back its unsent text
      const ta = document.getElementById("msg-text"); ta.value = drafts[T.id] || ""; ta.dataset.thread = T.id; ta.style.height = "";
      if (pendingFiles.length && !sendingMsg) { pendingFiles.forEach(p => p.url && URL.revokeObjectURL(p.url)); pendingFiles = []; drawPending(); }
    }
    msgSig = sig;
    const lastMineSeen = T.group ? null : [...ms].reverse().find(m => isMine(m) && (m.createdAt || 0) <= otherSeen);
    const items = []; let day = "", prev = null;
    for (const m of ms) {
      const dd = msgDay(m.createdAt || Date.now());
      if (dd !== day) { day = dd; prev = null; items.push(h("div", { class: "msg-day", text: dd })); }
      const mine = isMine(m);
      let del = null;
      if (mine || S.isOwner) {
        let armed = null;
        del = h("button", { class: "msg-del", type: "button", text: "Delete", "aria-label": "Delete this message" });
        del.onclick = () => { if (!armed) { del.textContent = "Confirm delete"; del.classList.add("armed"); armed = setTimeout(() => { armed = null; del.textContent = "Delete"; del.classList.remove("armed"); }, 4000); return; } clearTimeout(armed); write(db => db.doc(T.path(m)).delete(), "Message deleted"); };
      }
      const showName = T.group && !mine && (!prev || prev.createdBy !== m.createdBy);
      items.push(h("div", { class: "msg " + (mine ? "msg-mine" : "msg-theirs"), id: "msg-" + m.id },
        showName ? h("div", { class: "msg-from" + (m.byRole === "supervisor" ? " sup" : ""), text: T.sender(m) }) : null,
        m.text ? h("div", { class: "bubble", text: m.text }) : null,
        attachmentsEl(m),
        h("div", { class: "msg-meta" }, h("span", { text: mine ? "You · " + msgTime(m.createdAt || Date.now()) : T.group ? msgTime(m.createdAt || Date.now()) : T.sender(m) + " · " + msgTime(m.createdAt || Date.now()) }),
          m === lastMineSeen ? h("span", { class: "msg-seen", text: "✓ Seen" }) : null, del)));
      prev = m;
    }
    if (!ms.length) items.push(h("p", { class: "note msg-empty", text: T.empty }));
    list.replaceChildren(...items);
    if (stickBottom || force || switched) list.scrollTop = list.scrollHeight;
  }
  const visible = !document.hidden && !list.closest("[hidden]");
  const newest = ms.filter(m => !isMine(m)).reduce((a, m) => Math.max(a, m.createdAt || 0), 0);
  if (visible && unread && markedSeen[T.id] !== newest) { markedSeen[T.id] = newest; setTimeout(() => T.markSeen(Math.max(newest, Date.now())), 0); }
}

/* the Messages tab on a student's page */
function messagePanel(s) { return chatPanel(!S.isOwner); }
function refreshMessages(s, force) {
  if (!document.getElementById("msg-list")) return;
  const tabN = document.getElementById("tabn-messages");
  if (S.isOwner) { chatT = dmThread(s); tabN.textContent = unreadOf(s.id).length || ""; refreshChat(force); return; }
  const groups = groupsMine();
  if (S.thread !== "dm" && !groups.some(g => g.id === S.thread)) S.thread = "dm";
  chatT = S.thread === "dm" ? dmThread(s) : groupThread(groups.find(g => g.id === S.thread));
  tabN.textContent = allUnread() || "";                      // unread only, never the total
  const chip = (id, label, n, sub) => h("button", { type: "button", role: "tab", class: "thread-chip", "aria-selected": S.thread === id ? "true" : "false",
    onclick: () => { if (S.thread === id) return; S.thread = id; saveNav(); msgSig = null; stickBottom = true; refreshMessages(s, true); const t = document.getElementById("msg-text"); if (t && matchMedia("(min-width: 700px)").matches) t.focus({ preventScroll: true }); } },
    h("span", { class: "tc-name", text: label }), sub ? h("span", { class: "tc-sub", text: sub }) : null, n ? h("span", { class: "chip msg", text: String(n) }) : null);
  document.getElementById("thread-bar").replaceChildren(chip("dm", "Supervisor", unreadOf(s.id).length, "Private"),
    ...groups.map(g => chip(g.id, g.name, gUnread(g.id), "Group · " + (g.members || []).length)));
  refreshChat(force);
}

/* supervisor: Messages inbox (groups + private conversations), group pages, group editor */
function inboxPage() {
  return h("div", { class: "inbox-page" },
    h("section", { class: "panel sec-msg" },
      h("div", { class: "panel-head" }, h("h3", { text: "Groups" }), h("button", { class: "btn small", type: "button", text: "+ New group", onclick: () => { const b = document.getElementById("grp-new"); b.hidden = !b.hidden; if (!b.hidden) document.getElementById("grp-name").focus(); } })),
      h("div", { id: "grp-new", hidden: true }, groupForm(null)),
      h("ul", { class: "inbox", id: "group-inbox" })),
    h("section", { class: "panel sec-msg" },
      h("div", { class: "panel-head" }, h("h3", { text: "Private conversations" }), h("span", { class: "muted", id: "inbox-count" })),
      h("p", { class: "note", text: "One private conversation with each student." }),
      h("ul", { class: "inbox", id: "inbox" })));
}
function refreshInbox() {
  const gl = groupsMine().map(g => ({ g, ms: gmsgsOf(g.id), un: gUnread(g.id) }))
    .sort((a, b) => (b.un ? 1 : 0) - (a.un ? 1 : 0) || ((b.ms.at(-1) || {}).createdAt || 0) - ((a.ms.at(-1) || {}).createdAt || 0) || a.g.name.localeCompare(b.g.name));
  document.getElementById("group-inbox").replaceChildren(...(gl.length ? gl.map(({ g, ms, un }) => {
    const last = ms.at(-1);
    return h("li", null, h("button", { type: "button", class: "inbox-row" + (un ? " unread" : ""), onclick: () => select("__g:" + g.id) },
      h("span", { class: "inbox-av grp", "aria-hidden": "true", text: initials(g.name) }),
      h("span", { class: "inbox-main" },
        h("span", { class: "inbox-top" }, h("b", { text: g.name }), h("span", { class: "muted", text: plural((g.members || []).length, "member") }), last ? h("span", { class: "inbox-time", text: whenShort(last.createdAt) }) : null),
        h("span", { class: "inbox-prev", text: last ? (isMine(last) ? "You: " : (last.byName || "Student") + ": ") + msgPreview(last) : memberNames(g).join(", ") || "No members yet" })),
      un ? h("span", { class: "chip msg", text: String(un) }) : null));
  }) : [h("li", null, h("p", { class: "note", text: "No groups yet. Use “+ New group” to create one, for example “PhD group” or “Masters group”, and choose its students. The group appears for those students straight away." }))]));
  const rows = scopedStudents().map(s => ({ s, ms: msgsOf(s.id), un: unreadOf(s.id).length }))
    .sort((a, b) => (b.un ? 1 : 0) - (a.un ? 1 : 0) || ((b.ms.at(-1) || {}).createdAt || 0) - ((a.ms.at(-1) || {}).createdAt || 0) || a.s.name.localeCompare(b.s.name));
  const total = rows.reduce((n, r) => n + r.un, 0);
  document.getElementById("inbox-count").textContent = total ? plural(total, "unread message") : "";
  const typing = document.getElementById("grp-new") && document.getElementById("grp-new").contains(document.activeElement);
  document.getElementById("inbox").replaceChildren(...(rows.length ? rows.map(({ s, ms, un }) => {
    const last = ms.at(-1);
    return h("li", null, h("button", { type: "button", class: "inbox-row" + (un ? " unread" : ""), onclick: () => { S.tab = "messages"; select(s.id); } },
      h("span", { class: "inbox-av", "aria-hidden": "true", text: initials(s.name) }),
      h("span", { class: "inbox-main" },
        h("span", { class: "inbox-top" }, h("b", { text: s.name }), h("span", { class: "muted", text: courseOf(s) }), last ? h("span", { class: "inbox-time", text: whenShort(last.createdAt) }) : null),
        h("span", { class: "inbox-prev", text: last ? (isMine(last) ? "You: " : "") + msgPreview(last) : "No messages yet. Click to write the first one." })),
      un ? h("span", { class: "chip msg", text: String(un) }) : null));
  }) : [h("li", null, h("p", { class: "note", text: "No students yet." }))]));
  if (!typing) refreshGroupPicker(null);
}
/** Create (g = null) or edit a group: name and members, with quick "all PhD" style buttons. */
function groupForm(g) {
  const pfx = g ? "grp-e-" : "grp-";
  const picker = h("div", { class: "grp-picker", id: pfx + "picker", "data-gid": g ? g.id : "" });
  return h("form", { class: "edit-box", onsubmit: async e => {
      e.preventDefault(); const name = val(pfx + "name").trim();
      if (!name) { say("Give the group a name, e.g. PhD group."); return; }
      const members = [...picker.querySelectorAll("input[type=checkbox]:checked")].map(c => c.value);
      if (!members.length) { say("Tick at least one student for the group."); return; }
      if (g) { if (await write(db => db.doc("groups/" + g.id).update({ name, members }), "Group saved")) { document.getElementById("grp-edit").hidden = true; } return; }
      let id = null;
      const ok = await write(async db => { id = (await db.collection("groups").add({ name, members, createdAt: Date.now() })).id; }, "Group “" + name + "” created with " + plural(members.length, "student"));
      if (ok) { e.target.reset(); document.getElementById("grp-new").hidden = true; select("__g:" + id); }
    } },
    h("h4", { text: g ? "Edit group" : "New group" }),
    h("label", { class: "fieldlabel" }, "Group name", h("input", { id: pfx + "name", maxlength: "80", value: g ? g.name : "", placeholder: "e.g. PhD group, Masters group, Simulation team" })),
    h("div", { class: "fieldlabel" }, "Members"), picker,
    h("div", { class: "row-btns" }, h("button", { class: "btn", type: "submit", text: g ? "Save group" : "Create group" }),
      h("button", { class: "btn ghost", type: "button", text: "Cancel", onclick: e => { e.target.closest("[id^=grp-]").hidden = true; } })));
}
function refreshGroupPicker(g) {
  const el = document.getElementById(g ? "grp-e-picker" : "grp-picker"); if (!el) return;
  const chosen = new Set(el.dataset.filled ? [...el.querySelectorAll("input:checked")].map(c => c.value) : (g ? g.members || [] : []));
  el.dataset.filled = "1";
  const groups = byCourse(S.students);
  el.replaceChildren(...(S.students.length ? groups.map(([course, list]) => h("fieldset", { class: "grp-course" },
    h("legend", null, h("span", { text: course }), h("button", { type: "button", class: "textlink", text: "Select all " + course, onclick: e => {
      const boxes = [...e.target.closest("fieldset").querySelectorAll("input")], all = boxes.every(b => b.checked);
      boxes.forEach(b => b.checked = !all); e.target.textContent = (all ? "Select all " : "Clear all ") + course; } })),
    ...list.map(s => h("label", { class: "grp-member" }, h("input", { type: "checkbox", value: s.id, checked: chosen.has(s.id) }), h("span", { text: s.name }), h("span", { class: "muted", text: s.admissionNo || "" })))))
    : [h("p", { class: "note", text: "No students have registered yet." })]));
}
function groupPage(g) {
  const del = h("button", { class: "btn danger small", type: "button", text: "Delete group" }); let armed = null;
  del.onclick = async () => {
    if (!armed) { del.textContent = "Confirm: delete group and its messages"; del.classList.add("armed"); armed = setTimeout(() => { armed = null; del.textContent = "Delete group"; del.classList.remove("armed"); }, 5000); return; }
    clearTimeout(armed); if (await write(db => db.doc("groups/" + g.id).delete(), "Group deleted")) select("__msgs");
  };
  return h("div", { class: "group-page" },
    h("section", { class: "panel" },
      h("div", { class: "s-head" },
        h("div", { style: "min-width:0" }, h("div", { class: "label" }, h("button", { class: "linkish", type: "button", text: "← Messages", onclick: () => select("__msgs") })), h("h2", { id: "grp-title" }), h("div", { class: "grp-chips", id: "grp-members" })),
        h("div", { class: "s-controls" }, h("button", { class: "btn ghost small", type: "button", text: "Edit name & members", onclick: () => { const b = document.getElementById("grp-edit"); b.hidden = !b.hidden; if (!b.hidden) { delete document.getElementById("grp-e-picker").dataset.filled; refreshGroupPicker(g); } } }), del)),
      h("div", { id: "grp-edit", hidden: true }, groupForm(g))),
    chatPanel(false));
}
function refreshGroupPage(g) {
  document.getElementById("grp-title").textContent = g.name;
  const names = memberNames(g);
  document.getElementById("grp-members").replaceChildren(...(names.length ? names.map(n => h("span", { class: "chip plain", text: n })) : [h("span", { class: "muted", text: "No students in this group" })]));
  chatT = groupThread(g); refreshChat();
}


/* ---------- paper deadlines ---------- */
function deadlineFields(prefix, p) {
  const confs = (S.confs || []).filter(c => c.deadline && c.deadline >= todayStr()).sort((a, b) => a.deadline.localeCompare(b.deadline));
  const fill = confs.length ? h("select", { "aria-label": "Fill the deadline from a conference", onchange: e => {
      const c = confs.find(x => x.id === e.target.value); if (!c) return;
      document.getElementById(prefix + "deadline").value = c.deadline;
      if (!val(prefix + "dlnote")) document.getElementById(prefix + "dlnote").value = c.name;
      const v = document.getElementById(prefix + "venue"); if (v && !v.value) v.value = c.name;
      e.target.value = ""; e.target.dispatchEvent(new Event("input", { bubbles: true }));
    } }, h("option", { value: "", text: "Fill from Upcoming conferences…" }), ...confs.map(c => h("option", { value: c.id, text: c.name + " · " + fmtD(c.deadline) }))) : null;
  return h("div", { class: "dl-fields" },
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Submission deadline (optional)", h("input", { id: prefix + "deadline", type: "date", value: p && p.deadline || "" })),
      h("label", { class: "fieldlabel" }, "What's due (optional)", h("input", { id: prefix + "dlnote", maxlength: "120", value: p && p.deadlineNote || "", placeholder: "e.g. INFOCOM 2027 full paper · special issue on 6G" }))),
    fill ? h("div", { class: "dl-fill" }, fill) : null,
    h("p", { class: "note", text: "While the paper is a draft, reminders go to the student and the supervisor 14, 7 and 2 days before (email and bell), and the deadline shows in calendar feeds." }));
}
function deadlineChip(p) {
  if (!p.deadline || pStatus(p) !== "Currently writing") return null;
  const left = diff(todayStr(), p.deadline);
  const text = left < 0 ? "Deadline passed (" + fmtD(p.deadline) + ")" : left === 0 ? "Deadline today" : left === 1 ? "Deadline tomorrow" : "Deadline " + fmtD(p.deadline) + " · " + left + " days left";
  return h("span", { class: "chip " + (left <= 7 ? "bad" : left <= 14 ? "warn" : "plain"), title: p.deadlineNote || "", text });
}

/* ---------- export publications: BibTeX or a formatted list ---------- */
const EXPORT_STAGES = [["draft", "Drafts", s => s === "Currently writing"], ["review", "Submitted / under review", s => ["Submitted", "Under review", "Revision"].includes(s)], ["accepted", "Accepted / published", s => ["Accepted", "Published"].includes(s)]];
function authorNames(p) {
  const strip = n => String(n || "").replace(/\s*\(.*?\)\s*/g, " ").replace(/^(dr|prof)\.?\s+/i, "").trim();
  const raw = p.authors ? p.authors.split(/\s*(?:,|;|\band\b)\s*/i) : [ownerOf(p), ...(p.coauthors || []).map(nameOf), ...(p.externalAuthors || "").split(/\s*[,;]\s*/)];
  return raw.map(strip).filter(Boolean).filter((n, i, a) => a.indexOf(n) === i);
}
function initialsName(n) { const w = n.split(/\s+/); return w.length < 2 ? n : w.slice(0, -1).map(x => x[0].toUpperCase() + ".").join(" ") + " " + w[w.length - 1]; }
function paperYear(p) { const d = p.publishedOn || p.acceptedOn || p.submittedOn || p.statusSince || (p.createdAt ? localDate(p.createdAt) : ""); return String(d).slice(0, 4) || String(new Date().getFullYear()); }
function bibEsc(t) { return String(t || "").replace(/[{}\\]/g, "").replace(/([&%$#_])/g, "\\$1"); }
function bibtex(list) {
  const used = {};
  return list.map(p => {
    const names = authorNames(p), year = paperYear(p), st = pStatus(p);
    const last = (names[0] || "anon").split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, "") || "anon";
    let key = last + year + ((p.title || "").toLowerCase().match(/[a-z]{4,}/) || ["paper"])[0]; used[key] = (used[key] || 0) + 1; if (used[key] > 1) key += String.fromCharCode(95 + used[key]);
    const type = p.type === "Conference paper" ? "inproceedings" : p.type === "Book chapter" ? "incollection" : p.type === "Preprint" || p.type === "Patent" ? "misc" : "article";
    const f = [["title", "{" + bibEsc(p.title) + "}"], ["author", names.map(bibEsc).join(" and ")], ["year", year]];
    if (p.venue) f.push([type === "inproceedings" || type === "incollection" ? "booktitle" : type === "article" ? "journal" : "howpublished", bibEsc(p.venue)]);
    if (p.doi) f.push(["doi", bibEsc(p.doi)]);
    if (st !== "Accepted" && st !== "Published") f.push(["note", st === "Currently writing" ? "In preparation" : "Under review"]);
    return "@" + type + "{" + key + ",\n" + f.map(([k, v]) => "  " + k + " = {" + v.replace(/^\{(.*)\}$/, "{$1}") + "}").join(",\n") + "\n}";
  }).join("\n\n") + "\n";
}
function refList(list) {
  return list.map((p, i) => {
    const names = authorNames(p).map(initialsName), st = pStatus(p);
    const au = names.length > 2 ? names.slice(0, -1).join(", ") + ", and " + names[names.length - 1] : names.join(" and ");
    const tail = st === "Currently writing" ? "in preparation" : ["Accepted"].includes(st) ? "accepted" : st === "Published" ? "" : "under review";
    return "[" + (i + 1) + "] " + au + ", “" + (p.title || "") + ",” " + (p.venue ? p.venue + ", " : "") + paperYear(p) + (tail ? " (" + tail + ")" : "") + ".";
  }).join("\n") + "\n";
}
function downloadText(name, text, type) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportBox(getList, who) {
  const box = h("details", { class: "sub export-box" }, h("summary", { text: "Export publications (BibTeX or reference list)" }));
  const checks = EXPORT_STAGES.map(([k, label]) => h("label", { class: "check" }, h("input", { type: "checkbox", value: k, checked: k !== "draft" }), " " + label));
  const chosen = () => {
    const on = checks.map(c => c.querySelector("input")).filter(i => i.checked).map(i => i.value);
    const tests = EXPORT_STAGES.filter(([k]) => on.includes(k)).map(([, , t]) => t);
    return getList().filter(p => tests.some(t => t(pStatus(p)))).sort((a, b) => paperYear(b).localeCompare(paperYear(a)) || (a.title || "").localeCompare(b.title || ""));
  };
  const base = (who || "papers").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-publications";
  const go = fmt => { const list = chosen(); if (!list.length) { say("No papers match the stages you ticked."); return null; } return list; };
  box.append(h("div", { class: "export-body" },
    h("div", { class: "export-checks" }, ...checks),
    h("div", { class: "row-btns" },
      h("button", { class: "btn small", type: "button", text: "Download BibTeX (.bib)", onclick: () => { const l = go(); if (l) { downloadText(base + ".bib", bibtex(l), "application/x-bibtex"); say("Downloaded " + plural(l.length, "paper") + " as BibTeX"); } } }),
      h("button", { class: "btn ghost small", type: "button", text: "Download list (.txt)", onclick: () => { const l = go(); if (l) { downloadText(base + ".txt", refList(l), "text/plain"); say("Downloaded a list of " + plural(l.length, "paper")); } } }),
      h("button", { class: "btn ghost small", type: "button", text: "Copy list", onclick: async () => { const l = go(); if (!l) return; try { await navigator.clipboard.writeText(refList(l)); say("Copied " + plural(l.length, "reference")); } catch (e) { say("Couldn't copy here. Use Download list instead."); } } })),
    h("p", { class: "note", text: "The list uses IEEE style, e.g. “P. Sharma and A. Kalita, “Title,” IEEE TMC, 2026.” Drafts are marked “in preparation”." })));
  return box;
}

/* ---------- personal calendar feed ---------- */
function calendarPanel() {
  const out = h("div", { class: "cal-out", hidden: true });
  const show = async reset => {
    btn.disabled = true; btn.textContent = reset ? "Making a new link…" : "Getting your link…";
    try {
      const url = await calendarFeed(reset);
      const input = h("input", { class: "mono", readonly: true, value: url, "aria-label": "Your calendar link", onfocus: e => e.target.select() });
      let armed = null; const resetBtn = h("button", { class: "btn ghost small", type: "button", text: "Make a new link" });
      resetBtn.onclick = () => { if (!armed) { resetBtn.textContent = "Confirm: old link stops working"; armed = setTimeout(() => { armed = null; resetBtn.textContent = "Make a new link"; }, 5000); return; } clearTimeout(armed); show(true); };
      out.replaceChildren(
        h("div", { class: "cal-link" }, input, h("button", { class: "btn small", type: "button", text: "Copy", onclick: async () => { try { await navigator.clipboard.writeText(url); say("Calendar link copied"); } catch (e) { input.focus(); say("Press Ctrl+C (Cmd+C on Mac) to copy the selected link"); } } })),
        h("ol", { class: "cal-steps" },
          h("li", null, h("b", { text: "Google Calendar (computer): " }), "open calendar.google.com → next to “Other calendars” click + → “From URL” → paste the link → Add calendar."),
          h("li", null, h("b", { text: "iPhone / iPad: " }), "Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar → paste the link."),
          h("li", null, h("b", { text: "Outlook: " }), "Add calendar → Subscribe from web → paste the link.")),
        h("p", { class: "note", text: "Keep this link private: anyone with it can see your calendar entries. Google refreshes subscribed calendars every few hours, so new entries can take a while to appear. If the link is ever shared by mistake, make a new one." }),
        h("div", { class: "row-btns" }, resetBtn));
      out.hidden = false; btn.hidden = true;
      if (reset) say("New calendar link made. Subscribe again with it; the old link no longer works.");
    } catch (e) { say(e.message || "Couldn't get the calendar link."); }
    finally { btn.disabled = false; btn.textContent = "Get my calendar link"; }
  };
  const btn = h("button", { class: "btn", type: "button", text: "Get my calendar link", onclick: () => show(false) });
  return h("section", { class: "panel sec-meet cal-panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Add to your calendar" })),
    h("p", { class: "note", text: S.isOwner ? "One private link puts all scheduled meetings, your tasks and reminders, tasks you took on for students, paper and conference deadlines and students' approved leave into Google Calendar, iPhone or Outlook. It updates by itself." : "One private link puts your meetings, task due dates, paper and conference deadlines and approved leave into Google Calendar, iPhone or Outlook. It updates by itself." }),
    btn, out);
}


/* ---------- internal paper review ---------- */
const VERDICTS = ["Ready to submit", "Minor changes", "Major changes"];
function reviewsFor(p) { const path = P("papers", p); return (S.reviews || []).filter(r => r.paperPath === path); }
/** Lab authors of a reviewed paper: the student who added it plus its lab co-authors. */
function reviewAuthors(r) { const p = paperByPath(r.paperPath); return [r.owner, ...((p && p.coauthors) || [])].filter((k, i, a) => k && a.indexOf(k) === i); }
function paperByPath(path) { return [...S.papers, ...(S.supPapers || [])].find(p => P("papers", p) === path) || null; }
function verdictChip(v) { return h("span", { class: "chip " + (v === "Ready to submit" ? "good" : v === "Major changes" ? "bad" : "warn"), text: v }); }
function dueText(r) {
  if (r.status === "Done") return "Done " + fmtD(r.doneOn);
  if (!r.due) return "No due date";
  const left = diff(todayStr(), r.due);
  return left < 0 ? "Overdue (was due " + fmtD(r.due) + ")" : left === 0 ? "Due today" : left === 1 ? "Due tomorrow" : "Due " + fmtD(r.due) + " · " + left + " days left";
}
function goToReview(id) {
  if (S.isOwner) { S.supTab = "reviews"; select("__mine"); } else { S.tab = "reviews"; select(S.sel); }
  setTimeout(() => { const el = document.getElementById("review-" + id); if (el) { el.open = true; el.scrollIntoView({ block: "start", behavior: "smooth" }); } }, 60);
}
/** Inside a paper card: the reviews of this paper, and (supervisor) a form to assign more reviewers. */
function paperReviewBox(p) {
  const list = reviewsFor(p), owner = p.studentId === SUP ? SUP : p.studentId;
  if (!S.isOwner && !list.length) return null;
  const rows = list.map(r => h("li", null, h("button", { type: "button", class: "linkish", text: nameOf(r.reviewer) || "Reviewer", onclick: () => goToReview(r.id) }),
    h("span", { class: "muted", text: " · " + dueText(r) + " · " + plural((r.comments || []).length, "comment") }), r.verdict && r.status === "Done" ? verdictChip(r.verdict) : null));
  let form = null;
  if (S.isOwner) {
    const taken = new Set([...list.map(r => r.reviewer), ...(p.coauthors || [])]), sel = h("select", { "aria-label": "Reviewer" },
      h("option", { value: "", text: "Choose a reviewer…" }),
      ...byCourse(S.students.filter(x => x.id !== owner && !taken.has(x.id))).map(([c, l]) => h("optgroup", { label: c }, l.map(x => h("option", { value: x.id, text: x.name })))));
    const due = h("input", { type: "date", "aria-label": "Review due date", min: todayStr() }), note = h("input", { maxlength: "1000", placeholder: "What to focus on (optional), e.g. related work and figures" });
    form = h("details", { class: "sub review-assign" }, h("summary", { text: list.length ? "+ Assign another reviewer" : "+ Assign a reviewer" }),
      h("form", { class: "edit-box", style: "margin-top:8px", onsubmit: async e => {
          e.preventDefault();
          if (!sel.value) { say("Choose a reviewer from the lab."); return; }
          if (due.value && due.value < todayStr()) { say("The due date can't be in the past."); return; }
          const name = nameOf(sel.value);
          const ok = await write(db => db.collection("reviews").add({ paperPath: P("papers", p), reviewer: sel.value, due: due.value, note: note.value.trim(), status: "Assigned", comments: [], paperTitle: p.title, owner, createdAt: Date.now(), assignedOn: todayStr() }), name + " will review this paper. They've been notified.");
          if (ok) { sel.value = ""; due.value = ""; note.value = ""; e.target.closest("details").open = false; }
        } },
        h("div", { class: "row" }, h("label", { class: "fieldlabel" }, "Reviewer", sel), h("label", { class: "fieldlabel" }, "Due by (optional)", due)),
        h("label", { class: "fieldlabel" }, "Note for the reviewer", note),
        h("div", null, h("button", { class: "btn small", type: "submit", text: "Assign reviewer" })),
        h("p", { class: "note", text: "The reviewer can read this paper (and its Overleaf link) and write comments that only they, the paper's lab authors and you can see. Authors can't review their own paper. Assign as many reviewers as you like; each gets a separate review." })));
  }
  return h("div", { class: "review-box" }, h("span", { class: "label", text: "Internal review" + (list.length ? " · " + list.filter(r => r.status === "Done").length + " of " + list.length + " done" : "") }),
    rows.length ? h("ul", { class: "review-rows" }, ...rows) : h("p", { class: "note", text: "No reviewers yet." }), form);
}
function reviewsPanel() {
  return h("section", { class: "panel sec-review" },
    h("div", { class: "panel-head" }, h("h3", { text: "Internal reviews" }), h("span", { class: "muted", id: "rv-count" })),
    h("p", { class: "note", text: S.isOwner ? "Reviews you've assigned. Assign reviewers from a paper's card (Internal review). Each review is visible only to its reviewer, the paper's lab authors (who added it and its co-authors) and you." : "Papers you've been asked to review, and reviews of papers you're an author on. Only the reviewer, the paper's lab authors and the supervisor see a review." }),
    h("div", { id: "rv-list" }));
}
function reviewCard(r) {
  const p = paperByPath(r.paperPath), mine = !S.isOwner && r.reviewer === myKey(), author = !S.isOwner && reviewAuthors(r).includes(myKey());
  const role = mine ? "You're reviewing" : author ? (r.owner === myKey() ? "Review of your paper" : "Review of your co-authored paper") : "Review";
  const thread = h("div", { class: "rv-thread" }, ...((r.comments || []).length ? r.comments.map(c => h("div", { class: "rv-c" + (c.by === S.uid ? " me" : "") },
      h("div", { class: "rv-c-head" }, h("b", { text: c.by === S.uid ? "You" : c.byRole === "supervisor" ? "Supervisor" : c.byName }), h("span", { class: "muted", text: (c.byRole !== "supervisor" && c.by === "student:" + r.reviewer ? "reviewer · " : "") + fmtD(localDate(c.at)) + " " + msgTime(c.at) })),
      h("div", { class: "rv-c-text", text: c.text })))
    : [h("p", { class: "note", text: mine ? "No comments yet. Read the paper, then write your review below. You can add several comments before submitting." : "No comments yet." })]));
  const box = h("textarea", { id: "rvc-" + r.id, rows: "4", maxlength: "6000", placeholder: mine ? "Your review: strengths, problems, suggestions (section by section if you like)…" : "Reply or ask the reviewer something…" });
  const send = h("button", { class: "btn small", type: "button", text: "Add comment", onclick: async () => {
    const t = box.value.trim(); if (!t) { say("Write a comment first."); box.focus(); return; }
    send.disabled = true; send.textContent = "Saving…";
    try { await act("reviewComment", { id: r.id, text: t }); box.value = ""; say("Comment added"); } catch (e) { say(e.message || "Couldn't save the comment."); }
    finally { send.disabled = false; send.textContent = "Add comment"; }
  } });
  const actions = h("div", { class: "row-btns rv-actions" });
  if ((mine || S.isOwner) && r.status !== "Done") {
    const v = h("select", { "aria-label": "Verdict" }, h("option", { value: "", text: "Verdict…" }), ...VERDICTS.map(x => h("option", { value: x, text: x })));
    actions.append(v, h("button", { class: "btn small", type: "button", text: "Submit review", onclick: async () => {
      if (!v.value) { say("Choose a verdict first: " + VERDICTS.join(", ") + "."); v.focus(); return; }
      if (box.value.trim()) { say("Add your comment first (Add comment), then submit."); return; }
      try { await act("reviewStatus", { id: r.id, done: true, verdict: v.value }); say("Review submitted: " + v.value); } catch (e) { say(e.message || "Couldn't submit the review."); }
    } }));
  }
  if ((mine || S.isOwner) && r.status === "Done") actions.append(h("button", { class: "btn ghost small", type: "button", text: "Reopen review", onclick: async () => { try { await act("reviewStatus", { id: r.id, done: false }); say("Review reopened"); } catch (e) { say(e.message); } } }));
  if (S.isOwner) {
    const due = h("input", { type: "date", value: r.due || "", "aria-label": "Change due date", onchange: e => write(db => db.doc("reviews/" + r.id).update({ due: e.target.value }), e.target.value ? "Due date changed to " + fmtD(e.target.value) : "Due date removed") });
    let armed = null; const del = h("button", { class: "btn danger small", type: "button", text: "Remove review" });
    del.onclick = () => { if (!armed) { del.textContent = "Confirm: remove review and comments"; del.classList.add("armed"); armed = setTimeout(() => { armed = null; del.textContent = "Remove review"; del.classList.remove("armed"); }, 5000); return; } clearTimeout(armed); write(db => db.doc("reviews/" + r.id).delete(), "Review removed"); };
    actions.append(h("label", { class: "inline-label" }, "Due ", due), del);
  }
  return h("details", { class: "task review" + (r.status === "Done" ? " done" : ""), id: "review-" + r.id, open: S.openReviews.has(r.id),
      ontoggle: e => { e.target.open ? S.openReviews.add(r.id) : S.openReviews.delete(r.id); } },
    h("summary", null,
      h("div", { class: "t-main" },
        h("span", { class: "t-title", text: r.paperTitle || (p && p.title) || "Paper" }),
        h("div", { class: "t-sub" }, h("span", { class: "chip plain", text: role }),
          h("span", { text: "by " + (nameOf(r.owner) || "author") + " · reviewer " + (nameOf(r.reviewer) || "—") }),
          r.status === "Done" ? verdictChip(r.verdict) : h("span", { class: "chip " + (r.due && diff(todayStr(), r.due) < 0 ? "bad" : "warn"), text: dueText(r) }),
          h("span", { class: "muted", text: plural((r.comments || []).length, "comment") })))),
    h("div", { class: "t-body" },
      p && p.overleaf ? h("p", null, h("a", { class: "textlink", href: p.overleaf, target: "_blank", rel: "noopener", text: "Open the draft on Overleaf ↗" })) : h("p", { class: "note", text: p ? "No Overleaf link on this paper yet. Ask the author to add it, or to share the PDF in Messages." : "This paper is no longer in the tracker." }),
      p && p.venue ? h("p", { class: "note", text: "Target: " + p.venue + (p.deadline ? " · deadline " + fmtD(p.deadline) : "") }) : null,
      r.note ? h("div", { class: "fb fb-inline" }, h("span", { class: "fb-tag", text: "Supervisor's note" }), h("span", { text: r.note })) : null,
      thread,
      h("div", { class: "rv-compose" }, box, h("div", null, send)),
      actions.childNodes.length ? actions : null));
}
function refreshReviews() {
  const box = document.getElementById("rv-list"); if (!box) return;
  const ae = document.activeElement; if (ae && box.contains(ae) && (ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.tagName === "INPUT")) return;   // typing a comment
  const all = [...(S.reviews || [])].sort((a, b) => (a.status === "Done") - (b.status === "Done") || (a.due || "9999").localeCompare(b.due || "9999") || (b.createdAt || 0) - (a.createdAt || 0));
  const open = all.filter(r => r.status !== "Done").length;
  document.getElementById("rv-count").textContent = all.length ? open + " open · " + (all.length - open) + " done" : "";
  const tn = document.getElementById("tabn-reviews"); if (tn) tn.textContent = all.filter(r => r.status !== "Done" && r.reviewer === myKey()).length || "";
  const sec = (title, list, empty) => [h("div", { class: "task-group" }, h("span", { text: title }), h("span", { class: "mono", text: String(list.length) })),
    ...(list.length ? list.map(reviewCard) : [h("p", { class: "note", text: empty })])];
  if (S.isOwner) box.replaceChildren(...sec("Open", all.filter(r => r.status !== "Done"), "No open reviews. Assign one from any paper's card."), ...(all.some(r => r.status === "Done") ? sec("Done", all.filter(r => r.status === "Done"), "") : []));
  else box.replaceChildren(...sec("Papers you're reviewing", all.filter(r => r.reviewer === myKey()), "Nothing to review right now. When your supervisor asks you to review a paper, it appears here."),
    ...sec("Reviews of your papers", all.filter(r => r.reviewer !== myKey() && reviewAuthors(r).includes(myKey())), "No reviews of your papers yet. Reviews of papers you co-author show here too."));
}

/* ---------- publications ---------- */
/* "__sup" stands for the supervisor's own workspace (their papers and reading list live under supervisor/me/). */
const SUP = "__sup";
function P(kind, item) { return item.studentId === SUP ? "supervisor/me/" + kind + "/" + item.id : "students/" + item.studentId + "/" + kind + "/" + item.id; }
function C(kind, sid) { return sid === SUP ? "supervisor/me/" + kind : "students/" + sid + "/" + kind; }
/** Whose papers the current page shows: a student's, or the supervisor's own. */
function viewSid() { return S.sel === "__mine" ? SUP : S.sel; }
/** A student's papers: the ones they added plus the ones where a labmate listed them as co-author. */
function papersOf(sid) {
  if (sid === SUP) return [...(S.supPapers || []), ...(S.isOwner ? S.papers : [])];   // the supervisor's own papers + every student paper (all are common papers)
  return S.papers.filter(p => !sid || p.studentId === sid || (p.coauthors || []).includes(sid))
    .concat(sid ? (S.supPapers || []).filter(p => (p.coauthors || []).includes(sid)) : []);   // the supervisor's papers listing this student
}
/** Papers counted at the top of the dashboard: students' papers in the chosen course, plus the supervisor's own when showing everyone. Matches Supervisor → My papers. */
function labPapers() { return S.papers.filter(p => inScope(p.studentId)).concat(S.course === "all" ? (S.supPapers || []) : []); }
function ownPapers(sid) { return S.papers.filter(p => p.studentId === sid); }
function canEditPaper(p) { return S.canWrite && (S.isOwner || p.studentId === myKey()); }
/** Name of anyone in the lab (the supervisor sees all records; students get names from the lab list). */
function ownerOf(p) { return p.studentId === SUP ? (p.ownerName || S.supName || "Supervisor") : nameOf(p.studentId); }
function nameOf(key) { if (key === SUP) return S.supName || (labMembers().find(x => x.key === SUP) || {}).name || "Supervisor"; const s = S.students.find(x => x.id === key); if (s && s.name) return s.name; const m = labMembers().find(x => x.key === key); return m && m.name ? m.name : ""; }
function authorLine(p) {
  if (p.authors) return p.authors;
  const names = [ownerOf(p), ...(p.coauthors || []).map(nameOf)].filter(Boolean);
  if (p.externalAuthors) names.push(p.externalAuthors);
  return names.join(", ");
}
function pStatus(p) { return normStatus(p.status); }
function pActive(p) { return !["Published", "Rejected"].includes(pStatus(p)); }
function inReview(p) { return ["Submitted", "Under review", "Revision"].includes(pStatus(p)); }
function pLabel(s) { return s === "Currently writing" ? "Draft (currently writing)" : s; }
function pChip(s) { s = normStatus(s); return h("span", { class: "chip " + (PSTATUS_CLASS[s] ?? ""), text: s === "Currently writing" ? "Draft" : s }); }
function pMetrics(p) {
  // The label always follows the paper's CURRENT status; dates fill in the detail when we have them.
  const today = todayStr(), st = pStatus(p);
  const last = (p.history || []).map(x => x.date).filter(Boolean).sort().pop() || p.statusSince || today;
  const since = p.statusSince || last;                       // when it reached its current status
  const inStatus = Math.max(0, diff(last, today));
  const days = (a, b) => Math.max(0, diff(a, b));
  let review = null, reviewLabel = "", cls = "";
  if (st === "Currently writing") {
    reviewLabel = "Writing for " + plural(days(since || startOfPaper(p), today), "day");
  } else if (["Submitted", "Under review", "Revision"].includes(st)) {
    const sub = p.submittedOn || since;
    review = days(sub, today);
    reviewLabel = (st === "Revision" ? "In revision · " : "In review for ") + plural(review, "day") + (st === "Revision" ? " since submission" : "");
    cls = review > 180 ? "bad" : "";
  } else if (st === "Accepted" || st === "Published") {
    const acc = p.acceptedOn || (st === "Accepted" ? since : null);
    if (p.submittedOn && acc) review = days(p.submittedOn, acc);
    reviewLabel = st === "Published" ? "Published" + (p.publishedOn || since ? " on " + fmtD(p.publishedOn || since) : "")
      : "Accepted" + (acc ? " on " + fmtD(acc) : "");
    if (review != null) reviewLabel += " · " + plural(review, "day") + " in review";
    cls = "good";
  } else if (st === "Rejected") {
    const dec = p.decisionOn || since;
    if (p.submittedOn && dec) review = days(p.submittedOn, dec);
    reviewLabel = "Rejected" + (dec ? " on " + fmtD(dec) : "");
    cls = "bad";
  }
  const firstDecision = p.submittedOn && p.firstDecisionOn ? days(p.submittedOn, p.firstDecisionOn) : null;
  return { inStatus, review, reviewLabel, firstDecision, last, cls };
}
function startOfPaper(p) { return p.createdAt > 1e12 ? localDate(p.createdAt) : ((p.history || []).map(x => x.date).filter(Boolean).sort()[0] || p.statusSince || todayStr()); }
function stampDates(p, status, date) {
  const patch = {};
  if (["Submitted", "Under review", "Revision"].includes(status) && !p.submittedOn) patch.submittedOn = date;
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
        h("div", { class: "t-sub" }, pChip(st), deadlineChip(p), p.studentId !== viewSid() ? h("span", { class: "chip coauth", text: "Co-author" }) : null, h("span", { class: "chip plain", text: p.type || "Journal article" }),
          p.venue ? h("span", { class: "p-venue", text: (st === "Currently writing" ? "Target: " : "") + p.venue }) : h("span", { class: "muted", text: st === "Currently writing" ? "Target venue not set" : "Venue not set" }),
          authorLine(p) ? h("span", { class: "who", text: authorLine(p) }) : null),
        latestFeedback(p)),
      h("div", { class: "t-right" },
        h("span", { class: "days " + m.cls, text: m.reviewLabel }),
        h("span", { class: "who", text: plural(m.inStatus, "day") + " in current status" }),
        p.overleaf ? h("a", { class: "btn small overleaf", href: p.overleaf, target: "_blank", rel: "noopener", text: "Overleaf ↗", onclick: e => e.stopPropagation() })
          : (st === "Currently writing" ? h("span", { class: "chip warn", text: "No Overleaf link" }) : null))));
  const hist = (p.history || []).map((x, i) => [x, i]).sort((a, b) => (b[0].date || "").localeCompare(a[0].date || "") || b[1] - a[1]).map(p => p[0]);
  const body = h("div", { class: "t-body" },
    h("div", { class: "linkbtns" },
      p.overleaf ? h("a", { class: "btn small overleaf", href: p.overleaf, target: "_blank", rel: "noopener", text: "Open draft in Overleaf ↗" })
        : h("span", { class: "note", text: canEditPaper(p) ? "No Overleaf link yet. Add it under \"Edit paper details\"." : "No Overleaf link yet." })),
    h("p", { class: "note", text: [p.type || "Journal article", p.venue ? (pStatus(p) === "Currently writing" ? "Target venue: " : "Venue: ") + p.venue : null, authorLine(p) ? "Authors: " + authorLine(p) : null].filter(Boolean).join("  ·  ") }),
    paperReviewBox(p),
    (p.coauthors || []).filter(nameOf).length || p.studentId !== viewSid() ? h("div", { class: "coauth-row" },
      h("span", { class: "label", text: "In the lab" }),
      h("span", { class: "chip plain", text: (ownerOf(p) || "Student") + " · added it" }),
      ...(p.coauthors || []).filter(nameOf).map(k => h("span", { class: "chip coauth", text: nameOf(k) + " · co-author" }))) : null,
    !canEditPaper(p) && S.canWrite ? h("p", { class: "note", text: p.studentId === SUP ? "You're a co-author on your supervisor's paper. Your supervisor keeps it up to date." : "You're a co-author on this paper. " + (nameOf(p.studentId) || "The student who added it") + " and the supervisor keep it up to date." }) : null,
    h("div", { style: "display:grid;gap:8px" }, h("div", { class: "label", text: "Status timeline" }),
      hist.length ? h("ol", { class: "hist" }, hist.map(x => h("li", null,
        h("div", { class: "h-top" }, h("span", { class: "h-date", text: fmtD(x.date) }), pChip(x.status),
          h("span", { class: "who", text: x.via === "meeting" ? "Meeting update" : x.via === "added" ? "Added" : "Direct update" }), h("span", { class: "who", text: x.byName ? "by " + x.byName : "" })),
        remarkEl(x)))) : h("p", { class: "note", text: "No status changes yet." })),
    canEditPaper(p) ? paperStatusForm(p) : null,
    canEditPaper(p) ? h("details", { class: "sub" }, h("summary", { text: "Edit paper details" }), paperEditForm(p)) : null);
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
function paperFields(prefix, p, ownerSid) {
  p = p || {}; const sm = p.summary || {};
  const sel = (id, opts, v) => { const s = h("select", { id }, opts.map(x => h("option", { value: x, text: x }))); s.value = v || opts[0]; return s; };
  return [
    h("label", { class: "fieldlabel" }, "Title", h("input", { id: prefix + "title", maxlength: "400", value: p.title || "" })),
    h("label", { class: "fieldlabel" }, "Overleaf link (the working draft)", h("input", { id: prefix + "overleaf", type: "text", inputmode: "url", autocomplete: "off", maxlength: "300", value: p.overleaf || "", placeholder: "https://www.overleaf.com/project/…  (Share → link sharing)" })),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Venue: journal or conference (target, if still writing)", h("input", { id: prefix + "venue", maxlength: "300", value: p.venue || "", placeholder: "e.g. IEEE Transactions on Power Systems" })),
      h("label", { class: "fieldlabel" }, "Type", sel(prefix + "type", PTYPES, p.type))),
    deadlineFields(prefix, p),
    coauthorPicker(prefix, ownerSid, p.coauthors || []),
    h("label", { class: "fieldlabel" }, "Co-authors outside the lab", h("input", { id: prefix + "external", maxlength: "500", value: p.externalAuthors || "", placeholder: "e.g. R. Gupta (IIT Delhi), M. Chen (NUS)" })),
    h("label", { class: "fieldlabel" }, "Full author list in order (optional, as it appears on the paper)", h("input", { id: prefix + "authors", maxlength: "500", value: p.authors || "", placeholder: "Leave empty to use the names above" })),
];
}
/** Drop-down of lab members; each one picked becomes a removable chip. The paper then appears in their Publications too. */
function coauthorPicker(prefix, ownerSid, chosen) {
  const box = h("div", { class: "coauth-pick", id: prefix + "coauthors", "data-keys": JSON.stringify(chosen) });
  const sel = h("select", { "aria-label": "Add a co-author from the lab" });
  const draw = () => {
    const keys = JSON.parse(box.dataset.keys || "[]");
    const people = (labMembers().length ? labMembers() : [{ key: SUP, name: nameOf(SUP), course: "Supervisor" }, ...S.students.map(x => ({ key: x.id, name: x.name, course: courseOf(x) }))]).filter(m => m.key !== ownerSid && m.name);
    const left = people.filter(m => !keys.includes(m.key));
    const noList = !labMembers().length && !S.isOwner;          // the server didn't send the lab list (old Code.gs deployed)
    warn.hidden = !noList;
    sel.replaceChildren(h("option", { value: "", text: left.length ? "Add a co-author from WiNDS Lab…" : noList ? "Lab member list not available" : people.length ? "Everyone in the lab is added" : "No other lab members yet" }),
      ...[["Supervisor", left.filter(m => m.key === SUP)], ...COURSES.map(c => [c, left.filter(m => m.key !== SUP && (m.course || "PhD") === c)])].filter(([, l]) => l.length).map(([c, l]) => h("optgroup", { label: c }, l.map(m => h("option", { value: m.key, text: m.name })))));
    sel.disabled = !left.length;
    chips.replaceChildren(...keys.map(k => h("span", { class: "chip coauth removable" }, nameOf(k) || k.toUpperCase(),
      h("button", { type: "button", "aria-label": "Remove " + (nameOf(k) || k) + " as co-author", text: "×", onclick: () => { box.dataset.keys = JSON.stringify(keys.filter(x => x !== k)); draw(); box.dispatchEvent(new Event("input", { bubbles: true })); } }))));
  };
  const chips = h("div", { class: "coauth-chips" });
  const warn = h("p", { class: "err", hidden: true, text: "The list of lab members didn't load. The supervisor needs to deploy the latest Code.gs as a new version of the existing web app (Deploy → Manage deployments → ✏️ → New version). Until then, type lab co-authors under “Co-authors outside the lab”." });
  sel.addEventListener("focus", draw); sel.addEventListener("mousedown", () => { if (sel.options.length < 2) draw(); });
  sel.onchange = () => { if (!sel.value) return; const keys = JSON.parse(box.dataset.keys || "[]"); keys.push(sel.value); box.dataset.keys = JSON.stringify(keys); draw(); box.dispatchEvent(new Event("input", { bubbles: true })); };
  box.append(h("span", { class: "fieldlabel-text", text: "Co-authors from the lab" }), h("div", { class: "coauth-line" }, sel, chips), warn,
    h("span", { class: "note", text: "The paper also appears in their Publications, marked “Co-author”." }));
  draw();
  return box;
}
function readPaperFields(prefix) {
  const cb = document.getElementById(prefix + "coauthors");
  return { title: val(prefix + "title").trim(), authors: val(prefix + "authors").trim(), type: val(prefix + "type"),
    coauthors: cb ? JSON.parse(cb.dataset.keys || "[]") : [], externalAuthors: val(prefix + "external").trim(),
    venue: val(prefix + "venue").trim(), overleaf: cleanUrl(val(prefix + "overleaf")),
    deadline: val(prefix + "deadline"), deadlineNote: val(prefix + "dlnote").trim() };
}
function paperEditForm(p) {
  const prefix = "pe-" + p.id + "-";
  return h("form", { class: "edit-box", style: "margin-top:8px", oninput: () => S.dirtyPapers.add(p.id), onsubmit: async e => {
      e.preventDefault(); const d = readPaperFields(prefix); if (!d.title) { say("The paper needs a title."); return; }
      const ok = await write(db => db.doc(P("papers", p)).update(d), "Paper details saved");
      if (ok) { S.dirtyPapers.delete(p.id); const s = S.students.find(x => x.id === S.sel); if (s) refreshStudent(s); }
    } }, paperFields(prefix, p, p.studentId),
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
      const base = { ...d, studentId: s.id, ...(s.id === SUP ? { ownerName: S.supName || "Supervisor" } : {}), status, statusSince: date, createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole,
        history: [{ date, status, remark: "Paper added", via: "added", by: S.uid, byName: S.myName, byRole: S.myRole }] };
      Object.assign(base, stampDates({}, status, date));
          const ok = await write(db => db.collection(C("papers", s.id)).add(base), "Paper added");
      if (ok) { e.target.reset(); document.getElementById("np-date").value = todayStr(); sel.value = "Currently writing"; const cb = document.getElementById("np-coauthors"); if (cb) { cb.replaceWith(coauthorPicker("np-", s.id, [])); } e.target.closest("details").open = false;
        if (d.coauthors.length) say("Paper added. It also appears for " + d.coauthors.map(nameOf).filter(Boolean).join(", ") + "."); }
    } },
    h("div", { class: "row" }, h("label", { class: "fieldlabel" }, "Where is this paper now?", sel),
      h("label", { class: "fieldlabel" }, "Since (started / submitted / accepted on)", h("input", { type: "date", id: "np-date", value: todayStr() }))),
    paperFields(prefix, null, s.id),
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
      if (val("nt-due") && val("nt-due") < assigned) { say("The due date can't be before the assigned date."); return; }
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

  /* meeting form: one simple record per meeting */
  const meetForm = h("form", { hidden: !S.canWrite, onsubmit: async e => { e.preventDefault(); await submitMeeting(s, e.target); } },
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Meeting date", h("input", { id: "nm-date", type: "date", value: todayStr() })),
      h("label", { class: "fieldlabel" }, "Next meeting (optional)", h("input", { id: "nm-next", type: "date" }))),
    h("label", { class: "fieldlabel" }, "What was discussed", h("textarea", { id: "nm-notes", rows: "5", maxlength: "5000", placeholder: "Progress since the last meeting, results, problems, decisions…" })),
    h("label", { class: "fieldlabel" }, "Action items (optional, one per line; each becomes a task)", h("textarea", { id: "nm-actions", rows: "3", maxlength: "3000", placeholder: "Rerun the simulation with new parameters\nSend the draft abstract" })),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Action items due by (optional)", h("input", { id: "nm-due", type: "date" })),
      h("div", { style: "display:flex;align-items:end" }, h("button", { class: "btn", type: "submit", text: "Save meeting" }))));
  const meetPanel = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Record a meeting" })),
    h("p", { class: "note", text: S.isOwner ? "A short summary after each meeting. " + s.name + " gets an email with your notes." : "A short summary after each meeting with your supervisor." }),
    meetForm,
    S.canWrite ? null : h("p", { class: "note", text: "You have view-only access." }));
  const logPanel = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Meeting log" }), h("span", { class: "muted", id: "meet-count" })),
    h("ul", { class: "meetings", id: "meet-list" }));

  const papersPanel = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", { text: "Publications" }), h("div", { id: "paper-count" })),
    h("div", { class: "tasks", id: "paper-list" }),
    S.canWrite ? h("details", { class: "sub", id: "paper-add" }, h("summary", { text: "+ Add a paper: currently writing, submitted or accepted" }), h("div", { style: "margin-top:10px" }, paperAddForm(s))) : null,
    exportBox(() => papersOf(s.id), s.name));

  const refType = h("select", { id: "nr-type", onchange: e => { document.getElementById("nr-venue-label").firstChild.textContent = e.target.value === "Journal" ? "Journal name" : e.target.value === "Conference" ? "Conference name" : "Where it appeared (optional)"; } },
    ["Journal", "Conference", "Other"].map(x => h("option", { value: x, text: x === "Other" ? "Other (preprint, book, thesis…)" : x })));
  const refForm = h("form", { class: "edit-box", hidden: !S.canWrite, onsubmit: async e => {
      e.preventDefault(); const title = val("nr-title").trim(); let link = val("nr-link").trim(); const type = refType.value, venue = val("nr-venue").trim();
      if (!title) { say("Add the article's title."); return; }
      if (type !== "Other" && !venue) { say("Add the " + type.toLowerCase() + " name."); return; }
      if (link && !/^https?:\/\//i.test(link)) link = /^10\.\d{4,}\//.test(link) ? "https://doi.org/" + link : "https://" + link;
      const ok = await write(db => db.collection(C("refs", s.id)).add({ studentId: s.id, title, link, type, venue, note: val("nr-note").trim(), added: todayStr(), createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole }), "Article added");
      if (ok) { ["nr-title", "nr-link", "nr-venue", "nr-note"].forEach(id => document.getElementById(id).value = ""); }
    } },
    h("h4", { text: "Add an article" }),
    h("label", { class: "fieldlabel" }, "Title", h("input", { id: "nr-title", maxlength: "400", placeholder: "e.g. Attention Is All You Need" })),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Type", refType),
      h("label", { class: "fieldlabel", id: "nr-venue-label" }, "Journal name", h("input", { id: "nr-venue", maxlength: "300", placeholder: "e.g. IEEE Transactions on Mobile Computing / IEEE INFOCOM 2026" }))),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Link (URL or DOI)", h("input", { id: "nr-link", maxlength: "500", placeholder: "https://… or 10.xxxx/…" })),
      h("label", { class: "fieldlabel" }, "Note (optional)", h("input", { id: "nr-note", maxlength: "300", placeholder: "Why it matters, which chapter" }))),
    h("div", null, h("button", { class: "btn", type: "submit", text: "Add article" })));
  const refsPanel = h("section", { class: "panel sec-refs" },
    h("div", { class: "panel-head" }, h("h3", { text: "Read articles" }), h("span", { class: "muted", id: "ref-count" })),
    h("p", { class: "note", text: "Articles read or to cite, with where they were published and a link. The supervisor and the student can both add to this list." }),
    refForm, h("ul", { class: "refs", id: "ref-list" }));

  tasks.classList.add("sec-tasks"); papersPanel.classList.add("sec-pubs"); meetPanel.classList.add("sec-meet"); logPanel.classList.add("sec-meet");
  const panes = {
    tasks: h("div", { class: "tabpane", "data-pane": "tasks" }, tasks),
    refs: h("div", { class: "tabpane", "data-pane": "refs" }, refsPanel),
    confs: S.isOwner ? null : h("div", { class: "tabpane", "data-pane": "confs" }, confPanelEl()),
    papers: h("div", { class: "tabpane", "data-pane": "papers" }, papersPanel),
    meetings: h("div", { class: "tabpane", "data-pane": "meetings" },
      h("section", { class: "panel sec-meet" }, h("div", { class: "panel-head" }, h("h3", { text: "Scheduled meetings" }), h("span", { class: "muted", id: "stu-sched-count" })),
        h("ul", { class: "refs", id: "stu-sched" })),
      h("div", { class: "cols" }, meetPanel, logPanel), S.canWrite && !S.isOwner ? calendarPanel() : null),
    profile: h("div", { class: "tabpane", "data-pane": "profile" }, profilePanel(s), leavePanel(s)),
    messages: h("div", { class: "tabpane", "data-pane": "messages" }, messagePanel(s)),
    reviews: S.isOwner ? null : h("div", { class: "tabpane", "data-pane": "reviews" }, reviewsPanel()) };
  const tabBtn = (k, l) => h("button", { type: "button", role: "tab", "data-tab": k, class: "tab-" + k, "aria-selected": S.tab === k ? "true" : "false",
    onclick: () => { S.tab = k; showTab(); } }, l, h("span", { class: "n", id: "tabn-" + k }));
  const tabs = h("div", { class: "tabs", role: "tablist" }, tabBtn("tasks", "Tasks"), tabBtn("papers", "Publications"), tabBtn("refs", "Read articles"), S.isOwner ? null : tabBtn("confs", "Conferences"), tabBtn("meetings", "Meetings"), tabBtn("messages", "Messages"), S.isOwner ? null : tabBtn("reviews", "Reviews"), tabBtn("profile", "Profile & leave"));
  if (S.isOwner && S.tab === "confs") S.tab = "tasks";
  d.replaceChildren(...[head, tabs, panes.tasks, panes.papers, panes.refs, panes.confs, panes.meetings, panes.messages, panes.reviews, panes.profile].filter(Boolean));
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
        h("b", { text: m.done ? (m.taken == null ? "✓" : m.taken) : m.elapsed }), h("span", { text: m.done ? (m.taken == null ? "done" : "days taken") : "days so far" })),
      h("div", { style: "min-width:0" },
        h("div", { class: "t-sub", style: "margin-top:0" }, statusChip(st), ownerChip(t), h("span", { text: "Assigned " + fmtD(startOf(t)) }), h("span", { text: "Due " + fmtD(t.due) }), timingChip(t)),
        latestFeedback(t)),
      h("div", { class: "t-right" }, progBar(isDone(t) ? 100 : t.progress), h("span", { class: "days " + m.cls, text: m.label }), quickToggle(t)));
  const facts = h("dl", { class: "facts" },
    [["Status", st], ["Progress", (isDone(t) ? 100 : (t.progress || 0)) + "%"], ["Assigned", fmtD(startOf(t))], ["Due", fmtD(t.due)],
     ["Completed", isDone(t) ? fmtD(doneDateOf(t)) : "Not yet"], [m.done ? "Days taken" : "Days elapsed", m.done ? (m.taken == null ? "—" : String(m.taken)) : String(m.elapsed)],
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
    if (btn.disabled) return; btn.disabled = true;
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
      if (due && due < startOf(t)) { say("The due date can't be before the assigned date (" + fmtD(startOf(t)) + ")."); return; }
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
  saveNav();
  if (S.tab === "messages") { const s = S.students.find(x => x.id === S.sel); if (s && document.getElementById("msg-list")) { msgSig = null; stickBottom = true; refreshMessages(s, true); setTimeout(() => { const t = document.getElementById("msg-text"); if (t && matchMedia("(min-width: 700px)").matches) t.focus({ preventScroll: true }); }, 0); } }
}
let pupdSig = null;
function refreshPaperRows(s) {
  const act = ownPapers(s.id).filter(pActive);
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
  const date = val("nm-date") || todayStr(), notes = val("nm-notes").trim(), next = val("nm-next"), due = val("nm-due");
  const actions = val("nm-actions").split("\n").map(x => x.trim()).filter(Boolean);
  if (!notes && !actions.length) { say("Write what was discussed, or add an action item."); return; }
  if (date > todayStr()) { say("The meeting date is in the future. Use Scheduled meetings to plan upcoming ones."); return; }
  if (next && next <= date) { say("The next meeting should be after this meeting's date."); return; }
  if (actions.length && due && due < date) { say("Action items can't be due before the meeting date."); return; }
  const ok = await write(async db => {
    const newTasks = [];
    for (const a of actions) {
      const ref = await db.collection(C("tasks", s.id)).add({ studentId: s.id, title: a, details: "", owner: "student", assigned: date, due, status: "Not started", progress: 0, doneAt: "",
        createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole, fromMeeting: date,
        history: [{ date, status: "Not started", progress: 0, remark: "Assigned in meeting", via: "assigned", by: S.uid, byName: S.myName, byRole: S.myRole }] });
      newTasks.push({ taskId: ref.id, title: a, due });
    }
    await db.collection(C("meetings", s.id)).add({ studentId: s.id, date, next, notes, newTasks, updates: [], paperUpdates: [], createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole });
  }, "Meeting saved" + (actions.length ? " with " + plural(actions.length, "action item") : ""));
  if (ok) {
    ["nm-notes", "nm-actions", "nm-due", "nm-next"].forEach(id => document.getElementById(id).value = "");
    document.getElementById("nm-date").value = todayStr();
  }
}

function meetingItem(m) {
  const ups = m.updates || [], nts = m.newTasks || [];
  return h("li", { class: "meeting" },
    h("div", { class: "m-top" }, h("span", { class: "m-date", text: fmtD(m.date) }),
      h("span", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap" }, m.next ? h("span", { class: "chip plain", text: "Next: " + fmtD(m.next) }) : null,
        h("span", { class: "who", text: m.byName ? "by " + m.byName : "" }),
        S.canWrite && (S.isOwner || m.createdBy === S.uid) ? h("button", { class: "x", type: "button", text: "Delete", "aria-label": "Delete meeting record", onclick: () => write(db => db.doc(P("meetings", m)).delete(), "Meeting record deleted") }) : null)),
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
      if (deadline < todayStr()) { say("That deadline has already passed. Check the date."); return; }
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
/* Recurring meetings: one record per student per series (repeat, until, skip[]); occurrences are worked out from the first date. */
const REPEATS = [["none", "Does not repeat"], ["weekly", "Every week"], ["biweekly", "Every 2 weeks"], ["monthly", "Every month (same date)"]];
function addDaysStr(d, n) { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); }
function addMonthsStr(d, n) { const [y, m, dd] = d.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(dd, last)); return t.toISOString().slice(0, 10); }
function isRecurring(x) { return !!x.repeat && x.repeat !== "none"; }
function nthOcc(x, i) { const start = x.startDate || x.date; return x.repeat === "monthly" ? addMonthsStr(start, i) : addDaysStr(start, i * (x.repeat === "biweekly" ? 14 : 7)); }
/** First occurrence at or after fromKey ("YYYY-MM-DDTHH:MM"), or null when the series has ended. */
function nextOcc(x, fromKey) {
  if (!isRecurring(x)) return (x.date + "T" + (x.time || "23:59")) >= fromKey ? x.date : null;
  const skip = new Set(x.skip || []);
  for (let i = 0; i < 800; i++) { const d = nthOcc(x, i); if (x.until && d > x.until) return null; if (skip.has(d)) continue; if (d + "T" + (x.time || "23:59") >= fromKey) return d; }
  return null;
}
function lastOcc(x, beforeKey) {
  if (!isRecurring(x)) return x.date;
  const skip = new Set(x.skip || []); let last = null;
  for (let i = 0; i < 800; i++) { const d = nthOcc(x, i); if ((x.until && d > x.until) || d + "T" + (x.time || "23:59") >= beforeKey) break; if (!skip.has(d)) last = d; }
  return last || x.startDate || x.date;
}
function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function repeatText(x) {
  if (!isRecurring(x)) return "";
  const start = x.startDate || x.date, wd = parseD(start).toLocaleDateString("en-IN", { weekday: "long" });
  const base = x.repeat === "weekly" ? "Every week on " + wd : x.repeat === "biweekly" ? "Every 2 weeks on " + wd : "Every month on the " + ordinal(parseD(start).getDate());
  return base + (x.until ? ", until " + fmtD(x.until) : "");
}
/** One entry per meeting (copies share a groupId). A series shows as its next occurrence (or its last one once it has ended). */
function allSched(sid) {
  const by = new Map(), now = nowKey();
  for (const x of S.schedule || []) { if (sid && x.studentId !== sid) continue; const k = x.groupId || x.id; if (!by.has(k)) by.set(k, { ...x, copies: [] }); by.get(k).copies.push(x); }
  return [...by.values()].map(x => {
    if (!isRecurring(x)) return x;
    const nd = nextOcc(x, now);
    return { ...x, startDate: x.date, date: nd || lastOcc(x, now) };
  }).sort((a, b) => schedKey(a).localeCompare(schedKey(b)));
}
function upcomingSched(sid) { const now = nowKey(); return allSched(sid).filter(x => schedKey(x) >= now); }
function fmtTime(t) { if (!t) return ""; const [hh, mm] = t.split(":").map(Number); const ap = hh >= 12 ? "PM" : "AM"; return ((hh % 12) || 12) + ":" + String(mm).padStart(2, "0") + " " + ap; }
function whenText(x) { const d = diff(todayStr(), x.date); return (d === 0 ? "Today" : d === 1 ? "Tomorrow" : parseD(x.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })) + (x.time ? ", " + fmtTime(x.time) : ""); }
function nextBanner(x) {
  return h("div", { class: "next-meet" },
    h("div", null, h("div", { class: "label", text: "Next meeting" + (x.kind === "group" ? " · group" : "") + (isRecurring(x) ? " · repeats" : "") }), h("b", { text: whenText(x) }), x.agenda ? h("div", { class: "ref-note", text: x.agenda.split("\n")[0] }) : null),
    x.link ? h("a", { class: "btn small", href: x.link, target: "_blank", rel: "noopener", text: "Join ↗" }) : null);
}
function schedItem(x, showPeople) {
  const names = (x.attendees || []).map(k => studentName(k));
  const rec = isRecurring(x), upcoming = schedKey(x) >= nowKey();
  const confirmBtn = (label, run) => {
    let armed = null; const b = h("button", { class: "x", type: "button", text: label });
    b.onclick = () => { if (!armed) { b.textContent = "Confirm: " + label.toLowerCase(); armed = setTimeout(() => { armed = null; b.textContent = label; }, 4000); return; } clearTimeout(armed); run(); };
    return b;
  };
  const removeAll = msg => write(async db => { for (const c of x.copies) await db.doc("students/" + c.studentId + "/schedule/" + c.id).delete(); }, msg);
  const cancel = !S.isOwner ? null
    : rec && upcoming ? h("div", { style: "display:grid;gap:2px;justify-items:end" },
        confirmBtn("Cancel this one", () => write(async db => { for (const c of x.copies) await db.doc("students/" + c.studentId + "/schedule/" + c.id).update({ skip: [...new Set([...(c.skip || []), x.date])] }); }, "Cancelled the meeting on " + fmtD(x.date) + ". The series continues.")),
        confirmBtn("Cancel series", () => removeAll("Recurring meeting cancelled")))
    : confirmBtn(rec ? "Remove series" : "Cancel meeting", () => removeAll(rec ? "Series removed" : "Meeting cancelled"));
  const d = diff(todayStr(), x.date);
  return h("li", { class: "ref sched" + (schedKey(x) < nowKey() ? " past" : "") },
    h("div", { class: "conf-date sched-date" }, h("b", { text: parseD(x.date).getDate() }), h("span", { text: parseD(x.date).toLocaleDateString("en-IN", { month: "short" }) + (x.time ? " · " + fmtTime(x.time) : "") })),
    h("div", { style: "min-width:0;flex:1" },
      h("div", { class: "t-sub", style: "margin-top:0" }, h("span", { class: "chip " + (x.kind === "group" ? "" : "plain"), text: x.kind === "group" ? "Group meeting" : "Individual meeting" }),
        rec ? h("span", { class: "chip repeat", text: "↻ " + (x.repeat === "weekly" ? "Weekly" : x.repeat === "biweekly" ? "Every 2 weeks" : "Monthly") }) : null,
        d >= 0 && d <= 1 ? h("span", { class: "chip warn", text: d === 0 ? "Today" : "Tomorrow" }) : null,
        x.location ? h("span", { class: "who", text: x.location }) : null),
      rec ? h("div", { class: "who", text: repeatText(x) + (upcoming ? " · next: " + whenText(x) : " · ended") }) : null,
      x.agenda ? h("p", { class: "sched-agenda", text: x.agenda }) : h("p", { class: "note", text: "No agenda given." }),
      showPeople ? h("div", { class: "who", text: "With: " + (x.audience || (x.everyone ? "all students" : names.join(", "))) }) : null),
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
  if (!b.overdue.length && !b.today.length) return [h("span", { text: (S.mine || []).filter(x => !x.done).length ? "Nothing due today · papers, reading, meetings" : "Tasks · my papers · reading list · meetings" })];
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
      if (k === "reminder" && (date + "T" + (time || "23:59")) < nowKey()) { say("That time has already passed. Check the date and time."); return; }
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
    h("div", { class: "panel-head" }, h("h3", { text: "Today" }), h("button", { class: "linkish", type: "button", text: "Open Supervisor →", onclick: () => { S.supTab = "tasks"; select("__mine"); } })),
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
      const people = k === "individual" ? [val("ns-one")].filter(Boolean) : everyone ? S.students.map(s => s.id) : [...document.querySelectorAll("#ns-people input[data-sid]:checked")].map(i => i.value);
      const repeat = val("ns-repeat") || "none", until = repeat === "none" ? "" : val("ns-until");
      if (!date || !time) { say("Choose the date and time."); return; }
      if (date + "T" + time < nowKey()) { say("That time has already passed. Check the date and time."); return; }
      if (!people.length) { say(k === "individual" ? "Choose the student." : "Choose at least one student, or tick All students."); return; }
      if (k === "group" && !everyone && people.length < 2) { say("A group meeting needs two or more students. Use Individual for one student."); return; }
      if (until && until < date) { say("The repeat end date can't be before the first meeting."); return; }
      // a readable "With:" label for the whole group
      let audience = "";
      if (k === "group") {
        if (everyone) audience = "all students";
        else { const set = new Set(people); const c = COURSES.find(c => { const ids = S.students.filter(s => courseOf(s) === c).map(s => s.id); return ids.length && ids.length === set.size && ids.every(id => set.has(id)); }); if (c) audience = "all " + c + " students"; }
      }
      const groupId = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const data = { groupId, kind: k, everyone, audience, attendees: people, date, time, repeat, until, skip: [], agenda, link, location, createdAt: Date.now(), createdBy: S.uid, byName: S.myName, byRole: S.myRole };
      const ok = await write(async db => { for (const sid of people) await db.doc("students/" + sid + "/schedule/" + groupId).set({ ...data, studentId: sid }); },
        (repeat === "none" ? "" : "Recurring ") + (k === "group" ? "group meeting" : "meeting").replace(/^./, c => repeat === "none" ? c.toUpperCase() : c) + " scheduled. " + (people.length === 1 ? "The student sees it" : plural(people.length, "student") + " see it") + " on their page.");
      if (ok) { ["ns-agenda", "ns-link", "ns-loc", "ns-time", "ns-until"].forEach(id => document.getElementById(id).value = ""); document.getElementById("ns-repeat").value = "none"; document.getElementById("ns-until-wrap").hidden = true; }
    } },
    h("h4", { text: "Schedule a meeting" }),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Meeting type", kind),
      h("label", { class: "fieldlabel" }, "Date", h("input", { id: "ns-date", type: "date", value: todayStr() })),
      h("label", { class: "fieldlabel" }, "Time", h("input", { id: "ns-time", type: "time" }))),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Repeats", h("select", { id: "ns-repeat", onchange: e => { document.getElementById("ns-until-wrap").hidden = e.target.value === "none"; } }, REPEATS.map(([v, l]) => h("option", { value: v, text: l })))),
      h("label", { class: "fieldlabel", id: "ns-until-wrap", hidden: true }, "Until (optional; leave empty to keep repeating)", h("input", { id: "ns-until", type: "date" }))),
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
  if (kind === "individual") { box.replaceChildren(h("label", { class: "fieldlabel" }, "Student", h("select", { id: "ns-one" }, byCourse(studs).map(([course, list]) => h("optgroup", { label: course }, list.map(s => h("option", { value: s.id, text: s.name + (s.admissionNo ? " (" + s.admissionNo + ")" : "") }))))))); return; }
  const all = h("input", { type: "checkbox", id: "ns-all", checked: true, onchange: e => { box.querySelector("#ns-people").hidden = e.target.checked; } });
  const groups = byCourse(studs).map(([course, list]) => {
    const head = h("input", { type: "checkbox", "data-course": course, onchange: e => { box.querySelectorAll('input[data-sid][data-c="' + course + '"]').forEach(i => { i.checked = e.target.checked; }); } });
    const boxes = list.map(s => h("label", { class: "check" }, h("input", { type: "checkbox", value: s.id, "data-sid": "1", "data-c": course, onchange: () => {
      const mine = [...box.querySelectorAll('input[data-sid][data-c="' + course + '"]')]; head.checked = mine.every(i => i.checked); head.indeterminate = !head.checked && mine.some(i => i.checked); } }), " " + s.name));
    return h("div", { class: "pick-course" }, h("label", { class: "check pick-head" }, head, " All " + course + " (" + list.length + ")"), h("div", { class: "people" }, boxes));
  });
  box.replaceChildren(h("div", { class: "fieldlabel" }, "Students",
    h("label", { class: "check" }, all, " All students (" + studs.length + ")"),
    h("div", { id: "ns-people", hidden: true }, groups)));
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
  if (del) del.onclick = () => { if (!armed) { del.textContent = "Confirm remove"; armed = setTimeout(() => { armed = null; del.textContent = "Remove"; }, 4000); return; } clearTimeout(armed); write(db => db.doc(P("refs", r)).delete(), "Article removed"); };
  return h("li", { class: "ref" + (bySup(r) ? " ref-sup" : "") },
    h("div", { style: "min-width:0" },
      r.link ? h("a", { class: "ref-title", href: r.link, target: "_blank", rel: "noopener", text: r.title }) : h("span", { class: "ref-title", text: r.title }),
      h("div", { class: "t-sub" },
        r.type ? h("span", { class: "chip " + (r.type === "Journal" ? "" : "plain"), text: r.type }) : null,
        r.venue ? h("span", { class: "p-venue", text: r.venue }) : null,
        host ? h("span", { class: "mono", text: host }) : h("span", { class: "muted", text: "No link" }), h("span", { text: "Added " + fmtD(r.added) }),
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
  const withDue = done.filter(t => metrics(t).late != null);
  const avg = avgDays(mine), late = withDue.filter(t => metrics(t).late > 0).length, l = lastMeeting(s.id);
  const mySched = upcomingSched(s.id);
  const nextM = [...ms.map(m => m.next).filter(n => n && n >= todayStr()), ...mySched.map(x => x.date)].sort()[0];
  document.getElementById("next-banner").replaceChildren(...(mySched[0] ? [nextBanner(mySched[0])] : []));
  document.getElementById("stu-sched-count").textContent = mySched.length ? mySched.length + " upcoming" : "";
  document.getElementById("stu-sched").replaceChildren(...(mySched.length ? mySched.map(x => schedItem(x, false))
    : [h("li", null, h("p", { class: "note", text: S.isOwner ? "Nothing scheduled with this student. Use Supervisor → Meetings in the left column." : "No meetings scheduled. Your supervisor's invitations will appear here." }))]));
  document.getElementById("s-figs").replaceChildren(
    stat(open.length, "Open tasks"), stat(open.filter(isOverdue).length, "Overdue", open.filter(isOverdue).length), stat(done.length, "Completed"),
    stat(avg == null ? "—" : avg + "d", "Avg. days to finish"), stat(withDue.length ? (withDue.length - late) + "/" + withDue.length : "—", "Finished on time"),
    stat(pubCounts(papersOf(s.id)).draft, "Draft papers"), stat(pubCounts(papersOf(s.id)).submitted, "Submitted papers"), stat(pubCounts(papersOf(s.id)).accepted, "Accepted papers"),
    stat(ms.length, "Meetings"), stat(l ? diff(l, todayStr()) + "d" : "—", "Since last meeting"), stat(nextM ? fmtD(nextM) : "—", "Next meeting"),
    stat(leaveTotal(s.id, thisYear()) + "d", "Leave in " + thisYear()));
  refreshProfile(s);
  refreshMessages(s);
  refreshReviews();
  document.querySelectorAll("#task-filters button").forEach(b => b.setAttribute("aria-pressed", b.dataset.f === S.filter ? "true" : "false"));
  open.sort(sortTasks); done.sort((a, b) => (doneDateOf(b) || "").localeCompare(doneDateOf(a) || ""));
  const groupHead = (label, n) => h("div", { class: "task-group" }, h("span", { text: label }), h("span", { class: "mono", text: String(n) }));
  let items;
  if (S.filter === "open") items = open.length ? open.map(taskCard) : [h("p", { class: "note", text: "No current tasks. Add one above or assign tasks in a meeting." })];
  else if (S.filter === "done") items = done.length ? done.map(taskCard) : [h("p", { class: "note", text: "No completed tasks yet." })];
  else items = [groupHead("Current", open.length), ...(open.length ? open.map(taskCard) : [h("p", { class: "note", text: "No current tasks." })]),
    groupHead("Completed", done.length), ...(done.length ? done.map(taskCard) : [h("p", { class: "note", text: "No completed tasks yet." })])];
  const tl = document.getElementById("task-list");
  const editing = tl.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (!editing) tl.replaceChildren(...items);
  const pp = drawPapers(papersOf(s.id));
  document.getElementById("tabn-tasks").textContent = open.length;
  document.getElementById("tabn-papers").textContent = pp.length;
  document.getElementById("tabn-meetings").textContent = ms.length;
  const refs = (S.refs || []).filter(r => r.studentId === s.id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  document.getElementById("tabn-refs").textContent = refs.length;
  refreshConfs();
  document.getElementById("ref-count").textContent = plural(refs.length, "article");
  document.getElementById("ref-list").replaceChildren(...(refs.length ? refs.map(refItem) : [h("li", null, h("p", { class: "note", text: "No articles yet. Add one above with its journal or conference and link." }))]));
  const sorted = ms.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
  document.getElementById("meet-count").textContent = plural(sorted.length, "meeting");
  document.getElementById("meet-list").replaceChildren(...(sorted.length ? sorted.map(meetingItem) : [h("li", null, h("p", { class: "note", text: "No meetings logged yet." }))]));
  resolveNames();
}
/** Draws a list of papers grouped Draft → Submitted → Accepted into #paper-list (student page or the supervisor's own). */
function drawPapers(list) {
  const pp = list.sort((a, b) => (pActive(b) - pActive(a)) || PSTATUS.indexOf(pStatus(b)) - PSTATUS.indexOf(pStatus(a)) || (b.createdAt || 0) - (a.createdAt || 0));
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
  return pp;
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


/* ---------- Supervisor workspace: own tasks, own papers, reading list, meetings ---------- */
const SUP_TABS = [["tasks", "Tasks & reminders"], ["papers", "My papers"], ["reviews", "Reviews"], ["reading", "Reading list"], ["meetings", "Meetings"]];
function supSelf() { return { id: SUP, name: S.myName || "Supervisor" }; }
function supPage() {
  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Supervisor" }, SUP_TABS.map(([k, l]) =>
    h("button", { type: "button", role: "tab", "data-stab": k, class: "tab-sup-" + k, "aria-selected": S.supTab === k ? "true" : "false", onclick: () => { S.supTab = k; showSupTab(); refreshSup(); } },
      l, h("span", { class: "n", id: "stabn-" + k }))));
  const papers = h("section", { class: "panel sec-pubs" },
    h("div", { class: "panel-head" }, h("h3", { text: "My papers" }), h("div", { id: "paper-count" })),
    h("p", { class: "note", text: "All papers of the lab: your own and every student's (marked “Co-author”). The counts here match the totals at the top of the dashboard. Lab co-authors you pick on your own papers see them read-only in their Publications." }),
    h("div", { class: "tasks", id: "paper-list" }),
    h("details", { class: "sub", id: "paper-add" }, h("summary", { text: "+ Add a paper: currently writing, submitted or accepted" }), h("div", { style: "margin-top:10px" }, paperAddForm(supSelf()))),
    exportBox(() => papersOf(SUP), "WiNDS Lab"));
  return h("div", { class: "sup-page" }, tabs,
    h("div", { class: "tabpane", "data-spane": "tasks" }, minePage()),
    h("div", { class: "tabpane", "data-spane": "papers" }, papers),
    h("div", { class: "tabpane", "data-spane": "reading" }, readingPanel()),
    h("div", { class: "tabpane", "data-spane": "reviews" }, reviewsPanel()),
    h("div", { class: "tabpane", "data-spane": "meetings" }, schedPage(), calendarPanel()));
}
function showSupTab() {
  if (!SUP_TABS.some(([k]) => k === S.supTab)) S.supTab = "tasks";
  document.querySelectorAll("[data-stab]").forEach(b => b.setAttribute("aria-selected", b.dataset.stab === S.supTab ? "true" : "false"));
  document.querySelectorAll("[data-spane]").forEach(p => p.hidden = p.dataset.spane !== S.supTab);
  saveNav();
}
function refreshSup() {
  refreshMine(); refreshSched();
  const pp = drawPapers(papersOf(SUP));
  const n = (k, v) => { const el = document.getElementById("stabn-" + k); if (el) el.textContent = v || ""; };
  const b = mineBuckets();
  n("tasks", b.overdue.length + b.today.length + b.upcoming.length + b.nodate.length);
  n("papers", pp.length);
  n("reading", (S.supRefs || []).filter(r => !r.read).length);
  n("meetings", upcomingSched().length);
  n("reviews", (S.reviews || []).filter(r => r.status !== "Done").length);
  refreshReviews();
  refreshReading();
}
function readingPanel() {
  const type = h("select", { id: "sr-type" }, ["Journal", "Conference", "Other"].map(x => h("option", { value: x, text: x === "Other" ? "Other (preprint, book, thesis…)" : x })));
  const form = h("form", { class: "edit-box", onsubmit: async e => {
      e.preventDefault(); const title = val("sr-title").trim(); let link = val("sr-link").trim();
      if (!title) { say("Add the paper's title."); return; }
      if (link && !/^https?:\/\//i.test(link)) link = /^10\.\d{4,}\//.test(link) ? "https://doi.org/" + link : "https://" + link;
      const ok = await write(db => db.collection("supervisor/me/refs").add({ title, link, type: type.value, venue: val("sr-venue").trim(), note: val("sr-note").trim(), read: false, added: todayStr(), createdAt: Date.now() }), "Added to your reading list");
      if (ok) ["sr-title", "sr-link", "sr-venue", "sr-note"].forEach(id => document.getElementById(id).value = "");
    } },
    h("h4", { text: "Add a paper to read" }),
    h("label", { class: "fieldlabel" }, "Title", h("input", { id: "sr-title", maxlength: "400", placeholder: "e.g. Graph Neural Networks for Wireless Resource Allocation" })),
    h("div", { class: "row" }, h("label", { class: "fieldlabel" }, "Type", type),
      h("label", { class: "fieldlabel" }, "Journal / conference (optional)", h("input", { id: "sr-venue", maxlength: "300", placeholder: "e.g. IEEE JSAC" }))),
    h("div", { class: "row" },
      h("label", { class: "fieldlabel" }, "Link (URL or DOI)", h("input", { id: "sr-link", maxlength: "500", placeholder: "https://… or 10.xxxx/…" })),
      h("label", { class: "fieldlabel" }, "Note (optional)", h("input", { id: "sr-note", maxlength: "300", placeholder: "Why read it, for which project" }))),
    h("div", null, h("button", { class: "btn", type: "submit", text: "Add to reading list" })));
  return h("section", { class: "panel sec-refs" },
    h("div", { class: "panel-head" }, h("h3", { text: "Reading list" }), h("span", { class: "muted", id: "sr-count" })),
    h("p", { class: "note", text: "Papers you want to read. Only you can see this list. Tick one off when you've read it." }),
    form, h("div", { id: "sr-list" }));
}
function readingItem(r) {
  let host = ""; try { host = r.link ? new URL(r.link).hostname.replace(/^www\./, "") : ""; } catch (e) { host = ""; }
  const box = h("input", { type: "checkbox", checked: !!r.read, "aria-label": "Read", onchange: e => write(db => db.doc("supervisor/me/refs/" + r.id).update({ read: e.target.checked, readOn: e.target.checked ? todayStr() : "" }), e.target.checked ? "Marked as read" : "Moved back to “To read”") });
  let armed = null; const del = h("button", { class: "x", type: "button", text: "Remove" });
  del.onclick = () => { if (!armed) { del.textContent = "Confirm remove"; armed = setTimeout(() => { armed = null; del.textContent = "Remove"; }, 4000); return; } clearTimeout(armed); write(db => db.doc("supervisor/me/refs/" + r.id).delete(), "Removed from your reading list"); };
  return h("li", { class: "ref reading" + (r.read ? " is-read" : "") },
    h("label", { class: "reading-check" }, box),
    h("div", { style: "min-width:0;flex:1" },
      r.link ? h("a", { class: "ref-title", href: r.link, target: "_blank", rel: "noopener", text: r.title }) : h("span", { class: "ref-title", text: r.title }),
      h("div", { class: "t-sub" }, r.type ? h("span", { class: "chip " + (r.type === "Journal" ? "" : "plain"), text: r.type }) : null,
        r.venue ? h("span", { class: "p-venue", text: r.venue }) : null, host ? h("span", { class: "mono", text: host }) : null,
        h("span", { text: r.read && r.readOn ? "Read " + fmtD(r.readOn) : "Added " + fmtD(r.added) })),
      r.note ? h("p", { class: "ref-note", text: r.note }) : null),
    del);
}
function refreshReading() {
  const box = document.getElementById("sr-list"); if (!box) return;
  const all = [...(S.supRefs || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const todo = all.filter(r => !r.read), done = all.filter(r => r.read).sort((a, b) => (b.readOn || "").localeCompare(a.readOn || ""));
  document.getElementById("sr-count").textContent = todo.length + " to read" + (done.length ? " · " + done.length + " read" : "");
  box.replaceChildren(
    h("div", { class: "task-group" }, h("span", { text: "To read" }), h("span", { class: "mono", text: String(todo.length) })),
    h("ul", { class: "refs" }, ...(todo.length ? todo.map(readingItem) : [h("li", null, h("p", { class: "note", text: "Nothing waiting. Add a paper above." }))])),
    ...(done.length ? [h("details", { class: "sub" }, h("summary", { text: plural(done.length, "paper") + " read" }), h("ul", { class: "refs", style: "margin-top:8px" }, done.map(readingItem)))] : []));
}

let builtFor = null;
function renderDetail(force) {
  if (!S.isOwner && S.sel === null && S.loaded >= NCOLL && S.students.length) S.sel = S.students[0].id;
  if (S.sel === null) { builtFor = null; renderOverview(); return; }
  if (S.sel === "__sched") { S.sel = "__mine"; S.supTab = "meetings"; builtFor = null; }   // meetings now live under Supervisor
  if (S.sel === "__mine") {
    if (builtFor !== "__mine" || force) { document.getElementById("detail").replaceChildren(supPage()); builtFor = "__mine"; showSupTab(); }
    refreshSup(); return;
  }
  if (String(S.sel).startsWith("__g:")) {
    const g = (S.groups || []).find(x => x.id === S.sel.slice(4));
    if (!g) { if (S.groupsLoaded) { S.sel = "__msgs"; builtFor = null; renderDetail(); } return; }
    if (builtFor !== S.sel || force) { document.getElementById("detail").replaceChildren(groupPage(g)); builtFor = S.sel; msgSig = null; stickBottom = true; }
    refreshGroupPage(g); return;
  }
  if (S.sel === "__msgs") {
    if (builtFor !== "__msgs" || force) { document.getElementById("detail").replaceChildren(inboxPage()); builtFor = "__msgs"; }
    refreshInbox(); return;
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
function select(id, taskId) {
  S.sel = id; builtFor = null; S.filter = "all"; renderAll(); saveNav();
  // on phones the left column sits above the page, so jump to what was opened
  if (id !== null && matchMedia("(max-width: 860px)").matches) { const d = document.getElementById("detail"); if (d) d.scrollIntoView({ block: "start" }); }
  else window.scrollTo({ top: 0 });
  if (taskId) focusTask(taskId);
}
/* Remember the last page, tab and conversation on this browser, so a reload or the next sign-in opens the same place. */
function navKey() { return "winds.nav." + (S.uid || ""); }
function saveNav() { try { localStorage.setItem(navKey(), JSON.stringify({ sel: S.sel, tab: S.tab, supTab: S.supTab, thread: S.thread })); } catch (e) { /* private window: fine */ } }
function restoreNav() {
  try {
    const n = JSON.parse(localStorage.getItem(navKey()) || "null"); if (!n) return;
    if (S.isOwner && n.sel !== undefined) S.sel = n.sel;
    if (n.tab) S.tab = n.tab; if (n.supTab) S.supTab = n.supTab; if (n.thread) S.thread = n.thread;
  } catch (e) { /* nothing saved */ }
}

/* ---------- start-up: sign-in check, role, live data ---------- */
const subs = {};
function rebuildFlat() {
  for (const k of ["tasks", "meetings", "papers", "refs", "schedule", "leaves", "messages", "msgstate"]) S[k] = Object.values(subs).flatMap(x => x.data[k] || []);
  const have = new Set(S.papers.map(p => p.studentId + "/" + p.id));
  S.papers.push(...(S.sharedPapers || []).filter(p => !have.has(p.studentId + "/" + p.id)));   // papers a labmate added with this student as co-author
}
function watchStudent(sid) {
  if (subs[sid]) return;
  const entry = subs[sid] = { data: {}, un: [] };
  for (const k of ["tasks", "meetings", "papers", "refs", "schedule", "leaves", "messages", "msgstate"]) entry.un.push(S.db.collection(C(k, sid)).onSnapshot(snap => {
    entry.data[k] = snap.docs.map(doc => ({ ...doc.data(), id: doc.id, studentId: sid })); rebuildFlat(); renderAll();
  }, err => say("Couldn't load some " + k + ". Reload the page to try again.")));
}
const gsubs = {};
function rebuildGroups() { S.gmsgs = []; S.gseen = []; for (const e of Object.values(gsubs)) { S.gmsgs.push(...(e.data.messages || [])); S.gseen.push(...(e.data.seen || [])); } }
function watchGroup(gid) {
  if (gsubs[gid]) return;
  const entry = gsubs[gid] = { data: {}, un: [] };
  for (const k of ["messages", "seen"]) entry.un.push(S.db.collection("groups/" + gid + "/" + k).onSnapshot(snap => {
    entry.data[k] = snap.docs.map(doc => ({ ...doc.data(), id: doc.id, groupId: gid })); rebuildGroups(); renderAll();
  }, () => {}));
}
function unwatchMissing() { for (const sid of Object.keys(subs)) if (!S.students.some(x => x.id === sid)) { subs[sid].un.forEach(u => u()); delete subs[sid]; rebuildFlat(); } }

/** Top bar: initials, name and role; page heading greets the person. */
function showAccount(name, role) {
  const initials = String(name).replace(/^(dr|prof)\.?\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  document.getElementById("avatar").textContent = initials;
  document.getElementById("acctName").textContent = name;
  document.getElementById("acctRole").textContent = role;
  document.getElementById("account").hidden = false;
  const hr = new Date().getHours(), part = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  // "Dr. Alakesh Kalita" -> "Dr. Kalita"; "Priya Sharma" -> "Priya"
  const w = String(name).trim().split(/\s+/), titled = /^(dr|prof)\.?$/i.test(w[0]) && w.length > 1;
  document.getElementById("page-title").textContent = part + ", " + (titled ? w[0] + " " + w[w.length - 1] : w[0]);
}
/* ---------- notification bell: changes made by the other side ---------- */
const B = { items: [], seen: 0, shown: new Set(), key: "", first: true, baseTitle: document.title };
function bellLoad() { try { B.seen = Number(localStorage.getItem(B.key)) || 0; } catch (e) { B.seen = 0; } }
function bellSave() { try { localStorage.setItem(B.key, String(B.seen)); } catch (e) { /* this browser won't remember; fine */ } }
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now"; if (m < 60) return m + " min ago";
  const hrs = Math.round(m / 60); if (hrs < 24) return hrs + " h ago";
  const d = Math.round(hrs / 24); if (d < 7) return d + (d === 1 ? " day ago" : " days ago");
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function bellUnread() { return B.items.filter(e => e.ts > B.seen); }
function bellRender() {
  const n = bellUnread().length, cnt = document.getElementById("bellCount");
  if (!cnt) return;
  cnt.textContent = n > 9 ? "9+" : String(n); cnt.hidden = !n;
  document.getElementById("bellBtn").setAttribute("aria-label", n ? n + " new notifications" : "Notifications");
  document.title = (n ? "(" + n + ") " : "") + B.baseTitle;
  const list = document.getElementById("bellList");
  if (!B.items.length) list.replaceChildren(h("li", { class: "bell-empty", text: S.isOwner ? "No changes from students yet. When a student adds or updates something, it shows up here." : "Nothing new. When your supervisor gives feedback, adds a task or schedules a meeting, it shows up here." }));
  else list.replaceChildren(...B.items.slice(0, 40).map(e => {
    const who = S.isOwner && e.student ? (S.students.find(x => x.id === e.student) || {}).name : "";
    return h("li", {}, h("button", { type: "button", class: "bell-item" + (e.ts > B.seen ? " unread" : ""), onclick: () => bellOpen(e) },
      h("span", { class: "bell-text", text: e.text }),
      h("span", { class: "bell-meta", text: ago(e.ts) + (who && e.text.indexOf(who) < 0 ? " · " + who : "") })));
  }));
  const foot = document.getElementById("bellFoot");
  if ("Notification" in window && Notification.permission === "default") foot.replaceChildren(h("button", { type: "button", class: "btn ghost small", text: "Turn on desktop alerts", onclick: async () => { try { await Notification.requestPermission(); } catch (e) { /* ignored */ } bellRender(); say(Notification.permission === "granted" ? "Desktop alerts are on while this site is open in a tab." : "Desktop alerts stay off. You'll still see the bell."); } }));
  else if ("Notification" in window && Notification.permission === "granted") foot.replaceChildren(h("span", { class: "note", text: "Desktop alerts are on while this site is open in a tab. Emails still arrive for feedback, meetings and due dates." }));
  else foot.replaceChildren(h("span", { class: "note", text: "Desktop alerts are blocked in this browser's site settings." }));
}
function bellToggle(open) {
  const p = document.getElementById("bellPanel"), btn = document.getElementById("bellBtn");
  const willOpen = open === undefined ? p.hidden : open;
  p.hidden = !willOpen; btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  if (willOpen) bellRender();
}
function bellMarkRead() { if (B.items.length) B.seen = Math.max(B.seen, B.items[0].ts); bellSave(); bellRender(); }
function bellOpen(e) {
  if (e.ts > B.seen) { B.seen = Math.max(B.seen, e.ts); bellSave(); }
  bellToggle(false); bellRender();
  if (e.tab && e.tab.indexOf("group:") === 0) { const gid = e.tab.slice(6); if (S.isOwner) select("__g:" + gid); else { S.tab = "messages"; S.thread = gid; select(S.sel); } return; }
  if (e.tab === "messages") S.thread = "dm";
  if (S.isOwner && e.tab === "papers" && !e.student) { S.supTab = "papers"; select("__mine"); return; }
  if (e.tab === "reviews") { if (S.isOwner) { S.supTab = "reviews"; select("__mine"); } else { S.tab = "reviews"; select(S.sel); } return; }
  if (e.tab === "confs") { if (S.isOwner) select("__confs"); else { S.tab = "confs"; select(S.sel); } return; }
  if (S.isOwner) { if (!e.student || !S.students.some(x => x.id === e.student)) { select(null); return; } S.tab = e.tab || "tasks"; select(e.student); }
  else { S.tab = e.tab || "tasks"; select(S.sel); }
}
function bellIncoming(list) {
  B.items = list.slice().sort((a, b) => b.ts - a.ts);
  if (B.first) {                                   // first load in this browser: don't flood with old changes
    B.first = false;
    if (!B.seen) { B.seen = B.items.length ? B.items[0].ts : Date.now(); bellSave(); }
    B.items.forEach(e => B.shown.add(e.ts + e.text));
    bellRender(); return;
  }
  const fresh = B.items.filter(e => e.ts > B.seen && !B.shown.has(e.ts + e.text));
  fresh.forEach(e => B.shown.add(e.ts + e.text));
  bellRender();
  if (!fresh.length) return;
  say(fresh.length === 1 ? "🔔 " + fresh[0].text : "🔔 " + fresh.length + " new updates. Open the bell to see them.");
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    try {
      const n = new Notification(fresh.length === 1 ? "WiNDS Lab Research Tracking" : fresh.length + " new updates · WiNDS Lab", { body: fresh[0].text, tag: "winds-activity", icon: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f5f8b"/><text x="32" y="44" font-size="34" text-anchor="middle" fill="#fff" font-family="Georgia">W</text></svg>') });
      n.onclick = () => { window.focus(); bellOpen(fresh[0]); n.close(); };
    } catch (e) { /* some browsers only allow this from a service worker */ }
  }
}
function bellInit(user) {
  B.key = "winds.seen." + (user.uid || user.email || user.key || "me");
  bellLoad();
  document.getElementById("bellBtn").onclick = ev => { ev.stopPropagation(); bellToggle(); };
  document.getElementById("bellRead").onclick = () => bellMarkRead();
  document.getElementById("bellPanel").addEventListener("click", ev => ev.stopPropagation());
  document.addEventListener("click", () => { const p = document.getElementById("bellPanel"); if (p && !p.hidden) bellToggle(false); });
  document.addEventListener("keydown", ev => { if (ev.key === "Escape") { const p = document.getElementById("bellPanel"); if (p && !p.hidden) { bellToggle(false); document.getElementById("bellBtn").focus(); } } });
  setInterval(() => { if (!document.getElementById("bellPanel").hidden) bellRender(); }, 60000);   // keep "5 min ago" current
  onActivity(bellIncoming);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.tab === "messages") renderAll(); });
  bellRender();
}

export async function start(pageRole) {
  document.getElementById("signOutBtn").onclick = () => signOut();
  if (!configured) { S.loaded = NCOLL; setupNotice(document.getElementById("detail")); return; }
  const user = await currentUser();
  if (!user) { location.href = "index.html"; return; }
  const sup = isSupervisor(user);
  if (pageRole === "supervisor" && !sup) { location.href = "student.html"; return; }
  if (pageRole === "student" && sup) { location.href = "dashboard.html"; return; }
  S.db = db; S.uid = user.uid; S.isOwner = sup;
  restoreNav();
  if (document.getElementById("bellBtn")) bellInit(user);
  try { const c = localStorage.getItem("winds.course"); if (c && (c === "all" || COURSES.includes(c))) S.course = c; } catch (e) { /* default: all */ }
  S.myName = sup ? "Supervisor" : (user.displayName || "Student"); S.myRole = sup ? "supervisor" : "student";
  S.supName = sup ? (user.displayName || "Supervisor") : "";
  showAccount(sup ? (user.displayName && user.displayName !== "Supervisor" ? user.displayName : "Supervisor") : (user.displayName || "Student"), sup ? "Supervisor · " + user.email : "Student");
  S.timer = setTimeout(() => { if (S.loaded < NCOLL) { const n = document.getElementById("loadnote"); if (n) n.textContent = "Can't reach the saved records yet. They'll appear when the connection returns."; } }, 10000);
  renderAll();
  db.collection("groups").onSnapshot(snap => {
    S.groups = snap.docs.map(d => ({ ...d.data(), id: d.id })); S.groupsLoaded = true;
    S.groups.forEach(g => watchGroup(g.id));
    for (const gid of Object.keys(gsubs)) if (!S.groups.some(g => g.id === gid)) { gsubs[gid].un.forEach(u => u()); delete gsubs[gid]; rebuildGroups(); }
    renderAll();
  }, () => {});
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
    db.collection("supervisor/me/papers").onSnapshot(snap => { S.supPapers = snap.docs.map(d => ({ ...d.data(), id: d.id, studentId: SUP })); renderAll(); }, () => {});
    db.collection("reviews").onSnapshot(snap => { S.reviews = snap.docs.map(d => ({ ...d.data(), id: d.id })); renderAll(); }, () => {});
    db.collection("supervisor/me/refs").onSnapshot(snap => { S.supRefs = snap.docs.map(d => ({ ...d.data(), id: d.id, studentId: SUP })); renderAll(); }, () => {});
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
      showAccount(S.myName, "Student · " + (snap.data().admissionNo || key.toUpperCase()) + " · " + courseOf(snap.data()));
      watchStudent(key); S.sel = key;
      if (!S.revSub) S.revSub = db.collection("reviews").onSnapshot(sn => { S.reviews = sn.docs.map(d => ({ ...d.data(), id: d.id })); renderAll(); }, () => {});
      if (!S.supSub) S.supSub = db.collection("supervisor/me/papers").onSnapshot(sn => { S.supPapers = sn.docs.map(d => ({ ...d.data(), id: d.id, studentId: SUP, shared: true })); renderAll(); }, () => {});
      if (!S.sharedSub) S.sharedSub = db.collectionGroup("papers").onSnapshot(sn => {
        S.sharedPapers = sn.docs.filter(d => d.owner !== key).map(d => ({ ...d.data(), id: d.id, studentId: d.owner, shared: true })); rebuildFlat(); renderAll();
      }, () => {});
      if (!snap.metadata.fromCache) { S.loaded = NCOLL; clearTimeout(S.timer); }
      renderAll();
    }, err => { S.loaded = NCOLL; renderAll(); say("Couldn't load your record (" + (err.code || "error") + ")."); });
  }
}
