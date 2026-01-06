function fetchAspireTransactionsToSheet() {
  const accountId = '9d6d2e6b-4833-4b73-bdeb-a80718916cb3'; // Правильный Account ID
  const startDate = '2024-04-01T00:00:00Z';

  // URL прокси на Render
  const proxyUrl = `https://aspire-proxy-render.onrender.com/aspire?account_id=${encodeURIComponent(accountId)}&start_date=${encodeURIComponent(startDate)}`;

  const options = {
    method: 'GET',
    muteHttpExceptions: true,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GoogleAppsScript/1.0'
    }
  };

  try {
    Logger.log("📡 Отправляем запрос на прокси...");
    Logger.log("🔗 URL: " + proxyUrl);
    
    // Retry логика для 502 ошибок
    let response;
    let code;
    let body;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        response = UrlFetchApp.fetch(proxyUrl, options);
        code = response.getResponseCode();
        body = response.getContentText();
        
        Logger.log("📥 Код ответа: " + code);
        
        if (code === 502) {
          retryCount++;
          if (retryCount < maxRetries) {
            Logger.log(`🔄 Получена 502 ошибка. Ждем 10 секунд и пробуем снова (попытка ${retryCount}/${maxRetries})...`);
            Utilities.sleep(10000); // Ждем 10 секунд
            continue;
          }
        }
        
        break; // Выходим из цикла если не 502 или достигли максимума попыток
        
      } catch (fetchError) {
        retryCount++;
        if (retryCount < maxRetries) {
          Logger.log(`🔄 Ошибка запроса. Ждем 10 секунд и пробуем снова (попытка ${retryCount}/${maxRetries})...`);
          Utilities.sleep(10000);
          continue;
        }
        throw fetchError;
      }
    }

    Logger.log("📥 Размер ответа: " + body.length + " символов");

    if (code !== 200) {
      throw new Error(`Не удалось получить транзакции. Код ответа: ${code}, Ответ: ${body}`);
    }

    const data = JSON.parse(body);
    const transactions = data.data || [];

    Logger.log(`✅ Получено транзакций: ${transactions.length}`);

    const sheetName = 'Aspire_USD';
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    else sheet.clear();

    // Обновленные заголовки с новыми колонками
    const headers = [
      'Date', 'Amount (USD)', 'Currency', 'Type', 'Status', 'Reference', 
      'Description', 'Counterparty', 'Balance (USD)', 'Category', 'Card Number',
      'Outflow', 'Inflow', 'Payee', 'Memo'
    ];
    sheet.appendRow(headers);

    // Обработка каждой транзакции
    transactions.forEach((tx, index) => {
      try {
        const amountUSD = (tx.amount || 0) / 100; // Конвертируем в доллары
        
        // Вычисляем Outflow и Inflow
        let outflow = '';
        let inflow = '';
        if (amountUSD < 0) {
          outflow = Math.abs(amountUSD); // Положительное значение для оттока
        } else if (amountUSD > 0) {
          inflow = amountUSD; // Положительное значение для притока
        }
        
        const row = [
          tx.datetime || '',
          amountUSD,
          tx.currency_code || '',
          tx.type || '',
          tx.status || '',
          tx.reference || '',
          tx.counterparty_name || '',
          tx.counterparty_name || '',
          (tx.balance || 0) / 100, // Также делим баланс на 100
          tx.additional_info?.spend_category || '',
          tx.additional_info?.card_number || '',
          outflow, // Outflow (положительное значение для оттока)
          inflow,  // Inflow (положительное значение для притока)
          tx.counterparty_name || '', // Payee
          tx.reference || '' // Memo (используем reference вместо description)
        ];
        
        sheet.appendRow(row);
        
        if (index % 10 === 0) {
          Logger.log(`📊 Обработано транзакций: ${index + 1}/${transactions.length}`);
        }
      } catch (txError) {
        Logger.log(`❌ Ошибка обработки транзакции ${index}: ${txError.message}`);
      }
    });

    Logger.log(`✅ Загружено транзакций: ${transactions.length}`);
    Logger.log(`📊 Всего транзакций в системе: ${data.metadata?.total || 'неизвестно'}`);
    
    // Очищаем Counterparty от лишнего текста после FACEBK
    Logger.log("🧹 Очищаем Counterparty от лишнего текста...");
    cleanCounterpartyColumn(sheet);
    
  } catch (e) {
    Logger.log("❌ Ошибка: " + e.message);
    Logger.log("❌ Stack trace: " + e.stack);
  }
}

// Функция для очистки колонки Counterparty
function cleanCounterpartyColumn(sheet) {
  try {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return; // Только заголовки
    
    // Находим колонку Counterparty (8-я колонка, индекс 7)
    const counterpartyColumn = 8;
    const payeeColumn = 13; // Payee колонка (14-я, индекс 13)
    
    let cleanedCount = 0;
    
    for (let row = 2; row <= lastRow; row++) { // Начинаем со 2-й строки (после заголовков)
      const counterpartyValue = sheet.getRange(row, counterpartyColumn).getValue();
      const payeeValue = sheet.getRange(row, payeeColumn).getValue();
      
      if (counterpartyValue && counterpartyValue.toString().startsWith('FACEBK')) {
        // Очищаем Counterparty - оставляем только FACEBK
        sheet.getRange(row, counterpartyColumn).setValue('FACEBK');
        cleanedCount++;
      }
      
      if (payeeValue && payeeValue.toString().startsWith('FACEBK')) {
        // Очищаем Payee - оставляем только FACEBK
        sheet.getRange(row, payeeColumn).setValue('FACEBK');
        cleanedCount++;
      }
    }
    
    Logger.log(`✅ Очищено ${cleanedCount} ячеек с FACEBK`);
    
  } catch (error) {
    Logger.log(`❌ Ошибка при очистке Counterparty: ${error.message}`);
  }
}

// Функция для тестирования подключения к прокси
function testProxyConnection() {
  try {
    Logger.log("🧪 Тестируем подключение к прокси...");
    
    const response = UrlFetchApp.fetch('https://aspire-proxy-render.onrender.com/ping', {
      method: 'GET',
      muteHttpExceptions: true
    });
    
    const code = response.getResponseCode();
    const body = response.getContentText();
    
    Logger.log(`📡 Код ответа: ${code}`);
    Logger.log(`📡 Ответ: ${body}`);
    
    if (code === 200) {
      Logger.log("✅ Прокси доступен!");
    } else {
      Logger.log("❌ Прокси недоступен");
    }
    
  } catch (e) {
    Logger.log("❌ Ошибка подключения: " + e.message);
  }
}

// Функция для получения токена (для отладки)
function testTokenEndpoint() {
  try {
    Logger.log("🔑 Тестируем получение токена...");
    
    const response = UrlFetchApp.fetch('https://aspire-proxy-render.onrender.com/token', {
      method: 'GET',
      muteHttpExceptions: true
    });
    
    const code = response.getResponseCode();
    const body = response.getContentText();
    
    Logger.log(`📡 Код ответа: ${code}`);
    
    if (code === 200) {
      const data = JSON.parse(body);
      Logger.log("🔑 Access token: " + data.access_token.substring(0, 50) + "...");
    }
    
  } catch (e) {
    Logger.log("❌ Ошибка получения токена: " + e.message);
  }
}

// Функция для получения всех транзакций (без фильтрации по account_id)
function fetchAllTransactions() {
  const startDate = '2024-04-01T00:00:00Z';
  const proxyUrl = `https://aspire-proxy-render.onrender.com/aspire?start_date=${encodeURIComponent(startDate)}`;

  const options = {
    method: 'GET',
    muteHttpExceptions: true,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GoogleAppsScript/1.0'
    }
  };

  try {
    Logger.log("📡 Получаем все транзакции...");
    
    // Retry логика для 502 ошибок
    let response;
    let code;
    let body;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        response = UrlFetchApp.fetch(proxyUrl, options);
        code = response.getResponseCode();
        body = response.getContentText();
        
        Logger.log("📥 Код ответа: " + code);
        
        if (code === 502) {
          retryCount++;
          if (retryCount < maxRetries) {
            Logger.log(`🔄 Получена 502 ошибка. Ждем 10 секунд и пробуем снова (попытка ${retryCount}/${maxRetries})...`);
            Utilities.sleep(10000); // Ждем 10 секунд
            continue;
          }
        }
        
        break; // Выходим из цикла если не 502 или достигли максимума попыток
        
      } catch (fetchError) {
        retryCount++;
        if (retryCount < maxRetries) {
          Logger.log(`🔄 Ошибка запроса. Ждем 10 секунд и пробуем снова (попытка ${retryCount}/${maxRetries})...`);
          Utilities.sleep(10000);
          continue;
        }
        throw fetchError;
      }
    }

    if (code !== 200) {
      throw new Error(`Не удалось получить транзакции. Код ответа: ${code}, Ответ: ${body}`);
    }

    const data = JSON.parse(body);
    const transactions = data.data || [];

    Logger.log(`✅ Получено транзакций: ${transactions.length}`);
    Logger.log(`📊 Всего транзакций в системе: ${data.metadata?.total || 'неизвестно'}`);

    // Создаем лист для всех транзакций
    const sheetName = 'All_Transactions';
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    else sheet.clear();

    const headers = [
      'Account ID', 'Date', 'Amount (USD)', 'Currency', 'Type', 'Status', 
      'Reference', 'Description', 'Counterparty', 'Balance (USD)', 'Category',
      'Outflow', 'Inflow', 'Payee', 'Memo'
    ];
    sheet.appendRow(headers);

    transactions.forEach((tx, index) => {
      try {
        const amountUSD = (tx.amount || 0) / 100; // Конвертируем в доллары
        
        // Вычисляем Outflow и Inflow
        let outflow = '';
        let inflow = '';
        if (amountUSD < 0) {
          outflow = Math.abs(amountUSD); // Положительное значение для оттока
        } else if (amountUSD > 0) {
          inflow = amountUSD; // Положительное значение для притока
        }
        
        const row = [
          tx.account_id || '',
          tx.datetime || '',
          amountUSD,
          tx.currency_code || '',
          tx.type || '',
          tx.status || '',
          tx.reference || '',
          tx.counterparty_name || '',
          tx.counterparty_name || '',
          (tx.balance || 0) / 100, // Также делим баланс на 100
          tx.additional_info?.spend_category || '',
          outflow, // Outflow (положительное значение для оттока)
          inflow,  // Inflow (положительное значение для притока)
          tx.counterparty_name || '', // Payee
          tx.reference || '' // Memo (используем reference вместо description)
        ];
        
        sheet.appendRow(row);
      } catch (txError) {
        Logger.log(`❌ Ошибка обработки транзакции ${index}: ${txError.message}`);
      }
    });

    Logger.log(`✅ Загружено всех транзакций: ${transactions.length}`);
    
    // Очищаем Counterparty от лишнего текста после FACEBK
    Logger.log("🧹 Очищаем Counterparty от лишнего текста...");
    cleanCounterpartyColumn(sheet);
    
  } catch (e) {
    Logger.log("❌ Ошибка: " + e.message);
  }
}