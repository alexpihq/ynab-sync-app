// Initialize Supabase client
let supabaseClient = null;
let accessToken = null;
let budgets = [];
let accountsCache = {};
let deleteCallback = null;

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

// Format wallet address for display
function formatWalletAddress(address) {
  if (!address) return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ==================== WALLETS ====================

async function loadWallets() {
  const loading = document.getElementById('wallets-loading');
  const error = document.getElementById('wallets-error');
  const tableContainer = document.getElementById('wallets-table-container');
  const tbody = document.getElementById('wallets-tbody');
  const empty = document.getElementById('wallets-empty');

  try {
    loading.style.display = 'block';
    error.style.display = 'none';
    tableContainer.style.display = 'none';
    empty.style.display = 'none';

    const result = await apiCall('/api/wallet-mappings');
    const data = result.data;

    tbody.innerHTML = '';

    if (!data || data.length === 0) {
      loading.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    data.forEach(wallet => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>
          <code style="font-size: 12px;" title="${wallet.wallet_address}">${formatWalletAddress(wallet.wallet_address)}</code>
        </td>
        <td>${wallet.wallet_name || '-'}</td>
        <td><strong>${wallet.budget_name}</strong></td>
        <td>${wallet.account_name || wallet.account_id.slice(0, 8) + '...'}</td>
        <td>${wallet.budget_currency}</td>
        <td><span class="auto-matched ${wallet.is_active ? 'yes' : 'no'}">${wallet.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <button class="btn-edit" onclick="editWallet('${wallet.id}')">Edit</button>
          <button class="btn-delete" onclick="deleteWallet('${wallet.id}')">Delete</button>
        </td>
      `;
      tbody.appendChild(row);
    });

    loading.style.display = 'none';
    tableContainer.style.display = 'block';

  } catch (err) {
    console.error('Error loading wallets:', err);
    loading.style.display = 'none';
    error.textContent = `Error: ${err.message}`;
    error.style.display = 'block';
  }
}

// Open modal for new wallet
window.openWalletModal = async function() {
  document.getElementById('wallet-modal-title').textContent = 'Add Wallet';
  document.getElementById('wallet-id').value = '';
  document.getElementById('wallet-address').value = '';
  document.getElementById('wallet-name').value = '';
  document.getElementById('wallet-currency').value = 'USD';
  document.getElementById('wallet-active').checked = true;
  document.getElementById('wallet-account').innerHTML = '<option value="">Select account...</option>';

  await populateBudgetSelect();

  document.getElementById('wallet-modal').style.display = 'flex';
};

// Close wallet modal
window.closeWalletModal = function() {
  document.getElementById('wallet-modal').style.display = 'none';
};

// Edit existing wallet
window.editWallet = async function(id) {
  try {
    const result = await apiCall('/api/wallet-mappings');
    const wallet = result.data.find(w => w.id === id);
    if (!wallet) throw new Error('Wallet not found');

    document.getElementById('wallet-modal-title').textContent = 'Edit Wallet';
    document.getElementById('wallet-id').value = id;

    await populateBudgetSelect();
    document.getElementById('wallet-budget').value = wallet.budget_id;

    await loadAccountsForBudget();
    document.getElementById('wallet-account').value = wallet.account_id;

    document.getElementById('wallet-address').value = wallet.wallet_address;
    document.getElementById('wallet-name').value = wallet.wallet_name || '';
    document.getElementById('wallet-currency').value = wallet.budget_currency;
    document.getElementById('wallet-active').checked = wallet.is_active;

    document.getElementById('wallet-modal').style.display = 'flex';
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
};

// Delete wallet
window.deleteWallet = function(id) {
  document.getElementById('delete-message').textContent = 'Are you sure you want to delete this wallet?';
  deleteCallback = async () => {
    try {
      await apiCall(`/api/wallet-mappings/${id}`, { method: 'DELETE' });
      closeDeleteModal();
      loadWallets();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  };
  document.getElementById('delete-modal').style.display = 'flex';
};

// Close delete modal
window.closeDeleteModal = function() {
  document.getElementById('delete-modal').style.display = 'none';
  deleteCallback = null;
};

document.getElementById('confirm-delete-btn').addEventListener('click', () => {
  if (deleteCallback) {
    deleteCallback();
  }
});

// Populate budget select
async function populateBudgetSelect() {
  if (budgets.length === 0) {
    await loadBudgets();
  }

  const select = document.getElementById('wallet-budget');
  select.innerHTML = '<option value="">Select budget...</option>';

  budgets.forEach(budget => {
    const option = document.createElement('option');
    option.value = budget.id;
    option.textContent = budget.name;
    select.appendChild(option);
  });
}

// Load budgets
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

// Load accounts for selected budget
window.loadAccountsForBudget = async function() {
  const budgetId = document.getElementById('wallet-budget').value;
  const select = document.getElementById('wallet-account');

  if (!budgetId) {
    select.innerHTML = '<option value="">Select account...</option>';
    return;
  }

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
};

// Save wallet form
document.getElementById('wallet-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('wallet-id').value;
  const walletAddress = document.getElementById('wallet-address').value.trim();
  const walletName = document.getElementById('wallet-name').value.trim();
  const budgetId = document.getElementById('wallet-budget').value;
  const accountId = document.getElementById('wallet-account').value;
  const budgetCurrency = document.getElementById('wallet-currency').value;
  const isActive = document.getElementById('wallet-active').checked;

  const budgetSelect = document.getElementById('wallet-budget');
  const budgetName = budgetSelect.options[budgetSelect.selectedIndex].text;
  const accountSelect = document.getElementById('wallet-account');
  const accountName = accountSelect.options[accountSelect.selectedIndex].text;

  if (!walletAddress || !budgetId || !accountId) {
    alert('Please fill in all required fields');
    return;
  }

  try {
    const payload = {
      wallet_address: walletAddress,
      wallet_name: walletName || null,
      budget_id: budgetId,
      budget_name: budgetName,
      account_id: accountId,
      account_name: accountName,
      budget_currency: budgetCurrency,
      is_active: isActive
    };

    if (id) {
      await apiCall(`/api/wallet-mappings/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    } else {
      await apiCall('/api/wallet-mappings', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }

    closeWalletModal();
    loadWallets();
  } catch (err) {
    alert(`Error: ${err.message}`);
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
    document.getElementById('wallets-loading').style.display = 'none';
    document.getElementById('wallets-error').textContent = 'Failed to initialize. Please refresh the page.';
    document.getElementById('wallets-error').style.display = 'block';
    return;
  }

  const authenticated = await checkAuth();
  if (authenticated) {
    await loadBudgets();
    loadWallets();
  }
})();
