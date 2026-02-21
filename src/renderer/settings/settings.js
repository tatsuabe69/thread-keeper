const apiKeyInput = document.getElementById('api-key');
const btnSaveKey = document.getElementById('btn-save-key');
const keyStatus = document.getElementById('key-status');
const toggleAutostart = document.getElementById('toggle-autostart');
const browserSelect = document.getElementById('browser-select');
const btnOpenFolder = document.getElementById('btn-open-folder');

async function init() {
  const config = await window.electronAPI.getConfig();
  if (config.googleApiKey) {
    apiKeyInput.value = config.googleApiKey;
  }
  toggleAutostart.checked = !!config.openAtLogin;
  if (config.defaultBrowser) {
    browserSelect.value = config.defaultBrowser;
  }
}

btnSaveKey.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { showKeyStatus('error', 'キーを入力してください'); return; }
  if (!key.startsWith('AIza')) {
    showKeyStatus('error', '"AIza" で始まるキーを入力してください');
    return;
  }

  btnSaveKey.disabled = true;
  showKeyStatus('', '接続テスト中…');

  const result = await window.electronAPI.testApiKey(key);
  if (result.ok) {
    await window.electronAPI.saveConfig({ googleApiKey: key });
    showKeyStatus('', '✅ 保存しました');
  } else {
    showKeyStatus('error', '❌ ' + (result.error || '接続に失敗しました'));
  }
  btnSaveKey.disabled = false;
});

toggleAutostart.addEventListener('change', async () => {
  await window.electronAPI.saveConfig({ openAtLogin: toggleAutostart.checked });
});

browserSelect.addEventListener('change', async () => {
  await window.electronAPI.saveConfig({ defaultBrowser: browserSelect.value });
});

btnOpenFolder.addEventListener('click', () => {
  window.electronAPI.openDataFolder();
});

function showKeyStatus(type, msg) {
  keyStatus.textContent = msg;
  keyStatus.className = 'status-inline' + (type ? ' ' + type : '');
}

init();
