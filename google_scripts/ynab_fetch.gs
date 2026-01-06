function fetchYnabTransactions() {
  const token = 'xxxxx'; // Твой токен
  const sheetName = 'personal_export';
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(`Лист с именем "${sheetName}" не найден.`);
  }

  const configs = [
    {
      accountId: '5f0d008f-0104-4b0c-bf70-1e3bf516e315', // Epic Web3
    },
    {
      accountId: 'cd886047-90fe-416e-8fa7-e25d84a56c07', // TappAds
    },
    {
      accountId: '1cfe6e6d-0851-43c7-bb27-9d64ec267b9a', // Innerly
    }
  ];

  let allRows = [];

  configs.forEach(config => {
    const url = `https://api.ynab.com/v1/budgets/90024622-dd15-4ef9-bfad-4e555f5471ac/accounts/${config.accountId}/transactions`;

    const options = {
      method: 'get',
      headers: {
        'Authorization': 'Bearer ' + token,
        'accept': 'application/json'
      },
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());
    const transactions = data.data.transactions;

    const rows = transactions.map(tx => [
      tx.id, // уникальный ID транзакции
      tx.account_name,
      tx.date,
      tx.payee_name,
      tx.memo || '',
      tx.amount / 1000
    ]);

    allRows = allRows.concat(rows);
  });

  // Очистить только первые 6 колонок, остальное не трогать
  sheet.getRange(1, 1, sheet.getMaxRows(), 6).clearContent();

  const headers = ['transaction_id', 'account_name', 'date', 'payee_name', 'memo', 'amount'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (allRows.length > 0) {
    // Сортируем по дате
    allRows.sort((a, b) => {
      const dateA = new Date(a[2]);
      const dateB = new Date(b[2]);
      return dateA - dateB;
    });

    // Вставляем данные
    sheet.getRange(2, 1, allRows.length, headers.length).setValues(allRows);
  }

  SpreadsheetApp.flush();
}