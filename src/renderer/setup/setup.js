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
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.dataset.i18nHtml;
    const val = i18n[key];
    if (val && typeof val === 'string') el.innerHTML = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    const val = i18n[key];
    if (val && typeof val === 'string') el.placeholder = val;
  });
  document.querySelectorAll('[data-i18n-label]').forEach(el => {
    const key = el.dataset.i18nLabel;
    const val = i18n[key];
    if (val && typeof val === 'string') el.label = val;
  });
}

// ─── Provider Picker ──────────────────────────────────────────────────────────
let currentProvider = 'gemini';

function showProvider(p) {
  document.querySelectorAll('.provider-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.provider === p));
  document.querySelectorAll('.provider-section').forEach(sec =>
    sec.style.display = sec.id === 'section-' + p ? '' : 'none');
}

document.querySelectorAll('.provider-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentProvider = btn.dataset.provider;
    showProvider(currentProvider);
  });
});

// ─── External Link Handler (event delegation) ────────────────────────────────
const LINK_URLS = {
  'link-gemini': 'https://aistudio.google.com/apikey',
  'link-openai': 'https://platform.openai.com/api-keys',
  'link-anthropic': 'https://console.anthropic.com/',
  'link-ollama': 'https://ollama.com',
  'link-help': 'https://www.thethread-keeper.com/ai-setup.html',
};

document.addEventListener('click', e => {
  const a = e.target.closest('a[id^="link-"]');
  if (a && LINK_URLS[a.id]) {
    e.preventDefault();
    window.electronAPI.openUrl(LINK_URLS[a.id]);
  }
});

// ─── Gemini Test & Save ───────────────────────────────────────────────────────
document.getElementById('btn-test-gemini').addEventListener('click', async () => {
  const key = document.getElementById('setup-gemini-key').value.trim();
  const model = document.getElementById('setup-gemini-model').value;
  const statusEl = document.getElementById('status-gemini');
  const btn = document.getElementById('btn-test-gemini');

  if (!key) { statusEl.textContent = t('setup_err_empty'); statusEl.className = 'setting-status error'; return; }
  if (!key.startsWith('AIza')) { statusEl.textContent = t('settings_err_key_aiza'); statusEl.className = 'setting-status error'; return; }

  btn.disabled = true;
  statusEl.textContent = t('settings_testing');
  statusEl.className = 'setting-status';

  const result = await window.electronAPI.testAiConfig({ provider: 'gemini', googleApiKey: key, model });

  if (result.ok) {
    statusEl.textContent = t('settings_saved', { model });
    statusEl.className = 'setting-status';
    await window.electronAPI.saveConfig({
      googleApiKey: key,
      aiModel: model,
      geminiModel: model,
      aiProvider: 'gemini',
      defaultBrowser: document.getElementById('setup-browser').value,
    });
    setTimeout(() => window.electronAPI.closeSetup(), 800);
  } else {
    statusEl.textContent = '❌ ' + (result.error || t('setup_fail'));
    statusEl.className = 'setting-status error';
    btn.disabled = false;
  }
});

// ─── OpenAI Test & Save ───────────────────────────────────────────────────────
document.getElementById('btn-test-openai').addEventListener('click', async () => {
  const key = document.getElementById('setup-openai-key').value.trim();
  const model = document.getElementById('setup-openai-model').value;
  const statusEl = document.getElementById('status-openai');
  const btn = document.getElementById('btn-test-openai');

  if (!key) { statusEl.textContent = t('setup_err_empty'); statusEl.className = 'setting-status error'; return; }
  if (!key.startsWith('sk-')) { statusEl.textContent = t('settings_err_key_sk'); statusEl.className = 'setting-status error'; return; }

  btn.disabled = true;
  statusEl.textContent = t('settings_testing');
  statusEl.className = 'setting-status';

  const result = await window.electronAPI.testAiConfig({ provider: 'openai', openaiApiKey: key, model });

  if (result.ok) {
    statusEl.textContent = t('settings_saved', { model });
    statusEl.className = 'setting-status';
    await window.electronAPI.saveConfig({
      openaiApiKey: key,
      aiModel: model,
      aiProvider: 'openai',
      defaultBrowser: document.getElementById('setup-browser').value,
    });
    setTimeout(() => window.electronAPI.closeSetup(), 800);
  } else {
    statusEl.textContent = '❌ ' + (result.error || t('setup_fail'));
    statusEl.className = 'setting-status error';
    btn.disabled = false;
  }
});

// ─── Anthropic Test & Save ────────────────────────────────────────────────────
document.getElementById('btn-test-anthropic').addEventListener('click', async () => {
  const key = document.getElementById('setup-anthropic-key').value.trim();
  const model = document.getElementById('setup-anthropic-model').value;
  const statusEl = document.getElementById('status-anthropic');
  const btn = document.getElementById('btn-test-anthropic');

  if (!key) { statusEl.textContent = t('setup_err_empty'); statusEl.className = 'setting-status error'; return; }
  if (!key.startsWith('sk-ant-')) { statusEl.textContent = t('settings_err_key_skant'); statusEl.className = 'setting-status error'; return; }

  btn.disabled = true;
  statusEl.textContent = t('settings_testing');
  statusEl.className = 'setting-status';

  const result = await window.electronAPI.testAiConfig({ provider: 'anthropic', anthropicApiKey: key, model });

  if (result.ok) {
    statusEl.textContent = t('settings_saved', { model });
    statusEl.className = 'setting-status';
    await window.electronAPI.saveConfig({
      anthropicApiKey: key,
      aiModel: model,
      aiProvider: 'anthropic',
      defaultBrowser: document.getElementById('setup-browser').value,
    });
    setTimeout(() => window.electronAPI.closeSetup(), 800);
  } else {
    statusEl.textContent = '❌ ' + (result.error || t('setup_fail'));
    statusEl.className = 'setting-status error';
    btn.disabled = false;
  }
});

// ─── Ollama Test & Save ───────────────────────────────────────────────────────
document.getElementById('btn-test-ollama').addEventListener('click', async () => {
  const url = document.getElementById('setup-ollama-url').value.trim() || 'http://localhost:11434';
  const model = document.getElementById('setup-ollama-model').value.trim() || 'llama3.2';
  const statusEl = document.getElementById('status-ollama');
  const btn = document.getElementById('btn-test-ollama');

  btn.disabled = true;
  statusEl.textContent = t('settings_testing');
  statusEl.className = 'setting-status';

  const result = await window.electronAPI.testAiConfig({ provider: 'ollama', ollamaBaseUrl: url, model });

  if (result.ok) {
    statusEl.textContent = t('settings_saved', { model });
    statusEl.className = 'setting-status';
    await window.electronAPI.saveConfig({
      ollamaBaseUrl: url,
      aiModel: model,
      aiProvider: 'ollama',
      defaultBrowser: document.getElementById('setup-browser').value,
    });
    setTimeout(() => window.electronAPI.closeSetup(), 800);
  } else {
    statusEl.textContent = '❌ ' + (result.error || t('setup_fail'));
    statusEl.className = 'setting-status error';
    btn.disabled = false;
  }
});

// ─── Language Picker ──────────────────────────────────────────────────────────
const langSelect = document.getElementById('setup-lang');
langSelect.addEventListener('change', async (e) => {
  await window.electronAPI.saveConfig({ language: e.target.value });
  i18n = (await window.electronAPI.getTranslations()) || {};
  applyTranslations();
  document.title = t('setup_title');
});

// ─── Skip Button ──────────────────────────────────────────────────────────────
document.getElementById('btn-skip').addEventListener('click', async () => {
  await window.electronAPI.saveConfig({ defaultBrowser: document.getElementById('setup-browser').value });
  await window.electronAPI.closeSetup();
});

// ─── Initialization ──────────────────────────────────────────────────────────
(async () => {
  const cfg = await window.electronAPI.getConfig();

  // Language
  const langSelect = document.getElementById('setup-lang');
  if (langSelect) langSelect.value = cfg.language || 'ja';

  // Load translations
  i18n = (await window.electronAPI.getTranslations()) || {};
  applyTranslations();
  document.title = t('setup_title');

  // Browser default
  const browserEl = document.getElementById('setup-browser');
  if (browserEl && cfg.defaultBrowser) browserEl.value = cfg.defaultBrowser;

  // Pre-fill existing keys if any
  if (cfg.aiProvider) {
    currentProvider = cfg.aiProvider;
    showProvider(currentProvider);
  }
  if (cfg.googleApiKey) document.getElementById('setup-gemini-key').value = cfg.googleApiKey;
  if (cfg.openaiApiKey) document.getElementById('setup-openai-key').value = cfg.openaiApiKey;
  if (cfg.anthropicApiKey) document.getElementById('setup-anthropic-key').value = cfg.anthropicApiKey;
  if (cfg.ollamaBaseUrl) document.getElementById('setup-ollama-url').value = cfg.ollamaBaseUrl;
})();
