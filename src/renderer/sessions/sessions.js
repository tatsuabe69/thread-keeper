const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const btnSettings = document.getElementById('btn-settings');
if (btnSettings) {
  btnSettings.addEventListener('click', () => {
    // open-settings is not exposed via preload; button kept but handler removed
  });
}

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
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    const val = i18n[key];
    if (val && typeof val === 'string') el.title = val;
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  const d = new Date(iso);
  const weekdays = i18n.weekdays || ['日', '月', '火', '水', '木', '金', '土'];
  const wday = weekdays[d.getDay()];
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const date = t('date_format', { month: mo, day, weekday: wday });
  return { date, time: `${h}:${m}` };
}

function buildDetailHtml(s) {
  let html = '';
  if (s.windows && s.windows.length > 0) {
    html += `<span class="dl">${escapeHtml(t('detail_windows'))}</span><ul>`;
    s.windows.slice(0, 6).forEach((w) => {
      html += `<li>• ${escapeHtml(w.title)}</li>`;
    });
    html += '</ul>';
  }
  if (s.recentFiles && s.recentFiles.length > 0) {
    html += `<span class="dl">${escapeHtml(t('detail_recent_files'))}</span>`;
    html += `<span style="padding-left:8px;color:#5566aa">${escapeHtml(
      s.recentFiles.join('　')
    )}</span>`;
  }
  if (s.clipboard && s.clipboard.trim()) {
    html += `<span class="dl">${escapeHtml(t('detail_clipboard'))}</span>`;
    html += `<span style="padding-left:8px;color:#5566aa">${escapeHtml(
      s.clipboard.trim().substring(0, 120)
    )}${s.clipboard.length > 120 ? '…' : ''}</span>`;
  }
  return html || `<span>${escapeHtml(t('detail_none'))}</span>`;
}

async function handleRestore(id, btn) {
  btn.disabled = true;
  btn.textContent = t('restoring');

  const result = await window.electronAPI.restoreSession(id);

  if (!result || !result.success) {
    btn.textContent = t('restore_fail');
    setTimeout(() => { btn.disabled = false; btn.textContent = t('restore_btn'); }, 2000);
    return;
  }

  // Show restore result below the card
  const card = btn.closest('.session-card');
  const existing = card.querySelector('.restore-result');
  if (existing) existing.remove();

  const lines = [];
  if (result.clipboardRestored) {
    lines.push(t('restore_clipboard'));
  }
  if (result.launched && result.launched.length > 0) {
    const apps = result.launched.map(l => {
      const name = l.split(' ')[0];
      const action = l.includes('focused') ? t('restore_focus') : t('restore_launch');
      return `${name} ${action}`;
    });
    lines.push(apps.join(', '));
  }
  if (lines.length === 0) {
    lines.push(t('restore_confirmed'));
  }

  const resultEl = document.createElement('div');
  resultEl.className = 'restore-result';
  resultEl.innerHTML = lines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  btn.after(resultEl);

  btn.textContent = t('restore_done');
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = t('restore_btn');
  }, 4000);
}

async function init() {
  // Load translations
  i18n = await window.electronAPI.getTranslations() || {};
  applyTranslations();

  const sessions = await window.electronAPI.loadSessions();

  if (!sessions || sessions.length === 0) {
    countEl.textContent = t('session_count', { n: 0 });
    listEl.innerHTML = `
      <div class="empty">
        <div class="icon">📸</div>
        <p>${escapeHtml(t('empty_title'))}</p>
        <small>${escapeHtml(t('empty_hint', { key: 'Ctrl+Shift+S' }))}</small>
      </div>
    `;
    return;
  }

  countEl.textContent = t('session_count', { n: sessions.length });

  listEl.innerHTML = sessions
    .map((s) => {
      const { date, time } = formatDate(s.capturedAt);
      const metaTags = [
        s.windows && s.windows.length > 0
          ? `<span class="meta-tag">🪟 ${s.windows.length} ウィンドウ</span>`
          : '',
        s.recentFiles && s.recentFiles.length > 0
          ? `<span class="meta-tag">📁 ${s.recentFiles.length} ファイル</span>`
          : '',
        s.clipboard && s.clipboard.trim()
          ? `<span class="meta-tag">📋 ${escapeHtml(t('tag_clipboard'))}</span>`
          : '',
      ]
        .filter(Boolean)
        .join('');

      return `
      <div class="session-card">
        <div class="session-date">
          <span>${time}</span>
          <span class="day-badge">${date}</span>
        </div>
        <div class="session-summary">${escapeHtml(s.aiSummary)}</div>
        ${s.userNote ? `<div class="session-note">${escapeHtml(s.userNote)}</div>` : ''}
        <div class="session-meta">${metaTags}</div>
        <div class="detail-section">${buildDetailHtml(s)}</div>
        <button class="restore-btn" data-id="${s.id}">${escapeHtml(t('restore_btn'))}</button>
      </div>
    `;
    })
    .join('');

  // Attach restore button listeners
  listEl.querySelectorAll('.restore-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleRestore(btn.dataset.id, btn);
    });
  });
}

init();
