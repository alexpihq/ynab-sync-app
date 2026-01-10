// Initialize Supabase client
let supabaseClient = null;
let accessToken = null;
let currentEditingId = null;

// Cache for YNAB data
let budgetsCache = [];
let accountsCache = {}; // budgetId -> accounts[]

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

// Load YNAB budgets
async function loadBudgets() {
  try {
    const result = await apiCall('/api/ynab/budgets');
    budgetsCache = result.data || [];
    return budgetsCache;
  } catch (error) {
    console.error('Error loading budgets:', error);
    return [];
  }
}

// Load YNAB accounts for a budget
async function loadAccounts(budgetId) {
  if (accountsCache[budgetId]) {
    return accountsCache[budgetId];
  }

  try {
    const result = await apiCall(`/api/ynab/budgets/${budgetId}/accounts`);
    accountsCache[budgetId] = result.data || [];
    return accountsCache[budgetId];
  } catch (error) {
    console.error('Error loading accounts:', error);
    return [];
  }
}

// Get budget name by ID
function getBudgetName(budgetId) {
  const budget = budgetsCache.find(b => b.id === budgetId);
  return budget ? budget.name : budgetId.substring(0, 8) + '...';
}

// Get account name by ID
function getAccountName(budgetId, accountId) {
  const accounts = accountsCache[budgetId] || [];
  const account = accounts.find(a => a.id === accountId);
  return account ? account.name : accountId.substring(0, 8) + '...';
}

// Populate budget select
function populateBudgetSelect(selectElement, selectedValue = '') {
  selectElement.innerHTML = '<option value="">Select a budget...</option>';

  budgetsCache.forEach(budget => {
    const option = document.createElement('option');
    option.value = budget.id;
    option.textContent = `${budget.name} (${budget.currency_format?.iso_code || '?'})`;
    if (budget.id === selectedValue) {
      option.selected = true;
    }
    selectElement.appendChild(option);
  });
}

// Populate account select
async function populateAccountSelect(selectElement, budgetId, selectedValue = '') {
  if (!budgetId) {
    selectElement.innerHTML = '<option value="">Select a budget first</option>';
    selectElement.disabled = true;
    return;
  }

  selectElement.innerHTML = '<option value="">Loading accounts...</option>';
  selectElement.disabled = true;

  const accounts = await loadAccounts(budgetId);

  selectElement.innerHTML = '<option value="">Select an account...</option>';

  accounts.forEach(account => {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = `${account.name} (${account.type})`;
    if (account.id === selectedValue) {
      option.selected = true;
    }
    selectElement.appendChild(option);
  });

  selectElement.disabled = false;
}

// Load conversion accounts
async function loadConversionAccounts() {
  const loading = document.getElementById('accounts-loading');
  const error = document.getElementById('accounts-error');
  const tableContainer = document.getElementById('accounts-table-container');
  const tbody = document.getElementById('accounts-tbody');

  try {
    loading.style.display = 'block';
    error.style.display = 'none';
    tableContainer.style.display = 'none';

    const result = await apiCall('/api/conversion-accounts');
    const data = result.data;

    // Load accounts for each budget to display names
    const budgetIds = [...new Set(data.map(a => a.budget_id))];
    await Promise.all(budgetIds.map(id => loadAccounts(id)));

    tbody.innerHTML = '';

    if (!data || data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 2rem;">No conversion accounts configured. Click "Add Account" to create one.</td></tr>';
    } else {
      data.forEach(account => {
        const row = document.createElement('tr');
        const statusClass = account.is_active ? 'status-active' : 'status-inactive';
        const statusText = account.is_active ? 'Active' : 'Inactive';

        const budgetName = getBudgetName(account.budget_id);
        const accountName = getAccountName(account.budget_id, account.account_id);

        row.innerHTML = `
          <td title="${account.budget_id}">${budgetName}</td>
          <td title="${account.account_id}">${accountName}</td>
          <td><strong>${account.source_currency} → ${account.target_currency}</strong></td>
          <td><span class="${statusClass}">${statusText}</span></td>
          <td>${new Date(account.created_at).toLocaleDateString()}</td>
          <td>
            <button class="btn-edit" onclick="editAccount('${account.id}')">Edit</button>
            <button class="btn-delete" onclick="deleteAccount('${account.id}')">Delete</button>
          </td>
        `;
        tbody.appendChild(row);
      });
    }

    loading.style.display = 'none';
    tableContainer.style.display = 'block';

  } catch (err) {
    console.error('Error loading accounts:', err);
    loading.style.display = 'none';
    error.innerHTML = `
      <strong>Error loading accounts:</strong> ${err.message}<br><br>
      <small>Make sure you're logged in. <a href="/">Go to login page</a></small>
    `;
    error.style.display = 'block';
  }
}

// Get budget currency by ID
function getBudgetCurrency(budgetId) {
  const budget = budgetsCache.find(b => b.id === budgetId);
  return budget?.currency_format?.iso_code || null;
}

// Set target currency based on budget
function setTargetCurrency(budgetId) {
  const targetSelect = document.getElementById('edit-target-currency');
  const currency = getBudgetCurrency(budgetId);

  if (currency) {
    targetSelect.innerHTML = `<option value="${currency}">${currency}</option>`;
    targetSelect.value = currency;
  } else {
    targetSelect.innerHTML = '<option value="">Select a budget first</option>';
  }
}

// Budget select change handler
document.getElementById('edit-budget-id').addEventListener('change', async (e) => {
  const budgetId = e.target.value;
  const accountSelect = document.getElementById('edit-account-id');
  await populateAccountSelect(accountSelect, budgetId);
  setTargetCurrency(budgetId);
});

// Add new account
document.getElementById('add-account-btn').addEventListener('click', async () => {
  currentEditingId = null;
  document.getElementById('modal-title').textContent = 'Add Conversion Account';

  const budgetSelect = document.getElementById('edit-budget-id');
  const accountSelect = document.getElementById('edit-account-id');
  const targetSelect = document.getElementById('edit-target-currency');

  populateBudgetSelect(budgetSelect);
  budgetSelect.disabled = false;
  accountSelect.innerHTML = '<option value="">Select a budget first</option>';
  accountSelect.disabled = true;
  targetSelect.innerHTML = '<option value="">Select a budget first</option>';

  document.getElementById('edit-source-currency').value = 'EUR';
  document.getElementById('edit-is-active').checked = true;
  document.getElementById('is-active-group').style.display = 'none';
  document.getElementById('edit-modal').style.display = 'flex';
});

// Edit account
window.editAccount = async function(id) {
  currentEditingId = id;

  try {
    const result = await apiCall('/api/conversion-accounts');
    const account = result.data.find(a => a.id === id);

    if (!account) throw new Error('Account not found');

    document.getElementById('modal-title').textContent = 'Edit Conversion Account';

    const budgetSelect = document.getElementById('edit-budget-id');
    const accountSelect = document.getElementById('edit-account-id');

    populateBudgetSelect(budgetSelect, account.budget_id);
    budgetSelect.disabled = true;

    await populateAccountSelect(accountSelect, account.budget_id, account.account_id);
    accountSelect.disabled = true;

    setTargetCurrency(account.budget_id);

    document.getElementById('edit-source-currency').value = account.source_currency;
    document.getElementById('edit-is-active').checked = account.is_active;
    document.getElementById('is-active-group').style.display = 'block';
    document.getElementById('edit-modal').style.display = 'flex';

  } catch (err) {
    alert(`Error loading account: ${err.message}`);
  }
};

// Close modal
window.closeEditModal = function() {
  document.getElementById('edit-modal').style.display = 'none';
  document.getElementById('edit-budget-id').disabled = false;
  document.getElementById('edit-account-id').disabled = false;
  currentEditingId = null;
};

// Save account
document.getElementById('edit-account-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const budgetId = document.getElementById('edit-budget-id').value;
  const accountId = document.getElementById('edit-account-id').value;
  const sourceCurrency = document.getElementById('edit-source-currency').value;
  const targetCurrency = document.getElementById('edit-target-currency').value;
  const isActive = document.getElementById('edit-is-active').checked;

  // Validate
  if (!budgetId || !accountId) {
    alert('Please select a budget and account.');
    return;
  }

  // Validate currencies are different
  if (sourceCurrency === targetCurrency) {
    alert('Source and target currencies must be different.');
    return;
  }

  try {
    if (currentEditingId) {
      // Update existing
      await apiCall(`/api/conversion-accounts/${currentEditingId}`, {
        method: 'PUT',
        body: JSON.stringify({
          source_currency: sourceCurrency,
          target_currency: targetCurrency,
          is_active: isActive
        })
      });
      alert('Conversion account updated successfully!');
    } else {
      // Insert new
      await apiCall('/api/conversion-accounts', {
        method: 'POST',
        body: JSON.stringify({
          budget_id: budgetId,
          account_id: accountId,
          source_currency: sourceCurrency,
          target_currency: targetCurrency
        })
      });
      alert('Conversion account added successfully!');
    }

    closeEditModal();
    loadConversionAccounts();

  } catch (err) {
    alert(`Error saving account: ${err.message}`);
  }
});

// Delete account
window.deleteAccount = async function(id) {
  if (!confirm('Are you sure you want to delete this conversion account?')) {
    return;
  }

  try {
    await apiCall(`/api/conversion-accounts/${id}`, {
      method: 'DELETE'
    });

    alert('Conversion account deleted successfully!');
    loadConversionAccounts();

  } catch (err) {
    alert(`Error deleting account: ${err.message}`);
  }
};

// Close modal on background click
document.getElementById('edit-modal').addEventListener('click', (e) => {
  if (e.target.id === 'edit-modal') {
    closeEditModal();
  }
});

// Initialize
(async () => {
  console.log('conversion.js: Starting initialization...');

  const initialized = await initSupabase();
  if (!initialized) {
    document.getElementById('accounts-loading').style.display = 'none';
    document.getElementById('accounts-error').textContent = 'Failed to initialize. Please refresh the page.';
    document.getElementById('accounts-error').style.display = 'block';
    return;
  }

  const authenticated = await checkAuth();
  if (authenticated) {
    // Load budgets first for the dropdowns
    await loadBudgets();
    // Then load conversion accounts
    loadConversionAccounts();
  }
})();
