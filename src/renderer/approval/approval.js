const summaryEl = document.getElementById('summary');
const detailEl = document.getElementById('context-detail');
const noteEl = document.getElementById('note');
const btnApprove = document.getElementById('btn-approve');
const btnSkip = document.getElementById('btn-skip');

// ─── i18n ─────────────────────────────────────────────────────────────────────
let i18n = {};

function t(key, params) {
  let val = i18n[key];
  if (val === undefined || val === null) return key;
  if (typeof val !== 'string') return String(val);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
  }
  return val;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const val = i18n[key];
    if (val && typeof val === 'string') el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    const val = i18n[key];
    if (val && typeof val === 'string') el.placeholder = val;
  });
}

function updateHeaderTime() {
  const el = document.getElementById('header-time');
  if (!el) return;
  const now = new Date();
  const weekdays = i18n.weekdays || ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const w = weekdays[now.getDay()];
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const datePart = t('date_format', { month: now.getMonth() + 1, day: now.getDate(), weekday: w });
  const timePart = t('time_format', { h, m });
  el.innerHTML = datePart + '<br>' + timePart;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function init() {
  // Load translations
  i18n = await window.electronAPI.getTranslations() || {};
  applyTranslations();
  updateHeaderTime();

  const data = await window.electronAPI.getPendingSession();

  if (!data) {
    summaryEl.textContent = t('approval_no_data');
    summaryEl.classList.remove('loading');
    return;
  }

  // Show AI summary
  summaryEl.textContent = data.aiSummary;
  summaryEl.classList.remove('loading');

  // Build context detail HTML
  let html = '';

  if (data.windows && data.windows.length > 0) {
    html += `<span class="section-label">${escapeHtml(t('approval_ctx_windows'))}</span>`;
    html += '<ul>';
    data.windows.slice(0, 6).forEach((w) => {
      html += `<li>• ${escapeHtml(w.title)}</li>`;
    });
    html += '</ul>';
  }

  if (data.recentFiles && data.recentFiles.length > 0) {
    html += `<span class="section-label">${escapeHtml(t('approval_ctx_files'))}</span>`;
    html += `<span style="padding-left:8px;color:#5566aa">${escapeHtml(
      data.recentFiles.slice(0, 5).join('　')
    )}</span>`;
  }

  if (data.clipboard && data.clipboard.trim()) {
    html += `<span class="section-label">${escapeHtml(t('approval_ctx_clipboard'))}</span>`;
    html += `<span style="padding-left:8px;color:#5566aa">${escapeHtml(
      data.clipboard.trim().substring(0, 80)
    )}${data.clipboard.length > 80 ? '…' : ''}</span>`;
  }

  detailEl.innerHTML = html || `<span>${escapeHtml(t('approval_ctx_none'))}</span>`;
}

btnApprove.addEventListener('click', async () => {
  btnApprove.disabled = true;
  btnSkip.disabled = true;
  btnApprove.textContent = t('approval_saving');

  const userNote = noteEl.value.trim();
  await window.electronAPI.approveSession(userNote);
});

btnSkip.addEventListener('click', async () => {
  btnApprove.disabled = true;
  btnSkip.disabled = true;
  await window.electronAPI.skipSession();
});

init();
