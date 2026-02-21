const apiKeyInput = document.getElementById('api-key');
const btnSaveKey = document.getElementById('btn-save-key');
const keyStatus = document.getElementById('key-status');
const toggleAutostart = document.getElementById('toggle-autostart');
const browserSelect = document.getElementById('browser-select');
const btnOpenFolder = document.getElementById('btn-open-folder');

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
}

async function init() {
  // Load translations
  i18n = await window.electronAPI.getTranslations() || {};
  applyTranslations();
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
  if (!key) { showKeyStatus('error', t('err_api_key_empty')); return; }
  if (!key.startsWith('AIza')) {
    showKeyStatus('error', t('settings_err_key_aiza'));
    return;
  }

  btnSaveKey.disabled = true;
  showKeyStatus('', t('settings_testing'));

  const result = await window.electronAPI.testApiKey(key);
  if (result.ok) {
    await window.electronAPI.saveConfig({ googleApiKey: key });
    showKeyStatus('', t('settings_saved', { model: '' }));
  } else {
    showKeyStatus('error', (result.error || t('settings_err_connect')));
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
