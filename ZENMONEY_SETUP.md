# Zenmoney → YNAB Sync Setup

## Overview

This connector syncs personal bank accounts from Zenmoney to YNAB (Personal Budget).

## Features

- ✅ Syncs transactions from Zenmoney API since January 1, 2026
- ✅ Converts RUB to EUR using exchange rates from Supabase
- ✅ Includes original RUB amount in YNAB memo
- ✅ Supports multiple bank accounts (TBank & Sber)
- ✅ Prevents duplicate transactions via Supabase mappings

## Configuration

### 1. Get Zenmoney OAuth Token

Get your OAuth token from https://zerro.app/ or another OAuth2 client that supports Zenmoney API.

### 2. Add Token to `.env`

```bash
ZENMONEY_TOKEN=your_oauth_token_here
```

### 3. Create Supabase Table

Run the SQL script `create_zenmoney_table.sql` in your Supabase SQL Editor:

```bash
# Copy the contents of create_zenmoney_table.sql and execute in Supabase
```

Or use the Neon MCP to apply the migration:

```typescript
// Using apply_migration tool
apply_migration({ sql: "...", databaseName: "postgres", projectId: "..." });
```

### 4. Account Mapping

The following Zenmoney accounts are mapped to YNAB:

| Zenmoney Account ID | YNAB Account ID | Name |
|---------------------|-----------------|------|
| `22fdea45-0b17-4aab-9dc4-c3e7013ccf4e` | `4d79ac13-5af3-4974-ba36-bf6da266389c` | Alex TBank |
| `92bc1622-d60d-4178-b709-d68efaa3565b` | `4d79ac13-5af3-4974-ba36-bf6da266389c` | Alex TBank |
| `74fd2c56-eaeb-4e33-864f-b0ee514804e3` | `ad9cb006-c81c-437b-a80e-09bae0d51f85` | Jen TBank |
| `02cdd4a2-8c4f-4f6b-bb9e-2a33706a5f0a` | `a654aceb-7bae-4b53-8dd0-0c3fa99e4e92` | Jen Sber |

**YNAB Budget**: `90024622-dd15-4ef9-bfad-4e555f5471ac` (Personal)

## How It Works

1. **Fetch Transactions**: Gets all transactions from Zenmoney API since 2026-01-01
2. **Filter by Account**: Processes only configured accounts
3. **Currency Conversion**: Converts RUB → EUR using `exchange_rates` table
4. **Create Mapping**: Stores transaction mapping in `zenmoney_transaction_mappings`
5. **Create YNAB Transaction**: Creates transaction in YNAB Personal Budget
6. **Memo Format**: `{comment} | {amount} ₽` (e.g., "Grocery shopping | 1,234.56 ₽")

## Running the Sync

### Manual Sync (UI)

1. Open http://localhost:3000
2. Click **"💳 Zenmoney → YNAB"** button

### Manual Sync (API)

```bash
curl -X POST http://localhost:3000/api/sync/run/zenmoney \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Automatic Sync

Zenmoney sync is included in the full sync that runs daily at 00:00 UTC.

## Files

- **Client**: `src/clients/zenmoney.ts` - Zenmoney API client
- **Service**: `src/services/zenmoneySync.ts` - Sync logic
- **Supabase**: `src/clients/supabase.ts` - Database operations
- **SQL**: `create_zenmoney_table.sql` - Table creation script

## Troubleshooting

### "Failed to get exchange rate"

Make sure you have EUR/RUB exchange rates in the `exchange_rates` table for the transaction months.

### "No transactions found"

Check that:
1. Zenmoney token is valid
2. Account IDs are correct
3. Transactions exist after 2026-01-01

### "Duplicate transaction"

The system prevents duplicates automatically. If you see this error, the transaction has already been synced.

## API Reference

### Zenmoney API

Endpoint: `https://api.zenmoney.ru/v8/diff/`

Documentation: https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API

### Key Methods

- `getDiff(request)` - Get transactions and accounts
- `getAllDataSince2026()` - Convenience method for full sync
- `getTransactionsSince(accountIds, date)` - Filter transactions

## Notes

- RUB amounts are stored as milliunits (1000 = 1 RUB)
- EUR amounts are also in milliunits
- YNAB import_id format: `ZENMONEY:{date}:{amount}:{id_prefix}`
- Memo is limited to 200 characters (YNAB limit)

