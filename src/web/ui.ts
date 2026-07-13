import { buildPlatformIconMap } from './icons'
import { SCROLL_JS } from './ui-scroll'
import { buildAccountFilterHtml, CHATS_JS } from './ui-chats'

const PLATFORM_ICONS_JSON = JSON.stringify(buildPlatformIconMap())

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function buildHtmlPage(
  accounts: { platform: string; account: string }[],
  selectedAccount?: string,
): string {
  // Determine which platforms have more than one account
  const platformCounts = new Map<string, number>()
  for (const { platform } of accounts) {
    platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + 1)
  }
  const multiAccountPlatforms = [...platformCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([platform]) => platform)
  const multiAccountPlatformsJSON = JSON.stringify(multiAccountPlatforms)

  const accountFilterHtml = buildAccountFilterHtml(accounts, selectedAccount)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KhipuChat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; height: 100vh; display: flex; flex-direction: column; background: #f5f5f5; }
    #search-bar { display: flex; gap: 8px; padding: 12px 16px; background: #fff; border-bottom: 1px solid #ddd; }
    #search-bar input { flex: 1; padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
    #search-btn { padding: 8px 16px; background: #0070f3; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .mode-btn { padding: 6px 12px; border: 1px solid #ccc; background: none; font-size: 13px; cursor: pointer; color: #555; } .mode-btn:first-of-type { border-radius: 6px 0 0 6px; } .mode-btn:last-of-type { border-radius: 0 6px 6px 0; border-left: none; } .mode-btn.active { background: #0070f3; color: #fff; border-color: #0070f3; }
    #main { display: flex; flex: 1; overflow: hidden; }
    #sidebar { width: 280px; display: flex; flex-direction: column; background: #fff; border-right: 1px solid #ddd; }
    #type-filter { display: flex; border-bottom: 1px solid #ddd; }
    #type-filter button { flex: 1; padding: 8px 0; border: none; background: none; font-size: 12px; cursor: pointer; color: #555; border-bottom: 2px solid transparent; }
    #type-filter button.active { color: #0070f3; border-bottom-color: #0070f3; font-weight: 600; }
    #platform-filter { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-bottom: 1px solid #ddd; }
    #platform-filter button { display: flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid #ccc; background: none; border-radius: 12px; font-size: 11px; cursor: pointer; color: #555; }
    #platform-filter button.active { background: #0070f3; color: #fff; border-color: #0070f3; }
    #platform-filter button svg { display: block; flex-shrink: 0; }
    #chat-list { flex: 1; overflow-y: auto; }
    #panel { flex: 1; overflow-y: auto; padding: 16px; }
    .chat-item { padding: 12px 14px; border-bottom: 1px solid #f0f0f0; cursor: pointer; }
    .chat-item:hover { background: #f7f7f7; }
    .chat-item.active { background: #e8f0fe; }
    .chat-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chat-meta { display: flex; justify-content: space-between; margin-top: 4px; font-size: 12px; color: #888; }
    .badge { background: #6c757d; color: #fff; border-radius: 4px; padding: 1px 5px; font-size: 11px; } .badge.group { background: #5a67d8; } .badge.private { background: #38a169; }
    .msg { display: flex; flex-direction: column; margin: 8px 0; } .msg.sent { align-items: flex-end; } .msg.received { align-items: flex-start; }
    .msg-bubble { max-width: 65%; padding: 8px 12px; border-radius: 12px; font-size: 14px; line-height: 1.4; }
    .msg.sent .msg-bubble { background: #0070f3; color: #fff; } .msg.received .msg-bubble { background: #fff; border: 1px solid #ddd; }
    .msg-meta { font-size: 11px; color: #aaa; margin-top: 3px; } .msg-media { font-style: italic; color: #888; } .msg-sender { font-size: 12px; color: #5a67d8; font-weight: 600; }
    .result-item { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 8px 0; cursor: pointer; }
    .result-item:hover { background: #f7f7f7; } .result-chat { font-weight: 600; font-size: 13px; } .result-text { font-size: 14px; margin-top: 4px; }
    .result-meta { display: flex; gap: 8px; margin-top: 6px; font-size: 12px; color: #888; } #placeholder { color: #aaa; text-align: center; margin-top: 80px; font-size: 16px; }
  </style>
</head>
<body>
  <div id="search-bar">
    <input id="q" type="text" placeholder="Search messages…" />
    <div style="display:flex"><button class="mode-btn active" data-mode="keyword">Keyword</button><button class="mode-btn" data-mode="semantic">Semantic</button></div>
    <button id="search-btn">Search</button>
  </div>
  <div id="main">
    <div id="sidebar">
      <div id="type-filter">
        <button class="active" data-type="all">All</button>
        <button data-type="direct">Direct</button>
        <button data-type="group">Groups</button>
      </div>
      ${accountFilterHtml}
      <div id="platform-filter"></div>
      <div id="chat-list"></div>
    </div>
    <div id="panel"><div id="placeholder">Select a chat to view messages</div></div>
  </div>
  <script>
    ${SCROLL_JS}
    ${CHATS_JS}
    const PLATFORM_ICONS = ${PLATFORM_ICONS_JSON};
    const MULTI_ACCOUNT_PLATFORMS = new Set(${multiAccountPlatformsJSON});
    const chatList = document.getElementById('chat-list');
    const panel = document.getElementById('panel');
    const qInput = document.getElementById('q');
    const searchBtn = document.getElementById('search-btn');
    let allChats = [], activeType = 'all', activePlatform = 'all';
    let currentChatType = 'private', currentChatId = null, searchMode = 'keyword';
    document.getElementById('search-bar').addEventListener('click', e => { const btn = e.target.closest('.mode-btn'); if (!btn) return; searchMode = btn.dataset.mode; document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn)); });
    document.getElementById('type-filter').addEventListener('click', e => {
      const btn = e.target.closest('button[data-type]'); if (!btn) return;
      activeType = btn.dataset.type;
      document.querySelectorAll('#type-filter button').forEach(b => b.classList.toggle('active', b === btn));
      renderChatList();
    });
    document.getElementById('platform-filter').addEventListener('click', e => {
      const btn = e.target.closest('button[data-platform]'); if (!btn) return;
      activePlatform = btn.dataset.platform;
      document.querySelectorAll('#platform-filter button').forEach(b => b.classList.toggle('active', b === btn));
      renderChatList();
    });

    function ts(t) { return new Date(t * 1000).toLocaleString(); }

    async function loadChats() {
      const res = await fetch('/api/chats');
      allChats = await res.json();
      renderPlatformFilter();
      renderChatList();
    }

    function buildMsgEl(m, isGroup) {
      const sent = m.is_sender === 1;
      const el = document.createElement('div');
      el.className = 'msg ' + (sent ? 'sent' : 'received');
      const nameHtml = (!sent && isGroup && m.sender_name) ? '<strong class="msg-sender">' + esc(m.sender_name) + '</strong><br>' : '';
      const bodyHtml = typeof m.text === 'string' && m.text ? esc(m.text) : '<em class="msg-media">[' + esc(m.type || 'media') + ']</em>';
      el.innerHTML = \`<div class="msg-bubble">\${nameHtml}\${bodyHtml}</div><div class="msg-meta">\${ts(m.timestamp)}</div>\`;
      return el;
    }

    async function openThread(chatId) {
      if (chatId === currentChatId) { scrollToBottom(panel); return; }
      disconnectScroll();
      currentChatId = chatId;
      const res = await fetch('/api/messages/' + chatId);
      const { messages: msgs, has_more } = await res.json();
      panel.innerHTML = '';
      if (msgs.length === 0) { panel.innerHTML = '<div id="placeholder">No messages found</div>'; return; }
      const isGroup = currentChatType === 'group';
      msgs.forEach(m => panel.appendChild(buildMsgEl(m, isGroup)));
      scrollToBottom(panel);
      attachScrollSentinel(panel, chatId, msgs[0].timestamp, function(m) { return buildMsgEl(m, currentChatType === 'group'); }, has_more);
    }

    async function doSearch() {
      const q = qInput.value.trim();
      if (!q) return;
      const data = await (await fetch((searchMode === 'keyword' ? '/api/search?q=' : '/api/semantic-search?q=') + encodeURIComponent(q))).json();
      panel.innerHTML = '';
      document.querySelectorAll('.chat-item').forEach(x => x.classList.remove('active'));
      if (data.error) { panel.innerHTML = '<div class="search-error">' + esc(data.error) + '</div>'; return; }
      const results = Array.isArray(data) ? data : (data.results || []);
      if (results.length === 0) { panel.innerHTML = '<div id="placeholder">No results for "' + esc(q) + '"</div>'; return; }
      results.forEach(r => {
        const el = document.createElement('div');
        el.className = 'result-item'; el.dataset.chatId = r.chat_id;
        el.innerHTML = \`<div class="result-chat">\${esc(r.chat_name)} <span class="badge" title="\${esc(r.platform)}">\${platformLabel(r.platform)}</span></div>
          <div class="result-text">\${r.sender_name ? '<strong>' + esc(r.sender_name) + '</strong>: ' : ''}\${esc(r.text || '')}</div>
          <div class="result-meta"><span>\${ts(r.timestamp)}</span></div>\`;
        el.addEventListener('click', () => {
          document.querySelectorAll('.chat-item').forEach(x => x.classList.toggle('active', x.dataset.chatId === String(r.chat_id)));
          openThread(r.chat_id);
        });
        panel.appendChild(el);
      });
    }

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    searchBtn.addEventListener('click', doSearch);
    qInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    loadChats();
  </script>
</body>
</html>`
}

// Keep backward-compatible export for existing tests that import HTML_PAGE
export const HTML_PAGE = buildHtmlPage([])
