function fetchZenMoneyToTbankA() {
  const apiUrl = 'https://api.zenmoney.ru/v8/diff';
  const token = 'GoPaeFWYAHH7eiNTZqrSDjGDEo9O6i';
  const sheetName = 'zenmoney'; // лист для выгрузки

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  sheet.clearContents();

  const payload = {
    serverTimestamp: 0,
    currentClientTimestamp: Math.floor(Date.now() / 1000)
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(apiUrl, options);
  const result = JSON.parse(response.getContentText());

  if (!result.transaction || result.transaction.length === 0) {
    sheet.getRange(1, 1).setValue('Нет транзакций.');
    return;
  }

  // Мапа ID счёта -> Название
  const accountIdToTitle = {};
  if (result.account) {
    result.account.forEach(acc => {
      accountIdToTitle[acc.id] = acc.title;
    });
  }

  const headers = ['Дата', 'Описание', 'Комментарий', 'Категория', 'Счет (название)', 'Счет (ID)', 'Доход (RUB)', 'Расход (RUB)'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // Минимальная дата: 2025-05-01
  const minDate = new Date('2026-01-01');

  // Формируем данные
  let data = result.transaction
    .filter(tx => new Date(tx.date) >= minDate) // 👈 фильтрация по дате
    .map(tx => {
      let accountId = tx.account || tx.incomeAccount || tx.outcomeAccount || '';
      let accountTitle = accountIdToTitle[accountId] || '';

      return [
        Utilities.formatDate(new Date(tx.date), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
        tx.payee || '',
        tx.comment || '',
        tx.category || '',
        accountTitle,
        accountId,
        tx.income,
        tx.outcome
      ];
    });

  // Сортировка по дате
  data.sort((a, b) => new Date(a[0]) - new Date(b[0]));

  if (data.length === 0) {
    sheet.getRange(2, 1).setValue('Нет транзакций с этой даты.');
    return;
  }

  sheet.getRange(2, 1, data.length, headers.length).setValues(data);
}



function convertZenmoneyToTBank() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const zenSheet = ss.getSheetByName('zenmoney');
  const exchangeSheet = ss.getSheetByName('exchange_rates');

  const routing = {
    'Black Premium Леша': 'tbank_a_go',
    'ALL Airlines Premium Кредитный Леша': 'tbank_a_go',
    'Black Жека': 'tbank_j_go',
    'ALL Airlines Кредитный': 'tbank_j_go',
    'Платёжный счёт 2 Сбер Жека': 'sber_j_go',
    'Платёжный счёт Сбер Жека': 'sber_j_go',
    'Кредитная СберКарта Жека': 'sber_j_go'
  };

  const data = zenSheet.getDataRange().getValues();
  const header = data.shift();

  const dateIdx = header.indexOf('Дата');
  const payeeIdx = header.indexOf('Описание');
  const commentIdx = header.indexOf('Комментарий');
  const accountIdx = header.indexOf('Счет (название)');
  const incomeIdx = header.indexOf('Доход (RUB)');
  const expenseIdx = header.indexOf('Расход (RUB)');

  const targetSheets = {};
  for (const sheetName of [...new Set(Object.values(routing))]) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error(`Не найдена вкладка: ${sheetName}`);
    sheet.clearContents();
    sheet.appendRow(['Date', 'Payee', 'Memo', 'Outflow', 'Inflow']);
    targetSheets[sheetName] = sheet;
  }

  data.forEach(row => {
    const account = row[accountIdx];
    const targetSheetName = routing[account];
    if (!targetSheetName) return;

    const targetSheet = targetSheets[targetSheetName];
    const date = new Date(row[dateIdx]);
    const monthKey = getMonthKey(date);

    let exchangeRate;
    try {
      exchangeRate = getExchangeRate(exchangeSheet, monthKey);
    } catch (e) {
      updateExchangeRates();
      exchangeRate = getExchangeRate(exchangeSheet, monthKey);
    }

    const income = row[incomeIdx] || 0;
    const expense = row[expenseIdx] || 0;
    const memoAmount = income - expense;

    const outflow = expense ? (expense / exchangeRate).toFixed(2) : '';
    const inflow = income ? (income / exchangeRate).toFixed(2) : '';

    const payee = row[payeeIdx] || row[commentIdx] || '';

    targetSheet.appendRow([
      formatDate(date),
      payee,
      `${memoAmount} руб`,
      outflow,
      inflow
    ]);
  });
}

function getMonthKey(date) {
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[date.getMonth()]}_${date.getFullYear()}`;
}

function getExchangeRate(sheet, monthKey) {
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const colIdx = header.indexOf(monthKey);

  if (colIdx === -1) throw new Error(`Нет курса для месяца: ${monthKey}`);

  const rate = data[1][colIdx];
  if (!rate) throw new Error(`Курс для ${monthKey} не найден.`);

  return rate;
}

function formatDate(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function updateExchangeRates() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('exchange_rates');
  const today = new Date();
  const monthKey = getMonthKey(today);

  let data = sheet.getDataRange().getValues();
  if (data.length === 0) {
    sheet.appendRow([monthKey]);
    data = sheet.getDataRange().getValues();
  }

  let header = data[0];

  if (!header.includes(monthKey)) {
    sheet.getRange(1, header.length + 1).setValue(monthKey);
    header = sheet.getDataRange().getValues()[0];
  }

  const colIdx = header.indexOf(monthKey) + 1;

  if (!sheet.getRange(2, colIdx).getValue()) {
    const rate = fetchCurrentExchangeRate();
    sheet.getRange(2, colIdx).setValue(rate);
  }
}

function fetchCurrentExchangeRate() {
  const response = UrlFetchApp.fetch('https://www.cbr-xml-daily.ru/daily_json.js');
  const json = JSON.parse(response.getContentText());
  const rate = json.Valute.EUR.Value;
  return rate;
}
