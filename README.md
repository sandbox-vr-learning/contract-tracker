# Contract Tracker

Internal Sandbox VR replacement for Vendr — contract database, reporting, and renewal alerting.

**Live app:** https://sandbox-vr-learning.github.io/contract-tracker/
**Repo:** https://github.com/sandbox-vr-learning/contract-tracker

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

## Renewal alerts
`.github/workflows/alerts.yml` runs `scripts/send-alerts.mjs` daily (14:00 UTC, also triggerable manually via **Actions → Contract renewal alerts → Run workflow**). It checks every active contract against the enabled rows in `alert_thresholds` (edit these in-app under **Access Control**) and posts to Slack + sends email once per contract/threshold/channel, logged in `alert_log` to avoid duplicates.

Required repo secrets (**Settings → Secrets and variables → Actions**):
| Secret | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | Yes | Same as `supabase.js` |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | From Supabase Settings → API → service_role. Bypasses RLS — never expose client-side. |
| `SLACK_WEBHOOK_URL` | For Slack alerts | Incoming webhook URL for the target channel |
| `RESEND_API_KEY` | For email alerts | [Resend](https://resend.com) API key |
| `ALERT_EMAIL_RECIPIENTS` | For email alerts | Comma-separated list |
| `ALERT_EMAIL_FROM` | Optional | Defaults to `Contract Tracker <alerts@sandboxvr.com>` |

Missing Slack or email secrets are skipped gracefully (logged, not an error) so the workflow runs fine with only one channel configured.
