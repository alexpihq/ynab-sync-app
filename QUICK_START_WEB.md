# 🚀 Quick Start - Локальный запуск с Dashboard

Полная инструкция по запуску системы локально с веб-дашбордом.

## Архитектура

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  React Frontend │─────>│  Supabase Edge   │─────>│   Supabase DB   │
│  (localhost)    │ API  │  Function        │      │   (sync_jobs)   │
└─────────────────┘      └──────────────────┘      └─────────────────┘
                                                             │
                                                             ↓
                                                    ┌─────────────────┐
                                                    │  Node.js Worker │
                                                    │  (job processor)│
                                                    └─────────────────┘
```

## 📝 Шаг 1: Создайте пользователя в Supabase

1. Откройте [Supabase Dashboard](https://supabase.com/dashboard)
2. Выберите ваш проект
3. Authentication → Users → Add user
4. Email: `alexpihq@gmail.com`
5. Password: **[сгенерируйте надежный пароль]**
6. ✅ Auto Confirm User (включите!)

**Сохраните пароль** - он понадобится для входа!

## 📝 Шаг 2: Настройте Frontend

### 2.1. Создайте `.env` файл:

```bash
cd web
touch .env
```

### 2.2. Добавьте credentials в `web/.env`:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

**Где взять эти значения:**
1. Supabase Dashboard → Settings → API
2. **Project URL** → копируем в `VITE_SUPABASE_URL`
3. **anon public** key → копируем в `VITE_SUPABASE_ANON_KEY`

### 2.3. Запустите frontend:

```bash
cd web
npm run dev
```

Frontend запустится на **http://localhost:5173**

## 📝 Шаг 3: Задеплойте Edge Function

### 3.1. Установите Supabase CLI:

```bash
# macOS
brew install supabase/tap/supabase

# Другие платформы:
# https://supabase.com/docs/guides/cli/getting-started
```

### 3.2. Залогиньтесь и свяжите проект:

```bash
cd /Users/pisarevsky/Desktop/Cursor/YNAB_sync_app
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

**Project ref** можно найти в URL вашего проекта:
`https://supabase.com/dashboard/project/YOUR_PROJECT_REF`

Или в Settings → General → Reference ID

### 3.3. Задеплойте функцию:

```bash
supabase functions deploy run-sync
```

### 3.4. Установите секреты для функции:

```bash
# Копируем из вашего .env файла
supabase secrets set SUPABASE_URL=https://your-project-ref.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

**Service role key** находится в Supabase Dashboard:
- Settings → API → service_role (⚠️ НЕ anon key!)

## 📝 Шаг 4: Запустите Node.js Worker

### 4.1. Убедитесь что `.env` файл заполнен:

```bash
cd /Users/pisarevsky/Desktop/Cursor/YNAB_sync_app
cat .env
```

Должны быть все переменные из `env.template`

### 4.2. Запустите worker:

```bash
npm start
```

Worker будет:
- ✅ Проверять очередь `sync_jobs` каждые 5 секунд
- ✅ Выполнять pending задачи
- ✅ Записывать результаты в `sync_history`

## 🎯 Готово! Тестируем систему

### 1. Откройте Dashboard:
```
http://localhost:5173
```

### 2. Войдите:
- Email: `alexpihq@gmail.com`
- Password: [ваш пароль из Supabase]

### 3. Нажмите "Run All Syncs" или любую другую кнопку

### 4. Проверьте что происходит:

**В браузере:**
- Таблица "Sync History" автоматически обновится
- Появится новая запись со статусом "Running" → "Success"

**В терминале Worker:**
```
🔄 Job Worker started, polling for pending jobs...
🚀 Processing job xxx: all (triggered by: manual)
...
✅ Job xxx completed successfully
```

## 🔍 Мониторинг

### Проверить задачи в очереди:

```sql
-- В Supabase SQL Editor
SELECT * FROM sync_jobs 
ORDER BY created_at DESC 
LIMIT 10;
```

### Проверить историю синхронизаций:

```sql
SELECT * FROM sync_history 
ORDER BY started_at DESC 
LIMIT 10;
```

### Проверить логи Edge Function:

```bash
supabase functions logs run-sync --follow
```

## ⚠️ Troubleshooting

### Frontend не запускается
```bash
cd web
rm -rf node_modules package-lock.json
npm install
npm run dev
```

### Edge Function не работает
1. Проверьте деплой: `supabase functions list`
2. Проверьте секреты: `supabase secrets list`
3. Проверьте логи: `supabase functions logs run-sync`

### Worker не обрабатывает задачи
1. Убедитесь что `.env` файл заполнен
2. Проверьте что `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` правильные
3. Перезапустите worker: `npm start`

### Ошибка авторизации в Frontend
1. Убедитесь что пользователь создан в Supabase
2. Проверьте что **Auto Confirm User** включен
3. Проверьте `.env` в папке `web/`
4. Очистите cookies браузера

## 📚 Следующие шаги

✅ Локально работает  
⏳ Деплой на Production:
- Frontend → Cloudflare Pages
- Worker → Railway/Render/Fly.io
- Edge Function → уже в Supabase ✅

⏳ Добавить Cron job для автоматической синхронизации:
- Supabase Cron Extension
- Или внешний cron (cron-job.org) → вызывает Edge Function

## 🎉 Готово!

Теперь у вас есть:
- 🔐 Авторизованный дашборд
- 📊 История всех синхронизаций
- 🎯 Запуск синхронизации по кнопке
- 📈 Realtime обновления

Enjoy! 🚀






