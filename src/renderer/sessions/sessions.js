/* global require */
const { ipcRenderer } = require('electron');

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const btnSettings = document.getElementById('btn-settings');
if (btnSettings) {
  btnSettings.addEventListener('click', () => ipcRenderer.invoke('open-settings'));
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
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const wday = weekdays[d.getDay()];
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return { date: `${mo}月${day}日（${wday}）`, time: `${h}:${m}` };
}

function buildDetailHtml(s) {
  let html = '';
  if (s.windows && s.windows.length > 0) {
    html += '<span class="dl">開いていたウィンドウ</span><ul>';
    s.windows.slice(0, 6).forEach((w) => {
      html += `<li>• ${escapeHtml(w.title)}</li>`;
    });
    html += '</ul>';
  }
  if (s.recentFiles && s.recentFiles.length > 0) {
    html += '<span class="dl">最近のファイル</span>';
    html += `<span style="padding-left:8px;color:#5566aa">${escapeHtml(
      s.recentFiles.join('　')
    )}</span>`;
  }
  if (s.clipboard && s.clipboard.trim()) {
    html += '<span class="dl">クリップボード</span>';
    html += `<span style="padding-left:8px;color:#5566aa">${escapeHtml(
      s.clipboard.trim().substring(0, 120)
    )}${s.clipboard.length > 120 ? '…' : ''}</span>`;
  }
  return html || '<span>詳細なし</span>';
}

async function handleRestore(id, btn) {
  btn.disabled = true;
  btn.textContent = '復元中…';

  const result = await ipcRenderer.invoke('restore-session', id);

  if (!result || !result.success) {
    btn.textContent = '❌ 失敗';
    setTimeout(() => { btn.disabled = false; btn.textContent = '🔄 復元する'; }, 2000);
    return;
  }

  // 復元結果をカードの下に表示
  const card = btn.closest('.session-card');
  const existing = card.querySelector('.restore-result');
  if (existing) existing.remove();

  const lines = [];
  if (result.clipboardRestored) {
    lines.push('📋 クリップボードを復元しました');
  }
  if (result.launched && result.launched.length > 0) {
    const apps = result.launched.map(l => {
      const name = l.split(' ')[0];
      const action = l.includes('focused') ? 'フォーカス' : '起動';
      return `${name} を${action}`;
    });
    lines.push('🪟 ' + apps.join('、'));
  }
  if (lines.length === 0) {
    lines.push('ℹ️ コンテキストを確認しました（アプリは既に閉じられています）');
  }

  const resultEl = document.createElement('div');
  resultEl.className = 'restore-result';
  resultEl.innerHTML = lines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  btn.after(resultEl);

  btn.textContent = '✅ 復元完了';
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '🔄 復元する';
  }, 4000);
}

async function init() {
  const sessions = await ipcRenderer.invoke('load-sessions');

  if (!sessions || sessions.length === 0) {
    countEl.textContent = '0 セッション';
    listEl.innerHTML = `
      <div class="empty">
        <div class="icon">📸</div>
        <p>まだセッションがありません</p>
        <small>Ctrl+Shift+S でセッションを保存できます</small>
      </div>
    `;
    return;
  }

  countEl.textContent = `${sessions.length} セッション`;

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
          ? `<span class="meta-tag">📋 クリップボードあり</span>`
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
        <button class="restore-btn" data-id="${s.id}">🔄 復元する</button>
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
