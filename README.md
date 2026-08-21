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
