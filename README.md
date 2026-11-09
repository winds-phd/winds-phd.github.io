# PhD Supervision Log — GitHub Pages + Google Drive

- **Website:** these files, hosted free on GitHub Pages.
- **Data:** a Google Sheet called **"PhD Supervision Log — data"** in *your* Google Drive, written by a small Google Apps Script (`google-apps-script/Code.gs`) that runs under your Google account.
- **Logins:** separate pages for students (**admission number + secret code**) and the supervisor (**email + password**). Students don't need Google accounts.

```
index.html              start page: "I'm a student" / "I'm the supervisor"
student-login.html      student sign-in (admission number + secret code)
register.html           student sign-up with the class code (starts as 67890)
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

1. Go to <https://script.google.com> → **New project**. Name it "PhD Supervision Log".
2. Delete what's in `Code.gs`, paste in the whole of **`google-apps-script/Code.gs`**, and **Save**.
3. In the function menu next to **Run ▶** choose **`init`**, click **Run**, and approve the permissions it asks for
   (Google may show "Google hasn't verified this app": click **Advanced → Go to PhD Supervision Log** — it's your own script).
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
3. You're on the dashboard. The **class code is 67890** (change it in the left column).

## Students
Send them `https://winds-phd.github.io/register.html` and the class code. They register once, then sign in at **https://winds-phd.github.io/student-login.html** with **admission number + secret code**. Each student sees only their own record; the Apps Script checks this on every request.

## Good to know
- **Your data** is the Google Sheet in your Drive (tabs: `docs`, `users`, `sessions`). Don't edit it by hand while people are using the site. Secret codes and passwords are stored only as salted hashes.
- **Back up:** in Google Sheets, **File → Make a copy** (or File → Download).
- **Student forgot their secret code:** Dashboard → open the student → **Reset login code**.
- **You forgot your password:** in the Apps Script editor run **`newSetupKey`**, read the new key in the log, and do Part C again. Data is kept.
- **Changed `Code.gs` later?** Deploy → **Manage deployments** → edit (pencil) → Version: **New version** → Deploy. The URL stays the same.
- **Speed:** each save takes about 1–2 seconds and other people's changes appear within ~10 seconds. That suits a research group of a few dozen people; Google's free limits are well above that.
- **Removing a student:** Dashboard → open the student → **Remove student** (removes their records and login).
