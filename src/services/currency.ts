import { supabase } from '../clients/supabase.js';
import { logger } from '../utils/logger.js';

/**
 * Конвертирует сумму из EUR в USD
 * @param amountEur Сумма в EUR (milliunits)
 * @param date Дата транзакции (YYYY-MM-DD)
 * @returns Сумма в USD (milliunits) или null если курс не найден
 */
export async function convertEurToUsd(
  amountEur: number,
  date: string
): Promise<number | null> {
  const month = date.substring(0, 7); // YYYY-MM
  const rate = await supabase.getExchangeRate(month);

  if (!rate) {
    logger.warn(`Exchange rate not found for month ${month}`);
    return null;
  }

  // amountEur уже в milliunits (например, 1000 = 1 EUR)
  // rate - это EUR to USD (например, 1.035)
  // результат тоже в milliunits
  const amountUsd = Math.round(amountEur * rate);

  logger.debug(`Currency conversion: ${amountEur} EUR milliunits -> ${amountUsd} USD milliunits (rate: ${rate})`);

  return amountUsd;
}

/**
 * Конвертирует сумму из USD в EUR
 * @param amountUsd Сумма в USD (milliunits)
 * @param date Дата транзакции (YYYY-MM-DD)
 * @returns Сумма в EUR (milliunits) или null если курс не найден
 */
export async function convertUsdToEur(
  amountUsd: number,
  date: string
): Promise<number | null> {
  const month = date.substring(0, 7); // YYYY-MM
  const rate = await supabase.getExchangeRate(month);

  if (!rate) {
    logger.warn(`Exchange rate not found for month ${month}`);
    return null;
  }

  // amountUsd в milliunits
  // делим на rate чтобы получить EUR
  const amountEur = Math.round(amountUsd / rate);

  logger.debug(`Currency conversion: ${amountUsd} USD milliunits -> ${amountEur} EUR milliunits (rate: ${rate})`);

  return amountEur;
}

/**
 * Конвертирует сумму из RUB в EUR
 * @param amountRub Сумма в RUB (milliunits)
 * @param date Дата транзакции (YYYY-MM-DD)
 * @returns Сумма в EUR (milliunits) или null если курс не найден
 */
export async function convertRubToEur(
  amountRub: number,
  date: string
): Promise<number | null> {
  const month = date.substring(0, 7); // YYYY-MM
  const rate = await supabase.getExchangeRateRub(month);

  if (!rate) {
    logger.warn(`EUR/RUB exchange rate not found for month ${month}`);
    return null;
  }

  // amountRub в milliunits (копейки, 1/100 RUB)
  // EUR milliunits = центы (1/1000 EUR)
  // Соотношение: 1000/100 = 10, поэтому умножаем на 10
  // Формула: (RUB копейки / rate) * 10 = EUR центы
  const amountEur = Math.round((amountRub / rate) * 10);

  logger.debug(`Currency conversion: ${amountRub} RUB milliunits -> ${amountEur} EUR milliunits (rate: ${rate})`);

  return amountEur;
}

/**
 * Конвертирует сумму из EUR в RUB
 * @param amountEur Сумма в EUR (milliunits)
 * @param date Дата транзакции (YYYY-MM-DD)
 * @returns Сумма в RUB (milliunits) или null если курс не найден
 */
export async function convertEurToRub(
  amountEur: number,
  date: string
): Promise<number | null> {
  const month = date.substring(0, 7); // YYYY-MM
  const rate = await supabase.getExchangeRateRub(month);

  if (!rate) {
    logger.warn(`EUR/RUB exchange rate not found for month ${month}`);
    return null;
  }

  // amountEur в milliunits
  // умножаем на rate чтобы получить RUB
  const amountRub = Math.round(amountEur * rate);

  logger.debug(`Currency conversion: ${amountEur} EUR milliunits -> ${amountRub} RUB milliunits (rate: ${rate})`);

  return amountRub;
}

/**
 * Конвертирует сумму из RUB в USD (через EUR)
 * @param amountRub Сумма в RUB (milliunits)
 * @param date Дата транзакции (YYYY-MM-DD)
 * @returns Сумма в USD (milliunits) или null если курс не найден
 */
export async function convertRubToUsd(
  amountRub: number,
  date: string
): Promise<number | null> {
  // RUB -> EUR -> USD
  const amountEur = await convertRubToEur(amountRub, date);
  if (amountEur === null) return null;

  return await convertEurToUsd(amountEur, date);
}

/**
 * Конвертирует сумму из SGD в USD
 * @param amountSgd Сумма в SGD (milliunits)
 * @param date Дата транзакции (YYYY-MM-DD)
 * @returns Сумма в USD (milliunits) или null если курс не найден
 */
export async function convertSgdToUsd(
  amountSgd: number,
  date: string
): Promise<number | null> {
  const month = date.substring(0, 7); // YYYY-MM
  const rate = await supabase.getExchangeRateSgd(month);

  if (!rate) {
    logger.warn(`USD/SGD exchange rate not found for month ${month}`);
    return null;
  }

  // amountSgd в milliunits
  // делим на rate чтобы получить USD (1 USD = X SGD, поэтому SGD / rate = USD)
  const amountUsd = Math.round(amountSgd / rate);

  logger.debug(`Currency conversion: ${amountSgd} SGD milliunits -> ${amountUsd} USD milliunits (rate: ${rate})`);

  return amountUsd;
}

/**
 * Конвертирует сумму из USD в SGD
 * @param amountUsd Сумма в USD (milliunits)
 * @param date Дата транзакции (YYYY-MM-DD)
 * @returns Сумма в SGD (milliunits) или null если курс не найден
 */
export async function convertUsdToSgd(
  amountUsd: number,
  date: string
): Promise<number | null> {
  const month = date.substring(0, 7); // YYYY-MM
  const rate = await supabase.getExchangeRateSgd(month);

  if (!rate) {
    logger.warn(`USD/SGD exchange rate not found for month ${month}`);
    return null;
  }

  // amountUsd в milliunits
  // умножаем на rate чтобы получить SGD (1 USD = X SGD)
  const amountSgd = Math.round(amountUsd * rate);

  logger.debug(`Currency conversion: ${amountUsd} USD milliunits -> ${amountSgd} SGD milliunits (rate: ${rate})`);

  return amountSgd;
}

/**
 * Конвертирует сумму из EUR в SGD
 * @param amountEur Сумма в EUR (milliunits)
 * @param date Дата транзакции (YYYY-MM-DD)
 * @returns Сумма в SGD (milliunits) или null если курс не найден
 */
export async function convertEurToSgd(
  amountEur: number,
  date: string
): Promise<number | null> {
  // EUR -> USD -> SGD
  const amountUsd = await convertEurToUsd(amountEur, date);
  if (amountUsd === null) return null;

  return await convertUsdToSgd(amountUsd, date);
}

/**
 * Конвертирует сумму из SGD в EUR
 * @param amountSgd Сумма в SGD (milliunits)
 * @param date Дата транзакции (YYYY-MM-DD)
 * @returns Сумма в EUR (milliunits) или null если курс не найден
 */
export async function convertSgdToEur(
  amountSgd: number,
  date: string
): Promise<number | null> {
  // SGD -> USD -> EUR
  const amountUsd = await convertSgdToUsd(amountSgd, date);
  if (amountUsd === null) return null;

  return await convertUsdToEur(amountUsd, date);
}

/**
 * Форматирует milliunits в читаемую сумму
 * @param milliunits Сумма в milliunits (1000 = 1.00)
 * @param currency Валюта (EUR, USD, RUB или SGD)
 * @returns Отформатированная строка (например, "1.50 EUR")
 */
export function formatAmount(milliunits: number, currency: 'EUR' | 'USD' | 'RUB' | 'SGD'): string {
  const amount = milliunits / 1000;
  return `${amount.toFixed(2)} ${currency}`;
}

/**
 * Извлекает месяц из даты
 * @param date Дата в формате YYYY-MM-DD
 * @returns Месяц в формате YYYY-MM
 */
export function getMonthFromDate(date: string): string {
  return date.substring(0, 7);
}

