import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { proxyFetch, isProxyConfigured } from '../utils/proxyFetch.js';

export interface TbankBalance {
  balance: number;
  realOtb: number;
  otb: number;
  authorized: number;
  pendingPayments: number;
  pendingRequisitions: number;
}

export interface TbankAccount {
  accountNumber: string;
  name: string;
  status: string;
  tariffName: string;
  tariffCode: string;
  currency: string; // ISO 4217 numeric code (643 = RUB, 840 = USD, 826 = GBP)
  createdOn: string;
  mainFlag: string;
  bankBik: string;
  accountType: string;
  activationDate: string;
  balance: TbankBalance;
  transitAccount?: {
    accountNumber: string;
  };
}

export interface TbankCounterParty {
  account: string;
  inn?: string;
  kpp?: string;
  name: string;
  bankName: string;
  bankBic: string;
  corrAccount: string;
}

export interface TbankMerchant {
  name: string;
  city: string;
  country: string;
}

export interface TbankOperation {
  operationDate: string; // ISO 8601
  operationId: string;
  operationStatus: string; // "Transaction", "Authorization"
  accountNumber: string;
  bic: string;
  typeOfOperation: string; // "Debit", "Credit"
  category: string; // "cardOperation", "paymentOrder", etc.
  trxnPostDate?: string;
  authorizationDate?: string;
  drawDate?: string;
  chargeDate?: string;
  docDate?: string;
  documentNumber?: string;
  payVo?: string;
  vo?: string;
  priority?: number;
  operationAmount: number;
  operationCurrencyDigitalCode: string;
  accountAmount: number;
  accountCurrencyDigitalCode: string;
  rubleAmount?: number;
  description: string;
  payPurpose?: string;
  payer?: TbankCounterParty;
  receiver?: TbankCounterParty;
  counterParty?: TbankCounterParty;
  cardNumber?: string;
  ucid?: number;
  mcc?: string;
  merch?: TbankMerchant;
  authCode?: string;
  rrn?: string;
  acquirerId?: string;
}

export interface TbankStatementResponse {
  operations: TbankOperation[];
  nextCursor?: string;
  balances?: {
    incoming?: number;
    outgoing?: number;
  };
}

// Currency code mapping: ISO 4217 numeric -> alphabetic
const CURRENCY_MAP: Record<string, string> = {
  '643': 'RUB',
  '840': 'USD',
  '826': 'GBP',
  '978': 'EUR'
};

class TbankService {
  private readonly apiBaseUrl = 'https://business.tbank.ru/openapi/api';
  private token: string;

  constructor() {
    this.token = config.tbankToken;
    logger.info('TBank client initialized');
  }

  /**
   * Проверяет, настроен ли TBank клиент
   */
  isConfigured(): boolean {
    return !!this.token;
  }

  /**
   * Получает список счетов
   */
  async getAccounts(withInvest: boolean = false): Promise<TbankAccount[]> {
    try {
      const url = new URL(`${this.apiBaseUrl}/v4/bank-accounts`);
      if (withInvest) {
        url.searchParams.set('withInvest', 'true');
      }

      logger.debug(`Fetching TBank accounts from: ${url.toString()}`);

      const response = await proxyFetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000,
        useProxyOn403: true // Use QuotaGuard proxy on IP whitelist error
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`TBank API returned ${response.status}: ${errorText.substring(0, 200)}...`);
        throw new Error(`TBank API error: ${response.status} - ${errorText.substring(0, 200)}`);
      }

      const accounts = await response.json() as TbankAccount[];
      logger.info(`✅ Fetched ${accounts.length} TBank accounts`);
      return accounts;
    } catch (error: any) {
      logger.error('❌ TBank Get Accounts Error:', error.message);
      throw error;
    }
  }

  /**
   * Получает выписку по операциям за период
   */
  async getStatement(
    accountNumber: string,
    from: string, // ISO 8601: 2026-01-01T00:00:00Z
    to?: string, // ISO 8601: 2026-01-09T00:00:00Z
    limit: number = 1000,
    cursor?: string,
    operationStatus: 'All' | 'Authorization' | 'Transaction' = 'Transaction',
    withBalances: boolean = false
  ): Promise<TbankStatementResponse> {
    try {
      const url = new URL(`${this.apiBaseUrl}/v1/statement`);
      url.searchParams.set('accountNumber', accountNumber);
      url.searchParams.set('from', from);
      if (to) {
        url.searchParams.set('to', to);
      }
      url.searchParams.set('limit', limit.toString());
      if (cursor) {
        url.searchParams.set('cursor', cursor);
      }
      url.searchParams.set('operationStatus', operationStatus);
      if (withBalances) {
        url.searchParams.set('withBalances', 'true');
      }

      logger.debug(`Fetching TBank statement from: ${url.toString()}`);

      const response = await proxyFetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 60000,
        useProxyOn403: true // Use QuotaGuard proxy on IP whitelist error
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`TBank API returned ${response.status}: ${errorText.substring(0, 200)}...`);
        throw new Error(`TBank API error: ${response.status} - ${errorText.substring(0, 200)}`);
      }

      const data = await response.json() as TbankStatementResponse;
      logger.info(`✅ Fetched ${data.operations?.length || 0} operations from TBank account ${accountNumber}`);
      return data;
    } catch (error: any) {
      logger.error('❌ TBank Get Statement Error:', error.message);
      throw error;
    }
  }

  /**
   * Получает все операции за период (с пагинацией)
   */
  async getAllOperations(
    accountNumber: string,
    from: string,
    to?: string,
    operationStatus: 'All' | 'Authorization' | 'Transaction' = 'Transaction'
  ): Promise<TbankOperation[]> {
    const allOperations: TbankOperation[] = [];
    let cursor: string | undefined = undefined;
    let pageNumber = 1;

    try {
      do {
        logger.debug(`📄 Fetching page ${pageNumber}...`);
        const response = await this.getStatement(
          accountNumber,
          from,
          to,
          1000, // max limit
          cursor,
          operationStatus,
          pageNumber === 1 // withBalances only on first page
        );

        if (response.operations && response.operations.length > 0) {
          allOperations.push(...response.operations);
        }

        cursor = response.nextCursor;
        pageNumber++;

        // Небольшая задержка между запросами
        if (cursor) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } while (cursor);

      logger.info(`✅ Total ${allOperations.length} operations fetched from TBank`);
      return allOperations;
    } catch (error: any) {
      logger.error('❌ Failed to fetch all TBank operations:', error.message);
      throw error;
    }
  }

  /**
   * Конвертирует сумму из TBank (рубли) в YNAB milliunits
   * TBank: 8990.0 = 8990.00 (rubles)
   * YNAB: 1000 = 1.00 (milliunits)
   */
  convertToMilliunits(tbankAmount: number): number {
    return Math.round(tbankAmount * 1000);
  }

  /**
   * Нормализует дату из TBank ISO 8601 в YYYY-MM-DD для YNAB
   */
  normalizeDate(tbankDateTime: string): string {
    return tbankDateTime.split('T')[0];
  }

  /**
   * Генерирует уникальный import_id для YNAB (макс 36 символов)
   */
  generateImportId(operation: TbankOperation): string {
    // TBANK: + operationId (полностью, обычно UUID) = до 36 символов
    const opId = operation.operationId.substring(0, 28);
    return `TBANK:${opId}`;
  }

  /**
   * Получает код валюты в ISO 4217 alphabetic формате
   */
  getCurrencyCode(numericCode: string): string {
    return CURRENCY_MAP[numericCode] || numericCode;
  }

  /**
   * Формирует описание для YNAB memo
   */
  formatMemo(operation: TbankOperation): string {
    const parts: string[] = [];

    // Основное описание
    if (operation.description) {
      parts.push(operation.description);
    }

    // Исходная сумма в валюте счета (если не RUB, то не показываем, так как уже в USD)
    const currency = this.getCurrencyCode(operation.accountCurrencyDigitalCode);
    if (currency === 'RUB') {
      const amount = operation.accountAmount.toLocaleString('ru-RU', { 
        minimumFractionDigits: 2,
        maximumFractionDigits: 2 
      });
      parts.push(`${amount} ₽`);
    }

    // Номер карты (если есть и ещё не в описании)
    if (operation.cardNumber && !operation.description?.includes(operation.cardNumber)) {
      parts.push(`Card ${operation.cardNumber}`);
    }

    return parts.join(' | ').substring(0, 200); // YNAB memo max length
  }

  /**
   * Получает имя получателя/отправителя для YNAB payee
   */
  getPayeeName(operation: TbankOperation): string | null {
    // Для дебетовых операций (списание) - получатель
    if (operation.typeOfOperation === 'Debit') {
      if (operation.merch?.name) {
        return operation.merch.name;
      }
      if (operation.receiver?.name) {
        return operation.receiver.name;
      }
      if (operation.counterParty?.name) {
        return operation.counterParty.name;
      }
    }

    // Для кредитовых операций (зачисление) - отправитель
    if (operation.typeOfOperation === 'Credit') {
      if (operation.payer?.name) {
        return operation.payer.name;
      }
      if (operation.counterParty?.name) {
        return operation.counterParty.name;
      }
    }

    // Fallback - извлекаем из описания
    if (operation.description) {
      // Ищем "Оплата в XXX" или "Перевод от XXX"
      const match = operation.description.match(/(?:Оплата в|Перевод от|Поступление от)\s+([^.]+)/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return null;
  }
}

export const tbank = new TbankService();

