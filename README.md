# FlightWatch V3

V3 is the first deployment-ready baseline.

## Included
- Live MCO/MIA → U.S. discovery through SerpApi
- Persistent tracked flights
- Automatic price snapshots on every live refresh
- Price-history metrics + chart
- Watchlists (including ANY U.S. destination under a chosen price)
- Profile for phone + email
- Email/SMS preference toggles
- Quiet hours
- Nonstop preference
- Light / Dark / System theme
- System status page
- Optional password gate for the hosted site
- Local JSON storage for easy testing
- PostgreSQL support for hosting
- Render deployment blueprint

## Local setup
1. Rename `.env.example` to `.env`.
2. Add your SerpApi key.
3. Leave `DATABASE_URL` blank locally.
4. You can leave `APP_PASSWORD` blank locally, or set one to test login.
5. Run:
   npm.cmd install
   npm.cmd start
6. Open http://localhost:3000

Local persistent data is written to `.data/`.

## Hosting architecture
GitHub → Render → Neon PostgreSQL → SerpApi

### GitHub
Create a private repository named `flightwatch`. Upload this project, but DO NOT upload `.env`.

### Neon
Create a free PostgreSQL database and copy the pooled connection string.

### Render
Create a Web Service from the GitHub repository. The included `render.yaml` is ready for Render.

Set these environment variables in Render:
- `SERPAPI_KEY`
- `APP_PASSWORD`
- `DATABASE_URL`
- `SESSION_SECRET` (Render can generate this)

Once GitHub and Render are connected, every push to the repository can automatically redeploy the website.

## Why V3 has password protection
The Profile section can store a phone number and email address. Until full user authentication is added later, a private password gate prevents those settings from being exposed on a public URL.

## V4
- Scheduled background checks
- Watchlist evaluation
- Historical deal scoring
- Duplicate-alert suppression
- Real email notifications
- Real SMS notifications
- Alert history

## Future-update workflow
The goal is to stop replacing folders manually. After the GitHub repository and Render deployment exist, the live site updates whenever the repository changes.

There is not currently a GitHub write connector available to this ChatGPT session, so I cannot directly push commits into your repository from here yet. I can still prepare versioned update packages/patches, and once a compatible GitHub connection is available the manual commit step can be removed too.
