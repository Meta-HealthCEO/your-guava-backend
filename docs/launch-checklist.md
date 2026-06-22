# Your Guava Launch Checklist

Use this before each production release.

## Required Verification

- Backend tests: `npm test -- --runInBand`
- Portal tests: `npm test`
- Portal build: `npm run build`
- Dependency audit in both repos: `npm audit --omit=dev`
- Whitespace check in both repos: `git diff --check`

## Backend Production Environment

Production startup intentionally fails when critical settings are missing or unsafe.

- `NODE_ENV=production`
- `MONGODB_URI`
- `CLIENT_URL`
- `JWT_SECRET` with at least 32 characters
- `JWT_REFRESH_SECRET` with at least 32 characters
- `TOKEN_ENCRYPTION_KEY` strongly recommended
- `PAYMENT_PROVIDER=onegate`
- `ONEGATE_ORGANISATION_ID` or `ONEGATE_ORG_ID`
- `ONEGATE_API_SALT`
- `API_PUBLIC_URL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `ANTHROPIC_API_KEY`
- `WEATHER_API_KEY`

## Explicit MVP Gates

- `YOCO_INTEGRATION_ENABLED=false`
- `ACCOUNTING_INTEGRATIONS_ENABLED=false`
- `BILLING_MOCK_ENABLED=false`

These gates are enforced by production environment validation.

## Portal Production Environment

- `VITE_API_URL` should point to the deployed backend API, for example `https://api.example.com/api`.
- If `VITE_API_URL` is omitted, the portal falls back to `/api`, which is suitable only when the frontend and backend share a host or reverse proxy.

## Manual Smoke Pass

1. Sign up a new owner account.
2. Log out and log back in.
3. Upload a CSV/XLSX sales export.
4. Confirm column mapping and verify imported totals, skipped rows, and row errors.
5. Open upload history and upload detail.
6. View dashboard, forecasts, analytics, factors, insights, menu items, account, settings, and team pages.
7. Invite a manager and confirm no temporary password is exposed in the API response or UI.
8. Change password and confirm the old session is signed out.
9. Start a checkout or credit purchase and confirm OneGate redirects/callbacks work.
10. Confirm `/api/health`, `/api/ready`, and JSON 404 responses.

## Local Seed Scripts

The seed scripts are destructive and refuse production databases. Configure local demo data with:

- `SEED_IMPORT_FILE`
- `SEED_USER_NAME`
- `SEED_USER_EMAIL`
- `SEED_USER_PASSWORD`
- `SEED_ORG_NAME`
- `SEED_CAFE_NAME`
- `SEED_CAFE_CITY`
- `SEED_CAFE_ADDRESS`
