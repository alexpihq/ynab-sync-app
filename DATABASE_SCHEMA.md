# Database Schema Documentation

## Overview
База данных для синхронизации займов между личным бюджетом YNAB (EUR) и бюджетами компаний (USD).

## Tables

### 1. budgets_config
Конфигурация всех бюджетов YNAB.

| Column | Type | Description |
|--------|------|-------------|
| budget_id | TEXT (PK) | ID бюджета из YNAB |
| budget_name | TEXT | Название бюджета |
| budget_type | TEXT | 'personal' или 'company' |
| currency | TEXT | 'EUR' или 'USD' |
| is_active | BOOLEAN | Активен ли бюджет |
| created_at | TIMESTAMPTZ | Дата создания записи |
| updated_at | TIMESTAMPTZ | Дата последнего обновления |

**Initial Data:**
- `90024622-dd15-4ef9-bfad-4e555f5471ac` - Alex Personal (EUR)
- `6dd20115-3f86-44d8-9dfa-911c699034dc` - Innerly (USD)
- `35a5141d-d469-48fb-b9d1-1897127b5323` - Vibecon (USD)

---

### 2. loan_accounts
Маппинг аккаунтов для займов между личным бюджетом и компаниями.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | Уникальный ID записи |
| company_budget_id | TEXT (FK) | ID бюджета компании → budgets_config |
| company_name | TEXT | Название компании |
| personal_account_id | UUID | ID аккаунта в личном бюджете |
| personal_account_name | TEXT | Название аккаунта в личном бюджете |
| company_account_id | UUID | ID аккаунта в бюджете компании |
| company_account_name | TEXT | Название аккаунта в бюджете компании |
| is_active | BOOLEAN | Активна ли связь |
| created_at | TIMESTAMPTZ | Дата создания записи |
| updated_at | TIMESTAMPTZ | Дата последнего обновления |

**Initial Data:**
- Innerly: `1cfe6e6d-0851-43c7-bb27-9d64ec267b9a` ↔ `4ed8cf51-606f-412f-a21c-59b97fa8e4a5`
- Vibecon: `a3696e1d-f13c-4119-9129-9f8a0935c7b6` ↔ `c3760e66-e4c1-4e1e-863b-18033fb3212f`

---

### 3. exchange_rates
Курсы обмена EUR → USD по месяцам.

| Column | Type | Description |
|--------|------|-------------|
| month | TEXT (PK) | Месяц в формате 'YYYY-MM' |
| eur_to_usd | DECIMAL(10,6) | Курс конвертации 1 EUR = X USD |
| source | TEXT | Источник курса ('manual', 'api', etc) |
| created_at | TIMESTAMPTZ | Дата создания записи |
| updated_at | TIMESTAMPTZ | Дата последнего обновления |

**Example:**
- '2025-01': 1.035000
- '2024-12': 1.040000

**Note:** Курсы приблизительные, нужно обновить реальными значениями.

---

### 4. transaction_mappings
Соответствия транзакций между личным бюджетом и бюджетами компаний.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | Уникальный ID записи |
| company_budget_id | TEXT (FK) | К какой компании относится связка → budgets_config |
| personal_tx_id | UUID (UNIQUE) | ID транзакции в личном бюджете |
| company_tx_id | UUID (UNIQUE) | ID транзакции в бюджете компании |
| personal_amount | BIGINT | Сумма в EUR (milliunits: EUR * 1000) |
| company_amount | BIGINT | Сумма в USD (milliunits: USD * 1000) |
| exchange_rate | DECIMAL(10,6) | Курс обмена, использованный при создании |
| transaction_date | DATE | Дата транзакции |
| source_budget | TEXT | 'personal' или 'company' - откуда инициирована |
| sync_status | TEXT | 'active', 'deleted', 'error' |
| error_message | TEXT | Сообщение об ошибке (если есть) |
| created_at | TIMESTAMPTZ | Дата создания записи |
| updated_at | TIMESTAMPTZ | Дата последнего обновления |

**Indexes:**
- `idx_tx_mappings_personal_tx` on personal_tx_id
- `idx_tx_mappings_company_tx` on company_tx_id
- `idx_tx_mappings_company_budget` on company_budget_id
- `idx_tx_mappings_date` on transaction_date DESC
- `idx_tx_mappings_status` on sync_status

---

### 5. sync_state
Состояние синхронизации для каждого бюджета.

| Column | Type | Description |
|--------|------|-------------|
| budget_id | TEXT (PK, FK) | ID бюджета → budgets_config |
| last_server_knowledge | BIGINT | Server knowledge из YNAB API (для delta requests) |
| last_sync_at | TIMESTAMPTZ | Когда была последняя успешная синхронизация |
| last_sync_status | TEXT | 'success', 'error', 'running' |
| last_error_message | TEXT | Сообщение об ошибке последней синхронизации |
| transactions_synced | BIGINT | Количество обработанных транзакций |
| updated_at | TIMESTAMPTZ | Дата последнего обновления |

**Purpose:** 
Используется для получения только измененных транзакций из YNAB API через параметр `last_knowledge_of_server`.

---

### 6. sync_log
Лог всех действий синхронизации для отладки и мониторинга.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | Уникальный ID записи |
| sync_run_id | UUID | ID запуска синхронизации (группирует записи) |
| budget_id | TEXT (FK) | ID бюджета → budgets_config |
| action | TEXT | 'create', 'update', 'delete', 'skip', 'error' |
| transaction_id | UUID | ID исходной транзакции |
| mirror_transaction_id | UUID | ID зеркальной транзакции |
| details | JSONB | Дополнительная информация |
| error_message | TEXT | Сообщение об ошибке |
| created_at | TIMESTAMPTZ | Дата создания записи |

**Indexes:**
- `idx_sync_log_run_id` on sync_run_id
- `idx_sync_log_budget` on budget_id
- `idx_sync_log_created` on created_at DESC
- `idx_sync_log_action` on action

---

## Relationships

```
budgets_config (1) ──< (*) loan_accounts
budgets_config (1) ──< (*) transaction_mappings
budgets_config (1) ──< (1) sync_state
budgets_config (1) ──< (*) sync_log
```

---

## Usage Examples

### Check sync state
```sql
SELECT 
  bc.budget_name,
  bc.currency,
  ss.last_server_knowledge,
  ss.last_sync_at,
  ss.transactions_synced
FROM sync_state ss
JOIN budgets_config bc ON bc.budget_id = ss.budget_id
ORDER BY bc.budget_type, bc.budget_name;
```

### Find all transaction mappings for a company
```sql
SELECT 
  tm.transaction_date,
  tm.personal_amount / 1000.0 AS personal_eur,
  tm.company_amount / 1000.0 AS company_usd,
  tm.exchange_rate,
  tm.sync_status
FROM transaction_mappings tm
JOIN loan_accounts la ON la.company_budget_id = tm.company_budget_id
WHERE la.company_name = 'Innerly'
ORDER BY tm.transaction_date DESC;
```

### Get exchange rate for a specific month
```sql
SELECT eur_to_usd 
FROM exchange_rates 
WHERE month = '2025-01';
```

### Recent sync activity log
```sql
SELECT 
  sl.created_at,
  bc.budget_name,
  sl.action,
  sl.error_message
FROM sync_log sl
LEFT JOIN budgets_config bc ON bc.budget_id = sl.budget_id
ORDER BY sl.created_at DESC
LIMIT 50;
```

---

### 7. conversion_accounts
Аккаунты для автоматической конвертации валют в YNAB транзакциях.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | Уникальный ID записи |
| budget_id | UUID | ID бюджета YNAB |
| account_id | UUID | ID аккаунта в бюджете YNAB |
| source_currency | TEXT | Исходная валюта (EUR, RUB, SGD) |
| target_currency | TEXT | Целевая валюта бюджета (USD, EUR) |
| is_active | BOOLEAN | Активна ли конвертация |
| created_at | TIMESTAMPTZ | Дата создания записи |
| updated_at | TIMESTAMPTZ | Дата последнего обновления |

**Purpose:**
Автоматически конвертирует транзакции, которые импортируются в одной валюте, в валюту бюджета. Оригинальная сумма сохраняется в memo (например, "123.45 EUR | Original memo").

**SQL Creation:**
```sql
CREATE TABLE conversion_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id UUID NOT NULL,
  account_id UUID NOT NULL,
  source_currency TEXT NOT NULL CHECK (source_currency IN ('EUR', 'RUB', 'SGD')),
  target_currency TEXT NOT NULL CHECK (target_currency IN ('USD', 'EUR')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(budget_id, account_id)
);

CREATE INDEX idx_conversion_accounts_active ON conversion_accounts (is_active) WHERE is_active = true;
```

**Example:**
```sql
INSERT INTO conversion_accounts (budget_id, account_id, source_currency, target_currency)
VALUES (
  '9c2dd1ba-36c2-4cb9-9428-6882160a155a',  -- Innerly budget
  '9432ff4b-5858-4bcb-bdd5-1118884780db',  -- Account that imports EUR
  'EUR',
  'USD'
);
```

---

## Notes for Epic Web3

Бюджет Epic Web3 еще не создан в YNAB. Когда появится:

1. Добавить в `budgets_config`:
```sql
INSERT INTO budgets_config (budget_id, budget_name, budget_type, currency)
VALUES ('EPIC_BUDGET_ID', 'Epic Web3', 'company', 'USD');
```

2. Добавить в `loan_accounts`:
```sql
INSERT INTO loan_accounts (
  company_budget_id,
  company_name,
  personal_account_id,
  personal_account_name,
  company_account_id,
  company_account_name
) VALUES (
  'EPIC_BUDGET_ID',
  'Epic Web3',
  '5f0d008f-0104-4b0c-bf70-1e3bf516e315',
  'Account for Epic Web3',
  'EPIC_ACCOUNT_ID',
  'Account for Alex'
);
```

3. Состояние синхронизации добавится автоматически или вручную:
```sql
INSERT INTO sync_state (budget_id, last_server_knowledge)
VALUES ('EPIC_BUDGET_ID', 0);
```








