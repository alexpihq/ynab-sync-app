// Initialize Supabase client
let supabaseClient = null;
let accessToken = null;
let currentEditingMonth = null;

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
  console.log(`API Call: ${options.method || 'GET'} ${url}`);
  console.log('Access token present:', !!accessToken);
  
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    ...options.headers
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  console.log(`API Response status: ${response.status}`);
  
  const data = await response.json();
  console.log('API Response data:', data);

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

// Load exchange rates
async function loadRates() {
  const loading = document.getElementById('rates-loading');
  const error = document.getElementById('rates-error');
  const tableContainer = document.getElementById('rates-table-container');
  const tbody = document.getElementById('rates-tbody');

  try {
    console.log('Loading rates...');
    loading.style.display = 'block';
    error.style.display = 'none';
    tableContainer.style.display = 'none';

    console.log('Fetching from API...');
    const result = await apiCall('/api/rates');
    console.log('API response:', result);

    const data = result.data;

    tbody.innerHTML = '';

    if (!data || data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem;">No exchange rates found. Click "Add New Month" to create one.</td></tr>';
    } else {
      data.forEach(rate => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><strong>${rate.month}</strong></td>
          <td>${rate.eur_to_usd ? rate.eur_to_usd.toFixed(4) : '-'}</td>
          <td>${rate.eur_to_rub ? rate.eur_to_rub.toFixed(4) : '-'}</td>
          <td>${rate.usd_to_sgd ? rate.usd_to_sgd.toFixed(4) : '-'}</td>
          <td>${rate.source || '-'}</td>
          <td>${new Date(rate.updated_at).toLocaleString()}</td>
          <td>
            <button class="btn-edit" onclick="editRate('${rate.month}')">Edit</button>
            <button class="btn-delete" onclick="deleteRate('${rate.month}')">Delete</button>
          </td>
        `;
        tbody.appendChild(row);
      });
    }

    loading.style.display = 'none';
    tableContainer.style.display = 'block';

  } catch (err) {
    console.error('Error loading rates:', err);
    loading.style.display = 'none';
    error.innerHTML = `
      <strong>Error loading rates:</strong> ${err.message}<br><br>
      <small>Make sure you're logged in. <a href="/">Go to login page</a></small>
    `;
    error.style.display = 'block';
  }
}

// Add new rate
document.getElementById('add-rate-btn').addEventListener('click', () => {
  currentEditingMonth = null;
  document.getElementById('modal-title').textContent = 'Add New Exchange Rate';
  document.getElementById('edit-month').value = '';
  document.getElementById('edit-month').disabled = false;
  document.getElementById('edit-eur-usd').value = '';
  document.getElementById('edit-eur-rub').value = '';
  document.getElementById('edit-usd-sgd').value = '';
  document.getElementById('edit-source').value = 'manual';
  document.getElementById('edit-modal').style.display = 'flex';
});

// Edit rate
window.editRate = async function(month) {
  currentEditingMonth = month;
  
  try {
    const result = await apiCall('/api/rates');
    const rate = result.data.find(r => r.month === month);

    if (!rate) throw new Error('Rate not found');

    document.getElementById('modal-title').textContent = 'Edit Exchange Rate';
    document.getElementById('edit-month').value = rate.month;
    document.getElementById('edit-month').disabled = true;
    document.getElementById('edit-eur-usd').value = rate.eur_to_usd || '';
    document.getElementById('edit-eur-rub').value = rate.eur_to_rub || '';
    document.getElementById('edit-usd-sgd').value = rate.usd_to_sgd || '';
    document.getElementById('edit-source').value = rate.source || '';
    document.getElementById('edit-modal').style.display = 'flex';

  } catch (err) {
    alert(`Error loading rate: ${err.message}`);
  }
};

// Close modal
window.closeEditModal = function() {
  document.getElementById('edit-modal').style.display = 'none';
  currentEditingMonth = null;
};

// Save rate
document.getElementById('edit-rate-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const month = document.getElementById('edit-month').value;
  const eurToUsd = parseFloat(document.getElementById('edit-eur-usd').value);
  const eurToRub = parseFloat(document.getElementById('edit-eur-rub').value) || null;
  const usdToSgd = parseFloat(document.getElementById('edit-usd-sgd').value) || null;
  const source = document.getElementById('edit-source').value || 'manual';

  try {
    if (currentEditingMonth) {
      // Update existing
      await apiCall(`/api/rates/${currentEditingMonth}`, {
        method: 'PUT',
        body: JSON.stringify({
          eur_to_usd: eurToUsd,
          eur_to_rub: eurToRub,
          usd_to_sgd: usdToSgd,
          source: source
        })
      });
      alert('Exchange rate updated successfully!');
    } else {
      // Insert new
      await apiCall('/api/rates', {
        method: 'POST',
        body: JSON.stringify({
          month: month,
          eur_to_usd: eurToUsd,
          eur_to_rub: eurToRub,
          usd_to_sgd: usdToSgd,
          source: source
        })
      });
      alert('Exchange rate added successfully!');
    }

    closeEditModal();
    loadRates();

  } catch (err) {
    alert(`Error saving rate: ${err.message}`);
  }
});

// Delete rate
window.deleteRate = async function(month) {
  if (!confirm(`Are you sure you want to delete the exchange rate for ${month}?`)) {
    return;
  }

  try {
    await apiCall(`/api/rates/${month}`, {
      method: 'DELETE'
    });

    alert('Exchange rate deleted successfully!');
    loadRates();

  } catch (err) {
    alert(`Error deleting rate: ${err.message}`);
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
  console.log('rates.js: Starting initialization...');
  
  const initialized = await initSupabase();
  console.log('rates.js: Supabase initialized:', initialized);
  
  if (!initialized) {
    console.error('rates.js: Failed to initialize Supabase');
    document.getElementById('rates-loading').style.display = 'none';
    document.getElementById('rates-error').textContent = 'Failed to initialize. Please refresh the page.';
    document.getElementById('rates-error').style.display = 'block';
    return;
  }

  console.log('rates.js: Checking authentication...');
  const authenticated = await checkAuth();
  console.log('rates.js: Authenticated:', authenticated);
  
  if (authenticated) {
    console.log('rates.js: Loading rates...');
    loadRates();
  }
})();

