# WiNDS Lab Research Tracking — GitHub Pages + Google Drive

- **Website:** these files, hosted free on GitHub Pages.
- **Data:** a Google Sheet called **"WiNDS Lab Research Tracking — data"** in *your* Google Drive, written by a small Google Apps Script (`google-apps-script/Code.gs`) that runs under your Google account.
- **Logins:** separate pages for students (**admission number + password**) and the supervisor (**email + password**). Students don't need Google accounts.

```
index.html              start page: "I'm a student" / "I'm the supervisor"
student-login.html      student sign-in (admission number + password)
forgot.html             "Forgot?" — emails a reset link
reset.html              opened from the email: choose a new password / password
register.html           student sign-up with the lab code (starts as 67890)
supervisor-login.html   supervisor sign-in (email + password)
supervisor-signup.html  supervisor sign-up, once, with the setup key
dashboard.html      supervisor's working page
student.html        a student's own working page
assets/config.js    ← the only file you edit (paste the Apps Script URL)
assets/core.js      talks to the Apps Script
assets/tracker.js   tasks, papers, meetings
assets/app.css      styles
google-apps-script/Code.gs   the backend that stores data in your Drive
```

## Part A — Google Drive backend (10 minutes)

1. Go to <https://script.google.com> → **New project**. Name it "WiNDS Lab Research Tracking".
2. Delete what's in `Code.gs`, paste in the whole of **`google-apps-script/Code.gs`**, and **Save**.
3. In the function menu next to **Run ▶** choose **`init`**, click **Run**, and approve the permissions it asks for
   (Google may show "Google hasn't verified this app": click **Advanced → Go to WiNDS Lab Research Tracking** — it's your own script).
4. Open **Execution log**. Note two things:
   - the **Data sheet** link (the Google Sheet now in your Drive), and
   - the **SETUP KEY** — you need it once, in Part C.
5. **Deploy → New deployment** → gear icon → **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - **Deploy**, then copy the **Web app URL** (ends in `/exec`).

> **Use a personal Gmail account if "Anyone" isn't offered.** Some institute (Workspace) accounts only allow "Anyone within the institute", which would make students sign in to Google and blocks the site from calling the script.

## Part B — Website on GitHub Pages (5 minutes)

1. Open **`assets/config.js`** and paste the Web app URL into `API_URL`.
2. On GitHub: **New repository** (e.g. `phd-log`, Public) → **Add file → Upload files** → drag in *everything in this folder* (keep the `assets` folder) → **Commit**.
3. Repository **Settings → Pages** → Source: **Deploy from a branch** → Branch **main**, folder **/ (root)** → **Save**.
4. After a minute your site is at **https://winds-phd.github.io/**.

## Part C — First sign-in

1. Open **https://winds-phd.github.io/supervisor-signup.html** (or the start page → "I'm the supervisor").
2. Enter the **SETUP KEY** from Part A, your name, email and a password (8+ characters).
3. You're on the dashboard. The left column shows the **lab code** (67890; you can change it) and the student sign-up link with a **Copy link** button.

## Students
Send them `https://winds-phd.github.io/register.html` and the lab code. They register once, then sign in at **https://winds-phd.github.io/student-login.html** with **admission number + password**. Each student sees only their own record; the Apps Script checks this on every request.

## Sections on each student's page
Tasks (blue) · Publications (green) · Read articles: title, journal or conference name, and link (violet) · Conferences: shared by the whole group, anyone can add (rose) · Meetings (peach). Supervisor feedback is highlighted in yellow wherever it appears.

## Personal messages
A private conversation between you and each student. Only the two of you can read it.
- **Students:** the **Messages** tab on their page.
- **You:** **Messages** in the left column lists every student's conversation, unread ones first, with the latest message. Each student also has a **Messages** tab.
- Enter sends, Shift+Enter starts a new line. "✓ Seen" appears under your last message once the other person has opened the conversation. You can delete your own messages (you can also delete a student's); messages can't be edited.
- New messages show up in the bell and as "N new" counts on the tab, the left column and the student's name. **No email is sent for messages.**

## Supervisor workspace
"Supervisor" in the left column (it replaced "My tasks & reminders" and "Scheduled meetings") has four tabs:
- **Tasks & reminders:** your own to-do list and reminders, as before. Only you can see it.
- **My papers:** all papers of the lab: your own **plus every student's paper** (marked "Co-author"), so its Draft / Submitted / Accepted counts equal the totals at the top of the dashboard (with "All students" selected). Your own papers have the same stages, Overleaf link, history and co-author fields as student papers; you can add, edit and delete them. Students can also pick you in their co-author drop-down, so your name appears in the author list. Lab co-authors you pick see the paper in their Publications (marked "Co-author", read-only) and get a bell alert when added and when its status changes. Outside co-authors are typed as text. Papers without lab co-authors stay private to you.
- **Reading list:** papers to read (title, type, venue, link, note). Tick one when you've read it. Only you can see it.
- **Meetings:** schedule individual or group meetings, including recurring ones, as before.

## Co-authors on papers
When adding or editing a paper there are two co-author fields:
- **Co-authors from the lab:** a drop-down of everyone registered (grouped by course); each pick becomes a chip you can remove with ×. The paper then also appears in each co-author's Publications, marked **Co-author**, and counts towards their Draft / Submitted / Accepted numbers. They get a bell alert when added and whenever the paper's status changes.
- **Co-authors outside the lab:** free text, e.g. "R. Gupta (IIT Delhi), M. Chen (NUS)".
- Optional **Full author list in order** if the exact order matters; otherwise the names above are used.
- Only the student who added the paper and the supervisor can change it; co-authors see it read-only. On the overview, each paper is listed once, with "with <co-authors>" under the student's name.

## Internal paper review
- **Assigning (supervisor):** open any paper (a student's, or your own under Supervisor → My papers) → **Internal review → + Assign a reviewer**. Choose a student, optionally a due date and a note on what to focus on. Assign as many reviewers as you like; each gets a separate review. The reviewer gets an email and a bell alert.
- **Reviewing (student):** the **Reviews** tab shows "Papers you're reviewing", with the Overleaf link, target venue and your note. The reviewer writes one or more comments, then **Submit review** with a verdict: Ready to submit, Minor changes or Major changes. At least one comment is required. The author and you get an email.
- **Who sees what:** a review is visible only to its reviewer, the paper's author and you. Two reviewers of the same paper don't see each other's reviews. The author and you can reply in the thread. Reviewers can read the paper but not edit it.
- **Your Reviews tab** (Supervisor → Reviews) lists every review, open ones first. There you can change the due date, reopen a review, or remove it. Each paper card shows "Internal review · 1 of 2 done".
- **Reminders:** the reviewer gets an email the day before the due date. Comments trigger bell alerts only, not emails.
- Deleting a paper or removing a student also removes the related reviews.

## Paper deadlines
- On any paper's form (add or edit): **Submission deadline** and **What's due** (e.g. "INFOCOM 2027 full paper"). **Fill from Upcoming conferences** copies a conference's name and deadline in one step; journal or special-issue deadlines can be typed.
- While the paper is a **draft**, its card shows a countdown ("Deadline 29 Nov · 7 days left", amber at 14 days, red at 7).
- Reminders go out **14, 7 and 2 days before** (from 9 AM), by email to the student and you (only you for your own papers) and in the bell. Each one is sent once. Changing the deadline starts the reminders again for the new date. Reminders stop once the paper is marked Submitted. They need the email timer from `setupNotifications`.

## Export publications
- **Supervisor → My papers** (all lab papers) and each student's **Publications** have **Export publications** at the bottom.
- Tick which stages to include (Drafts, Submitted / under review, Accepted / published), then **Download BibTeX (.bib)**, **Download list (.txt)** in IEEE style, or **Copy list**. Drafts are marked "in preparation" and submitted papers "under review". If "Full author list in order" is filled, that order is used; otherwise the owner, lab co-authors, then outside co-authors.

## Calendar feed (Google Calendar, iPhone, Outlook)
- **Supervisor → Meetings** and each student's **Meetings** tab have **Add to your calendar → Get my calendar link**. Subscribe to the link once; it updates by itself (Google refreshes every few hours).
- **Supervisor feed:** all scheduled meetings (repeats and cancelled dates included), your tasks and reminders, tasks you took on for students, every draft paper's deadline, conference deadlines and students' approved leave.
- **Student feed:** their meetings, own task due dates, deadlines of their papers and co-authored papers, conference deadlines and their approved leave.
- The link is private. **Make a new link** switches the old one off if it was ever shared by mistake.

## Attachments in messages (images and PDFs)
- In any private or group conversation, click 📎, **paste** an image (Ctrl/Cmd+V), or **drag and drop** files onto the conversation. Up to 5 files per message, 5 MB each. Large phone photos are reduced automatically before upload. Only JPG, PNG, GIF, WebP and PDF are accepted.
- Images show inside the conversation; click one to open it full size. PDFs show as a card; click to open it.
- Files are stored in a **private folder in your Google Drive** ("WiNDS Lab Research Tracking — message files") and are never shared by link. The script checks that the person can read that conversation before sending a file. Deleting a message moves its files to Drive's Trash.
- **One-time step after updating Code.gs:** in the Apps Script editor, choose **setupFiles** in the function menu, click **Run** and approve the Google Drive permission. Then deploy a New version.

## Smaller conveniences
- The site remembers the page, tab and conversation you last had open (per browser).
- Unsent message text is kept per conversation while you move around the site.
- **Students drop-down:** in the left column, students are in one drop-down grouped by course (PhD / Masters / B-Tech), each showing alerts such as "1 overdue", "leave request" or "2 new messages". You can type the first letters of a name while it's open to jump to it. Below it, **Needs attention** lists only the students with something overdue, a pending leave request or unread messages; click a name to open that student.
- On phones, opening a student or page scrolls straight to it.

## Group messages
You create groups and choose their members. Students can't create or change groups.
- **Create:** Messages (left column) → **+ New group** → name it (e.g. "PhD group", "Masters group", "Simulation team") and tick the students. "Select all PhD" / "Select all Masters" buttons tick a whole course at once; a group can mix courses.
- **Where groups appear:** for you, at the top of the Messages page; for each member, as a chip next to "Supervisor" on their Messages tab. Students see only the groups they belong to.
- **Chat:** everyone in the group reads and posts; each message shows the sender's name. Unread counts only, bell alerts, **no emails**. Members can delete their own posts; you can delete any post.
- **Change or remove:** open the group → **Edit name & members**. A student you add sees the group's earlier messages; a student you remove loses access to the group straight away. **Delete group** removes it and all its messages.
- New students aren't added to groups automatically; edit the group to include them.

## Profile & leave
Each student has a **Profile & leave** tab: name, admission number, course, year of admission, research topic, co-supervisor, email and phone (editable with **Edit profile**), followed by their leave record.
- **Students apply for leave:** first day, last day, type (Personal, Medical, Academic, Family / emergency, Other) and a reason. **Every calendar day counts, Saturdays and Sundays included** (Fri 20 to Mon 23 = 4 days). Overlapping dates are refused with a message. A request can be withdrawn while it's still pending.
- **You approve or reject**, with an optional note, from the student's tab or from **Leave requests waiting for you** at the top of the Group overview. **Change decision** sends one back to pending. **Record leave** on a student's tab saves leave as approved straight away. Only you can approve, reject or delete; the server enforces this.
- **Yearly totals:** approved days per calendar year, with days still waiting for approval shown separately and a breakdown by type. Use the Year menu for earlier years. Leave over New Year is split between the two years. The overview table has a **Leave <year>** column for every student.
- **Notifications:** you get an email and a bell alert when a student applies; the student gets an email and a bell alert when you approve, reject or record leave.

## Courses and recurring meetings
- Students are grouped by course (PhD, Masters, B-Tech) in the sidebar and on the overview. The **Showing** switch above the figures narrows the dashboard to one course; your choice is remembered on that device.
- **Scheduled meetings → Repeats:** every week, every 2 weeks or every month, with an optional end date. Each occurrence gets its own 15-minute reminder email. Use **Cancel this one** to skip a single date, or **Cancel series** to stop it.
- For group meetings you can tick **All PhD**, **All Masters** or **All B-Tech** instead of picking names.

## Which Apps Script project holds your data (important)
- **Working project:** the Apps Script project **"PhD Supervisor"** (personal Gmail). Its web app link ends in **`…QBj1mDnuoA/exec`**, which is what `assets/config.js` uses.
- **Real data Sheet:** "PhD Supervision Log — data" with ID **`12UK3C58VqG0BT_CMW_D8wgWp26qy5c8Nid21EzJEEKk`**. Running `init` in "PhD Supervisor" says "Supervisor account already exists".
- **To update the server:** open "PhD Supervisor", paste the new Code.gs, save, then **Deploy → Manage deployments → ✏️ → New version → Deploy**. Never "New deployment"; that creates a different link.
- **Not used:** the project "PhD Supervision Log" (link ending in `…lRHzd/exec`) and its Sheet with the same name, "PhD Supervision Log — data" (ID starting `1OiA1o7…`). It was never used for real data. If it shows a setup key or asks for a supervisor sign-up, ignore it. Consider renaming that pair "OLD – not used".

## In-app notifications (the bell)
The 🔔 in the top bar shows changes made by the **other side**, with a red count of unread items:
- **You see** what students do: joined the lab, added or finished a task, comments, papers added or moved (Draft → Submitted → Accepted), Overleaf links, articles, recorded meetings.
- **A student sees** what you do in their record: feedback, new or deleted tasks, tasks marked done or reopened, meetings scheduled or cancelled, plus new conferences.
- Nobody is notified about their own changes. Click an item to jump to it; **Mark all as read** clears the count. The page checks every 10 seconds; the tab title shows the count too, e.g. "(2) Supervisor Dashboard".
- **Turn on desktop alerts** (inside the bell) shows a system pop-up while the site is open in a background tab. When the site is closed, the emails below still cover feedback, meetings and due dates.
- The history is kept in a new **activity** tab of your Sheet (latest ~600 changes; older rows are removed automatically).

## Email notifications
Sent from the Gmail account that owns the Apps Script, to students' **recovery email** and to the supervisor's sign-in email:
- **Supervisor feedback:** the moment you save a remark on a student's task or paper, or log a meeting with notes, remarks or new tasks.
- **Meetings:** about 15 minutes before each scheduled meeting (each invited student, and you), and before your own Reminders.
- **Due dates:** one email the day before a task is due (from 9 AM), to the student or to you, depending on who the task belongs to. Not sent for tasks already Done.

**Turn it on once:** in the Apps Script editor choose **`setupNotifications`** → **Run** → allow the permissions. To check emails arrive, run **`sendTestEmail`** (look in spam the first time).
Free Gmail allows about 100 email recipients a day; a group meeting with 10 students counts as 10.

## Good to know
- **Your data** is the Google Sheet in your Drive (tabs: `docs`, `users`, `sessions`). Don't edit it by hand while people are using the site. Passwords and passwords are stored only as salted hashes.
- **Back up:** in Google Sheets, **File → Make a copy** (or File → Download).
- **Forgot a password or password:** click **Forgot?** on the sign-in page. A reset link (valid 60 minutes, works once) is emailed from your Gmail to the student's recovery email, or to the supervisor's email. All records are kept. At most 3 emails per account per hour.
- **Student has no email on file / no email arrives:** Dashboard → open the student → **Reset login code**, or add their **Recovery email** on their page.
- **Last resort for the supervisor:** in the Apps Script editor run **`newSetupKey`**, then sign up again on `supervisor-signup.html`. Data is kept.
- **Changed `Code.gs` later?** Deploy → **Manage deployments** → edit (pencil) → Version: **New version** → Deploy. The URL stays the same.
- **Speed:** each save takes about 1–2 seconds and other people's changes appear within ~10 seconds. That suits a research group of a few dozen people; Google's free limits are well above that.
- **Removing a student:** Dashboard → open the student → **Remove student** (removes their records and login).
