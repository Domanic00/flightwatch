# FlightWatch V4

V4 adds the automation and alert engine on top of the working V3 deployment.

## New in V4

- Hourly monitoring endpoint for MCO + MIA
- GitHub Actions scheduled workflow
- Watchlist evaluation
- Historical route statistics
- Deal scoring:
  - EXCEPTIONAL — at or below the lowest recorded fare
  - GREAT — at least 25% below recent average
  - GOOD — at least 12% below recent average
  - MATCH — meets your watchlist threshold
  - NEW — insufficient history, but meets your threshold
- Duplicate alert suppression
- Persistent alert history in Neon
- Manual "Run monitor now" button
- Test notification button
- Email delivery support through Resend
- SMS delivery support through Twilio
- Quiet-hours enforcement
- System-status indicators for automation, email, SMS, and cron
- Retains V3 profile, tracked flights, watchlists, and snapshots
- Includes the Render proxy/session fix

## Upgrade the live site

V4 is intended to replace the files in your existing GitHub `flightwatch` repository.

Do NOT delete or recreate the Neon database. V4 automatically adds the new `alerts` table and keeps the existing V3 tables/data.

### Render: new environment variable

Add:

    CRON_SECRET=<a long random secret>

Later, for email:

    RESEND_API_KEY=...
    RESEND_FROM=FlightWatch <your-verified-sender@example.com>

Later, for SMS:

    TWILIO_ACCOUNT_SID=...
    TWILIO_AUTH_TOKEN=...
    TWILIO_FROM_NUMBER=...

You can deploy V4 before Resend or Twilio are configured. The engine will record alert history and mark delivery as `not_configured`.

## Hourly automation with GitHub Actions

The included workflow is:

    .github/workflows/flightwatch-monitor.yml

In your GitHub repository, create these repository Actions secrets:

    FLIGHTWATCH_URL
    CRON_SECRET

`FLIGHTWATCH_URL` should be your Render site URL without a trailing slash, for example:

    https://flightwatch-example.onrender.com

`CRON_SECRET` must exactly match the `CRON_SECRET` value you set in Render.

The workflow runs at minute 17 of each hour and can also be run manually from the Actions tab.

Why use GitHub Actions:
- Your Render free web service can sleep while idle.
- GitHub Actions can wake it by calling the secure monitoring endpoint.
- Your computer does not need to be on.

## Notification setup

### Email — Resend
V4 supports Resend. During initial testing, Resend may restrict where its default sender can send. Once you verify a domain/sender, set `RESEND_FROM` to that sender.

### SMS — Twilio
V4 supports Twilio Messaging. You will need:
- Account SID
- Auth token
- A Twilio sender phone number

Keep all credentials in Render environment variables. Never commit them to GitHub.

## Database migration

No manual SQL is necessary. V4 runs `CREATE TABLE IF NOT EXISTS` at startup and adds the new alert table/index automatically.

## Safe first test

1. Deploy V4.
2. Confirm the site loads and V3 data is still present.
3. Create a cheap watchlist, such as `MCO + MIA → ANY under $100`.
4. Open Alerts.
5. Click `Run monitor now`.
6. Confirm alert records appear.
7. Only then configure Resend/Twilio.
8. Use `Send test notification`.
9. Finally add GitHub Actions secrets for hourly monitoring.

## Important

FlightWatch uses the fare values returned by Google Travel Explore. Always verify the final itinerary, traveler count, fees, and final booking price before purchasing.


## V5 additions
- In-app Admin Center
- Persistent deduplicated provider/application errors
- Acknowledge/resolve workflow
- Provider health overview
- Audit log
- Lightweight beta tester allowlist
- Twilio/Resend failures logged with provider response details

Note: beta users are an administrative allowlist in V5.0; the existing private app password remains the authentication gate. Per-user passwords/invitation links are intentionally deferred so the personal-use architecture stays simple.


## V5.1 Tester Login
Admin adds tester emails under Admin → Beta testers. A tester enters that email, chooses a password of at least 10 characters, and clicks **First-time tester setup** once. Passwords are bcrypt-hashed in Neon. Subsequent sign-ins use email + password. Admin still signs in using email `admin` and the existing `APP_PASSWORD`. Admin APIs are server-side role protected. Core search behavior remains MCO/MIA, 2 travelers, U.S. destinations.

## V5.1.1 Login UI fix
- Restores the visible tester email field.
- Keeps admin login using email `admin` (or blank) + `APP_PASSWORD`.
- Keeps first-time tester setup using invited email + password.

## V5.2 usability fixes
- Persistent Sign out button pinned to the lower-left sidebar.
- Logout now calls `/api/auth/logout` consistently.
- Manual Discover searches can select 1–6 adult travelers; default remains 2.
- Flight deal results are paginated at 10 per page instead of one long infinite list.
- New searches and sorting reset to page 1.

## V5.2.1 hotfix
Fixes a duplicated malformed logout JavaScript block introduced in V5.2 that prevented the page script from parsing. Sign in, tester setup, logout, pagination, and other button handlers can now initialize normally.

## V5.3 user isolation
- Sidebar now shows the signed-in account email and role.
- Tester profile/contact settings are stored separately from the admin profile.
- Tester login email is displayed in Profile and is read-only.
- Admin and System Status navigation are hidden from testers.
- `/api/admin/*` and `/api/status` are server-side admin-only.
- Admin profile remains unchanged and continues using the original profile record.

## V6 all-in-one
- Full private ownership for tracked flights, watchlists, profiles, and alert reads. Existing pre-V6 rows migrate to the admin owner.
- Shared price snapshots remain global system data intentionally.
- Groups: create groups, invite existing tester emails, accept invitations, and provide a foundation for explicitly shared tracked routes/watchlists.
- Advanced SerpApi-backed search filters: travelers, exact outbound/return dates, cabin class, stops.
- Searchable destination and airline filtering in the UI.
- Destination-first results: destinations are the primary cards, with airline/fare options nested underneath.
- Pagination is 10 destinations per page.
- MCO/MIA remain the only departure airports and U.S. destinations remain the product scope.

SerpApi's Google Travel Explore API supports outbound/return dates, travel class, adults, stops, arrival IDs, airline inclusion, and maximum duration. V6 uses the supported server-side parameters for the primary filters and client-side search for clean destination/airline discovery.

## V6.0.1
- Fixes the V6 Render startup syntax error.
- Adds User → Admin → Super Admin hierarchy.
- Primary password-based admin login is Super Admin.
- Optional `SUPER_ADMIN_EMAIL` Render variable identifies the primary Super Admin email.
- Super Admin Access Management supports role changes, suspension, revocation, reactivation, and Security Events.
- Regular Admins cannot use Super Admin management endpoints.

## V6.0.2 Super Admin login fix
The master login now accepts the email configured in `SUPER_ADMIN_EMAIL` together with `APP_PASSWORD`.
For backward compatibility, `admin` (and a blank email) also remain valid master usernames.
The first-time setup button is renamed to **First-time account setup**.

## V6.1 UI polish
- Restyles all advanced filters to match the existing FlightWatch dark UI.
- Search inputs, date pickers, cabin/stops dropdowns, destination search, and airline search now use the same border, background, spacing, and focus treatment as the original controls.
- Destination result cards now maintain a consistent two-row visual footprint.
- When only one distinct fare is returned for a destination, the second row becomes a subtle informational placeholder rather than leaving an awkward empty card area.

### Roadmap: Admin custom email broadcasts
Add an Admin/Super Admin communication tool that can send a custom email to:
- one selected user,
- multiple selected users,
- a group,
- all active users.

Planned safeguards:
- recipient preview before send,
- subject/body editor,
- test-send to self,
- audit event for every broadcast,
- delivery status / failure reporting,
- Super Admin-only option for "all users" if desired.

## V6.1.1 User issue reporting
- Adds a bottom-right **Report an issue** control for all signed-in users.
- Users provide a title and description; submissions become persistent tickets in Neon.
- Admins and Super Admins review tickets inside **Admin → Error Center → User-submitted reports**.
- Admins can acknowledge, resolve, reopen, and add an internal note.
- Every user ticket creation/update is written to the audit trail.

## V6.2
- Rebrands FlightWatch to **Anywhere With You**.
- Discover description is **Just us. Somewhere else.**
- Advanced filters are collapsed by default; only the primary search row is shown initially.
- Bottom-right disclosure control expands/collapses the remaining filters.
- User-submitted reports now use a clean subject-only ticket list with a selectable detail pane.
- Adds a Super Admin-only to-do list under Error Center with title, remarks, open/done status, and delete controls.

## V6.3
- Discover headline is now **Just us. Somewhere else.** in the main white bold hero position.
- Find Deals is centered within the filter panel.
- Removes Airline search to keep the expanded filter grid visually balanced.
- User reports place resolved tickets inside a collapsible **Resolved** folder.
- Audit Log retains full history but displays a configurable 10/25/50/100 rows at once with keyword search.
- Access Management role selector uses the same dark UI styling as the rest of the application.
- Toast notifications now appear above the Report an issue button so group/status messages are not blocked.
- Adds Admin → **Send email** with self-test, selected users, and Super Admin-only all-active-users delivery through Resend.
- Admin email sends are audited and summarized in Neon.
