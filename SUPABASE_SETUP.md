# Supabase Setup Guide

## Где взять ключи для .env файла

### 1. SUPABASE_URL

**Путь в Supabase Dashboard:**
```
Project Settings → API → Configuration → Project URL
```

Выглядит как: `https://xxxxx.supabase.co`

Это то же самое что `NEXT_PUBLIC_SUPABASE_URL`

---

### 2. SUPABASE_SERVICE_ROLE_KEY ⚠️ ВАЖНО

**Путь в Supabase Dashboard:**
```
Project Settings → API → Project API keys → service_role (secret)
```

**Кликните "Reveal" чтобы увидеть ключ.**

⚠️ **НЕ путать с:**
- `anon` / `public` key (он же `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`)
- Эти ключи для frontend с ограниченным доступом

**Service Role Key:**
- ✅ Полный доступ к базе данных
- ✅ Bypass Row Level Security (RLS)
- ✅ Нужен для backend/server операций
- ⚠️ СЕКРЕТНЫЙ - никогда не коммитить в Git!

---

## Какие ключи НЕ нужны для этого проекта

### ❌ ANON / PUBLISHABLE KEY
```
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
```
Это публичный ключ для frontend приложений. Нам не нужен.

### ❌ Database Password
Пароль для прямого подключения через PostgreSQL (psql). 
Нам не нужен, так как используем Supabase SDK.

---

## Итоговый .env файл

```bash
# YNAB API Token (из https://app.ynab.com/settings/developer)
YNAB_TOKEN=xxxxxx

# Supabase (из Project Settings → API)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ey...

# Budget IDs (уже заполнены)
PERSONAL_BUDGET_ID=90024622-dd15-4ef9-bfad-4e555f5471ac
INNERLY_BUDGET_ID=6dd20115-3f86-44d8-9dfa-911c699034dc
VIBECON_BUDGET_ID=35a5141d-d469-48fb-b9d1-1897127b5323

# Sync Configuration
SYNC_INTERVAL_MINUTES=5
LOG_LEVEL=info
```

---

## Проверка подключения (когда будет код)

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Проверяем подключение
const { data, error } = await supabase
  .from('budgets_config')
  .select('*');

if (error) {
  console.error('Ошибка подключения:', error);
} else {
  console.log('✅ Подключение успешно!', data);
}
```

---

## Security Notes

1. **Никогда не коммитить .env файл в Git**
   - Уже добавлен в `.gitignore`
   - Используйте `env.template` как образец

2. **Service Role Key - максимально секретен**
   - Дает полный доступ к БД
   - Используйте только на сервере
   - Никогда не отправляйте на frontend

3. **Для production**
   - Используйте переменные окружения платформы (Railway, Render, Vercel и т.д.)
   - Не храните ключи в коде

---

## Troubleshooting

### Ошибка: "Invalid API key"
- Проверьте что используете **service_role** key, а не anon key
- Проверьте что скопировали весь ключ целиком

### Ошибка: "relation does not exist"
- Убедитесь что все миграции применены
- Проверьте что подключаетесь к правильному проекту

### Ошибка: "row level security policy"
- Это нормально для anon key
- Используйте service_role key для backend операций





