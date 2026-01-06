function fetchRawTronscanTransactions() {
  const wallet = 'TU3ZFzu6VedX4AydFtbfCTDKcJvKPBbtGp';
  const sheetName = 'tron_raw';
  const pageSize = 50;
  const startDate = new Date('2025-10-01');
  const DELAY_MS = 1200; // Минимум 1 секунда между запросами (RPS=1)

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  // Очищаем только первые 9 колонок
  const maxRows = sheet.getMaxRows();
  sheet.getRange(1, 1, maxRows, 9).clearContent();

  // Заголовки
  sheet.getRange(1, 1, 1, 9).setValues([[
    'TxID',
    'Direction',
    'From',
    'To',
    'Amount (USDT)',
    'Date',
    'Outflow',
    'Inflow',
    'Payee'
  ]]);

  const directions = [
    { label: 'in', queryParam: `toAddress=${wallet}` },
    { label: 'out', queryParam: `fromAddress=${wallet}` }
  ];

  let rowIndex = 2;

  for (let dir of directions) {
    let start = 0;
    let hasMore = true;

    while (hasMore) {
      const url = `https://apilist.tronscanapi.com/api/token_trc20/transfers?limit=${pageSize}&start=${start}&sort=-timestamp&${dir.queryParam}`;
      const headers = {
        "TRON-PRO-API-KEY": "87da2a1e-0651-4848-a91a-00b95660fd3a"
      };
      const options = {
        headers: headers,
        muteHttpExceptions: true
      };

      let response, data;
      let retryCount = 0;
      const maxRetries = 3;

      // Retry logic для обработки 429
      while (retryCount <= maxRetries) {
        try {
          response = UrlFetchApp.fetch(url, options);
          const statusCode = response.getResponseCode();

          if (statusCode === 429) {
            Logger.log(`⚠️ Rate limit (429) - пауза 30 секунд, попытка ${retryCount + 1}/${maxRetries + 1}`);
            if (retryCount < maxRetries) {
              Utilities.sleep(30000); // Ждём 30 секунд как указано в ошибке
              retryCount++;
              continue;
            } else {
              throw new Error('Превышен лимит попыток после 429 ошибки');
            }
          }

          if (statusCode !== 200) {
            throw new Error(`API вернул статус ${statusCode}: ${response.getContentText()}`);
          }

          data = JSON.parse(response.getContentText());
          break; // Успешный запрос

        } catch (e) {
          Logger.log(`❌ Ошибка: ${e.message}`);
          if (retryCount >= maxRetries) throw e;
          retryCount++;
          Utilities.sleep(5000);
        }
      }

      const txs = data?.token_transfers;
      if (!txs || txs.length === 0) break;

      const rows = [];

      for (let tx of txs) {
        const txDate = new Date(tx.block_ts);
        if (txDate < startDate) {
          hasMore = false;
          break;
        }

        const token = tx.tokenInfo?.tokenAbbr || 'UNKNOWN';
        if (token !== 'USDT') continue;

        const amount = parseFloat(tx.quant) / 1e6;
        const dateStr = Utilities.formatDate(txDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
        const outflow = dir.label === 'out' ? amount.toFixed(2) : '';
        const inflow = dir.label === 'in' ? amount.toFixed(2) : '';
        const payee = dir.label === 'in' ? tx.from_address : tx.to_address;

        rows.push([
          tx.transaction_id,
          dir.label,
          tx.from_address,
          tx.to_address,
          amount.toFixed(2),
          dateStr,
          outflow,
          inflow,
          payee
        ]);
      }

      if (rows.length > 0) {
        sheet.getRange(rowIndex, 1, rows.length, 9).setValues(rows);
        rowIndex += rows.length;
        Logger.log(`✓ Загружено ${rows.length} транзакций (${dir.label}), всего строк: ${rowIndex - 1}`);
      }

      start += pageSize;
      
      // Обязательная пауза между запросами (RPS=1)
      if (hasMore) {
        Utilities.sleep(DELAY_MS);
      }
    }
  }

  // Сортировка по дате (столбец 6 — Date)
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 9).sort({ column: 6, ascending: true });
  }

  Logger.log('✅ Выписка завершена и отсортирована по дате');
}
