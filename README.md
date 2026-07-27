# PBEC Web Portal

The PBEC web portal is the browser-based admin and teacher console for the PreBoard Exam Checker platform. It uses vanilla HTML, CSS, and JavaScript modules with Firebase Authentication and Firestore.

This folder is a static web app. There is no build step, but it must be served from a local HTTP server. Do not open `index.html` directly with `file://`, because browser module imports and Firebase SDK imports will fail.

## Requirements

Install these before running the portal:

- Node.js 18 or newer
- npm, included with Node.js
- A modern browser such as Chrome, Edge, or Firefox
- Internet access for Firebase Web SDK imports and Firestore/Auth access

Optional fallback tools:

- VS Code with the Live Server extension
- Python 3

## Firebase Project

The web app currently points to this Firebase project in `js/firebase-config.js`:

```text
projectId: boardexam-checker
authDomain: boardexam-checker.firebaseapp.com
```

Firebase services used by the portal:

- Firebase Authentication
- Anonymous Authentication, used for Teacher ID login sessions
- Email/Password Authentication, used for email-based admin or teacher login
- Cloud Firestore

Before running against a new Firebase project, confirm these are enabled in the Firebase console:

1. Go to Firebase Console.
2. Open the project.
3. Open Authentication.
4. Enable Email/Password provider.
5. Enable Anonymous provider.
6. Open Firestore Database.
7. Create or enable the Firestore database.
8. Make sure the web app has permission to read/write the expected collections according to your Firestore rules.

## Install Dependencies

From the repository root:

```bash
cd /Users/jaysonreales/Desktop/dev-project/preboardexam/web
npm install
```

The only local runtime dependency is `serve`, used to host the static files.

## Run Locally

Recommended command:

```bash
cd /Users/jaysonreales/Desktop/dev-project/preboardexam/web
npm run dev
```

This runs:

```bash
npx serve .
```

The server normally starts at:

```text
http://localhost:3000
```

If port `3000` is already used, `serve` may offer another port. Use the URL printed in the terminal.

Open the login page:

```text
http://localhost:3000
```

or:

```text
http://localhost:3000/index.html
```

Keep the terminal running while using the web portal. Stop the server with `Ctrl+C`.

## First-Time Database Setup

The project includes `setup.html` for local/demo initialization.

Start the server first:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000/setup.html
```

The setup page has two actions:

1. Create Admin & Teacher
2. Initialize 50 Students & Questions

Default accounts created by `setup.html`:

```text
Admin email:   admin@catci.edu.ph
Teacher email: teacher@catci.edu.ph
Teacher ID:    T2026-000
Password:      value entered in the setup password field
Default field: pbec2026
```

Notes:

- The password must be at least 6 characters.
- If the account already exists in Firebase Auth, setup will report that it already exists.
- If the Auth account exists but the Firestore `users` role document is missing, login can fail until the matching Firestore user record is fixed.
- Setup sample data is meant for development/demo use. Do not run it repeatedly on production data unless duplicate sample records are acceptable.

## Login Paths

After starting the server, use:

```text
http://localhost:3000/index.html
```

Supported login methods:

- Admin email/password login
- Teacher email/password login
- Teacher ID/password login

Role-based destinations:

- Admin users go to `admin/dashboard.html`.
- Teacher users go to `teacher/dashboard.html`.

Teacher ID sessions are stored in `sessionStorage`, so the session is tab-scoped and is cleared on logout.

## Alternative Run Methods

### VS Code Live Server

1. Open the `web` folder in VS Code.
2. Install the Live Server extension.
3. Right-click `index.html`.
4. Select `Open with Live Server`.
5. Use the local URL shown by VS Code.

If a page link fails because it uses a clean URL, open the matching `.html` file directly from the browser address bar.

### Python HTTP Server

Python can serve the static files:

```bash
cd /Users/jaysonreales/Desktop/dev-project/preboardexam/web
python3 -m http.server 8000
```

Open:

```text
http://localhost:8000/index.html
```

Use this mainly for quick checks. Some extensionless links may not resolve on Python's basic static server. If that happens, use `npm run dev`.

## Important Files

```text
web/
├── index.html                 # Login page
├── setup.html                 # Demo/admin setup helper
├── admin/                     # Admin pages
├── teacher/                   # Teacher pages
├── assets/pbec-logo.png       # Sidebar logo
├── css/style.css              # Global UI styles
├── js/auth.js                 # Login, session, role guards, logout
├── js/firebase-config.js      # Firebase project config
├── js/sidebar.js              # Shared admin/teacher sidebar
├── js/ui.js                   # Shared UI helpers
├── js/audit.js                # Activity logging helper
├── js/settings.js             # Portal settings helper
└── js/lucide-icons.js         # Shared inline Lucide SVG icons
```

## Main Routes

Admin:

```text
admin/dashboard.html
admin/students.html
admin/question-bank.html
admin/exams.html
admin/summary.html
admin/users.html
admin/logs.html
admin/settings.html
```

Teacher:

```text
teacher/dashboard.html
teacher/students.html
teacher/question-bank.html
teacher/exams.html
teacher/summary.html
```

## Typical Development Workflow

1. Open a terminal.
2. Go to the web folder.
3. Run `npm install` if dependencies are missing.
4. Run `npm run dev`.
5. Open `http://localhost:3000/index.html`.
6. Log in as admin or teacher.
7. Edit HTML, CSS, or JS files.
8. Refresh the browser to see changes.
9. Check the browser console for Firebase or JavaScript errors.

No compile step is required.

## Firestore Collections Used

The portal expects these collections:

```text
users
students
question_banks
question_banks/{bankId}/questions
exams
examResults
activityLogs
settings
```

Question banks and exams are shared with the Android app when they use the same Firebase project and compatible ownership fields such as:

```text
teacherId
uploadedByTeacherId
uploadedByUid
uploaderEmail
createdByEmail
```

## Troubleshooting

### Blank page or module import error

Cause: the app was opened through `file://`.

Fix:

```bash
npm run dev
```

Then open `http://localhost:3000/index.html`.

### Firebase permission denied

Check:

- Firestore rules allow the current user to read/write the target collection.
- Authentication provider is enabled.
- The logged-in user has a matching document in `users`.
- The user document has the correct `role`.

### Invalid credentials or Teacher ID

Check:

- The Teacher ID exists in `users.teacherId`.
- The user is active.
- The entered password matches the stored `passwordHash`.
- Anonymous Auth is enabled in Firebase.

### Query requires an index

Firestore may show an index creation link in the browser console. Some pages already avoid composite indexes by filtering client-side. If a new query triggers this error, either create the Firebase index from the console link or adjust the query to avoid the composite index.

### Port already in use

Either use the alternate URL printed by `serve`, or run:

```bash
npx serve . -l 3001
```

Then open:

```text
http://localhost:3001/index.html
```

### Setup page says email already exists

The Auth account already exists. Verify Firestore has a corresponding document in `users` with:

```text
email
role
status or isActive
teacherId, for teacher accounts
passwordHash, for Teacher ID login
```

## Production Notes

For production hosting, deploy the contents of the `web` folder to a static host that supports normal static file serving. Firebase Hosting, Vercel static output, Netlify, or any equivalent static server can work.

Before production use:

- Review Firestore security rules.
- Disable or remove public access to `setup.html`.
- Verify admin accounts manually.
- Confirm Firebase project config points to the intended project.
- Test admin and teacher login flows.
- Test question import, exam generation, summary recording, and logout.

© 2026 PBEC — CATCI
