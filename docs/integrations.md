# Accounting integrations

Three providers supported: Xero, QuickBooks, Sage Accounting.

## Setup

For MVP, keep `ACCOUNTING_INTEGRATIONS_ENABLED=false`. Production startup
refuses this flag until provider posting is implemented end-to-end.

For each provider you want to use, register a developer app and add the OAuth
callback URL `http://localhost:5173/integrations/<provider>/callback` (or your
production equivalent). Then populate the corresponding env vars in `.env` (see
`.env.example`).

## Status of each integration

- **OAuth flow**: fully wired (real authorize URL build, real code exchange, real token refresh)
- **Sales push**: not implemented. Sync returns `501` until the provider posting code is wired. The next step is to
  wire the `pushSalesSummary` function in each `src/services/integrations/<provider>.service.js`
  to call the provider's actual invoice/journal endpoint:
  - Xero: POST `/BankTransactions` or `/Invoices`
    (https://developer.xero.com/documentation/api/accounting/banktransactions)
  - QuickBooks: POST `/v3/company/<realmId>/salesreceipt` (preferred for POS data) or `/invoice`
    (https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/salesreceipt)
  - Sage: POST `/sales_invoices` or `/sales_quick_entries`
    (https://developer.sage.com/accounting/reference/sales-invoices/)

## Provider-specific notes

### Xero

1. Go to https://developer.xero.com/myapps and create a new app.
2. Set the redirect URI to `http://localhost:5173/integrations/xero/callback`.
3. Copy Client ID and Client Secret into `.env`.
4. After the OAuth redirect, the frontend must fetch the tenant list from
   `GET https://api.xero.com/connections` (using the new access token) and
   forward the chosen `tenantId` in the callback POST body. This is required
   because Xero supports multi-org — a future enhancement could auto-select if
   only one org is connected.

### QuickBooks (Intuit)

1. Go to https://developer.intuit.com/app/developer/myapps and create an app.
2. Set the redirect URI to `http://localhost:5173/integrations/quickbooks/callback`.
3. Copy Client ID and Client Secret into `.env`.
4. Set `QUICKBOOKS_ENV=sandbox` for testing (use `production` when live).
5. Intuit appends `realmId` (company ID) to the OAuth redirect URL as a query
   parameter — the frontend must extract it and include it in the callback POST
   body.

### Sage Accounting

1. Go to https://developer.sage.com/accounting/ and register an app.
2. Set the redirect URI to `http://localhost:5173/integrations/sage/callback`.
3. Copy Client ID and Client Secret into `.env`.
4. After token exchange, the `businessId` can be fetched from
   `GET https://api.accounting.sage.com/v3.1/business`. Pass it in the
   callback POST body if available, otherwise implement auto-fetch in
   `sage.service.js → exchangeCodeForTokens`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/integrations` | Connection status for all 3 providers (no tokens) |
| GET | `/api/integrations/:provider/auth` | Returns OAuth authorize URL |
| POST | `/api/integrations/:provider/callback` | Exchanges auth code for tokens |
| POST | `/api/integrations/:provider/sync` | Pushes last-7-days sales summary |
| POST | `/api/integrations/:provider/disconnect` | Clears stored tokens |

Valid `:provider` values: `xero`, `quickbooks`, `sage`.

## Callback body shape

```json
{
  "code": "<authorization_code from provider>",
  "state": "<state value echoed back by provider>",
  "tenantId": "<xero org guid — xero only>",
  "realmId": "<intuit company id — quickbooks only>",
  "businessId": "<sage business id — sage only>"
}
```

## Token storage

Tokens are stored encrypted on the `Cafe` document under `accountingIntegrations.<provider>`.
They are **never returned** in API responses — only connection status, sync timestamps, and
error messages are surfaced.

Token refresh is handled automatically in the sync endpoint when a token is within
60 seconds of its `expiresAt` timestamp.
