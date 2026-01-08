# Настройка автоматической синхронизации на бесплатном Render

## Проблема

На **бесплатном тарифе Render** приложение "засыпает" после 15 минут бездействия. Когда приложение спит:
- ❌ `node-cron` не работает
- ❌ Автоматические задачи не выполняются
- ❌ Нужно "разбудить" приложение внешним запросом

## Решение: Внешний Cron сервис

Используйте внешний сервис для периодического вызова endpoint синхронизации.

---

## Вариант 1: cron-job.org (Рекомендуется - бесплатно)

### Шаг 1: Получите секретный токен

1. Добавьте в `.env` на Render:
```env
CRON_SECRET=your_very_strong_random_secret_here
```

2. Сгенерируйте секрет:
```bash
# В терминале
openssl rand -hex 32
```

### Шаг 2: Настройте cron-job.org

1. Зарегистрируйтесь на [cron-job.org](https://cron-job.org) (бесплатно)
2. Создайте новую задачу:
   - **Title**: `YNAB Sync Daily`
   - **Address (URL)**: `https://your-app.onrender.com/api/cron/sync?secret=YOUR_SECRET`
   - **Schedule**: 
     - **Every day at**: `00:00` (или другое время)
     - **Timezone**: `UTC`
   - **Request Method**: `POST`
   - **Request Headers**: (опционально)
     ```
     X-Cron-Secret: YOUR_SECRET
     ```
   - **Request Body**: (оставьте пустым)

3. Сохраните задачу

### Шаг 3: Проверьте работу

1. Нажмите "Run now" в cron-job.org
2. Проверьте логи в Render Dashboard
3. Должно появиться: `⏰ Cron-triggered sync started`

---

## Вариант 2: EasyCron (Бесплатно, до 2 задач)

1. Зарегистрируйтесь на [EasyCron](https://www.easycron.com)
2. Создайте новую задачу:
   - **Cron Job Name**: `YNAB Sync`
   - **URL**: `https://your-app.onrender.com/api/cron/sync?secret=YOUR_SECRET`
   - **HTTP Method**: `POST`
   - **Cron Expression**: `0 0 * * *` (каждый день в 00:00 UTC)
   - **HTTP Headers**: (опционально)
     ```
     X-Cron-Secret: YOUR_SECRET
     ```

---

## Вариант 3: GitHub Actions (Бесплатно, если репозиторий публичный)

Создайте файл `.github/workflows/sync.yml`:

```yaml
name: Daily YNAB Sync

on:
  schedule:
    # Запуск каждый день в 00:00 UTC
    - cron: '0 0 * * *'
  workflow_dispatch: # Позволяет запускать вручную

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Sync
        run: |
          curl -X POST \
            -H "X-Cron-Secret: ${{ secrets.CRON_SECRET }}" \
            https://your-app.onrender.com/api/cron/sync?secret=${{ secrets.CRON_SECRET }}
```

Добавьте `CRON_SECRET` в Secrets репозитория (Settings → Secrets → Actions).

---

## Вариант 4: UptimeRobot (Бесплатно, мониторинг + пробуждение)

1. Зарегистрируйтесь на [UptimeRobot](https://uptimerobot.com)
2. Создайте HTTP Monitor:
   - **Monitor Type**: `HTTP(s)`
   - **Friendly Name**: `YNAB Sync App`
   - **URL**: `https://your-app.onrender.com/api/health`
   - **Monitoring Interval**: `5 minutes` (будет "будить" приложение каждые 5 минут)

3. Создайте отдельный Alert Contact для cron:
   - Используйте Webhook или HTTP Post
   - URL: `https://your-app.onrender.com/api/cron/sync?secret=YOUR_SECRET`
   - Метод: `POST`

---

## Вариант 5: Render Cron Jobs (Платно, от $7/мес)

Если перейдете на платный тариф Render:
1. В настройках приложения включите "Cron Jobs"
2. Настройте задачу:
   - **Schedule**: `0 0 * * *` (каждый день в 00:00 UTC)
   - **Command**: `curl -X POST https://your-app.onrender.com/api/cron/sync?secret=YOUR_SECRET`

---

## Безопасность

⚠️ **ВАЖНО**: Используйте сильный секретный токен!

```bash
# Генерация секрета
openssl rand -hex 32
```

Никогда не коммитьте `CRON_SECRET` в репозиторий!

---

## Тестирование

### Проверка endpoint вручную:

```bash
# С секретом в query параметре
curl -X POST "https://your-app.onrender.com/api/cron/sync?secret=YOUR_SECRET"

# С секретом в заголовке
curl -X POST "https://your-app.onrender.com/api/cron/sync" \
  -H "X-Cron-Secret: YOUR_SECRET"
```

### Проверка health endpoint:

```bash
curl https://your-app.onrender.com/api/health
```

---

## Troubleshooting

### "Cron endpoint not configured"
- Убедитесь, что `CRON_SECRET` добавлен в переменные окружения на Render

### "Unauthorized: Invalid secret"
- Проверьте, что секрет в cron-сервисе совпадает с `CRON_SECRET` на Render
- Убедитесь, что нет лишних пробелов или символов

### "Sync already running"
- Это нормально - предыдущая синхронизация еще не завершилась
- Cron-сервис пропустит этот запуск

### Приложение не просыпается
- Убедитесь, что cron-сервис делает запросы регулярно
- Используйте UptimeRobot для постоянного "пробуждения" приложения

---

## Рекомендации

1. **Для бесплатного Render**: Используйте **cron-job.org** + **UptimeRobot**
   - UptimeRobot будет "будить" приложение каждые 5 минут
   - cron-job.org будет запускать синхронизацию раз в день

2. **Для платного Render**: Используйте встроенные Cron Jobs Render

3. **Альтернатива**: Перейдите на **Railway** или **Fly.io** - там нет проблем с "засыпанием" на бесплатном тарифе

---

## Примеры конфигурации

### cron-job.org
```
URL: https://ynab-sync-app.onrender.com/api/cron/sync?secret=abc123...
Method: POST
Schedule: Daily at 00:00 UTC
```

### UptimeRobot
```
Monitor URL: https://ynab-sync-app.onrender.com/api/health
Interval: 5 minutes
```

---

**Нужна помощь?** Проверьте логи в Render Dashboard для диагностики проблем.


