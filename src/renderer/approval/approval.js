/* global require */
const { ipcRenderer } = require('electron');

const summaryEl = document.getElementById('summary');
const detailEl = document.getElementById('context-detail');
const noteEl = document.getElementById('note');
const btnApprove = document.getElementById('btn-approve');
const btnSkip = document.getElementById('btn-skip');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function init() {
  const data = await ipcRenderer.invoke('get-pending-session');

  if (!data) {
    summaryEl.textContent = 'セッションデータが見つかりません。';
    summaryEl.classList.remove('loading');
    return;
  }

  // Show AI summary
  summaryEl.textContent = data.aiSummary;
  summaryEl.classList.remove('loading');

  // Build context detail HTML
  let html = '';

  if (data.windows && data.windows.length > 0) {
    html += '<span class="section-label">開いているウィンドウ</span>';
    html += '<ul>';
    data.windows.slice(0, 6).forEach((w) => {
      html += `<li>• ${escapeHtml(w.title)}</li>`;
    });
    html += '</ul>';
  }

  if (data.recentFiles && data.recentFiles.length > 0) {
    html += '<span class="section-label">最近のファイル</span>';
    html += `<span style="padding-left:8px;color:#5566aa">${escapeHtml(
      data.recentFiles.slice(0, 5).join('　')
    )}</span>`;
  }

  if (data.clipboard && data.clipboard.trim()) {
    html += '<span class="section-label">クリップボード（先頭）</span>';
    html += `<span style="padding-left:8px;color:#5566aa">${escapeHtml(
      data.clipboard.trim().substring(0, 80)
    )}${data.clipboard.length > 80 ? '…' : ''}</span>`;
  }

  detailEl.innerHTML = html || '<span>コンテキスト情報なし</span>';
}

btnApprove.addEventListener('click', async () => {
  btnApprove.disabled = true;
  btnSkip.disabled = true;
  btnApprove.textContent = '保存中…';

  const userNote = noteEl.value.trim();
  await ipcRenderer.invoke('approve-session', userNote);
});

btnSkip.addEventListener('click', async () => {
  btnApprove.disabled = true;
  btnSkip.disabled = true;
  await ipcRenderer.invoke('skip-session');
});

init();
