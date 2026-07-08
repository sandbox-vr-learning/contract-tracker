# Contract Tracker

Internal Sandbox VR replacement for Vendr — contract database, reporting, and renewal alerting.

**Live app:** https://prismo1020.github.io/contract-tracker/ (enable Pages in repo settings on first deploy)

## Stack
- Frontend: vanilla HTML/CSS/JS, no build step, hosted on GitHub Pages.
- Backend: [Supabase](https://supabase.com) (Postgres + Auth + Row Level Security).
- Alerts: GitHub Actions scheduled workflow (Slack webhook + email).

## Local files
- `index.html` — all views/markup
- `app.js` — state, rendering, business logic
- `db.js` — all Supabase queries
- `supabase.js` — Supabase client init
- `style.css` — Sandbox VR branded styles
- `schema.sql` — full database schema (source of truth; already applied to Supabase)

## Access
Access is controlled via the `user_roles` table in Supabase (managed in-app under **Access Control**, admin only). Roles: `admin`, `editor`, `viewer`. Sign-in is email magic link via Supabase Auth — no passwords.

## Deployment
Push to `main` → GitHub Pages auto-deploys in 1–3 minutes.
