// Supabase client
let supabaseClient = null;
let accessToken = null;

// SSE for real-time logs
let logEventSource = null;

// Initialize Supabase
async function initSupabase() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    
    const { createClient } = window.supabase;
    supabaseClient = createClient(config.supabaseUrl, config.supabaseAnonKey);
    
    // Listen for auth state changes
    supabaseClient.auth.onAuthStateChange((event, session) => {
      console.log('Auth state changed:', event, session);
      if (session) {
        accessToken = session.access_token;
        // Clean URL from auth parameters
        if (window.location.search || window.location.hash) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
        showDashboard();
      } else {
        accessToken = null;
        showLogin();
      }
    });
    
    // Check existing session
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      accessToken = session.access_token;
      showDashboard();
    } else {
      showLogin();
    }
  } catch (error) {
    console.error('Failed to initialize Supabase:', error);
    showLogin();
  }
}

// Wait for DOM to load
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, initializing...');
  initSupabase();
  
  // Login form handler
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    console.log('Login form found, attaching handler');
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      console.log('Form submitted');
      
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('login-error');
      
      console.log('Attempting login with email:', email);
      
      if (!supabaseClient) {
        errorEl.textContent = 'Supabase not initialized. Check console for errors.';
        console.error('Supabase client is null');
        return;
      }
      
      try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
          email,
          password
        });
        
        console.log('Login response:', { data, error });
        
        if (error) {
          errorEl.textContent = error.message;
          console.error('Login error:', error);
        } else if (data.session) {
          accessToken = data.session.access_token;
          errorEl.textContent = '';
          console.log('Login successful, showing dashboard');
          showDashboard();
        }
      } catch (error) {
        const errorMsg = 'Connection error: ' + error.message;
        errorEl.textContent = errorMsg;
        console.error('Exception during login:', error);
      }
    });
  } else {
    console.error('Login form not found!');
  }
});

// Logout handler
document.getElementById('logout-btn')?.addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  accessToken = null;
  showLogin();
});

function showLogin() {
  document.getElementById('login-page').style.display = 'block';
  document.getElementById('dashboard-page').style.display = 'none';
}

function showDashboard() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('dashboard-page').style.display = 'block';
  loadSyncStatus();
  loadServerIP();
  setInterval(loadSyncStatus, 5000); // Refresh every 5 seconds
}

// Load server's outbound IP address
async function loadServerIP() {
  try {
    const response = await fetch('/api/server-ip');
    if (response.ok) {
      const data = await response.json();
      const ipElement = document.getElementById('server-ip');
      if (ipElement) {
        ipElement.textContent = data.ip || 'Unknown';
        ipElement.style.color = '#2196F3';
        ipElement.style.fontFamily = 'monospace';
      }
    } else {
      const ipElement = document.getElementById('server-ip');
      if (ipElement) {
        ipElement.textContent = 'Unable to determine';
        ipElement.style.color = '#f44336';
      }
    }
  } catch (error) {
    console.error('Failed to load server IP:', error);
    const ipElement = document.getElementById('server-ip');
    if (ipElement) {
      ipElement.textContent = 'Error loading IP';
      ipElement.style.color = '#f44336';
    }
  }
}

async function loadSyncStatus() {
  if (!accessToken) return;
  
  try {
    const response = await fetch('/api/sync/status', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (response.status === 401) {
      // Token expired, logout
      await supabaseClient.auth.signOut();
      accessToken = null;
      showLogin();
      return;
    }
    
    const data = await response.json();
    updateStatusUI(data);
  } catch (error) {
    console.error('Failed to load sync status:', error);
  }
}

function createTransactionsTable(transactions, syncType) {
  const container = document.createElement('div');
  container.className = 'transactions-container';
  
  const header = document.createElement('h4');
  header.textContent = `Transactions (${transactions.length})`;
  header.className = 'transactions-header';
  container.appendChild(header);
  
  const table = document.createElement('table');
  table.className = 'transactions-table';
  
  // Table header
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>Date</th>
      <th>Amount</th>
      <th>Payee</th>
      <th>Account</th>
      <th>Budget</th>
      <th>Action</th>
      <th>Details</th>
    </tr>
  `;
  table.appendChild(thead);
  
  // Table body
  const tbody = document.createElement('tbody');
  transactions.forEach(tx => {
    const row = document.createElement('tr');
    row.className = `tx-${tx.action}`;
    
    const amount = (tx.amount / 1000).toFixed(2);
    const actionBadge = `<span class="action-badge action-${tx.action}">${tx.action}</span>`;
    
    row.innerHTML = `
      <td>${tx.date}</td>
      <td class="amount">${amount}</td>
      <td>${tx.payee || 'N/A'}</td>
      <td>${tx.account}</td>
      <td>${tx.budget}</td>
      <td>${actionBadge}</td>
      <td class="details">${tx.details || tx.mirrorId ? `Mirror: ${tx.mirrorId}` : '-'}</td>
    `;
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  
  container.appendChild(table);
  return container;
}

function updateStatusUI(data) {
  const statusBadge = document.getElementById('status-badge');
  const lastRun = document.getElementById('last-run');
  const syncRunning = document.getElementById('sync-running');
  const syncResults = document.getElementById('sync-results');
  const syncHistory = document.getElementById('sync-history');
  
  // Update status badge
  if (data.isRunning) {
    statusBadge.textContent = '⏳ Running';
    statusBadge.className = 'status-badge running';
    syncRunning.style.display = 'block';
    disableSyncButtons(true);
  } else {
    syncRunning.style.display = 'none';
    disableSyncButtons(false);
    disconnectLogs(); // Disconnect from log stream when sync completes
    
    if (data.lastResult) {
      if (data.lastResult.success) {
        statusBadge.textContent = '✅ Success';
        statusBadge.className = 'status-badge success';
      } else {
        statusBadge.textContent = '❌ Error';
        statusBadge.className = 'status-badge error';
      }
    } else {
      statusBadge.textContent = '💤 Idle';
      statusBadge.className = 'status-badge idle';
    }
  }
  
  // Update last run
  if (data.lastRun) {
    const date = new Date(data.lastRun);
    lastRun.textContent = `Last run: ${date.toLocaleString()}`;
  } else {
    lastRun.textContent = 'Last run: Never';
  }
  
  // Update results
  if (data.lastResult) {
    console.log('Last result:', data.lastResult); // DEBUG
    syncResults.innerHTML = '';
    
    const types = [
      { key: 'ynab', label: '💰 YNAB ↔ YNAB', icon: '💰' },
      { key: 'finolog', label: '💼 Finolog → YNAB', icon: '💼' },
      { key: 'aspire', label: '🏦 Aspire → YNAB', icon: '🏦' },
      { key: 'tron', label: '⛓️ Tron → YNAB', icon: '⛓️' }
    ];
    
    types.forEach(({ key, label, icon }) => {
      if (data.lastResult[key]) {
        const result = data.lastResult[key];
        const resultItem = document.createElement('div');
        resultItem.className = 'result-item';
        
        const title = document.createElement('h3');
        title.textContent = label;
        
        resultItem.appendChild(title);
        
        // Show error details if any
        if (result.error) {
          const errorDiv = document.createElement('div');
          errorDiv.className = 'error-details';
          errorDiv.textContent = `Error: ${result.error}`;
          resultItem.appendChild(errorDiv);
        }
        
        // Show transactions table if available
        console.log(`📋 Transactions for ${key}:`, result.transactions);
        if (result.transactions && result.transactions.length > 0) {
          console.log(`✅ Creating table with ${result.transactions.length} transactions`);
          const transactionsTable = createTransactionsTable(result.transactions, label);
          resultItem.appendChild(transactionsTable);
        } else {
          console.log(`⚠️ No transactions to display for ${key}`);
        }
        
        syncResults.appendChild(resultItem);
      }
    });
    
    if (!syncResults.hasChildNodes()) {
      syncResults.innerHTML = '<p class="no-data">No detailed results</p>';
    }
  } else {
    syncResults.innerHTML = '<p class="no-data">No sync results yet</p>';
  }
  
  // Update history
  if (data.history && data.history.length > 0) {
    syncHistory.innerHTML = '';
    
    data.history.slice(0, 10).forEach(item => {
      const historyItem = document.createElement('div');
      historyItem.className = `history-item ${item.success ? 'success' : 'error'}`;
      
      const timestamp = document.createElement('div');
      timestamp.className = 'timestamp';
      timestamp.textContent = new Date(item.timestamp).toLocaleString();
      
      const message = document.createElement('div');
      message.className = 'message';
      message.textContent = item.message;
      
      const duration = document.createElement('div');
      duration.className = 'duration';
      duration.textContent = `${(item.duration / 1000).toFixed(1)}s`;
      
      historyItem.appendChild(timestamp);
      historyItem.appendChild(message);
      historyItem.appendChild(duration);
      
      syncHistory.appendChild(historyItem);
    });
  } else {
    syncHistory.innerHTML = '<p class="no-data">No history yet</p>';
  }
}

function disableSyncButtons(disabled) {
  document.querySelectorAll('.sync-btn').forEach(btn => {
    btn.disabled = disabled;
  });
}

async function runSync(type) {
  console.log('🔵 runSync called with type:', type);
  console.log('🔑 accessToken:', accessToken ? 'present' : 'NULL');
  
  if (!accessToken) {
    alert('Not authenticated');
    return;
  }
  
  const url = type === 'all' ? '/api/sync/run' : `/api/sync/run/${type}`;
  console.log('📡 Sending POST to:', url);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    console.log('📥 Response status:', response.status);
    
    if (response.status === 401) {
      // Token expired, logout
      console.error('❌ Unauthorized, logging out');
      await supabaseClient.auth.signOut();
      accessToken = null;
      showLogin();
      return;
    }
    
    const data = await response.json();
    console.log('📦 Response data:', data);
    
    if (response.ok) {
      // Refresh status immediately
      console.log('✅ Sync started, refreshing status in 500ms');
      setTimeout(loadSyncStatus, 500);
      
      // Start listening to logs
      connectToLogs();
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (error) {
    console.error('❌ Connection error:', error);
    alert(`Connection error: ${error.message}`);
  }
}

// Real-time logs functions
function connectToLogs() {
  if (logEventSource) {
    logEventSource.close();
  }
  
  const logsContainer = document.getElementById('sync-logs-container');
  const logsContent = document.getElementById('sync-logs');
  
  // Show logs container
  logsContainer.style.display = 'block';
  logsContent.innerHTML = '<p class="log-line info">📡 Connecting to log stream...</p>';
  
  try {
    // EventSource не поддерживает custom headers, поэтому передаем токен через query параметр
    // Но это небезопасно, поэтому лучше использовать fetch + ReadableStream
    
    // Используем fetch API для SSE с авторизацией
    fetch('/api/sync/logs/stream', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'text/event-stream'
      }
    }).then(response => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      function readStream() {
        reader.read().then(({ done, value }) => {
          if (done) {
            console.log('Log stream ended');
            return;
          }
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const log = JSON.parse(line.substring(6));
                appendLog(log);
              } catch (e) {
                console.error('Failed to parse log:', e);
              }
            }
          }
          
          readStream();
        }).catch(error => {
          console.error('Stream read error:', error);
        });
      }
      
      readStream();
    }).catch(error => {
      console.error('Failed to connect to log stream:', error);
      logsContent.innerHTML += '<p class="log-line log-error">❌ Failed to connect to log stream</p>';
    });
    
  } catch (error) {
    console.error('Failed to connect to log stream:', error);
    logsContent.innerHTML += '<p class="log-line log-error">❌ Connection error</p>';
  }
}

function appendLog(log) {
  const logsContent = document.getElementById('sync-logs');
  const logLine = document.createElement('div');
  logLine.className = `log-line log-${log.level}`;
  
  const timestamp = new Date(log.timestamp).toLocaleTimeString();
  const icon = log.level === 'error' ? '❌' : log.level === 'warn' ? '⚠️' : 'ℹ️';
  
  logLine.innerHTML = `<span class="log-time">[${timestamp}]</span> ${icon} ${escapeHtml(log.message)}`;
  logsContent.appendChild(logLine);
  
  // Auto-scroll to bottom
  logsContent.scrollTop = logsContent.scrollHeight;
  
  // Limit to last 500 lines
  while (logsContent.children.length > 500) {
    logsContent.removeChild(logsContent.firstChild);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Clear logs button
document.getElementById('clear-logs-btn')?.addEventListener('click', () => {
  document.getElementById('sync-logs').innerHTML = '';
});

// Disconnect logs when sync completes
function disconnectLogs() {
  if (logEventSource) {
    logEventSource.close();
    logEventSource = null;
  }
}
