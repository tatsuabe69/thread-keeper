/* global window */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let sessions = [];
let config = {};
let pendingSession = null;
let isCollecting = false; // true while context is being collected (before pendingSession is set)
let currentLayout = localStorage.getItem('ck-layout') || 'cards';

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;'); // MEDIUM-05: escape single quotes
}

function formatDate(iso) {
  const d = new Date(iso);
  const w = ['日','月','火','水','木','金','土'][d.getDay()];
  const h = String(d.getHours()).padStart(2,'0');
  const m = String(d.getMinutes()).padStart(2,'0');
  return {
    time: h + ':' + m,
    date: (d.getMonth()+1) + '月' + d.getDate() + '日（' + w + '）',
  };
}

/** Builds the tag chips HTML shared across all 3 layouts.
 *  History count is intentionally omitted — all sessions have it and it adds noise. */
function makeTags(s) {
  const tabCount = (s.browserTabs && s.browserTabs.length) || (s.browserUrls && s.browserUrls.length) || 0;
  return [
    s.windows     && s.windows.length > 0     ? '<span class="tag">🪟 ' + s.windows.length + '</span>'     : '',
    tabCount > 0                               ? '<span class="tag">🌐 ' + tabCount + '</span>'              : '',
    s.recentFiles && s.recentFiles.length > 0  ? '<span class="tag">📁 ' + s.recentFiles.length + '</span>' : '',
    s.clipboard   && s.clipboard.trim()        ? '<span class="tag">📋</span>'                               : '',
  ].filter(Boolean).join('');
}

/**
 * Renders aiSummary as structured HTML if it has the new labelled format
 * (作業内容：/ 参照中：/ 残タスク：), otherwise falls back to plain text.
 * - 参照中 values are split by " / " and rendered as individual lines
 * - Plain text gets <br> after 。 for natural Japanese line breaks
 */
function formatSummary(text) {
  if (!text) return '';
  const isStructured = /^作業内容[：:]/.test(text.trim()) || text.includes('\n作業内容');
  if (!isStructured) {
    // Plain text: insert <br> after 。 for readability
    const withBreaks = esc(text).replace(/。(?!<br>)/g, '。<br>');
    return '<span class="summary-plain">' + withBreaks + '</span>';
  }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let html = '<dl class="summary-struct">';
  for (const line of lines) {
    // Match "ラベル：value" where label is 2-6 chars before the colon
    const m = line.match(/^(.{2,6})[：:]\s*(.*)/);
    if (m) {
      const label = m[1];
      const value = m[2];
      if (label === '参照中') {
        // Split by " / " and show each item on its own line
        const refs = value.split(/\s*\/\s*/).filter(Boolean);
        const refsHtml = refs.map(r => '<span class="ss-ref-item">' + esc(r) + '</span>').join('');
        html += '<div class="ss-row"><dt class="ss-label">' + esc(label) + '</dt>'
              + '<dd class="ss-value ss-refs">' + refsHtml + '</dd></div>';
      } else {
        html += '<div class="ss-row"><dt class="ss-label">' + esc(label) + '</dt>'
              + '<dd class="ss-value">' + esc(value) + '</dd></div>';
      }
    } else {
      html += '<div class="ss-row"><dd class="ss-value ss-plain">' + esc(line) + '</dd></div>';
    }
  }
  html += '</dl>';
  return html;
}

/**
 * Returns just the 作業内容 line value for compact (list) display.
 * Falls back to plain text for old-format summaries.
 */
function getSummaryPreview(text) {
  if (!text) return '';
  const m = text.match(/作業内容[：:]\s*(.+)/);
  return m ? m[1].trim() : text;
}

/** Returns today / 昨日 / 〇曜日 / M月D日 label for timeline grouping */
function dayGroupLabel(iso) {
  const d    = new Date(iso);
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now  = new Date();
  const tDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((tDay - dDay) / 86400000);
  if (diff === 0) return '今日';
  if (diff === 1) return '昨日';
  const wdays = ['日','月','火','水','木','金','土'];
  if (diff < 7) return wdays[d.getDay()] + '曜日';
  return (d.getMonth()+1) + '月' + d.getDate() + '日';
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(el =>
    el.classList.toggle('active', el.id === 'panel-' + name));
  if (name === 'capture') clearBadge('capture');
}

function setBadge(tab) {
  const item = document.querySelector('[data-tab="' + tab + '"]');
  if (!item || item.querySelector('.nav-badge')) return;
  const dot = document.createElement('span');
  dot.className = 'nav-badge';
  item.appendChild(dot);
}

function clearBadge(tab) {
  const dot = document.querySelector('[data-tab="' + tab + '"] .nav-badge');
  if (dot) dot.remove();
}

// ─── History Grouping ─────────────────────────────────────────────────────────

const DOMAIN_INFO = {
  'youtube.com':            { label: 'YouTube',        icon: '📺' },
  'google.com':             { label: 'Google 検索',     icon: '🔍' },
  'google.co.jp':           { label: 'Google 検索',     icon: '🔍' },
  'github.com':             { label: 'GitHub',          icon: '💻' },
  'stackoverflow.com':      { label: 'Stack Overflow',  icon: '💬' },
  'twitter.com':            { label: 'X (Twitter)',     icon: '🐦' },
  'x.com':                  { label: 'X (Twitter)',     icon: '🐦' },
  'amazon.co.jp':           { label: 'Amazon',          icon: '🛒' },
  'amazon.com':             { label: 'Amazon',          icon: '🛒' },
  'wikipedia.org':          { label: 'Wikipedia',       icon: '📖' },
  'zenn.dev':               { label: 'Zenn',            icon: '📝' },
  'qiita.com':              { label: 'Qiita',           icon: '📝' },
  'notion.so':              { label: 'Notion',          icon: '📋' },
  'figma.com':              { label: 'Figma',           icon: '🎨' },
  'chatgpt.com':            { label: 'ChatGPT',         icon: '🤖' },
  'claude.ai':              { label: 'Claude',          icon: '🤖' },
  'gemini.google.com':      { label: 'Gemini',          icon: '🤖' },
  'openai.com':             { label: 'OpenAI',          icon: '🤖' },
  'bing.com':               { label: 'Bing',            icon: '🔍' },
  'duckduckgo.com':         { label: 'DuckDuckGo',      icon: '🔍' },
  'reddit.com':             { label: 'Reddit',          icon: '💬' },
  'linkedin.com':           { label: 'LinkedIn',        icon: '💼' },
  'docs.google.com':        { label: 'Google Docs',     icon: '📄' },
  'mail.google.com':        { label: 'Gmail',           icon: '📧' },
  'drive.google.com':       { label: 'Google Drive',    icon: '💾' },
  'npmjs.com':              { label: 'npm',             icon: '📦' },
  'developer.mozilla.org':  { label: 'MDN Web Docs',    icon: '📖' },
  'vercel.com':             { label: 'Vercel',          icon: '▲' },
  'netlify.com':            { label: 'Netlify',         icon: '🌿' },
};

function getHostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function getDomainInfo(hostname) {
  if (DOMAIN_INFO[hostname]) return DOMAIN_INFO[hostname];
  for (const [key, val] of Object.entries(DOMAIN_INFO)) {
    if (hostname === key || hostname.endsWith('.' + key)) return val;
  }
  const name = hostname.split('.')[0] || hostname;
  return { label: name.charAt(0).toUpperCase() + name.slice(1), icon: '🌐' };
}

function extractSearchQuery(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    if (u.pathname === '/search' && (h === 'google.com' || h.match(/^google\./))) {
      return { engine: 'Google', query: u.searchParams.get('q') || '' };
    }
    if (h.includes('bing.com') && u.pathname === '/search') {
      return { engine: 'Bing', query: u.searchParams.get('q') || '' };
    }
    if (h === 'youtube.com' && u.pathname === '/results') {
      return { engine: 'YouTube', query: u.searchParams.get('search_query') || '' };
    }
    if (h === 'duckduckgo.com') {
      return { engine: 'DuckDuckGo', query: u.searchParams.get('q') || '' };
    }
  } catch { /* ok */ }
  return null;
}

function formatRelTime(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'たった今';
  if (mins < 60) return mins + '分前';
  return Math.round(mins / 60) + '時間前';
}

/**
 * Groups history entries by domain, separating search queries.
 * Returns array of groups sorted by most recent visit.
 */
function groupHistory(entries) {
  if (!entries || entries.length === 0) return [];

  const domainMap = new Map();

  for (const entry of entries) {
    const hostname = getHostname(entry.url);
    if (!hostname) continue;

    const info = getDomainInfo(hostname);
    if (!domainMap.has(hostname)) {
      domainMap.set(hostname, {
        domain:      hostname,
        label:       info.label,
        icon:        info.icon,
        searches:    [],
        pages:       [],
        lastVisitMs: 0,
      });
    }

    const group = domainMap.get(hostname);
    const visitMs = new Date(entry.visitedAt).getTime();
    if (visitMs > group.lastVisitMs) group.lastVisitMs = visitMs;

    const search = extractSearchQuery(entry.url);
    if (search && search.query) {
      group.searches.push({ ...entry, searchQuery: search.query, searchEngine: search.engine });
    } else {
      group.pages.push(entry);
    }
  }

  return Array.from(domainMap.values())
    .map(g => ({ ...g, totalCount: g.pages.length + g.searches.length }))
    .sort((a, b) => b.lastVisitMs - a.lastVisitMs);
}

/**
 * Renders grouped history as collapsible HTML sections.
 * @param {object[]} groups - from groupHistory()
 * @param {string}   prefix - unique prefix for collapse IDs (avoid conflicts)
 * @param {number}   autoExpandThreshold - groups with ≤N items are auto-expanded
 */
function buildHistoryGroupsHtml(groups, prefix, autoExpandThreshold = 3) {
  return groups.map((g, idx) => {
    const collapseId  = prefix + '-hg-' + idx;
    const isExpanded  = g.totalCount <= autoExpandThreshold;
    const relTime     = formatRelTime(g.lastVisitMs);
    const countBadge  = g.totalCount + 'ページ';

    let entriesHtml = '';

    // Search entries
    if (g.searches.length > 0) {
      entriesHtml += g.searches.map(s =>
        `<li class="hentry hentry--search">
          <span class="hentry-search-label">🔍「${esc(s.searchQuery)}」を検索</span>
          <span class="hentry-time">${formatRelTime(new Date(s.visitedAt).getTime())}</span>
        </li>`
      ).join('');
    }

    // Page entries
    if (g.pages.length > 0) {
      const show = g.pages.slice(0, 8);
      const more = g.pages.length - show.length;
      entriesHtml += show.map(p => {
        const hasTitle = p.title && p.title !== p.url && p.title.length > 3;
        return `<li class="hentry">
          <a class="hentry-link" href="#" data-url="${esc(p.url)}" title="${esc(p.url)}">${esc(hasTitle ? p.title : p.url)}</a>
          <span class="hentry-time">${formatRelTime(new Date(p.visitedAt).getTime())}</span>
        </li>`;
      }).join('');
      if (more > 0) entriesHtml += `<li class="hentry hentry--more">… 他 ${more} ページ</li>`;
    }

    return `<div class="hgroup">
      <button class="hgroup-header" data-group-id="${collapseId}">
        <span class="hgroup-icon">${g.icon}</span>
        <span class="hgroup-name">${esc(g.label)}</span>
        <span class="hgroup-badge">${countBadge}</span>
        <span class="hgroup-time">${relTime}</span>
        <span class="hgroup-chevron" id="${collapseId}-ch">${isExpanded ? '▾' : '▸'}</span>
      </button>
      <ul class="hgroup-body" id="${collapseId}" ${isExpanded ? '' : 'style="display:none"'}>
        ${entriesHtml}
      </ul>
    </div>`;
  }).join('');
}

// ─── Sessions Panel ───────────────────────────────────────────────────────────

/**
 * Builds the HTML for the collapsible detail section.
 * Returns a .detail-grid (2-col or 1-col) with sections for
 * windows, recent files, and clipboard.
 */
function buildDetailHtml(s) {
  const sections = [];

  if (s.windows && s.windows.length > 0) {
    const items = s.windows.slice(0, 6);
    const more  = s.windows.length - items.length;
    let li = items.map(w => '<li>' + esc(w.title) + '</li>').join('');
    if (more > 0) li += '<li class="detail-more">…他 ' + more + ' ウィンドウ</li>';
    sections.push(
      '<div class="detail-section">' +
        '<div class="detail-section-title">ウィンドウ</div>' +
        '<ul class="detail-list">' + li + '</ul>' +
      '</div>'
    );
  }

  if (s.recentFiles && s.recentFiles.length > 0) {
    const items = s.recentFiles.slice(0, 8);
    const more  = s.recentFiles.length - items.length;
    let li = items.map(f => {
      const name = (f.split(/[/\\]/).pop() || f).replace(/\.lnk$/i, '');
      return '<li><a class="file-link" href="#" data-path="' + esc(f) + '" title="' + esc(f) + '">' + esc(name) + '</a></li>';
    }).join('');
    if (more > 0) li += '<li class="detail-more">…他 ' + more + ' ファイル</li>';
    sections.push(
      '<div class="detail-section">' +
        '<div class="detail-section-title">最近のファイル</div>' +
        '<ul class="detail-list">' + li + '</ul>' +
      '</div>'
    );
  }

  // Browser Tabs — full-width below the 2-col grid
  // Support both new browserTabs ({url,title,browser}) and legacy browserUrls (string[])
  let urlsHtml = '';
  const rawTabs = s.browserTabs && s.browserTabs.length > 0
    ? s.browserTabs
    : (s.browserUrls || []).map(u => ({ url: u, title: u, browser: 'browser' }));
  if (rawTabs.length > 0) {
    const items  = rawTabs.slice(0, 15);
    const more   = rawTabs.length - items.length;
    let li = items.map(t => {
      const u = t.url;
      let domain = u;
      try {
        domain = new URL(u).hostname.replace(/^www\./, '');
      } catch { /* ok */ }
      // Show title if meaningful, otherwise show domain
      const hasTitle = t.title && t.title !== u && t.title.length > 3;
      const label    = hasTitle ? esc(t.title) : esc(domain);
      const sub      = hasTitle ? '<span class="tab-domain">' + esc(domain) + '</span>' : '';
      return '<li><a class="url-link" href="#" data-url="' + esc(u) + '" title="' + esc(u) + '">' +
        '<span class="tab-title">' + label + '</span>' + sub +
      '</a></li>';
    }).join('');
    if (more > 0) li += '<li class="detail-more">…他 ' + more + ' タブ</li>';
    urlsHtml =
      '<div class="detail-urls">' +
        '<div class="detail-section-title">ブラウザで開いていたタブ</div>' +
        '<ul class="detail-list url-list">' + li + '</ul>' +
      '</div>';
  }

  // Browser History — grouped collapsible sections
  let historyHtml = '';
  const history = s.browserHistory || [];
  if (history.length > 0) {
    const groups = groupHistory(history);
    const groupsHtml = buildHistoryGroupsHtml(groups, 'card-' + (s.id || Math.random().toString(36).slice(2)));
    historyHtml =
      '<div class="detail-history">' +
        '<div class="detail-section-title">🕐 閲覧履歴（' + history.length + ' ページ）</div>' +
        groupsHtml +
      '</div>';
  }

  let clipHtml = '';
  if (s.clipboard && s.clipboard.trim()) {
    const clip   = s.clipboard.trim().substring(0, 300);
    const suffix = s.clipboard.trim().length > 300 ? '…' : '';
    clipHtml =
      '<div class="detail-clip">' +
        '<div class="detail-section-title">クリップボード</div>' +
        '<pre class="clip-pre">' + esc(clip) + suffix + '</pre>' +
      '</div>';
  }

  if (sections.length === 0 && !urlsHtml && !historyHtml && !clipHtml) {
    return '<p style="color:var(--text-3);font-size:12px;padding:0 2px">詳細なし</p>';
  }

  // Top: 2-col grid for windows + files; URLs + history + clipboard are full-width below
  const gridClass = 'detail-grid' + (sections.length <= 1 ? ' single' : '');
  const gridHtml = sections.length > 0
    ? '<div class="' + gridClass + '">' + sections.join('') + '</div>'
    : '';
  return gridHtml + urlsHtml + historyHtml + clipHtml;
}

// ─── Sessions Layout Renderers ────────────────────────────────────────────────

/** Layout A: カード型 — click-to-expand cards */
function renderCardsLayout(listEl) {
  listEl.innerHTML = sessions.map(s => {
    const { date, time } = formatDate(s.capturedAt);
    const tags = makeTags(s);
    return `
    <div class="session-card">
      <div class="card-top">
        <div class="card-header">
          <span class="card-time">${time}</span>
          <span class="card-date">${date}</span>
          <span class="card-tags">${tags}</span>
          <button class="btn-restore" data-id="${esc(s.id)}">復元する →</button>
        </div>
        <div class="card-summary">${formatSummary(s.aiSummary)}</div>
        ${s.userNote ? '<p class="card-note">' + esc(s.userNote) + '</p>' : ''}
      </div>
      <div class="card-foot">
        <button class="card-expand-btn" data-expand="${esc(s.id)}">▸ 詳細を見る</button>
      </div>
      <div class="card-detail" id="detail-${esc(s.id)}">${buildDetailHtml(s)}</div>
      <div class="restore-result" id="result-${esc(s.id)}"></div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.btn-restore').forEach(btn => {
    btn.addEventListener('click', () => handleRestore(btn.dataset.id, btn));
  });
}

/** Layout B: リスト型 — compact rows, click row to expand detail */
function renderListLayout(listEl) {
  const rows = sessions.map(s => {
    const { date, time } = formatDate(s.capturedAt);
    const tags = makeTags(s);
    return `
    <div class="list-row" data-expand-list="${esc(s.id)}">
      <div class="lr-time">${time}</div>
      <div class="lr-main">
        <div class="lr-meta"><span class="lr-date">${date}</span>${tags}</div>
        <div class="lr-summary">${esc(getSummaryPreview(s.aiSummary))}</div>
      </div>
      <div class="lr-restore-wrap">
        <button class="btn-restore" data-id="${esc(s.id)}">復元する →</button>
      </div>
    </div>
    <div class="list-detail" id="list-detail-${esc(s.id)}">${buildDetailHtml(s)}</div>
    <div class="restore-result" id="result-${esc(s.id)}"></div>`;
  }).join('');

  listEl.innerHTML = '<div class="list-wrap">' + rows + '</div>';

  listEl.querySelectorAll('.btn-restore').forEach(btn => {
    btn.addEventListener('click', () => handleRestore(btn.dataset.id, btn));
  });
}

/** Layout C: タイムライン型 — date-grouped with timeline dots */
function renderTimelineLayout(listEl) {
  // Group sessions by day label (preserves insertion order = newest-first)
  const groups = [];
  const seen   = new Map();
  sessions.forEach(s => {
    const label = dayGroupLabel(s.capturedAt);
    if (!seen.has(label)) { seen.set(label, groups.length); groups.push({ label, items: [] }); }
    groups[seen.get(label)].items.push(s);
  });

  const html = groups.map(g => {
    const items = g.items.map(s => {
      const { time } = formatDate(s.capturedAt);
      const tags = makeTags(s);
      return `
      <div class="tl-item">
        <div class="tl-left"><div class="tl-dot"></div><div class="tl-line"></div></div>
        <div class="tl-body">
          <div class="tl-header">
            <span class="tl-time">${time}</span>${tags}
            <button class="btn-restore" data-id="${esc(s.id)}" style="margin-left:auto">復元する →</button>
          </div>
          <div class="tl-summary">${formatSummary(s.aiSummary)}</div>
          ${s.userNote ? '<div class="tl-note">' + esc(s.userNote) + '</div>' : ''}
          <button class="tl-expand-btn" data-expand="${esc(s.id)}">▸ 詳細を見る</button>
          <div class="tl-detail" id="tl-detail-${esc(s.id)}">${buildDetailHtml(s)}</div>
          <div class="restore-result" id="result-${esc(s.id)}"></div>
        </div>
      </div>`;
    }).join('');
    return '<div class="tl-day-group"><div class="tl-day-label">' + esc(g.label) + '</div>' + items + '</div>';
  }).join('');

  listEl.innerHTML = html;

  listEl.querySelectorAll('.btn-restore').forEach(btn => {
    btn.addEventListener('click', () => handleRestore(btn.dataset.id, btn));
  });
}

function renderSessions() {
  const listEl  = document.getElementById('session-list');
  const countEl = document.getElementById('session-count');

  if (!sessions || sessions.length === 0) {
    if (countEl) countEl.textContent = '';
    const captureKey = config.captureShortcut || 'Ctrl+Shift+S';
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">▤</div>
        <p class="empty-title">まだセッションがありません</p>
        <p class="empty-hint"><kbd>${esc(captureKey)}</kbd> を押してセッションを保存できます</p>
      </div>`;
    return;
  }

  if (countEl) countEl.textContent = sessions.length + ' 件';

  if (currentLayout === 'list')          renderListLayout(listEl);
  else if (currentLayout === 'timeline') renderTimelineLayout(listEl);
  else                                   renderCardsLayout(listEl);
}

async function handleRestore(id, btn) {
  btn.disabled = true;
  btn.textContent = '復元中…';
  const result = await window.electronAPI.restoreSession(id);

  const resultEl = document.getElementById('result-' + id);

  if (!result || !result.success) {
    btn.textContent = '❌ 失敗';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '復元する →';
    }, 2500);
    return;
  }

  const lines = [];
  if (result.clipboardRestored) lines.push('📋 クリップボードを復元しました');
  if (result.launched && result.launched.length > 0) {
    const apps = result.launched.map(l => {
      const name = l.split(' ')[0];
      return name + (l.includes('focused') ? ' をフォーカス' : ' を起動');
    });
    lines.push('🪟 ' + apps.join('、'));
  }
  if (result.urlsOpened && result.urlsOpened > 0) {
    lines.push('🌐 ' + result.urlsOpened + ' 件のURLをブラウザで開きました');
  }
  if (lines.length === 0) lines.push('ℹ️ コンテキストを確認しました');

  // Setting innerHTML triggers :empty to disappear; clearing it hides again
  resultEl.innerHTML = lines.map(l => '<div>' + esc(l) + '</div>').join('');
  btn.textContent = '✅ 完了';
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '復元する →';
    resultEl.innerHTML = '';
  }, 4000);
}

// ─── Capture Panel ────────────────────────────────────────────────────────────
function renderCapturePanel() {
  const panel = document.getElementById('panel-capture');

  // State: collecting context (shortcut just pressed, waiting for data)
  if (isCollecting && !pendingSession) {
    panel.innerHTML = `
      <div class="panel-header">
        <span style="font-size:16px">◎</span>
        <h2 class="panel-title">保存・確認</h2>
      </div>
      <div class="panel-body">
        <div class="capture-wrap">
          <div class="summary-box" style="text-align:center;padding:32px 20px;">
            <div class="summary-loading" style="justify-content:center">
              <span class="spinner"></span>
              <span>コンテキストを収集中…</span>
            </div>
            <p style="font-size:11.5px;color:var(--text-3);margin-top:12px;">
              ウィンドウ・タブ・ファイル・履歴を収集しています
            </p>
          </div>
        </div>
      </div>`;
    return;
  }

  // State: idle (no capture in progress)
  if (!pendingSession) {
    panel.innerHTML = `
      <div class="empty-state" style="height:100%">
        <div class="empty-icon">◎</div>
        <p class="empty-title">保存待ちのセッションはありません</p>
        <p class="empty-hint">
          <kbd>${esc(config.captureShortcut || 'Ctrl+Shift+S')}</kbd> を押すとAIが作業内容を推測して<br>保存確認を表示します
        </p>
      </div>`;
    return;
  }

  const now = new Date();
  const wdays = ['日','月','火','水','木','金','土'];
  const nowStr = (now.getMonth()+1) + '月' + now.getDate() + '日（' + wdays[now.getDay()] + '）'
    + String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

  // Build context sections
  let winHtml = '';
  if (pendingSession.windows && pendingSession.windows.length > 0) {
    const items = pendingSession.windows.slice(0, 6);
    const more  = pendingSession.windows.length - items.length;
    winHtml =
      '<div><div class="ctx-col-title">ウィンドウ</div><ul class="ctx-list">' +
      items.map(w => '<li>' + esc(w.title) + '</li>').join('') +
      (more > 0 ? '<li style="color:var(--text-3);font-size:11px">…他 ' + more + '</li>' : '') +
      '</ul></div>';
  }

  let filesHtml = '';
  if (pendingSession.recentFiles && pendingSession.recentFiles.length > 0) {
    const items = pendingSession.recentFiles.slice(0, 5);
    filesHtml =
      '<div><div class="ctx-col-title">最近のファイル</div><ul class="ctx-list">' +
      items.map(f => {
        const name = (f.split(/[/\\]/).pop() || f).replace(/\.lnk$/i, '');
        return '<li><a class="file-link" href="#" data-path="' + esc(f) + '" title="' + esc(f) + '">' + esc(name) + '</a></li>';
      }).join('') +
      '</ul></div>';
  }

  let urlsCapHtml = '';
  const capTabs = pendingSession.browserTabs && pendingSession.browserTabs.length > 0
    ? pendingSession.browserTabs
    : (pendingSession.browserUrls || []).map(u => ({ url: u, title: u, browser: 'browser' }));
  if (capTabs.length > 0) {
    const items = capTabs.slice(0, 8);
    const more  = capTabs.length - items.length;
    let li = items.map(t => {
      const u = t.url;
      let domain = u;
      try { domain = new URL(u).hostname.replace(/^www\./, ''); } catch { /* ok */ }
      const hasTitle = t.title && t.title !== u && t.title.length > 3;
      const label = hasTitle ? esc(t.title) : esc(domain);
      const sub   = hasTitle ? ' <span style="color:var(--text-3);font-size:10px">(' + esc(domain) + ')</span>' : '';
      return '<li>' + label + sub + '</li>';
    }).join('');
    if (more > 0) li += '<li style="color:var(--text-3);font-size:11px">…他 ' + more + ' タブ</li>';
    urlsCapHtml =
      '<div><div class="ctx-col-title">ブラウザタブ</div><ul class="ctx-list">' + li + '</ul></div>';
  }

  // Capture panel: browser history — grouped
  let histCapHtml = '';
  const capHistory = pendingSession.browserHistory || [];
  if (capHistory.length > 0) {
    const capGroups = groupHistory(capHistory);
    const capGroupsHtml = buildHistoryGroupsHtml(capGroups, 'cap', 5);
    histCapHtml =
      '<div class="cap-history">' +
        '<div class="ctx-col-title">🕐 閲覧履歴（' + capHistory.length + ' ページ）</div>' +
        capGroupsHtml +
      '</div>';
  }

  let clipHtml = '';
  if (pendingSession.clipboard && pendingSession.clipboard.trim()) {
    const c      = pendingSession.clipboard.trim().substring(0, 200);
    const suffix = pendingSession.clipboard.trim().length > 200 ? '…' : '';
    clipHtml =
      '<div class="ctx-clip"><div class="ctx-col-title">クリップボード</div>' +
      '<pre>' + esc(c) + suffix + '</pre></div>';
  }

  const hasCtx = winHtml || filesHtml || urlsCapHtml || histCapHtml || clipHtml;
  const ctxCardHtml = hasCtx
    ? `<div class="ctx-card">
        ${(winHtml || filesHtml) ? '<div class="ctx-row">' + winHtml + filesHtml + '</div>' : ''}
        ${urlsCapHtml ? '<div class="ctx-row">' + urlsCapHtml + '</div>' : ''}
        ${histCapHtml ? '<div>' + histCapHtml + '</div>' : ''}
        ${clipHtml}
      </div>`
    : '';

  const isLoading = !pendingSession.aiSummary;
  const summaryBodyHtml = isLoading
    ? `<div class="summary-loading" id="summary-display"><span class="spinner"></span><span>AI が作業内容を推測中…</span></div>`
    : `<div class="summary-text" id="summary-display">${formatSummary(pendingSession.aiSummary)}</div>`;

  panel.innerHTML = `
    <div class="panel-header">
      <span style="font-size:16px">◎</span>
      <h2 class="panel-title">保存・確認</h2>
      <span style="margin-left:auto;font-size:12px;color:var(--text-3)">${nowStr}</span>
    </div>
    <div class="panel-body">
      <div class="capture-wrap">

        <div class="summary-box">
          <div class="summary-section-label">AI による作業内容の推測</div>
          ${summaryBodyHtml}
        </div>

        ${ctxCardHtml}

        <div>
          <label class="note-label" for="capture-note">メモを追加（任意）</label>
          <textarea id="capture-note" class="note-input"
            placeholder="今やっていたことを補足メモ…"></textarea>
        </div>

        <div class="capture-actions">
          <button class="btn-secondary" id="btn-skip-capture">スキップ</button>
          <button class="btn-primary" id="btn-approve-capture"${isLoading ? ' disabled' : ''}>✓ 保存する</button>
        </div>

      </div>
    </div>`;

  document.getElementById('btn-approve-capture').addEventListener('click', async () => {
    const note = document.getElementById('capture-note').value.trim();
    document.getElementById('btn-approve-capture').disabled = true;
    document.getElementById('btn-skip-capture').disabled = true;
    await window.electronAPI.approveSession(note);
    pendingSession = null;
    clearBadge('capture');
    sessions = await window.electronAPI.loadSessions();
    renderSessions();
    renderCapturePanel();
    switchTab('sessions');
  });

  document.getElementById('btn-skip-capture').addEventListener('click', async () => {
    await window.electronAPI.skipSession();
    pendingSession = null;
    clearBadge('capture');
    renderCapturePanel();
    switchTab('sessions');
  });
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
function initSettings() {
  // ── Non-AI settings ──────────────────────────────────────────────────────
  const browser   = document.getElementById('setting-browser');
  const autostart = document.getElementById('setting-autostart');
  if (browser   && config.defaultBrowser) browser.value     = config.defaultBrowser;
  if (autostart)                          autostart.checked = !!config.openAtLogin;

  browser.addEventListener('change', async e => {
    await window.electronAPI.saveConfig({ defaultBrowser: e.target.value });
    config.defaultBrowser = e.target.value;
  });
  autostart.addEventListener('change', async e => {
    await window.electronAPI.saveConfig({ openAtLogin: e.target.checked });
    config.openAtLogin = e.target.checked;
  });

  // ── History range settings ────────────────────────────────────────────────
  const historyMode  = document.getElementById('setting-history-mode');
  const historyRange = document.getElementById('setting-history-range');
  const rangeRow     = document.getElementById('history-range-row');

  function updateRangeRowVisibility() {
    if (!rangeRow) return;
    const isSinceLast = historyMode && historyMode.value === 'since-last';
    rangeRow.style.display = isSinceLast ? 'none' : 'block';
  }

  if (historyMode) {
    historyMode.value = config.historyMode || 'fixed';
    historyMode.addEventListener('change', async e => {
      await window.electronAPI.saveConfig({ historyMode: e.target.value });
      config.historyMode = e.target.value;
      updateRangeRowVisibility();
    });
    updateRangeRowVisibility();
  }
  if (historyRange) {
    historyRange.value = String(config.historyMinutesBack || 60);
    historyRange.addEventListener('change', async e => {
      const val = parseInt(e.target.value, 10);
      await window.electronAPI.saveConfig({ historyMinutesBack: val });
      config.historyMinutesBack = val;
    });
  }

  document.getElementById('btn-open-folder').addEventListener('click', () => {
    window.electronAPI.openDataFolder();
  });

  // ── Shortcut keys ─────────────────────────────────────────────────────────
  const elCaptureShortcut = document.getElementById('setting-capture-shortcut');
  const elOpenShortcut    = document.getElementById('setting-open-shortcut');
  const elShortcutStatus  = document.getElementById('shortcut-status');

  if (elCaptureShortcut && config.captureShortcut) elCaptureShortcut.value = config.captureShortcut;
  if (elOpenShortcut    && config.openShortcut)    elOpenShortcut.value    = config.openShortcut;

  document.getElementById('btn-save-shortcuts')?.addEventListener('click', async () => {
    const captureKey = (elCaptureShortcut.value || '').trim() || 'Ctrl+Shift+S';
    const openKey    = (elOpenShortcut.value    || '').trim() || 'Ctrl+Shift+R';
    elShortcutStatus.textContent = '登録中…';
    elShortcutStatus.className   = 'setting-status';

    // save-config now auto-registers shortcuts when shortcut keys change
    await window.electronAPI.saveConfig({ captureShortcut: captureKey, openShortcut: openKey });
    const result = await window.electronAPI.registerShortcuts(captureKey, openKey);

    if (result.captureOk && result.openOk) {
      Object.assign(config, { captureShortcut: captureKey, openShortcut: openKey });
      elShortcutStatus.textContent = '✅ 保存・登録しました';
      elShortcutStatus.className   = 'setting-status';
    } else {
      const parts = [];
      if (!result.captureOk) parts.push('保存ショートカット（他アプリが使用中かも）');
      if (!result.openOk)    parts.push('開くショートカット（他アプリが使用中かも）');
      elShortcutStatus.textContent = '⚠️ 登録失敗: ' + parts.join(' / ');
      elShortcutStatus.className   = 'setting-status error';
    }
  });

  // ── Browser Extension UI ─────────────────────────────────────────────────
  const btnOpenExt  = document.getElementById('btn-open-extension');
  const btnCheckExt = document.getElementById('btn-check-ext');
  const extDot      = document.getElementById('ext-status-dot');
  const extText     = document.getElementById('ext-status-text');

  async function checkExtensionStatus() {
    try {
      const res = await fetch('http://localhost:9224/ping', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        // Relay server is up — check if extension has sent tabs
        // First get auth token (CORS-protected), then check tabs
        let token = '';
        try {
          const tokenRes = await fetch('http://localhost:9224/token', { signal: AbortSignal.timeout(1000) });
          if (tokenRes.ok) token = await tokenRes.text();
        } catch { /* ignore */ }

        if (token) {
          const tabsRes = await fetch('http://localhost:9224/tabs', {
            signal: AbortSignal.timeout(1000),
            headers: { 'Authorization': 'Bearer ' + token },
          });
          const tabs = await tabsRes.json();
          if (tabs.length > 0) {
            extDot.style.background  = 'var(--success)';
            extText.textContent = '✅ 拡張機能が接続されています（' + tabs.length + ' タブを認識中）';
          } else {
            extDot.style.background  = '#f59e0b';
            extText.textContent = '⚠️ サーバーは起動中ですが拡張機能が未接続です';
          }
        } else {
          extDot.style.background  = '#f59e0b';
          extText.textContent = '⚠️ サーバーは起動中ですがトークン取得に失敗しました';
        }
      }
    } catch {
      extDot.style.background = 'var(--error)';
      extText.textContent = '❌ 拡張機能が接続されていません（拡張機能をインストールしてください）';
    }
  }

  if (btnOpenExt) {
    btnOpenExt.addEventListener('click', () => {
      window.electronAPI.openExtensionFolder();
    });
  }
  if (btnCheckExt) {
    btnCheckExt.addEventListener('click', () => {
      checkExtensionStatus();
    });
  }

  // Auto-check on settings tab open
  checkExtensionStatus();

  // External links (open in default browser via IPC)
  ['link-gemini','link-openai','link-anthropic','link-ollama'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', e => {
      e.preventDefault();
      window.electronAPI.openUrl(el.href);
    });
  });

  // ── AI Provider Picker ───────────────────────────────────────────────────
  let currentProvider = config.aiProvider || 'gemini';

  function showProvider(p) {
    document.querySelectorAll('.provider-btn').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.provider === p));
    document.querySelectorAll('.provider-section').forEach(sec =>
      sec.style.display = sec.id === 'section-' + p ? '' : 'none');
  }
  showProvider(currentProvider);

  document.querySelectorAll('.provider-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentProvider = btn.dataset.provider;
      showProvider(currentProvider);
      await window.electronAPI.saveConfig({ aiProvider: currentProvider });
      config.aiProvider = currentProvider;
    });
  });

  // ── Gemini ───────────────────────────────────────────────────────────────
  const elGeminiKey   = document.getElementById('setting-api-key');
  const elGeminiModel = document.getElementById('setting-gemini-model');
  const elGeminiStatus = document.getElementById('api-key-status');

  if (config.googleApiKey) elGeminiKey.value = config.googleApiKey;
  if (config.aiProvider === 'gemini' && config.aiModel) {
    elGeminiModel.value = config.aiModel;
  } else if (config.geminiModel) {
    elGeminiModel.value = config.geminiModel;
  }

  elGeminiModel.addEventListener('change', async e => {
    await window.electronAPI.saveConfig({ aiModel: e.target.value, geminiModel: e.target.value });
    config.aiModel = e.target.value;
  });

  document.getElementById('btn-save-ai-gemini').addEventListener('click', async () => {
    const key   = elGeminiKey.value.trim();
    const model = elGeminiModel.value;
    elGeminiStatus.textContent = '接続テスト中…';
    elGeminiStatus.className   = 'setting-status';
    if (!key.startsWith('AIza')) {
      elGeminiStatus.textContent = '❌ "AIza" で始まるキーを入力してください';
      elGeminiStatus.className   = 'setting-status error';
      return;
    }
    const result = await window.electronAPI.testAiConfig({ provider: 'gemini', googleApiKey: key, model });
    if (result.ok) {
      await window.electronAPI.saveConfig({ googleApiKey: key, aiModel: model, geminiModel: model, aiProvider: 'gemini' });
      Object.assign(config, { googleApiKey: key, aiModel: model, geminiModel: model, aiProvider: 'gemini' });
      elGeminiStatus.textContent = '✅ 保存しました（' + model + '）';
      elGeminiStatus.className   = 'setting-status';
    } else {
      elGeminiStatus.textContent = '❌ ' + (result.error || '接続に失敗しました');
      elGeminiStatus.className   = 'setting-status error';
    }
  });

  // ── OpenAI ───────────────────────────────────────────────────────────────
  const elOpenAIKey    = document.getElementById('setting-openai-key');
  const elOpenAIModel  = document.getElementById('setting-openai-model');
  const elOpenAIStatus = document.getElementById('openai-key-status');

  if (config.openaiApiKey)  elOpenAIKey.value   = config.openaiApiKey;
  if (config.aiProvider === 'openai' && config.aiModel) elOpenAIModel.value = config.aiModel;

  elOpenAIModel.addEventListener('change', async e => {
    if (config.aiProvider !== 'openai') return;
    await window.electronAPI.saveConfig({ aiModel: e.target.value });
    config.aiModel = e.target.value;
  });

  document.getElementById('btn-save-ai-openai').addEventListener('click', async () => {
    const key   = elOpenAIKey.value.trim();
    const model = elOpenAIModel.value;
    elOpenAIStatus.textContent = '接続テスト中…';
    elOpenAIStatus.className   = 'setting-status';
    if (!key.startsWith('sk-')) {
      elOpenAIStatus.textContent = '❌ "sk-" で始まるキーを入力してください';
      elOpenAIStatus.className   = 'setting-status error';
      return;
    }
    const result = await window.electronAPI.testAiConfig({ provider: 'openai', openaiApiKey: key, model });
    if (result.ok) {
      await window.electronAPI.saveConfig({ openaiApiKey: key, aiModel: model, aiProvider: 'openai' });
      Object.assign(config, { openaiApiKey: key, aiModel: model, aiProvider: 'openai' });
      currentProvider = 'openai';
      showProvider('openai');
      elOpenAIStatus.textContent = '✅ 保存しました（' + model + '）';
      elOpenAIStatus.className   = 'setting-status';
    } else {
      elOpenAIStatus.textContent = '❌ ' + (result.error || '接続に失敗しました');
      elOpenAIStatus.className   = 'setting-status error';
    }
  });

  // ── Anthropic ────────────────────────────────────────────────────────────
  const elAnthKey    = document.getElementById('setting-anthropic-key');
  const elAnthModel  = document.getElementById('setting-anthropic-model');
  const elAnthStatus = document.getElementById('anthropic-key-status');

  if (config.anthropicApiKey) elAnthKey.value = config.anthropicApiKey;
  if (config.aiProvider === 'anthropic' && config.aiModel) elAnthModel.value = config.aiModel;

  elAnthModel.addEventListener('change', async e => {
    if (config.aiProvider !== 'anthropic') return;
    await window.electronAPI.saveConfig({ aiModel: e.target.value });
    config.aiModel = e.target.value;
  });

  document.getElementById('btn-save-ai-anthropic').addEventListener('click', async () => {
    const key   = elAnthKey.value.trim();
    const model = elAnthModel.value;
    elAnthStatus.textContent = '接続テスト中…';
    elAnthStatus.className   = 'setting-status';
    if (!key.startsWith('sk-ant-')) {
      elAnthStatus.textContent = '❌ "sk-ant-" で始まるキーを入力してください';
      elAnthStatus.className   = 'setting-status error';
      return;
    }
    const result = await window.electronAPI.testAiConfig({ provider: 'anthropic', anthropicApiKey: key, model });
    if (result.ok) {
      await window.electronAPI.saveConfig({ anthropicApiKey: key, aiModel: model, aiProvider: 'anthropic' });
      Object.assign(config, { anthropicApiKey: key, aiModel: model, aiProvider: 'anthropic' });
      currentProvider = 'anthropic';
      showProvider('anthropic');
      elAnthStatus.textContent = '✅ 保存しました（' + model + '）';
      elAnthStatus.className   = 'setting-status';
    } else {
      elAnthStatus.textContent = '❌ ' + (result.error || '接続に失敗しました');
      elAnthStatus.className   = 'setting-status error';
    }
  });

  // ── Ollama ───────────────────────────────────────────────────────────────
  const elOllamaUrl    = document.getElementById('setting-ollama-url');
  const elOllamaModel  = document.getElementById('setting-ollama-model');
  const elOllamaStatus = document.getElementById('ollama-status');

  elOllamaUrl.value   = config.ollamaBaseUrl   || 'http://localhost:11434';
  elOllamaModel.value = config.aiProvider === 'ollama' ? (config.aiModel || '') : '';

  document.getElementById('btn-save-ai-ollama').addEventListener('click', async () => {
    const url   = elOllamaUrl.value.trim() || 'http://localhost:11434';
    const model = elOllamaModel.value.trim() || 'llama3.2';
    elOllamaStatus.textContent = '接続テスト中…';
    elOllamaStatus.className   = 'setting-status';
    const result = await window.electronAPI.testAiConfig({ provider: 'ollama', ollamaBaseUrl: url, model });
    if (result.ok) {
      await window.electronAPI.saveConfig({ ollamaBaseUrl: url, aiModel: model, aiProvider: 'ollama' });
      Object.assign(config, { ollamaBaseUrl: url, aiModel: model, aiProvider: 'ollama' });
      currentProvider = 'ollama';
      showProvider('ollama');
      const modelInfo = result.model ? '（利用可能: ' + result.model.substring(0, 40) + '）' : '';
      elOllamaStatus.textContent = '✅ 接続成功・保存しました ' + modelInfo;
      elOllamaStatus.className   = 'setting-status';
    } else {
      elOllamaStatus.textContent = '❌ ' + (result.error || '接続に失敗しました');
      elOllamaStatus.className   = 'setting-status error';
    }
  });
}

// ─── IPC Events ───────────────────────────────────────────────────────────────
window.electronAPI.onNavigate((tab) => switchTab(tab));

// Phase 0: Shortcut pressed — show collecting state immediately
window.electronAPI.onCaptureStarted(() => {
  isCollecting = true;
  pendingSession = null;
  renderCapturePanel();
  setBadge('capture');
  switchTab('capture');
});

// Phase 1: Context collected — show context (AI still loading)
window.electronAPI.onNewSessionPending((data) => {
  isCollecting = false;
  pendingSession = data;
  renderCapturePanel();
  setBadge('capture');
  switchTab('capture');
});

// Capture error
window.electronAPI.onCaptureError((msg) => {
  isCollecting = false;
  pendingSession = null;
  renderCapturePanel();
});

// AI summary arrived — update the summary box in-place without full re-render
window.electronAPI.onSessionSummaryReady((aiSummary) => {
  if (!pendingSession) return;
  pendingSession.aiSummary = aiSummary;

  const displayEl = document.getElementById('summary-display');
  if (displayEl) {
    displayEl.className = 'summary-text';
    displayEl.innerHTML = formatSummary(aiSummary);
  }
  const saveBtn = document.getElementById('btn-approve-capture');
  if (saveBtn) saveBtn.disabled = false;
});

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const [loadedSessions, loadedConfig, loadedPending, captureState, loadedInitialTab] = await Promise.all([
    window.electronAPI.loadSessions(),
    window.electronAPI.getConfig(),
    window.electronAPI.getPendingSession(),
    window.electronAPI.getCaptureState(),
    window.electronAPI.getInitialTab(),
  ]);
  sessions = loadedSessions;
  config = loadedConfig;
  pendingSession = loadedPending;
  isCollecting = (captureState === 'collecting');
  const initialTab = loadedInitialTab;

  applyTheme(config.theme || 'system');

  renderSessions();
  renderCapturePanel();
  initSettings();

  // Theme buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const t = btn.dataset.theme;
      applyTheme(t);
      config.theme = t;
      await window.electronAPI.saveConfig({ theme: t });
    });
  });

  // Nav items
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
  });

  // Layout picker — sync initial active state then handle clicks
  document.querySelectorAll('.layout-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.layout === currentLayout));
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentLayout = btn.dataset.layout;
      localStorage.setItem('ck-layout', currentLayout);
      document.querySelectorAll('.layout-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.layout === currentLayout));
      renderSessions();
    });
  });

  // Layout A — card expand/collapse
  document.addEventListener('click', e => {
    const btn = e.target.closest('.card-expand-btn');
    if (!btn) return;
    const id = btn.dataset.expand;
    const detail = document.getElementById('detail-' + id);
    if (!detail) return;
    const expanded = detail.classList.toggle('expanded');
    btn.textContent = expanded ? '▾ 詳細を閉じる' : '▸ 詳細を見る';
  });

  // Layout B — list row expand/collapse (skip if clicking restore button)
  document.addEventListener('click', e => {
    const row = e.target.closest('[data-expand-list]');
    if (!row) return;
    if (e.target.closest('.btn-restore')) return;
    const id = row.dataset.expandList;
    const detail = document.getElementById('list-detail-' + id);
    if (!detail) return;
    detail.classList.toggle('expanded');
  });

  // Layout C — timeline expand/collapse
  document.addEventListener('click', e => {
    const btn = e.target.closest('.tl-expand-btn');
    if (!btn) return;
    const id = btn.dataset.expand;
    const detail = document.getElementById('tl-detail-' + id);
    if (!detail) return;
    const expanded = detail.classList.toggle('expanded');
    btn.textContent = expanded ? '▾ 詳細を閉じる' : '▸ 詳細を見る';
  });

  // History group collapse — event delegation (works for dynamically rendered cards)
  document.addEventListener('click', e => {
    const header = e.target.closest('.hgroup-header');
    if (!header) return;
    const id = header.dataset.groupId;
    const body    = document.getElementById(id);
    const chevron = document.getElementById(id + '-ch');
    if (!body) return;
    const hidden = body.style.display === 'none';
    body.style.display  = hidden ? 'block' : 'none';
    if (chevron) chevron.textContent = hidden ? '▾' : '▸';
  });

  // URL open for history links — event delegation
  document.addEventListener('click', e => {
    const link = e.target.closest('[data-url]');
    if (!link) return;
    e.preventDefault();
    const url = link.dataset.url;
    if (url) window.electronAPI.openUrl(url);
  });

  // File path open — event delegation
  document.addEventListener('click', e => {
    const link = e.target.closest('[data-path]');
    if (!link) return;
    e.preventDefault();
    const filePath = link.dataset.path;
    if (filePath) window.electronAPI.openPath(filePath);
  });

  // Initial tab + badge
  if (pendingSession) {
    setBadge('capture');
    switchTab(initialTab === 'capture' ? 'capture' : (initialTab || 'sessions'));
  } else {
    switchTab(initialTab || 'sessions');
  }
}

init();
