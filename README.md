# YNAB Sync Application

Unified synchronization application for YNAB budgets with web dashboard.

## Features

✅ **YNAB ↔ YNAB**: Bidirectional loan synchronization between personal and company budgets  
✅ **Finolog → YNAB**: One-way sync from Finolog (Epic Web3) to YNAB  
✅ **Aspire Bank → YNAB**: Automatic bank statement import  
✅ **Tron Blockchain → YNAB**: USDT transaction import from Tron  
✅ **Web Dashboard**: Simple web interface with authentication  
✅ **Automatic Sync**: Built-in cron runs daily at 00:00 UTC (paid Render plan)  
✅ **Manual Triggers**: Run syncs on-demand via web UI  
✅ **Sync History**: View past synchronization results

## Quick Start

### 1. Prerequisites

- Node.js 18+ 
- Supabase account (for database)
- YNAB API token
- Finolog API token (optional)

### 2. Installation

```bash
npm install
```

### 3. Configuration

Copy `.env` template and fill in your credentials:

```bash
cp env.template .env
```

Required environment variables:
- `YNAB_TOKEN` - Your YNAB API token
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `ADMIN_USERNAME` - Web dashboard username (default: admin)
- `ADMIN_PASSWORD` - Web dashboard password (CHANGE THIS!)
- `SESSION_SECRET` - Session secret for Express (CHANGE THIS!)

Optional:
- `FINOLOG_API_TOKEN` - For Epic Web3 sync
- `ASPIRE_PROXY_URL` - For Aspire Bank sync
- `TRON_WALLET_ADDRESS` - For Tron blockchain sync
- `TRON_API_KEY` - Tronscan API key

### 4. Database Setup

Run the SQL scripts in `DATABASE_SCHEMA.md` to create required tables in Supabase.

### 5. Start Application

```bash
npm start
```

The application will:
- Start web server on `http://localhost:3000`
- Schedule automatic syncs once per day at 00:00 UTC

## Usage

### Web Dashboard

1. Open `http://localhost:3000` in your browser
2. Login with your admin credentials
3. View sync status and history
4. Run syncs manually:
   - **Run All Syncs** - Execute all synchronization types
   - **YNAB ↔ YNAB** - Loan sync between budgets
   - **Finolog → YNAB** - Epic Web3 transactions
   - **Aspire → YNAB** - Bank statements
   - **Tron → YNAB** - Blockchain transactions

### One-Time Sync (CLI)

Run a single synchronization cycle without starting the server:

```bash
npm run sync-once
```

### Test Connection

Test your API credentials:

```bash
npm run test-connection
```

## Deployment

**⚠️ Важно:** Это приложение требует долгоживущий процесс с Express сервером и cron-задачами. **Cloudflare Pages не подойдет** - он только для статических сайтов. Используйте платформы, которые поддерживают Node.js серверы: Render, Railway, Fly.io, DigitalOcean, Heroku.

Подробное руководство по деплою: [DEPLOYMENT.md](./DEPLOYMENT.md)

This application can be deployed to any Node.js hosting service:

### Digital Ocean App Platform

1. Create new app from GitHub repository
2. Set environment variables in App settings
3. Deploy!

### Railway

```bash
railway login
railway init
railway up
```

### Fly.io

```bash
fly launch
fly deploy
```

### Render

1. Connect GitHub repository
2. Select "Web Service"
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables

## Architecture

```
┌─────────────────┐
│  Web Dashboard  │ ← User interacts
│   (HTML/CSS/JS) │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  Express Server │ ← API endpoints
│  (src/server/)  │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  Sync Services  │ ← Business logic
│  (src/services/)│
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│   API Clients   │ ← YNAB, Finolog, etc.
│  (src/clients/) │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│    Supabase     │ ← Database
│   (PostgreSQL)  │
└─────────────────┘
```

## Synchronization Details

### YNAB ↔ YNAB

Bidirectional loan synchronization:
- Personal (EUR) ↔ Innerly (USD)
- Personal (EUR) ↔ Vibecon (USD)
- Automatic currency conversion
- Mirror transactions with correct sign
- Handles creation, updates, deletions

### Finolog → YNAB

One-way sync from Finolog:
- Epic Web3 accounts (EUR, USD, RUB)
- Converts all to EUR for YNAB
- Creates/updates/deletes mirrored transactions
- Recreation of manually deleted YNAB transactions

### Aspire → YNAB

Bank statement import:
- USD account (no conversion)
- EUR account (converts to USD)
- SGD account (converts to USD)
- Idempotent import using `import_id`

### Tron → YNAB

Blockchain transaction import:
- Monitors USDT transactions
- Handles incoming and outgoing transfers
- Direct import (USDT = USD)

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/status` - Check auth status

### Sync
- `GET /api/sync/status` - Get sync status and history
- `POST /api/sync/run` - Run all syncs
- `POST /api/sync/run/:type` - Run specific sync (`ynab`, `finolog`, `aspire`, `tron`)

## Development

### Project Structure

```
YNAB_sync_app/
├── src/
│   ├── server/           # Express server
│   │   ├── index.ts      # Main server file
│   │   └── public/       # Static web files
│   │       ├── index.html
│   │       ├── styles.css
│   │       └── app.js
│   ├── services/         # Sync business logic
│   │   ├── sync.ts       # YNAB ↔ YNAB
│   │   ├── finologSync.ts
│   │   ├── aspireSync.ts
│   │   └── tronSync.ts
│   ├── clients/          # API clients
│   │   ├── ynab.ts
│   │   ├── finolog.ts
│   │   ├── aspire.ts
│   │   ├── tron.ts
│   │   └── supabase.ts
│   ├── types/            # TypeScript types
│   ├── utils/            # Utilities
│   └── config/           # Configuration
├── package.json
├── tsconfig.json
└── README.md
```

### Watch Mode

Run in development with auto-reload:

```bash
npm run dev
```

## Troubleshooting

### "Unauthorized" error

Check your API tokens in `.env` file.

### "Database connection failed"

Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

### "Port already in use"

Change `PORT` in `.env` file or kill existing process:

```bash
lsof -ti:3000 | xargs kill
```

### Sync not running

Check logs for errors. Verify:
1. API tokens are valid
2. Database tables exist
3. Exchange rates are populated

## License

MIT
