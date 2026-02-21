/* global require */
const { ipcRenderer, shell } = require('electron');

const inputEl = document.getElementById('api-key');
const browserSelect = document.getElementById('browser-select');
const btnSave = document.getElementById('btn-save');
const btnSkip = document.getElementById('btn-skip');
const statusEl = document.getElementById('status');
const linkAistudio = document.getElementById('link-aistudio');

linkAistudio.addEventListener('click', (e) => {
  e.preventDefault();
  shell.openExternal('https://aistudio.google.com/apikey');
});

function setStatus(type, msg) {
  statusEl.className = 'status ' + type;
  statusEl.textContent = msg;
}

btnSave.addEventListener('click', async () => {
  const key = inputEl.value.trim();
  if (!key) {
    setStatus('error', 'APIキーを入力してください');
    return;
  }
  if (!key.startsWith('AIza')) {
    setStatus('error', 'Google APIキーは "AIza" で始まります。確認してください。');
    return;
  }

  btnSave.disabled = true;
  setStatus('loading', '接続テスト中…');

  const result = await ipcRenderer.invoke('test-api-key', key);

  if (result.ok) {
    setStatus('success', '✅ 接続成功！設定を保存しました。');
    await ipcRenderer.invoke('save-config', {
      googleApiKey: key,
      defaultBrowser: browserSelect.value,
    });
    setTimeout(() => ipcRenderer.invoke('close-setup'), 800);
  } else {
    setStatus('error', '❌ ' + (result.error || '接続に失敗しました。キーを確認してください。'));
    btnSave.disabled = false;
  }
});

btnSkip.addEventListener('click', async () => {
  // ブラウザ選択だけは保存してからスキップ
  await ipcRenderer.invoke('save-config', { defaultBrowser: browserSelect.value });
  await ipcRenderer.invoke('close-setup');
});

// Focus input on load
inputEl.focus();
