# Руководство по деплою YNAB Sync App

## Обзор

Это приложение требует долгоживущий процесс (long-running process) с Express сервером и cron-задачами. Поэтому **Cloudflare Pages не подойдет** - он предназначен для статических сайтов.

## Варианты деплоя

### ✅ Рекомендуемые платформы

#### 1. **Render** (Рекомендуется - простой и бесплатный)

**Плюсы:**
- Бесплатный тариф для небольших приложений
- Автоматический деплой из GitHub
- Простая настройка
- Поддержка долгоживущих процессов

**Шаги:**

1. Зарегистрируйтесь на [render.com](https://render.com)
2. Подключите GitHub репозиторий
3. Создайте новый **Web Service**:
   - **Name**: `ynab-sync-app`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free (или Starter за $7/мес для лучшей производительности)

4. Добавьте все переменные окружения из `.env`:
   - `YNAB_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_ANON_KEY`
   - `PERSONAL_BUDGET_ID`
   - `INNERLY_BUDGET_ID`
   - `VIBECON_BUDGET_ID`
   - И другие из `env.template`

5. Деплой автоматически запустится!

**Важно:** На бесплатном тарифе приложение "засыпает" после 15 минут бездействия. Для постоянной работы нужен платный тариф ($7/мес).

---

#### 2. **Railway** (Отличный выбор)

**Плюсы:**
- Очень простой деплой
- Автоматический деплой из GitHub
- $5 бесплатных кредитов в месяц
- Хорошая документация

**Шаги:**

```bash
# Установите Railway CLI
npm i -g @railway/cli

# Войдите
railway login

# В директории проекта
railway init

# Добавьте переменные окружения
railway variables set YNAB_TOKEN=your_token
railway variables set SUPABASE_URL=your_url
# ... и так далее для всех переменных

# Деплой
railway up
```

Или через веб-интерфейс:
1. Зайдите на [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Добавьте переменные окружения в Settings → Variables
4. Деплой автоматический!

---

#### 3. **Fly.io** (Быстрый и гибкий)

**Плюсы:**
- Быстрый деплой
- Глобальная сеть
- Хорошая производительность
- Бесплатный тариф для небольших приложений

**Шаги:**

```bash
# Установите Fly CLI
curl -L https://fly.io/install.sh | sh

# Войдите
fly auth login

# В директории проекта
fly launch

# Следуйте инструкциям, затем:
fly secrets set YNAB_TOKEN=your_token
fly secrets set SUPABASE_URL=your_url
# ... и так далее

# Деплой
fly deploy
```

---

#### 4. **DigitalOcean App Platform**

**Плюсы:**
- Надежная платформа
- Автоматический деплой
- Хорошая производительность

**Шаги:**

1. Зайдите на [cloud.digitalocean.com](https://cloud.digitalocean.com)
2. Create → App → GitHub
3. Выберите репозиторий
4. Настройте:
   - **Build Command**: `npm install`
   - **Run Command**: `npm start`
   - **Environment Variables**: Добавьте все из `.env`

5. Выберите план (Basic $5/мес минимум)

---

#### 5. **Heroku** (Классический вариант)

**Плюсы:**
- Проверенная платформа
- Много документации

**Минусы:**
- Нет бесплатного тарифа (от $5/мес)

**Шаги:**

```bash
# Установите Heroku CLI
# brew install heroku/brew/heroku

# Войдите
heroku login

# Создайте приложение
heroku create ynab-sync-app

# Добавьте переменные окружения
heroku config:set YNAB_TOKEN=your_token
heroku config:set SUPABASE_URL=your_url
# ... и так далее

# Деплой
git push heroku main
```

---

### ❌ Не подходят

#### **Cloudflare Pages**
- ❌ Только для статических сайтов
- ❌ Не поддерживает долгоживущие процессы
- ❌ Нет поддержки Node.js серверов

#### **Cloudflare Workers**
- ⚠️ Теоретически возможно, но требует полной переработки:
  - Нужно убрать Express
  - Нужно убрать node-cron
  - Использовать Cloudflare Cron Triggers
  - Переписать на serverless архитектуру
- ❌ Не рекомендуется - слишком много работы

---

## Настройка синхронизации

### Текущая настройка

Синхронизация запускается **один раз в сутки в 00:00 UTC**.

Если нужно изменить время, отредактируйте cron-расписание в `src/server/index.ts`:

```typescript
// Текущее: каждый день в 00:00 UTC
cron.schedule('0 0 * * *', () => {
  runFullSync();
});

// Примеры других расписаний:
// '0 2 * * *' - каждый день в 02:00 UTC
// '0 0 * * 1' - каждый понедельник в 00:00 UTC
// '0 */6 * * *' - каждые 6 часов
```

### Формат cron

```
* * * * *
│ │ │ │ │
│ │ │ │ └─── день недели (0-7, где 0 и 7 = воскресенье)
│ │ │ └───── месяц (1-12)
│ │ └─────── день месяца (1-31)
│ └───────── час (0-23)
└─────────── минута (0-59)
```

---

## Проверка после деплоя

1. **Проверьте, что сервер запустился:**
   ```bash
   curl https://your-app-url.com/api/config
   ```

2. **Проверьте логи:**
   - В Render: Logs в дашборде
   - В Railway: View Logs
   - В Fly.io: `fly logs`

3. **Проверьте синхронизацию:**
   - Зайдите в веб-дашборд
   - Запустите синхронизацию вручную
   - Проверьте логи на наличие ошибок

4. **Проверьте автоматическую синхронизацию:**
   - Подождите до следующего запуска (00:00 UTC)
   - Или измените cron на более частое расписание для теста

---

## Переменные окружения

Убедитесь, что все переменные из `env.template` добавлены в настройки платформы:

**Обязательные:**
- `YNAB_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `PERSONAL_BUDGET_ID`
- `INNERLY_BUDGET_ID`
- `VIBECON_BUDGET_ID`

**Опциональные:**
- `FINOLOG_API_TOKEN`
- `ASPIRE_PROXY_URL`
- `TRON_WALLET_ADDRESS`
- `TRON_API_KEY`
- `PORT` (по умолчанию 3000)
- `ADMIN_USERNAME` (по умолчанию admin)
- `ADMIN_PASSWORD`
- `SESSION_SECRET`

---

## Мониторинг

### Логи

Все платформы предоставляют доступ к логам:
- **Render**: Dashboard → Logs
- **Railway**: View Logs в дашборде
- **Fly.io**: `fly logs` или Dashboard

### Алерты

Настройте алерты на ошибки:
- Email уведомления при падении приложения
- Мониторинг через внешние сервисы (UptimeRobot, Pingdom)

---

## Стоимость

| Платформа | Бесплатный тариф | Платный тариф |
|-----------|------------------|---------------|
| **Render** | Есть (с ограничениями) | $7/мес |
| **Railway** | $5 кредитов/мес | Pay-as-you-go |
| **Fly.io** | Есть (ограниченный) | ~$2-5/мес |
| **DigitalOcean** | Нет | $5/мес минимум |
| **Heroku** | Нет | $5/мес минимум |

**Рекомендация:** Начните с **Render** или **Railway** - они самые простые для начала.

---

## Troubleshooting

### Приложение не запускается

1. Проверьте логи на наличие ошибок
2. Убедитесь, что все переменные окружения установлены
3. Проверьте, что порт правильный (обычно платформы устанавливают `PORT` автоматически)

### Синхронизация не запускается автоматически

1. Проверьте логи - должно быть сообщение `⏰ Automatic sync scheduled daily at 00:00 UTC`
2. Убедитесь, что приложение работает постоянно (не "засыпает")
3. Проверьте часовой пояс - cron использует UTC

### Ошибки подключения к Supabase/YNAB

1. Проверьте правильность токенов
2. Убедитесь, что используете `service_role` key для Supabase
3. Проверьте, что API токены не истекли

---

## Дополнительные ресурсы

- [Render Documentation](https://render.com/docs)
- [Railway Documentation](https://docs.railway.app)
- [Fly.io Documentation](https://fly.io/docs)
- [Cron Expression Guide](https://crontab.guru)

