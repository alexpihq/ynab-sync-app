-- SQL скрипт для обновления курсов обмена валют
-- Используйте этот скрипт для добавления/обновления курсов вручную

-- Обновить курс за конкретный месяц (или вставить если не существует)
INSERT INTO exchange_rates (month, eur_to_usd, source)
VALUES ('2025-01', 1.0350, 'manual')
ON CONFLICT (month) 
DO UPDATE SET 
  eur_to_usd = EXCLUDED.eur_to_usd,
  source = EXCLUDED.source,
  updated_at = NOW();

-- Массовое обновление за несколько месяцев
INSERT INTO exchange_rates (month, eur_to_usd, source) VALUES
  ('2025-02', 1.0320, 'manual'),
  ('2025-03', 1.0380, 'manual'),
  ('2025-04', 1.0410, 'manual')
ON CONFLICT (month) 
DO UPDATE SET 
  eur_to_usd = EXCLUDED.eur_to_usd,
  source = EXCLUDED.source,
  updated_at = NOW();

-- Посмотреть текущие курсы
SELECT 
  month,
  eur_to_usd,
  source,
  updated_at
FROM exchange_rates
ORDER BY month DESC
LIMIT 12;

-- Конвертировать сумму EUR в USD для конкретного месяца
-- Пример: 100 EUR в январе 2025
SELECT 
  100 * eur_to_usd AS usd_amount
FROM exchange_rates
WHERE month = '2025-01';

-- Получить курс за месяц транзакции (для использования в приложении)
SELECT eur_to_usd
FROM exchange_rates
WHERE month = LEFT('2025-01-15', 7); -- извлекаем YYYY-MM из даты транзакции

-- Удалить курс (осторожно!)
-- DELETE FROM exchange_rates WHERE month = '2024-10';





















