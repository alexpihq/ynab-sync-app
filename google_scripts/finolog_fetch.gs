function importMultipleFinologTransactions() {
  const apiToken = 'xxxxxx';
  const fromDate = '2026-01-01';
  const toDate = '2035-05-30';

  const sources = [
    { bizId: 47504, accountId: 161752 },
    { bizId: 47504, accountId: 168187 },
    { bizId: 47504, accountId: 161666 }
  ];

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // === Справочник бизнесов ===
  const businessMap = new Map();
  const businessSheet = ss.getSheetByName('businesses');
  if (businessSheet) {
    const data = businessSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const [bizId, name] = data[i];
      businessMap.set(bizId, name);
    }
  }

  // === Справочник контрагентов ===
  const contractorMap = new Map();
  const contractorSheet = ss.getSheetByName('finolog_contractors');
  if (contractorSheet) {
    const data = contractorSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const [id, name, bizId] = data[i];
      contractorMap.set(`${bizId}|${id}`, name);
    }
  }

  // === Справочник валют ===
  const currencyMap = new Map();
  const currencySheet = ss.getSheetByName('currencies');
  if (currencySheet) {
    const data = currencySheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const [accId, currency] = data[i];
      currencyMap.set(accId, currency);
    }
  }

  // === Курсы валют ===
  const exchangeRates = new Map();
  const ratesSheet = ss.getSheetByName('exchange_rates');
  if (ratesSheet) {
    const data = ratesSheet.getDataRange().getValues();
    const headers = data[0];

    const colMonth = headers.indexOf('month');
    const colEurRub = headers.indexOf('EUR/RUB');
    const colEurUsd = headers.indexOf('EUR/USD');

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rawMonth = row[colMonth];
      let month = '';

      if (rawMonth instanceof Date) {
        const yyyy = rawMonth.getFullYear();
        const mm = ('0' + (rawMonth.getMonth() + 1)).slice(-2);
        month = `${yyyy}-${mm}`;
      } else {
        month = String(rawMonth).trim();
      }

      const eurRub = parseFloat(row[colEurRub]);
      const eurUsd = parseFloat(row[colEurUsd]);
      exchangeRates.set(month, { 'EUR/RUB': eurRub, 'EUR/USD': eurUsd });
    }
  }

  function getRateForMonth(dateStr, currency) {
    const txMonth = dateStr.substring(0, 7);
    const sortedMonths = Array.from(exchangeRates.keys()).sort();
    Logger.log(`📅 Доступные месяцы: ${sortedMonths.join(', ')}`);
    Logger.log(`📅 Ищем курс на: ${txMonth}, валюта: ${currency}`);

    let selectedMonth = null;
    for (const m of sortedMonths) {
      if (m <= txMonth) selectedMonth = m;
      else break;
    }

    if (!selectedMonth) return null;

    const rate = exchangeRates.get(selectedMonth);
    if (!rate) return null;

    if (currency === 'EUR') return 1;
    if (currency === 'RUB') return rate['EUR/RUB'];
    if (currency === 'USD') return rate['EUR/USD'];

    return null;
  }

  // === Подготовка листа finolog ===
  let sheet = ss.getSheetByName('finolog');
  if (!sheet) {
    sheet = ss.insertSheet('finolog');
  } else {
    sheet.getRange(1, 1, sheet.getMaxRows(), 13).clearContent();
  }

  const headers = [
    'ID', 'Date', 'Type', 'Description', 'Value', 'Value EUR',
    'Contractor ID', 'Transfer ID', 'bizId', 'accountId',
    'Business', 'Contractor', 'Currency'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  let currentRow = 2;

  sources.forEach(({ bizId, accountId }) => {
    const url = `https://api.finolog.ru/v1/biz/${bizId}/transaction?status=regular&account_ids=${accountId}&report_date_from=${fromDate}&report_date_to=${toDate}&with_transfer=true&with_bizzed=false&with_splitted=false&without_closed_accounts=false`;

    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Accept': '*/*',
        'Api-Token': apiToken,
      },
      muteHttpExceptions: true,
    });

    const transactions = JSON.parse(response.getContentText());

    transactions.forEach(tx => {
      const date = tx.date.split(' ')[0];
      const businessName = businessMap.get(bizId) || '';
      const contractorName = contractorMap.get(`${bizId}|${tx.contractor_id}`) || '';
      const currency = (currencyMap.get(accountId) || '').toUpperCase().trim();

      const rate = getRateForMonth(date, currency);
      const valueEur = (typeof rate === 'number' && !isNaN(rate)) ? (tx.value / rate) : '';

      Logger.log(`💱 TX ${tx.id} | Date: ${date} | Currency: ${currency} | Rate: ${rate} | Value: ${tx.value} | EUR: ${valueEur}`);

      sheet.getRange(currentRow, 1, 1, headers.length).setValues([[
        tx.id,
        date,
        tx.type,
        tx.description || '',
        tx.value,
        valueEur,
        tx.contractor_id || '',
        tx.transfer_id || '',
        bizId,
        accountId,
        businessName,
        contractorName,
        currency
      ]]);
      currentRow++;
    });
  });

  if (currentRow > 2) {
    const dataRange = sheet.getRange(2, 1, currentRow - 2, headers.length);
    dataRange.sort({ column: 2, ascending: true });
  }

  Logger.log(`✅ Импорт завершён. Всего строк: ${currentRow - 2}`);
}

function debugFinologRawResponse() {
  const apiToken = 'OwlFJ8Hk3A2gRQRne71a4ca4d5c3329c32e15ca35f350afdwxXCittqJPOCM0ei';
  const sample = { bizId: 47504, accountId: 161752 };
  const fromDate = '2024-10-01';
  const toDate = '2035-05-30';

  const url = `https://api.finolog.ru/v1/biz/${sample.bizId}/transaction?status=regular&account_ids=${sample.accountId}&report_date_from=${fromDate}&report_date_to=${toDate}&with_transfer=true&with_bizzed=false&with_splitted=false&without_closed_accounts=false`;

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Accept': '*/*',
      'Api-Token': apiToken,
    },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const rawBody = response.getContentText();

  Logger.log(`HTTP статус: ${status}`);
  Logger.log(`Тип тела: ${typeof rawBody}, длина: ${rawBody.length}`);

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    Logger.log(`❌ Ошибка парсинга JSON: ${err.message}`);
    return;
  }

  Logger.log(`Тип ответа после JSON.parse: ${Array.isArray(parsed) ? 'Array' : typeof parsed}`);

  if (Array.isArray(parsed)) {
    Logger.log(`Всего элементов в массиве: ${parsed.length}`);
    if (parsed.length) {
      Logger.log(`Пример элемента: ${JSON.stringify(parsed[0], null, 2)}`);
    }
  } else {
    Logger.log(`Ключи объекта: ${Object.keys(parsed).join(', ')}`);
    if (parsed.data && Array.isArray(parsed.data)) {
      Logger.log(`parsed.data содержит ${parsed.data.length} элементов`);
      if (parsed.data.length) {
        Logger.log(`Пример элемента из parsed.data: ${JSON.stringify(parsed.data[0], null, 2)}`);
      }
    }
  }
}
