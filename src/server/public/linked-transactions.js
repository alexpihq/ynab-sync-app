// Initialize Supabase client
let supabaseClient = null;
let accessToken = null;
let budgets = [];
let accountsCache = {};
let deleteCallback = null;
let companyLoanAccounts = [];
let currentTransactions = { account_1: [], account_2: [] };

// Initialize Supabase
async function initSupabase() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();

    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    return true;
  } catch (error) {
    console.error('Failed to initialize Supabase:', error);
    return false;
  }
}

// Check authentication
async function checkAuth() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();

    if (!session) {
      window.location.href = '/';
      return false;
    }

    accessToken = session.access_token;
    return true;
  } catch (error) {
    console.error('Auth check failed:', error);
    window.location.href = '/';
    return false;
  }
}

// Helper for API calls
async function apiCall(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    ...options.headers
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

// Logout
document.getElementById('logout-btn').addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  localStorage.removeItem('supabase_token');
  window.location.href = '/';
});

// Tab switching
window.switchTab = function(tabName) {
  // Hide all tabs
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  // Show selected tab
  document.getElementById(`tab-${tabName}`).classList.add('active');
  event.target.classList.add('active');

  // Load data for tab
  if (tabName === 'linked') {
    loadLinkedTransactions();
  } else if (tabName === 'sync-accounts') {
    loadLoanAccounts();
    loadCompanyLoanAccounts();
  }
};

// Format amount from milliunits
function formatAmount(milliunits) {
  const amount = milliunits / 1000;
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Get budget name by ID
function getBudgetName(budgetId) {
  const budget = budgets.find(b => b.id === budgetId);
  return budget ? budget.name : budgetId.substring(0, 8) + '...';
}

// ==================== LINKED TRANSACTIONS ====================

async function loadLinkedTransactions() {
  const loading = document.getElementById('linked-loading');
  const error = document.getElementById('linked-error');
  const tableContainer = document.getElementById('linked-table-container');
  const tbody = document.getElementById('linked-tbody');
  const empty = document.getElementById('linked-empty');

  try {
    loading.style.display = 'block';
    error.style.display = 'none';
    tableContainer.style.display = 'none';
    empty.style.display = 'none';

    const result = await apiCall('/api/linked-transactions');
    const data = result.data;

    tbody.innerHTML = '';

    if (!data || data.length === 0) {
      loading.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    data.forEach(link => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><strong>${link.transaction_date}</strong></td>
        <td>
          <span class="tx-link">${link.transaction_id_1.substring(0, 8)}...</span>
          <span class="budget-name">${getBudgetName(link.budget_id_1)}</span>
        </td>
        <td>
          <span class="tx-link">${link.transaction_id_2.substring(0, 8)}...</span>
          <span class="budget-name">${getBudgetName(link.budget_id_2)}</span>
        </td>
        <td class="amount-cell">${formatAmount(link.amount)}</td>
        <td><span class="link-type-badge link-type-${link.link_type}">${link.link_type}</span></td>
        <td><span class="auto-matched ${link.is_auto_matched ? 'yes' : 'no'}">${link.is_auto_matched ? 'Auto' : 'Manual'}</span></td>
        <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${link.link_reason || ''}">${link.link_reason || '-'}</td>
        <td>
          <button class="btn-edit" onclick="editLinkedTransaction('${link.id}')">Edit</button>
          <button class="btn-delete" onclick="deleteLinkedTransaction('${link.id}')">Unlink</button>
        </td>
      `;
      tbody.appendChild(row);
    });

    loading.style.display = 'none';
    tableContainer.style.display = 'block';

  } catch (err) {
    console.error('Error loading linked transactions:', err);
    loading.style.display = 'none';
    error.textContent = `Error: ${err.message}`;
    error.style.display = 'block';
  }
}

window.deleteLinkedTransaction = function(id) {
  document.getElementById('delete-message').textContent = 'Are you sure you want to unlink these transactions? This will allow mirror transactions to be created again.';
  deleteCallback = async () => {
    try {
      await apiCall(`/api/linked-transactions/${id}`, { method: 'DELETE' });
      closeDeleteModal();
      loadLinkedTransactions();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  };
  document.getElementById('delete-modal').style.display = 'flex';
};

// Open modal for new linked transaction
window.openLinkedModal = async function() {
  document.getElementById('linked-modal-title').textContent = 'Add Linked Transaction';
  document.getElementById('linked-id').value = '';
  document.getElementById('linked-reason').value = '';
  document.getElementById('linked-type').value = 'bank_transfer';
  document.getElementById('linked-amount1').value = '';
  document.getElementById('linked-amount2').value = '';
  document.getElementById('linked-date1').value = '';
  document.getElementById('linked-date2').value = '';

  // Set current month
  const now = new Date();
  document.getElementById('linked-month').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Reset transaction selects
  document.getElementById('linked-tx1').innerHTML = '<option value="">Select transaction...</option>';
  document.getElementById('linked-tx2').innerHTML = '<option value="">Select transaction...</option>';
  currentTransactions = { account_1: [], account_2: [] };

  await populateLoanAccountSelect();

  document.getElementById('linked-modal').style.display = 'flex';
};

// Close linked modal
window.closeLinkedModal = function() {
  document.getElementById('linked-modal').style.display = 'none';
};

// Edit existing linked transaction
window.editLinkedTransaction = async function(id) {
  try {
    const result = await apiCall('/api/linked-transactions');
    const link = result.data.find(l => l.id === id);
    if (!link) throw new Error('Linked transaction not found');

    document.getElementById('linked-modal-title').textContent = 'Edit Linked Transaction';
    document.getElementById('linked-id').value = id;

    await populateLoanAccountSelect();

    // Find matching loan account
    const loanAccount = companyLoanAccounts.find(a =>
      (a.budget_id_1 === link.budget_id_1 && a.budget_id_2 === link.budget_id_2) ||
      (a.budget_id_1 === link.budget_id_2 && a.budget_id_2 === link.budget_id_1)
    );

    if (loanAccount) {
      document.getElementById('linked-loan-account').value = loanAccount.id;
    }

    // Set month from transaction date
    const txDate = new Date(link.transaction_date);
    document.getElementById('linked-month').value = `${txDate.getFullYear()}-${String(txDate.getMonth() + 1).padStart(2, '0')}`;

    // Load transactions for this month
    if (loanAccount) {
      await loadTransactionsForMonth();

      // Set selected transactions
      document.getElementById('linked-tx1').value = link.transaction_id_1;
      document.getElementById('linked-tx2').value = link.transaction_id_2;
    }

    // Trigger the change handlers to populate amount/date fields
    onTransaction1Change();
    onTransaction2Change();

    document.getElementById('linked-reason').value = link.link_reason || '';
    document.getElementById('linked-type').value = link.link_type || 'bank_transfer';

    document.getElementById('linked-modal').style.display = 'flex';
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
};

// Populate loan account select
async function populateLoanAccountSelect() {
  try {
    const result = await apiCall('/api/company-loan-accounts');
    companyLoanAccounts = result.data || [];

    const select = document.getElementById('linked-loan-account');
    select.innerHTML = '<option value="">Select loan account pair...</option>';

    companyLoanAccounts.forEach(account => {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = `${account.budget_name_1} ↔ ${account.budget_name_2} (${account.currency})`;
      select.appendChild(option);
    });
  } catch (err) {
    console.error('Error loading loan accounts:', err);
  }
}

// When loan account changes, update labels
window.onLoanAccountChange = function() {
  const loanAccountId = document.getElementById('linked-loan-account').value;
  const loanAccount = companyLoanAccounts.find(a => a.id === loanAccountId);

  if (loanAccount) {
    document.getElementById('linked-tx1-label').textContent = `${loanAccount.budget_name_1} - ${loanAccount.account_name_1}`;
    document.getElementById('linked-tx2-label').textContent = `${loanAccount.budget_name_2} - ${loanAccount.account_name_2}`;
  } else {
    document.getElementById('linked-tx1-label').textContent = 'Transaction 1';
    document.getElementById('linked-tx2-label').textContent = 'Transaction 2';
  }

  // Reset and reload transactions
  document.getElementById('linked-tx1').innerHTML = '<option value="">Select transaction...</option>';
  document.getElementById('linked-tx2').innerHTML = '<option value="">Select transaction...</option>';
  currentTransactions = { account_1: [], account_2: [] };

  if (loanAccountId && document.getElementById('linked-month').value) {
    loadTransactionsForMonth();
  }
};

// Load transactions for selected month
window.loadTransactionsForMonth = async function() {
  const loanAccountId = document.getElementById('linked-loan-account').value;
  const month = document.getElementById('linked-month').value;

  if (!loanAccountId || !month) return;

  const loading = document.getElementById('transactions-loading');
  loading.style.display = 'block';

  try {
    const result = await apiCall(`/api/loan-account-transactions?loan_account_id=${loanAccountId}&month=${month}`);
    currentTransactions = {
      account_1: result.data.account_1.transactions,
      account_2: result.data.account_2.transactions
    };

    // Populate transaction selects
    populateTransactionSelect('linked-tx1', currentTransactions.account_1);
    populateTransactionSelect('linked-tx2', currentTransactions.account_2);

    loading.style.display = 'none';
  } catch (err) {
    console.error('Error loading transactions:', err);
    loading.style.display = 'none';
    alert(`Error loading transactions: ${err.message}`);
  }
};

// Populate transaction select with options
function populateTransactionSelect(selectId, transactions) {
  const select = document.getElementById(selectId);
  select.innerHTML = '<option value="">Select transaction...</option>';

  transactions.forEach(tx => {
    const option = document.createElement('option');
    option.value = tx.id;
    const amount = formatAmount(tx.amount);
    const sign = tx.amount >= 0 ? '+' : '';
    option.textContent = `${tx.date} | ${sign}${amount} | ${tx.payee_name || tx.memo || 'No payee'}`;
    option.dataset.amount = tx.amount;
    option.dataset.date = tx.date;
    select.appendChild(option);
  });
}

// When transaction 1 is selected, auto-fill amount and date
window.onTransaction1Change = function() {
  const select = document.getElementById('linked-tx1');
  const selectedOption = select.options[select.selectedIndex];

  if (selectedOption && selectedOption.value) {
    const amount = parseInt(selectedOption.dataset.amount);
    const sign = amount >= 0 ? '+' : '';
    document.getElementById('linked-amount1').value = sign + formatAmount(amount);
    document.getElementById('linked-date1').value = selectedOption.dataset.date;
  } else {
    document.getElementById('linked-amount1').value = '';
    document.getElementById('linked-date1').value = '';
  }
};

// When transaction 2 is selected, auto-fill amount and date
window.onTransaction2Change = function() {
  const select = document.getElementById('linked-tx2');
  const selectedOption = select.options[select.selectedIndex];

  if (selectedOption && selectedOption.value) {
    const amount = parseInt(selectedOption.dataset.amount);
    const sign = amount >= 0 ? '+' : '';
    document.getElementById('linked-amount2').value = sign + formatAmount(amount);
    document.getElementById('linked-date2').value = selectedOption.dataset.date;
  } else {
    document.getElementById('linked-amount2').value = '';
    document.getElementById('linked-date2').value = '';
  }
};

// Save linked transaction form
document.getElementById('linked-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('linked-id').value;
  const loanAccountId = document.getElementById('linked-loan-account').value;
  const loanAccount = companyLoanAccounts.find(a => a.id === loanAccountId);

  if (!loanAccount) {
    alert('Please select a loan account pair');
    return;
  }

  const txId1 = document.getElementById('linked-tx1').value;
  const txId2 = document.getElementById('linked-tx2').value;

  if (!txId1 || !txId2) {
    alert('Please select both transactions');
    return;
  }

  const tx1 = currentTransactions.account_1.find(t => t.id === txId1);

  const amount = Math.abs(tx1 ? tx1.amount : 0);
  const date = tx1 ? tx1.date : document.getElementById('linked-date1').value;
  const reason = document.getElementById('linked-reason').value.trim();
  const type = document.getElementById('linked-type').value;

  try {
    const payload = {
      budget_id_1: loanAccount.budget_id_1,
      account_id_1: loanAccount.account_id_1,
      transaction_id_1: txId1,
      budget_id_2: loanAccount.budget_id_2,
      account_id_2: loanAccount.account_id_2,
      transaction_id_2: txId2,
      amount: amount,
      transaction_date: date,
      link_reason: reason || `Manual link: ${loanAccount.budget_name_1} ↔ ${loanAccount.budget_name_2}`,
      link_type: type,
      is_auto_matched: false
    };

    if (id) {
      await apiCall(`/api/linked-transactions/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    } else {
      await apiCall('/api/linked-transactions', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }

    closeLinkedModal();
    loadLinkedTransactions();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

// ==================== LOAN ACCOUNTS ====================

async function loadLoanAccounts() {
  const loading = document.getElementById('loan-loading');
  const error = document.getElementById('loan-error');
  const tableContainer = document.getElementById('loan-table-container');
  const tbody = document.getElementById('loan-tbody');
  const empty = document.getElementById('loan-empty');

  try {
    loading.style.display = 'block';
    error.style.display = 'none';
    tableContainer.style.display = 'none';
    empty.style.display = 'none';

    const result = await apiCall('/api/loan-accounts');
    const data = result.data;

    tbody.innerHTML = '';

    if (!data || data.length === 0) {
      loading.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    data.forEach(account => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>
          <strong>${account.company_name || 'N/A'}</strong>
          <span class="budget-name">${account.company_budget_id.substring(0, 8)}...</span>
        </td>
        <td>
          ${account.personal_account_name || account.personal_account_id.substring(0, 8) + '...'}
        </td>
        <td>
          ${account.company_account_name || account.company_account_id.substring(0, 8) + '...'}
        </td>
        <td><span class="auto-matched ${account.is_active ? 'yes' : 'no'}">${account.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <button class="btn-edit" onclick="editLoanAccount('${account.id}')">Edit</button>
          <button class="btn-delete" onclick="deleteLoanAccount('${account.id}')">Delete</button>
        </td>
      `;
      tbody.appendChild(row);
    });

    loading.style.display = 'none';
    tableContainer.style.display = 'block';

  } catch (err) {
    console.error('Error loading loan accounts:', err);
    loading.style.display = 'none';
    error.textContent = `Error: ${err.message}`;
    error.style.display = 'block';
  }
}

document.getElementById('add-loan-btn').addEventListener('click', () => {
  document.getElementById('loan-modal-title').textContent = 'Add Loan Account';
  document.getElementById('loan-id').value = '';
  document.getElementById('loan-company').value = '';
  document.getElementById('loan-personal-account').innerHTML = '<option value="">Select account...</option>';
  document.getElementById('loan-company-account').innerHTML = '<option value="">Select account...</option>';
  document.getElementById('loan-active').checked = true;
  populateBudgetSelects();
  document.getElementById('loan-modal').style.display = 'flex';
});

window.editLoanAccount = async function(id) {
  try {
    const result = await apiCall('/api/loan-accounts');
    const account = result.data.find(a => a.id === id);
    if (!account) throw new Error('Account not found');

    document.getElementById('loan-modal-title').textContent = 'Edit Loan Account';
    document.getElementById('loan-id').value = id;

    await populateBudgetSelects();
    document.getElementById('loan-company').value = account.company_budget_id;

    // Load accounts for selected budget
    await loadAccountsForBudget(account.company_budget_id, 'loan-company-account');
    await loadPersonalAccounts('loan-personal-account');

    document.getElementById('loan-personal-account').value = account.personal_account_id;
    document.getElementById('loan-company-account').value = account.company_account_id;
    document.getElementById('loan-active').checked = account.is_active;

    document.getElementById('loan-modal').style.display = 'flex';
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
};

window.deleteLoanAccount = function(id) {
  document.getElementById('delete-message').textContent = 'Are you sure you want to delete this loan account?';
  deleteCallback = async () => {
    try {
      await apiCall(`/api/loan-accounts/${id}`, { method: 'DELETE' });
      closeDeleteModal();
      loadLoanAccounts();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  };
  document.getElementById('delete-modal').style.display = 'flex';
};

window.closeLoanModal = function() {
  document.getElementById('loan-modal').style.display = 'none';
};

document.getElementById('loan-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('loan-id').value;
  const companyBudgetId = document.getElementById('loan-company').value;
  const personalAccountId = document.getElementById('loan-personal-account').value;
  const companyAccountId = document.getElementById('loan-company-account').value;
  const isActive = document.getElementById('loan-active').checked;

  const companySelect = document.getElementById('loan-company');
  const companyName = companySelect.options[companySelect.selectedIndex].text;
  const personalSelect = document.getElementById('loan-personal-account');
  const personalAccountName = personalSelect.options[personalSelect.selectedIndex].text;
  const companyAccountSelect = document.getElementById('loan-company-account');
  const companyAccountName = companyAccountSelect.options[companyAccountSelect.selectedIndex].text;

  try {
    if (id) {
      await apiCall(`/api/loan-accounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          company_budget_id: companyBudgetId,
          company_name: companyName,
          personal_account_id: personalAccountId,
          personal_account_name: personalAccountName,
          company_account_id: companyAccountId,
          company_account_name: companyAccountName,
          is_active: isActive
        })
      });
    } else {
      await apiCall('/api/loan-accounts', {
        method: 'POST',
        body: JSON.stringify({
          company_budget_id: companyBudgetId,
          company_name: companyName,
          personal_account_id: personalAccountId,
          personal_account_name: personalAccountName,
          company_account_id: companyAccountId,
          company_account_name: companyAccountName,
          is_active: isActive
        })
      });
    }

    closeLoanModal();
    loadLoanAccounts();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

// Load accounts when company budget changes
document.getElementById('loan-company').addEventListener('change', async (e) => {
  const budgetId = e.target.value;
  if (budgetId) {
    await loadAccountsForBudget(budgetId, 'loan-company-account');
  }
});

// ==================== COMPANY LOAN ACCOUNTS ====================

async function loadCompanyLoanAccounts() {
  const loading = document.getElementById('company-loan-loading');
  const error = document.getElementById('company-loan-error');
  const tableContainer = document.getElementById('company-loan-table-container');
  const tbody = document.getElementById('company-loan-tbody');
  const empty = document.getElementById('company-loan-empty');

  try {
    loading.style.display = 'block';
    error.style.display = 'none';
    tableContainer.style.display = 'none';
    empty.style.display = 'none';

    const result = await apiCall('/api/company-loan-accounts');
    const data = result.data;

    tbody.innerHTML = '';

    if (!data || data.length === 0) {
      loading.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    data.forEach(account => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>
          <strong>${account.budget_name_1 || 'N/A'}</strong>
          <span class="budget-name">${account.account_name_1 || account.account_id_1.substring(0, 8) + '...'}</span>
        </td>
        <td>
          <strong>${account.budget_name_2 || 'N/A'}</strong>
          <span class="budget-name">${account.account_name_2 || account.account_id_2.substring(0, 8) + '...'}</span>
        </td>
        <td>${account.currency}</td>
        <td><span class="auto-matched ${account.is_active ? 'yes' : 'no'}">${account.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <button class="btn-edit" onclick="editCompanyLoanAccount('${account.id}')">Edit</button>
          <button class="btn-delete" onclick="deleteCompanyLoanAccount('${account.id}')">Delete</button>
        </td>
      `;
      tbody.appendChild(row);
    });

    loading.style.display = 'none';
    tableContainer.style.display = 'block';

  } catch (err) {
    console.error('Error loading company loan accounts:', err);
    loading.style.display = 'none';
    error.textContent = `Error: ${err.message}`;
    error.style.display = 'block';
  }
}

document.getElementById('add-company-loan-btn').addEventListener('click', () => {
  document.getElementById('company-loan-modal-title').textContent = 'Add Company Loan Account';
  document.getElementById('company-loan-id').value = '';
  document.getElementById('company-loan-budget1').value = '';
  document.getElementById('company-loan-account1').innerHTML = '<option value="">Select account...</option>';
  document.getElementById('company-loan-budget2').value = '';
  document.getElementById('company-loan-account2').innerHTML = '<option value="">Select account...</option>';
  document.getElementById('company-loan-currency').value = 'USD';
  document.getElementById('company-loan-active').checked = true;
  populateCompanyBudgetSelects();
  document.getElementById('company-loan-modal').style.display = 'flex';
});

window.editCompanyLoanAccount = async function(id) {
  try {
    const result = await apiCall('/api/company-loan-accounts');
    const account = result.data.find(a => a.id === id);
    if (!account) throw new Error('Account not found');

    document.getElementById('company-loan-modal-title').textContent = 'Edit Company Loan Account';
    document.getElementById('company-loan-id').value = id;

    await populateCompanyBudgetSelects();
    document.getElementById('company-loan-budget1').value = account.budget_id_1;
    document.getElementById('company-loan-budget2').value = account.budget_id_2;

    await loadAccountsForBudget(account.budget_id_1, 'company-loan-account1');
    await loadAccountsForBudget(account.budget_id_2, 'company-loan-account2');

    document.getElementById('company-loan-account1').value = account.account_id_1;
    document.getElementById('company-loan-account2').value = account.account_id_2;
    document.getElementById('company-loan-currency').value = account.currency;
    document.getElementById('company-loan-active').checked = account.is_active;

    document.getElementById('company-loan-modal').style.display = 'flex';
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
};

window.deleteCompanyLoanAccount = function(id) {
  document.getElementById('delete-message').textContent = 'Are you sure you want to delete this company loan account?';
  deleteCallback = async () => {
    try {
      await apiCall(`/api/company-loan-accounts/${id}`, { method: 'DELETE' });
      closeDeleteModal();
      loadCompanyLoanAccounts();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  };
  document.getElementById('delete-modal').style.display = 'flex';
};

window.closeCompanyLoanModal = function() {
  document.getElementById('company-loan-modal').style.display = 'none';
};

document.getElementById('company-loan-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('company-loan-id').value;
  const budgetId1 = document.getElementById('company-loan-budget1').value;
  const accountId1 = document.getElementById('company-loan-account1').value;
  const budgetId2 = document.getElementById('company-loan-budget2').value;
  const accountId2 = document.getElementById('company-loan-account2').value;
  const currency = document.getElementById('company-loan-currency').value;
  const isActive = document.getElementById('company-loan-active').checked;

  const budget1Select = document.getElementById('company-loan-budget1');
  const budgetName1 = budget1Select.options[budget1Select.selectedIndex].text;
  const account1Select = document.getElementById('company-loan-account1');
  const accountName1 = account1Select.options[account1Select.selectedIndex].text;
  const budget2Select = document.getElementById('company-loan-budget2');
  const budgetName2 = budget2Select.options[budget2Select.selectedIndex].text;
  const account2Select = document.getElementById('company-loan-account2');
  const accountName2 = account2Select.options[account2Select.selectedIndex].text;

  try {
    if (id) {
      await apiCall(`/api/company-loan-accounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          budget_id_1: budgetId1,
          budget_name_1: budgetName1,
          account_id_1: accountId1,
          account_name_1: accountName1,
          budget_id_2: budgetId2,
          budget_name_2: budgetName2,
          account_id_2: accountId2,
          account_name_2: accountName2,
          currency: currency,
          is_active: isActive
        })
      });
    } else {
      await apiCall('/api/company-loan-accounts', {
        method: 'POST',
        body: JSON.stringify({
          budget_id_1: budgetId1,
          budget_name_1: budgetName1,
          account_id_1: accountId1,
          account_name_1: accountName1,
          budget_id_2: budgetId2,
          budget_name_2: budgetName2,
          account_id_2: accountId2,
          account_name_2: accountName2,
          currency: currency,
          is_active: isActive
        })
      });
    }

    closeCompanyLoanModal();
    loadCompanyLoanAccounts();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

// Load accounts when company budget changes
document.getElementById('company-loan-budget1').addEventListener('change', async (e) => {
  const budgetId = e.target.value;
  if (budgetId) {
    await loadAccountsForBudget(budgetId, 'company-loan-account1');
  }
});

document.getElementById('company-loan-budget2').addEventListener('change', async (e) => {
  const budgetId = e.target.value;
  if (budgetId) {
    await loadAccountsForBudget(budgetId, 'company-loan-account2');
  }
});

// ==================== HELPERS ====================

async function loadBudgets() {
  try {
    const result = await apiCall('/api/ynab/budgets');
    budgets = result.data || [];
    return budgets;
  } catch (err) {
    console.error('Error loading budgets:', err);
    return [];
  }
}

async function loadAccountsForBudget(budgetId, selectId) {
  const select = document.getElementById(selectId);
  select.innerHTML = '<option value="">Loading...</option>';

  try {
    if (!accountsCache[budgetId]) {
      const result = await apiCall(`/api/ynab/budgets/${budgetId}/accounts`);
      accountsCache[budgetId] = result.data || [];
    }

    const accounts = accountsCache[budgetId];
    select.innerHTML = '<option value="">Select account...</option>';
    accounts.forEach(account => {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.name;
      select.appendChild(option);
    });
  } catch (err) {
    console.error('Error loading accounts:', err);
    select.innerHTML = '<option value="">Error loading accounts</option>';
  }
}

async function loadPersonalAccounts(selectId) {
  // Personal budget is usually the first non-company budget
  const personalBudget = budgets.find(b => !b.name.includes('Innerly') && !b.name.includes('Vibecon') && !b.name.includes('Epic'));
  if (personalBudget) {
    await loadAccountsForBudget(personalBudget.id, selectId);
  }
}

async function populateBudgetSelects() {
  if (budgets.length === 0) {
    await loadBudgets();
  }

  const companySelect = document.getElementById('loan-company');
  companySelect.innerHTML = '<option value="">Select company...</option>';

  // Filter to company budgets
  budgets.filter(b => b.name.includes('Innerly') || b.name.includes('Vibecon') || b.name.includes('Epic'))
    .forEach(budget => {
      const option = document.createElement('option');
      option.value = budget.id;
      option.textContent = budget.name;
      companySelect.appendChild(option);
    });

  // Load personal accounts
  await loadPersonalAccounts('loan-personal-account');
}

async function populateCompanyBudgetSelects() {
  if (budgets.length === 0) {
    await loadBudgets();
  }

  const selects = ['company-loan-budget1', 'company-loan-budget2'];

  selects.forEach(selectId => {
    const select = document.getElementById(selectId);
    select.innerHTML = '<option value="">Select company...</option>';

    budgets.filter(b => b.name.includes('Innerly') || b.name.includes('Vibecon') || b.name.includes('Epic'))
      .forEach(budget => {
        const option = document.createElement('option');
        option.value = budget.id;
        option.textContent = budget.name;
        select.appendChild(option);
      });
  });
}

// ==================== MODALS ====================

window.closeDeleteModal = function() {
  document.getElementById('delete-modal').style.display = 'none';
  deleteCallback = null;
};

document.getElementById('confirm-delete-btn').addEventListener('click', () => {
  if (deleteCallback) {
    deleteCallback();
  }
});

// Close modals on background click
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
      modal.style.display = 'none';
    }
  });
});

// ==================== INITIALIZATION ====================

(async () => {
  const initialized = await initSupabase();
  if (!initialized) {
    document.getElementById('linked-loading').style.display = 'none';
    document.getElementById('linked-error').textContent = 'Failed to initialize. Please refresh the page.';
    document.getElementById('linked-error').style.display = 'block';
    return;
  }

  const authenticated = await checkAuth();
  if (authenticated) {
    await loadBudgets();
    loadLinkedTransactions();
  }
})();
