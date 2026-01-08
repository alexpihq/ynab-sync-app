const ZERION_API_KEY = 'zk_dev_2a421d522dec44978319e1096c5c2ba2';

const wallets = [
  {
    address: '0xe03574f97784fa8f6d2e92666c7bf55c44fe6435',
    sheetName: 'safe_0xe035_6435'
  },
  {
    address: '0xda4a77521f05dc0671ff2944d1fb14ee0e4977a3',
    sheetName: 'safe_0xda4a_77a3'
  },
  {
    address: '0x479624417561a1b53f508c41409adedd8cedbaaf',
    sheetName: 'zerion_0x479_baaf'
  }
];

const ALLOWED_CHAINS = ['polygon', 'binance-smart-chain', 'ethereum', 'arbitrum'];

const BANNED_ASSETS = [
  'BUSDT', 'UD', 'BU', 'BT', 'SD',
  'Visit WWW.10ETH.EU To Claim Reward',
  'SHIB - [ t.ly/uSHIB ] *Redeem within 7 days'
];

const BANNED_SUBSTRINGS = ['BUSDT', 'USDT', 'BUSD', 'USDC', 'T.LY', '10ETH.EU', 'SHIB', 'REDEEM', 'CLAIM'];

const LEGIT_ASSETS = ['USDT', 'DAI', 'USDC', 'ETH', 'WETH', 'WBTC', 'MATIC', 'BNB'];

function normalizeTokenSymbol(symbol) {
  if (!symbol) return '';
  return symbol.normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toUpperCase().trim();
}

function importFilteredZerionTransactions() {
  wallets.forEach(({ address, sheetName }) => {
    const isValid = /^0x[a-fA-F0-9]{40}$/.test(address);
    if (!isValid) {
      Logger.log(`❌ Пропущен некорректный адрес: ${address}`);
      return;
    }
    importWalletTransactions(address.toLowerCase(), sheetName);
  });
}

function importWalletTransactions(walletAddress, sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  const numCols = 13;
  sheet.getRange(1, 1, sheet.getMaxRows(), numCols).clearContent();
  sheet.getRange(1, 1, 1, numCols).setValues([[
    'Date', 'Operation Type', 'Asset', 'Amount',
    'Sender', 'Recipient', 'NFT Name', 'Spam?', 'Blockchain',
    'Payee', 'Outflow', 'Inflow', 'tx_hash'
  ]]);

  let rowIndex = 2;
  const seenKeys = new Set();
  let nextUrl = `https://api.zerion.io/v1/wallets/${walletAddress}/transactions`;

  const headers = {
    'Authorization': 'Basic ' + Utilities.base64Encode(ZERION_API_KEY + ':'),
    'accept': 'application/json'
  };

  const options = {
    method: 'get',
    headers: headers,
    muteHttpExceptions: true
  };

  while (nextUrl) {
    const response = UrlFetchApp.fetch(nextUrl, options);
    const statusCode = response.getResponseCode();
    const content = response.getContentText();

    if (statusCode !== 200) {
      Logger.log(`❌ Ошибка ${statusCode} от Zerion для адреса ${walletAddress}`);
      Logger.log(content);
      break;
    }

    const data = JSON.parse(content);
    const transactions = Array.isArray(data.data) ? data.data : [];

    for (const tx of transactions) {
      const attrs = tx.attributes;
      const type = attrs.operation_type || '';
      if (!['send', 'receive'].includes(type)) continue;

      const chainId = tx.relationships?.chain?.data?.id || '';
      if (!ALLOWED_CHAINS.includes(chainId)) continue;

      const rawDate = attrs.mined_at || attrs.submitted_at || '';
      const date = rawDate
        ? Utilities.formatDate(new Date(rawDate), Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : '';

      const transfers = attrs.transfers || [];
      if (transfers.length === 0) continue;

      let validTransfer = null;

      for (const tr of transfers) {
        const rawAsset = tr.fungible_info?.symbol || tr.nft_info?.interface || '';
        const asset = normalizeTokenSymbol(rawAsset);
        const isSpam = tr.nft_info?.flags?.is_spam || false;
        const isTooShort = asset.length <= 3;

        const isExactBanned = BANNED_ASSETS.some(b => normalizeTokenSymbol(b) === asset);
        const isLegit = LEGIT_ASSETS.includes(asset);
        const isSuspicious = BANNED_SUBSTRINGS.some(substr =>
          asset.includes(substr) && !isLegit
        );
        const looksLikeFakeUSDT = ['USDT', 'BUSDT', 'BUSD', 'USDC'].some(real =>
          asset !== real && asset.includes(real)
        );

        if (
          !asset ||
          isSpam ||
          isTooShort ||
          isExactBanned ||
          isSuspicious ||
          looksLikeFakeUSDT
        ) continue;

        validTransfer = { ...tr, asset };
        break;
      }

      if (!validTransfer) continue;

      const tr = validTransfer;
      const amount = tr.quantity?.numeric || '';
      const sender = tr.sender || '';
      const recipient = tr.recipient || '';
      const nftName = tr.nft_info?.name || '';
      const spamFlag = tr.nft_info?.flags?.is_spam ? 'yes' : 'no';
      const asset = tr.asset;

      const uniqueKey = `${date}_${type}_${asset}_${amount}_${sender}_${recipient}`;
      if (seenKeys.has(uniqueKey)) {
        Logger.log(`⛔️ Пропущено как дубликат: ${uniqueKey}`);
        continue;
      }
      seenKeys.add(uniqueKey);

      const payee = type === 'receive' ? sender : recipient;
      const inflow = type === 'receive' ? amount : '';
      const outflow = type === 'send' ? amount : '';
      const hash = attrs.hash || '';

      sheet.getRange(rowIndex, 1, 1, numCols).setValues([[
        date, type, asset, amount,
        sender, recipient, nftName, spamFlag, chainId,
        payee, outflow, inflow, hash
      ]]);

      rowIndex++;
    }

    nextUrl = data.links?.next || null;
  }

  if (rowIndex > 2) {
    sheet.getRange(2, 1, rowIndex - 2, numCols).sort({ column: 1, ascending: true });
  }

  Logger.log(`✅ Импорт завершён: ${walletAddress} → ${sheetName}, строк: ${rowIndex - 2}`);
}