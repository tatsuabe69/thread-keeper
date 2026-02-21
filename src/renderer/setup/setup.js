const inputEl = document.getElementById('api-key');
const browserSelect = document.getElementById('browser-select');
const btnSave = document.getElementById('btn-save');
const btnSkip = document.getElementById('btn-skip');
const statusEl = document.getElementById('status');
const linkAistudio = document.getElementById('link-aistudio');

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

// ─── Hint text (contains a link, so handled in JS) ───────────────────────────
function applyHintText() {
  const hintEl = document.querySelector('.hint-text');
  if (!hintEl) return;
  const raw = t('setup_api_hint');
  // Replace the URL text with the clickable link
  const linkText = 'aistudio.google.com/apikey';
  const idx = raw.indexOf(linkText);
  if (idx >= 0) {
    const before = raw.substring(0, idx);
    const after = raw.substring(idx + linkText.length);
    hintEl.innerHTML = before +
      '<a href="#" id="link-aistudio">' + linkText + '</a>' +
      after;
  } else {
    hintEl.textContent = raw;
  }
  // Re-bind the link click handler
  const newLink = document.getElementById('link-aistudio');
  if (newLink) {
    newLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.electronAPI.openExternal('https://aistudio.google.com/apikey');
    });
  }
}

linkAistudio.addEventListener('click', (e) => {
  e.preventDefault();
  window.electronAPI.openExternal('https://aistudio.google.com/apikey');
});

function setStatus(type, msg) {
  statusEl.className = 'status ' + type;
  statusEl.textContent = msg;
}

btnSave.addEventListener('click', async () => {
  const key = inputEl.value.trim();
  if (!key) {
    setStatus('error', t('setup_err_empty'));
    return;
  }
  if (!key.startsWith('AIza')) {
    setStatus('error', t('setup_err_format'));
    return;
  }

  btnSave.disabled = true;
  setStatus('loading', t('setup_testing'));

  const result = await window.electronAPI.testApiKey(key);

  if (result.ok) {
    setStatus('success', t('setup_success'));
    await window.electronAPI.saveConfig({
      googleApiKey: key,
      defaultBrowser: browserSelect.value,
    });
    setTimeout(() => window.electronAPI.closeSetup(), 800);
  } else {
    setStatus('error', '❌ ' + (result.error || t('setup_fail')));
    btnSave.disabled = false;
  }
});

btnSkip.addEventListener('click', async () => {
  // ブラウザ選択だけは保存してからスキップ
  await window.electronAPI.saveConfig({ defaultBrowser: browserSelect.value });
  await window.electronAPI.closeSetup();
});

// ─── Init: load translations then focus ───────────────────────────────────────
(async () => {
  i18n = (await window.electronAPI.getTranslations()) || {};
  applyTranslations();
  applyHintText();
  document.title = t('setup_title');
  inputEl.focus();
})();
