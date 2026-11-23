# ServiceUNSW

This a React + TypeScript app built with Vite, so if you've used React before this should feel familiar.

## Prerequisites

Before getting started, make sure you have the following installed:

- [Node.js](https://nodejs.org/) (LTS version recommended)
- npm (comes with Node.js)

## Installation

Clone the repository and install dependencies:

```bash
npm install
```

## Running the App

Start the local development server:

```bash
npm run dev
```

This prints a local URL (usually `http://localhost:5173`) — open it in your browser. The dev server supports Hot Module Reloading, so most changes show up instantly without a full page refresh.

## Available Scripts

- `npm run dev` — start the Vite dev server
- `npm run build` — type-check with `tsc` and produce a production build in `dist/`
- `npm run preview` — locally preview the production build
- `npm run lint` — run Oxlint over the codebase

## Mock database

Accounts and sign-in use the real backend (see *Sign-in and email
verification*). Portal data still comes from a simulated API
(`/api/profiles` and `/api/users/:userId/...`) served by
[server/mockApi.ts](server/mockApi.ts) inside the Vite dev and preview servers.

- `server/seed/` — committed starting data (users, services, lecture schedule,
  demo calendar events, timesheet settings, starting teaching notes and
  timesheet entries, and empty user tables).
- `.mockdb/` — the local mock database the API reads and writes. It is
  git-ignored because it changes as each person tests the app. On server
  start, any missing table is copied from `server/seed/`; existing data is
  never overwritten.

To reset your local data, stop the server and delete `.mockdb/`. To change the
starting data for everyone, edit `server/seed/`; existing `.mockdb/` folders
keep their current files until deleted. A static build without the Vite server
has no API.

## Project Structure

```
server/
  mockApi.ts           # Simulated API backed by the local mock database
  seed/                # Committed starting data for the mock database
src/
  App.tsx              # Route definitions
  api/                 # Backend client (backend.ts) and simulated API client
  auth/                # JWT and pending-registration session storage
  calendar/            # Shared event parsing, recurrence and state
  components/          # Shared UI components (Sidebar, ...)
  hooks/               # API-backed state (favourites, services, lectures, timesheets)
  models/              # Shared types and helpers
  pages/               # Route pages (Home, Calendar, QuickLinks, Lectures, Timesheets, Profile, SignIn)
```

The service catalogue contains only the fields used by the shared, currently
disabled service cards. Shared icons are SVG components; the UNSW crest and
site favicon are the remaining image assets.

Routing is handled by [react-router-dom](https://reactrouter.com/). Add new pages under `src/pages/` and register them in [App.tsx](src/App.tsx).

The workspace sidebar links to Home (`/home`), Calendar (`/calendar`), and
Quick links (`/quick-links`). The root URL redirects to Home. The profile card
opens `/profile`, and Help & support opens UNSW student support in a new tab.
Teaching staff also see a Teaching section. Users who are both a tutor and a
professor see "Teaching - Tutor" first, followed by "Teaching - Professor".

### User data

User records are seeded from [server/seed/users.json](server/seed/users.json). Each user
has an ID, a name, and a roles array supporting `student`, `tutor`, and
`professor`. The five sample users are Peter (student), Alex (tutor), Jordan
(professor), Sam (tutor and professor), and Taylor (tutor and student).
The sidebar and profile read the currently signed-in user.
These are fictional sample profiles, including contact details, degree progress
and teaching appointments; they are not connected to university records.

### Profile page

The profile page at `/profile` shows university identity, personal details,
role-specific access, degree progress for students and teaching appointments
for teaching staff. Multiple roles are shown together in the profile and sidebar.
The layout adapts to smaller screens. The degree portal link opens myUNSW in a
new tab. The profile page is read-only and has a Sign out button.
Teaching tool names describe role access; those tools are not yet implemented
in this workspace.

### Sign-in and email verification

Accounts live in the ServiceUNSW backend (`/Users/jason/UniStuff/ServiceUNSW`,
API under `/v1`), not in the mock database. [src/api/backend.ts](src/api/backend.ts)
is the client; [src/pages/SignIn.tsx](src/pages/SignIn.tsx) has three views:

1. **Sign in** posts `{zId, password}` to `/v1/auth/login` and receives a JWT.
   A 403 means the account is unverified: if this tab has that zID's pending
   registration it opens the verify view, otherwise it asks the user to register
   again (the backend allows re-registering an unverified zID after 60 seconds).
2. **Create an account** posts zID, name, date of birth (ms), degree and a
   password (14+ characters with upper, lower and a number) to
   `/v1/auth/register`. The backend emails a six-digit code to
   `<zID>@ad.unsw.edu.au` and returns an opaque `registrationToken`.
3. **Verify your email** posts `{zId, registrationToken, verificationCode}` to
   `/v1/auth/register/verify` and receives a JWT. **Send a new code** calls
   `/v1/auth/register/resend` (60-second cooldown; earlier codes stop working).
   Codes expire after 10 minutes or five wrong attempts.

The JWT and pending registration (zID, token, send time) are kept in
sessionStorage, so a refresh keeps them and closing the tab ends them. Passwords
and codes are never stored. On load the app calls `/v1/users/me`; a 401/403
clears the token and returns to sign-in. Sign out clears the token.

After sign-in the browser posts the `/users/me` details to the mock
`POST /api/profiles`, which returns the portal profile used by every other page.
A zID matching a seeded profile (below) keeps that profile's roles and teaching
appointments; any other zID gets a new student profile. Names and degree come
from the backend.

| Seeded profile | zID | Roles |
| --- | --- | --- |
| Peter | z2460811 | Student |
| Alex | z2460812 | Tutor |
| Jordan | z2460813 | Professor |
| Sam | z2460814 | Tutor, Professor |
| Taylor | z2460815 | Tutor, Student |

**Which backend.** `npm run dev` proxies `/v1` to the AWS Development
deployment, `https://api.dev.serviceunsw.com`. To use a local backend instead,
create `.env.local` containing `SERVICEUNSW_API_URL=http://127.0.0.1:3000`.
The local backend must listen on `0.0.0.0` when it runs in Docker. A hosted
build (S3 + CloudFront, see ServiceUNSW-infra) reads `apiBaseUrl` from
`/runtime-config.json` and calls API Gateway directly with a bearer token.

**Development email limits.** Development SES is in the sandbox, so codes only
reach recipients verified in ServiceUNSW-infra (`sesSandboxRecipients`).
Registering any other zID gets 503 "Email delivery failed". Per-recipient and
per-IP send limits apply (see the backend's `docs/registration-verification.md`).

This is for demonstration only: it is not UNSW identity. The profile bridge
trusts the browser and checks no JWT, and the other portal data is still mock.

### Home

The home page greets the signed-in user and shows today's date, schedule
and radar cards. Home and Calendar share imported iCal, personal and demo events.
Today's schedule includes every event occurring today, including recurring
classes, all-day events, deadlines and campus events, sorted by time with
all-day events first. Calendar display filters do not hide events from Home.
Timetable loading and import errors are shown on both pages.
Run `node --test tests/calendar.test.mjs` for the shared schedule regression tests.
Home favourites use the same service cards and link behaviour as Quick links.
Study support opens `https://www.unsw.edu.au/student/support` in a new tab.

### Quick links and favourites

Quick links lists 12 services grouped into Study & learn, Manage your studies
and Campus & support, with search and All services / Favourites filters.
Moodle opens `https://moodle.telt.unsw.edu.au/` in a new tab on
both Quick links and Home. myUNSW opens
`https://my.unsw.edu.au/portal/portal/student.xml` in a new tab on both pages.
Other service cards remain non-interactive.
Library also opens `https://www.library.unsw.edu.au/` in a new tab on both pages.
Course catalogue opens `https://www.unsw.edu.au/course-outlines` in a new tab on
both pages.
Student wellbeing opens `https://www.unsw.edu.au/student/support` in a new tab
on both pages.
IT help opens `https://www.unsw.edu.au/myit` in a new tab on both pages.
Makerspace opens `https://www.making.unsw.edu.au/` in a new tab on both pages
for booking machines.
Manage favourites opens a
selection dialog. Choose zero to four services and save to update Home.
Cancel leaves the saved selection unchanged. At four selections, deselect a
service before choosing another.

Favourites are saved in the mock database separately for each signed-in user
and survive refreshes and sign-out. New users default to Moodle, myUNSW, Library
and Student email. Service cards on both Home and Quick links
share the same appearance, link behaviour and favourite marker. Storage errors
are displayed explicitly. The shared catalogue is seeded from `server/seed/services.json`.
MyPlan replaces Fees & payments and describes the signed-in student's degree
pathway on both pages. Users without a student degree see a generic description.
Existing Fees & payments favourites are migrated to MyPlan.

### Lectures

Professors see a Lectures page under Teaching in the sidebar. It lists two
lectures per week for each professor course between 26 October and 20 November
2026, based on [server/seed/lectureSchedule.json](server/seed/lectureSchedule.json).
Each lecture has a preparation checklist: no items is Not planned, unchecked
items is Planned, some checked is In progress and all checked is Ready.
Checklists and each professor's teaching note are saved in the mock database.

### Timesheets

Tutors see a Timesheets page under Teaching in the sidebar for recording and
submitting teaching hours. Hours are grouped into fortnightly reporting periods
configured in [server/seed/timesheetSettings.json](server/seed/timesheetSettings.json);
the current and previous periods are open and older periods are read-only.
In the **Record hours** form, a tutor can submit an entry for approval
directly or save it as a draft. Drafts can be opened with the pen button in
Your entries to edit, delete or submit them; submitted entries are read-only.
The API rejects future dates, closed periods, courses the tutor does
not teach and overlapping times. **Export CSV** downloads the selected period.

### Calendar

The calendar includes month navigation, a Today button, a selected-day agenda
and a next-deadline card. My timetable, Deadlines and Campus events can each be
toggled independently. Professors also see their lecture sessions under a
Lectures filter. Demo data in
[server/seed/demoCalendarEvents.json](server/seed/demoCalendarEvents.json)
includes three assignment deadlines and three illustrative DevSoc events,
dated relative to the day the calendar is opened. These are not actual
university deadlines or scheduled society events.

Settings beside Add event opens the iCal subscription form. HTTP, HTTPS and
webcal links are supported; a blank link disconnects the timetable. Settings
are saved in the mock database separately for each signed-in user, and feed
errors are displayed explicitly.
The existing `/api/ics-proxy` endpoint runs in the Vite development server;
a production deployment needs an equivalent server-side endpoint.
Add event creates personal events shared with Home. They are saved in the mock
database for the signed-in user.
Click a day number to view its agenda or an event to view its details.
Event details open in an adjacent non-modal card: to the right on Monday
through Wednesday and to the left on Thursday through Sunday. On small screens
the card stays within the viewport. Close it with its close button, Escape or
an outside click; scrolling or resizing dismisses it. Settings and Add event
still use dialogs.

## Resources

- [React documentation](https://react.dev/)
- [Vite documentation](https://vite.dev/)
- [React Router documentation](https://reactrouter.com/)
