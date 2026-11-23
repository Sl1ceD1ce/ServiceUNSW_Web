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

## Portal data

There is no mock server: everything the portal shows comes either from the
ServiceUNSW backend or from data bundled into the build, so `npm run build`
output runs as plain static files.

- **Bundled catalogue data** lives in [src/data/](src/data/): seeded role
  profiles (`users.json`), the service catalogue, the lecture schedule, demo
  calendar events, timesheet settings, and the starting teaching notes and
  timesheet entries for the seeded profiles.
- **Per-user state** is saved in the backend's key-value store
  (`GET/PATCH/DELETE /v1/users/me/data`, JWT bearer) under `portal.*` keys:
  favourites, calendar settings, personal events, lecture checklists, the
  teaching note and timesheet entries. A record that was never saved falls back
  to its starting value in `src/data/`. It follows the account, not the browser.

[src/api/portalData.ts](src/api/portalData.ts) builds the profile, catalogue,
lecture plan, calendar events and timesheets, and validates every save in the
browser (favourites limit, iCal URL, timesheet future dates, closed periods,
courses, activities and overlaps, draft-only edits). This is a demo: the backend
stores whatever a signed-in client sends.

[src/api/userData.ts](src/api/userData.ts) talks to the store. Backends before
the `20261123000000_user_data_value_mediumtext` migration keep each value in a
`VARCHAR(191)` column, so a record larger than about 180 characters is split
across a header key and `portal.<name>#<n>` chunk keys, all written in one
PATCH. Once every deployed backend has that migration, `MAX_STORED_CHARS` in
userData.ts can be raised so records are stored whole (existing chunked records
still read correctly). Each page load fetches the account's data once. To reset an account's
portal data, `DELETE /v1/users/me/data` with its token (this removes all of
its keys). Records are capped (200 personal events, 300 timesheet entries,
about 90 kB per save) to stay under the backend's 100 kB request limit.

Run `node --test tests/user-data.test.mjs` for the store and validation tests.
They use an in-memory fake backend by default; set `USER_DATA_TEST_API` and
`USER_DATA_TEST_TOKEN` to run them against a real backend with a throwaway
verified account (its `portal.*` keys are overwritten).

## Hosting on AWS

The Development site is `https://dev.serviceunsw.com` (private S3 + CloudFront,
defined in `ServiceUNSW-infra`). To deploy:

```bash
npm run build
```

Then run `scripts/publish-frontend.ts` from `ServiceUNSW-infra`. It uploads
`dist/` and writes `/runtime-config.json` with `apiBaseUrl` (the API Gateway
URL, `https://api.dev.serviceunsw.com` in dev). The app needs nothing else: it
reads that file on load and sends every `/v1` request straight to API Gateway.

- **CORS.** API Gateway allows the frontend's own origin
  (`allowedOrigins: [frontend.url]` in `ServiceUNSW-infra/lib/api-stack.ts`),
  which is `https://dev.serviceunsw.com` in dev. `npm run dev` and
  `npm run preview` need no CORS, because Vite proxies `/v1`. Only a local
  static server whose `runtime-config.json` points at API Gateway directly
  would need its `http://localhost:<port>` origin added to `allowedOrigins`.
- **Routes.** A CloudFront function rewrites extensionless paths such as
  `/calendar` to `/index.html`, so deep links and refreshes work.
- **iCal feeds.** `npm run dev` fetches feeds through the Vite
  `/api/ics-proxy`. The built app uses the backend's `GET /v1/calendar/ics`
  proxy (JWT bearer). If the deployed backend doesn't have that route yet (404),
  it fetches the feed directly from the browser, which only works for feeds
  that send CORS headers.

## Project Structure

```
src/
  App.tsx              # Route definitions
  api/                 # Backend client, key-value store and portal data (see Portal data)
  auth/                # JWT and pending-registration session storage
  calendar/            # Shared event parsing, recurrence and state
  components/          # Shared UI components (Sidebar, ...)
  data/                # Bundled catalogue and starting data
  hooks/               # Portal state (favourites, services, lectures, timesheets)
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

Seeded profiles are bundled from [src/data/users.json](src/data/users.json). Each user
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
API under `/v1`). [src/api/backend.ts](src/api/backend.ts)
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

After sign-in the browser maps the `/users/me` details to the portal profile
used by every other page (`linkProfile` in `src/api/portalData.ts`). A zID matching a seeded profile (below) keeps that profile's roles and teaching
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

This is for demonstration only: it is not UNSW identity. Roles come from the
bundled seed profiles, not from the backend.

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

Favourites are saved in the backend separately for each signed-in user
and survive refreshes and sign-out. New users default to Moodle, myUNSW, Library
and Student email. Service cards on both Home and Quick links
share the same appearance, link behaviour and favourite marker. Storage errors
are displayed explicitly. The shared catalogue is bundled from `src/data/services.json`.
MyPlan replaces Fees & payments and describes the signed-in student's degree
pathway on both pages. Users without a student degree see a generic description.
Existing Fees & payments favourites are migrated to MyPlan.

### Lectures

Professors see a Lectures page under Teaching in the sidebar. It lists two
lectures per week for each professor course between 26 October and 20 November
2026, based on [src/data/lectureSchedule.json](src/data/lectureSchedule.json).
Each lecture has a preparation checklist: no items is Not planned, unchecked
items is Planned, some checked is In progress and all checked is Ready.
Checklists and each professor's teaching note are saved in the backend.

### Timesheets

Tutors see a Timesheets page under Teaching in the sidebar for recording and
submitting teaching hours. Hours are grouped into fortnightly reporting periods
configured in [src/data/timesheetSettings.json](src/data/timesheetSettings.json);
the current and previous periods are open and older periods are read-only.
In the **Record hours** form, a tutor can submit an entry for approval
directly or save it as a draft. Drafts can be opened with the pen button in
Your entries to edit, delete or submit them; submitted entries are read-only.
The app rejects future dates, closed periods, courses the tutor does
not teach and overlapping times. **Export CSV** downloads the selected period.

### Calendar

The calendar includes month navigation, a Today button, a selected-day agenda
and a next-deadline card. My timetable, Deadlines and Campus events can each be
toggled independently. Professors also see their lecture sessions under a
Lectures filter. Demo data in
[src/data/demoCalendarEvents.json](src/data/demoCalendarEvents.json)
includes three assignment deadlines and three illustrative DevSoc events,
dated relative to the day the calendar is opened. These are not actual
university deadlines or scheduled society events.

Settings beside Add event opens the iCal subscription form. HTTP, HTTPS and
webcal links are supported; a blank link disconnects the timetable. Settings
are saved in the backend separately for each signed-in user, and feed
errors are displayed explicitly.
Feeds load through a proxy (the Vite `/api/ics-proxy` in development, the
backend's `/v1/calendar/ics` when hosted; see *Hosting on AWS*).
Add event creates personal events shared with Home. They are saved in the
backend for the signed-in user.
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
