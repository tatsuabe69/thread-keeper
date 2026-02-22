// ─── State ────────────────────────────────────────────────────────────────────
const TOTAL_STEPS = 4;
let currentStep = 0;
let i18n = {};
let currentProvider = 'gemini';

// ─── i18n ─────────────────────────────────────────────────────────────────────
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

// ─── Wizard Navigation ───────────────────────────────────────────────────────
function goToStep(n) {
  if (n < 0 || n >= TOTAL_STEPS) return;
  currentStep = n;

  // Slide track
  const track = document.getElementById('wizard-track');
  track.style.transform = 'translateX(-' + (n * 25) + '%)';

  // Update progress dots
  document.querySelectorAll('.progress-dot').forEach(dot => {
    const idx = parseInt(dot.dataset.dot, 10);
    dot.classList.remove('active', 'done');
    if (idx < n) dot.classList.add('done');
    else if (idx === n) dot.classList.add('active');
  });

  // Progress label
  document.getElementById('progress-label').textContent = (n + 1) + ' / ' + TOTAL_STEPS;

  // Footer buttons
  const btnBack = document.getElementById('btn-back');
  const btnNext = document.getElementById('btn-next');
  const btnSkip = document.getElementById('btn-skip');

  // Back button visibility
  btnBack.style.display = n === 0 ? 'none' : '';

  // Skip button visibility (hidden on last step)
  btnSkip.style.display = n === TOTAL_STEPS - 1 ? 'none' : '';

  // Next button text
  if (n === 0) {
    btnNext.textContent = t('wizard_start');
  } else if (n === TOTAL_STEPS - 1) {
    btnNext.textContent = t('wizard_finish');
  } else {
    btnNext.textContent = t('wizard_next');
  }

  // Update tutorial capture title with current shortcut key
  if (n === TOTAL_STEPS - 1) {
    updateTutorialCaptureTitle();
  }
}

async function updateTutorialCaptureTitle() {
  try {
    const cfg = await window.electronAPI.getConfig();
    const key = cfg.captureShortcut || 'Ctrl+Shift+S';
    const el = document.getElementById('tutorial-capture-title');
    if (el) el.textContent = t('wizard_tutorial_capture_title', { key });
  } catch { /* ignore */ }
}

// ─── Provider Picker ──────────────────────────────────────────────────────────
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
};

document.addEventListener('click', e => {
  const a = e.target.closest('a[id^="link-"]');
  if (a && LINK_URLS[a.id]) {
    e.preventDefault();
    window.electronAPI.openUrl(LINK_URLS[a.id]);
  }
});

// ─── AI Test Helper ──────────────────────────────────────────────────────────
async function testAndSaveAi(provider, cfg, statusEl, btn) {
  btn.disabled = true;
  statusEl.textContent = t('settings_testing');
  statusEl.className = 'setting-status';

  const result = await window.electronAPI.testAiConfig(cfg);

  if (result.ok) {
    const saveCfg = { ...cfg, defaultBrowser: document.getElementById('setup-browser').value };
    // Map fields for config store
    if (provider === 'gemini') {
      saveCfg.googleApiKey = cfg.googleApiKey;
      saveCfg.geminiModel = cfg.model;
    }
    saveCfg.aiModel = cfg.model;
    saveCfg.aiProvider = provider;
    delete saveCfg.provider; // not a config field
    await window.electronAPI.saveConfig(saveCfg);
    statusEl.textContent = t('settings_saved', { model: cfg.model });
    statusEl.className = 'setting-status';
    btn.disabled = false;
    // Auto-advance to next step
    setTimeout(() => goToStep(currentStep + 1), 800);
  } else {
    statusEl.textContent = '\u274c ' + (result.error || t('setup_fail'));
    statusEl.className = 'setting-status error';
    btn.disabled = false;
  }
}

// ─── Gemini Test & Save ───────────────────────────────────────────────────────
document.getElementById('btn-test-gemini').addEventListener('click', async () => {
  const key = document.getElementById('setup-gemini-key').value.trim();
  const model = document.getElementById('setup-gemini-model').value;
  const statusEl = document.getElementById('status-gemini');
  const btn = document.getElementById('btn-test-gemini');

  if (!key) { statusEl.textContent = t('setup_err_empty'); statusEl.className = 'setting-status error'; return; }
  if (!key.startsWith('AIza')) { statusEl.textContent = t('settings_err_key_aiza'); statusEl.className = 'setting-status error'; return; }

  await testAndSaveAi('gemini', { provider: 'gemini', googleApiKey: key, model }, statusEl, btn);
});

// ─── OpenAI Test & Save ───────────────────────────────────────────────────────
document.getElementById('btn-test-openai').addEventListener('click', async () => {
  const key = document.getElementById('setup-openai-key').value.trim();
  const model = document.getElementById('setup-openai-model').value;
  const statusEl = document.getElementById('status-openai');
  const btn = document.getElementById('btn-test-openai');

  if (!key) { statusEl.textContent = t('setup_err_empty'); statusEl.className = 'setting-status error'; return; }
  if (!key.startsWith('sk-')) { statusEl.textContent = t('settings_err_key_sk'); statusEl.className = 'setting-status error'; return; }

  await testAndSaveAi('openai', { provider: 'openai', openaiApiKey: key, model }, statusEl, btn);
});

// ─── Anthropic Test & Save ────────────────────────────────────────────────────
document.getElementById('btn-test-anthropic').addEventListener('click', async () => {
  const key = document.getElementById('setup-anthropic-key').value.trim();
  const model = document.getElementById('setup-anthropic-model').value;
  const statusEl = document.getElementById('status-anthropic');
  const btn = document.getElementById('btn-test-anthropic');

  if (!key) { statusEl.textContent = t('setup_err_empty'); statusEl.className = 'setting-status error'; return; }
  if (!key.startsWith('sk-ant-')) { statusEl.textContent = t('settings_err_key_skant'); statusEl.className = 'setting-status error'; return; }

  await testAndSaveAi('anthropic', { provider: 'anthropic', anthropicApiKey: key, model }, statusEl, btn);
});

// ─── Ollama Test & Save ───────────────────────────────────────────────────────
document.getElementById('btn-test-ollama').addEventListener('click', async () => {
  const url = document.getElementById('setup-ollama-url').value.trim() || 'http://localhost:11434';
  const model = document.getElementById('setup-ollama-model').value.trim() || 'llama3.2';
  const statusEl = document.getElementById('status-ollama');
  const btn = document.getElementById('btn-test-ollama');

  await testAndSaveAi('ollama', { provider: 'ollama', ollamaBaseUrl: url, model }, statusEl, btn);
});

// ─── Language Picker ──────────────────────────────────────────────────────────
const langSelect = document.getElementById('setup-lang');
langSelect.addEventListener('change', async (e) => {
  await window.electronAPI.saveConfig({ language: e.target.value });
  i18n = (await window.electronAPI.getTranslations()) || {};
  applyTranslations();
  document.title = t('setup_title');
  // Re-apply step-dependent text
  goToStep(currentStep);
});

// ─── Footer Buttons ──────────────────────────────────────────────────────────
document.getElementById('btn-next').addEventListener('click', async () => {
  if (currentStep === TOTAL_STEPS - 1) {
    // Final step: save browser + close
    await window.electronAPI.saveConfig({ defaultBrowser: document.getElementById('setup-browser').value });
    await window.electronAPI.closeSetup();
  } else {
    goToStep(currentStep + 1);
  }
});

document.getElementById('btn-back').addEventListener('click', () => {
  goToStep(currentStep - 1);
});

document.getElementById('btn-skip').addEventListener('click', async () => {
  await window.electronAPI.saveConfig({ defaultBrowser: document.getElementById('setup-browser').value });
  await window.electronAPI.closeSetup();
});

// ─── Initialization ──────────────────────────────────────────────────────────
(async () => {
  const cfg = await window.electronAPI.getConfig();

  // Language
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

  // Start at step 0
  goToStep(0);
})();
