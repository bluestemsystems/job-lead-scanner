/* ── State ─────────────────────────────────────────────────────────────────── */
let allListings = [];
let activeFilter = 'all';
let isScanning = false;

/* ── DOM refs ──────────────────────────────────────────────────────────────── */
const authSection   = document.getElementById('authSection');
const statusBar     = document.getElementById('statusBar');
const statusMsg     = document.getElementById('statusMsg');
const progressFill  = document.getElementById('progressFill');
const errorBanner   = document.getElementById('errorBanner');
const errorMsg      = document.getElementById('errorMsg');
const emptyState    = document.getElementById('emptyState');
const listingsGrid  = document.getElementById('listingsGrid');
const statEmails    = document.getElementById('statEmails');
const statListings  = document.getElementById('statListings');
const statStrong    = document.getElementById('statStrong');
const statSkip      = document.getElementById('statSkip');
const countStrong   = document.getElementById('countStrong');
const countMaybe    = document.getElementById('countMaybe');
const countSkip     = document.getElementById('countSkip');

/* ── Init ──────────────────────────────────────────────────────────────────── */
(async function init() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('error')) {
    showError(`OAuth error: ${params.get('error')}. Make sure your Google Cloud credentials and REDIRECT_URI are set correctly.`);
    window.history.replaceState({}, '', '/');
  }

  const status = await fetchJSON('/api/status');
  renderAuthSection(status.authenticated);

  if (params.get('auth') === 'success') {
    window.history.replaceState({}, '', '/');
  }
})();

/* ── Auth UI ───────────────────────────────────────────────────────────────── */
function renderAuthSection(authenticated) {
  if (authenticated) {
    authSection.innerHTML = `
      <span class="auth-badge">
        <span class="auth-dot"></span>Gmail connected
      </span>
      <button class="btn btn-primary" id="scanBtn">📥 Scan inbox</button>
      <a href="/logout" class="btn btn-ghost">Sign out</a>
    `;
    document.getElementById('scanBtn').addEventListener('click', startScan);
  } else {
    authSection.innerHTML = `
      <a href="/auth" class="btn btn-outline">🔐 Connect Gmail</a>
    `;
    emptyState.querySelector('.empty-title').textContent = 'Connect your Gmail to get started';
  }
}

/* ── Scan ──────────────────────────────────────────────────────────────────── */
function startScan() {
  if (isScanning) return;
  isScanning = true;

  // Reset UI
  allListings = [];
  listingsGrid.innerHTML = '';
  hideError();
  showStatusBar('Connecting to Gmail…');
  setProgress(0);
  updateCounts();

  const scanBtn = document.getElementById('scanBtn');
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = '⏳ Scanning…';
  }

  const evtSource = new EventSource('/api/scan');

  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    switch (msg.type) {

      case 'status':
        updateStatusMsg(msg.message);
        if (msg.emailCount) statEmails.textContent = msg.emailCount;
        break;

      case 'progress':
        updateStatusMsg(msg.message);
        setProgress(msg.pct || 0);
        break;

      case 'tally':
        statListings.textContent = msg.count;
        statStrong.textContent = msg.strong;
        break;

      case 'done':
        evtSource.close();
        isScanning = false;

        allListings = msg.listings || [];

        // Update stat cards
        statEmails.textContent    = msg.stats?.emails   ?? '—';
        statListings.textContent  = msg.stats?.listings ?? allListings.length;
        statStrong.textContent    = msg.stats?.strong   ?? 0;
        statSkip.textContent      = msg.stats?.skip     ?? 0;

        updateCounts();
        renderListings();
        hideStatusBar();
        setProgress(100);

        if (scanBtn) {
          scanBtn.disabled = false;
          scanBtn.textContent = '📥 Scan inbox';
        }
        break;

      case 'error':
        evtSource.close();
        isScanning = false;
        hideStatusBar();
        showError(msg.message);

        if (scanBtn) {
          scanBtn.disabled = false;
          scanBtn.textContent = '📥 Scan inbox';
        }
        break;

      default:
        break;
    }
  };

  evtSource.onerror = () => {
    evtSource.close();
    isScanning = false;
    hideStatusBar();

    // If we got listings before the connection dropped, show them
    if (allListings.length > 0) {
      renderListings();
    } else {
      showError('Connection to server lost. Try scanning again.');
    }

    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.textContent = '📥 Scan inbox';
    }
  };
}

/* ── Rendering ─────────────────────────────────────────────────────────────── */
function renderListings() {
  const filtered = activeFilter === 'all'
    ? allListings
    : allListings.filter(l => l.score === activeFilter);

  listingsGrid.innerHTML = '';

  if (allListings.length === 0) {
    emptyState.classList.remove('hidden');
    emptyState.querySelector('.empty-title').textContent = 'No listings found';
    emptyState.querySelector('.empty-body').textContent =
      'No job listings were found in your recent job alert emails. Try scanning again after your next batch arrives.';
    return;
  }

  emptyState.classList.add('hidden');

  if (filtered.length === 0) {
    listingsGrid.innerHTML = `
      <div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--c-muted);">
        No listings in this category.
      </div>`;
    return;
  }

  // Sort: strong → maybe → skip
  const order = { strong: 0, maybe: 1, skip: 2 };
  const sorted = [...filtered].sort((a, b) =>
    (order[a.score] ?? 99) - (order[b.score] ?? 99)
  );

  sorted.forEach(listing => {
    listingsGrid.appendChild(buildCard(listing));
  });
}

function buildCard(l) {
  const score = (l.score || 'maybe').toLowerCase();
  const card = document.createElement('div');
  card.className = `job-card job-card--${score}`;
  card.dataset.score = score;

  const badgeLabel = score === 'strong' ? '✅ Strong match'
    : score === 'maybe' ? '🤔 Maybe'
    : '⏭ Skip';

  const locationIcon = (l.location || '').toLowerCase().includes('remote') ? '🌐' : '📍';
  const payChip = l.pay
    ? `<span class="meta-chip"><span class="meta-chip-icon">💰</span>${escHtml(l.pay)}</span>`
    : '';

  const applyBtn = l.applyUrl
    ? `<a href="${escHtml(l.applyUrl)}" target="_blank" rel="noopener noreferrer" class="apply-link">Apply now</a>`
    : '';

  card.innerHTML = `
    <div class="job-card-top">
      <div class="job-title">${escHtml(l.title || 'Untitled Role')}</div>
      <span class="score-badge score-badge--${score}">${badgeLabel}</span>
    </div>
    <div class="job-meta">
      <span class="meta-chip"><span class="meta-chip-icon">🏢</span>${escHtml(l.company || 'Unknown company')}</span>
      <span class="meta-chip"><span class="meta-chip-icon">${locationIcon}</span>${escHtml(l.location || 'Location unknown')}</span>
      ${payChip}
    </div>
    ${l.reason ? `<p class="job-reason">${escHtml(l.reason)}</p>` : ''}
    ${applyBtn}
  `;

  return card;
}

/* ── Filter tabs ───────────────────────────────────────────────────────────── */
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeFilter = tab.dataset.filter;
    renderListings();
  });
});

function updateCounts() {
  countStrong.textContent = allListings.filter(l => l.score === 'strong').length;
  countMaybe.textContent  = allListings.filter(l => l.score === 'maybe').length;
  countSkip.textContent   = allListings.filter(l => l.score === 'skip').length;
}

/* ── UI helpers ────────────────────────────────────────────────────────────── */
function showStatusBar(msg) {
  statusMsg.textContent = msg;
  statusBar.classList.remove('hidden');
  emptyState.classList.add('hidden');
}

function hideStatusBar() {
  statusBar.classList.add('hidden');
}

function updateStatusMsg(msg) {
  statusMsg.textContent = msg;
}

function setProgress(pct) {
  progressFill.style.width = `${Math.min(100, pct)}%`;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorBanner.classList.remove('hidden');
}

function hideError() {
  errorBanner.classList.add('hidden');
}

function escHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    return r.json();
  } catch {
    return {};
  }
}
