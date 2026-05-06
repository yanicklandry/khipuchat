export const HTML_PAGE = `<!DOCTYPE html>
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
    #search-bar button { padding: 8px 16px; background: #0070f3; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
    #main { display: flex; flex: 1; overflow: hidden; }
    #sidebar { width: 280px; overflow-y: auto; background: #fff; border-right: 1px solid #ddd; }
    #panel { flex: 1; overflow-y: auto; padding: 16px; }
    .chat-item { padding: 12px 14px; border-bottom: 1px solid #f0f0f0; cursor: pointer; }
    .chat-item:hover { background: #f7f7f7; }
    .chat-item.active { background: #e8f0fe; }
    .chat-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chat-meta { display: flex; justify-content: space-between; margin-top: 4px; font-size: 12px; color: #888; }
    .badge { background: #6c757d; color: #fff; border-radius: 4px; padding: 1px 5px; font-size: 11px; }
    .msg { display: flex; flex-direction: column; margin: 8px 0; }
    .msg.sent { align-items: flex-end; }
    .msg.received { align-items: flex-start; }
    .msg-bubble { max-width: 65%; padding: 8px 12px; border-radius: 12px; font-size: 14px; line-height: 1.4; }
    .msg.sent .msg-bubble { background: #0070f3; color: #fff; }
    .msg.received .msg-bubble { background: #fff; border: 1px solid #ddd; }
    .msg-meta { font-size: 11px; color: #aaa; margin-top: 3px; }
    .msg-media { font-style: italic; color: #888; }
    .result-item { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 8px 0; cursor: pointer; }
    .result-item:hover { background: #f7f7f7; }
    .result-chat { font-weight: 600; font-size: 13px; }
    .result-text { font-size: 14px; margin-top: 4px; }
    .result-meta { display: flex; gap: 8px; margin-top: 6px; font-size: 12px; color: #888; }
    #placeholder { color: #aaa; text-align: center; margin-top: 80px; font-size: 16px; }
  </style>
</head>
<body>
  <div id="search-bar">
    <input id="q" type="text" placeholder="Search messages…" />
    <button id="search-btn">Search</button>
  </div>
  <div id="main">
    <div id="sidebar"></div>
    <div id="panel"><div id="placeholder">Select a chat to view messages</div></div>
  </div>
  <script>
    const sidebar = document.getElementById('sidebar');
    const panel = document.getElementById('panel');
    const qInput = document.getElementById('q');
    const searchBtn = document.getElementById('search-btn');

    function ts(t) {
      return new Date(t * 1000).toLocaleString();
    }

    async function loadChats() {
      const res = await fetch('/api/chats');
      const chats = await res.json();
      sidebar.innerHTML = '';
      chats.forEach(c => {
        const el = document.createElement('div');
        el.className = 'chat-item';
        el.dataset.chatId = c.chat_id;
        el.innerHTML = \`
          <div class="chat-name">\${esc(c.name)}</div>
          <div class="chat-meta">
            <span class="badge">\${esc(c.platform)}</span>
            <span>\${c.message_count} msgs</span>
          </div>\`;
        el.addEventListener('click', () => {
          document.querySelectorAll('.chat-item').forEach(x => x.classList.remove('active'));
          el.classList.add('active');
          loadThread(c.chat_id);
        });
        sidebar.appendChild(el);
      });
    }

    async function loadThread(chatId) {
      const res = await fetch('/api/messages/' + chatId);
      const msgs = await res.json();
      panel.innerHTML = '';
      if (msgs.length === 0) {
        panel.innerHTML = '<div id="placeholder">No messages found</div>';
        return;
      }
      msgs.forEach(m => {
        const sent = m.is_sender === 1;
        const text = m.text || '<em class="msg-media">[media]</em>';
        const el = document.createElement('div');
        el.className = 'msg ' + (sent ? 'sent' : 'received');
        el.innerHTML = \`
          <div class="msg-bubble">\${sent ? '' : '<strong>' + esc(m.sender_name || '') + '</strong><br>'}\${typeof m.text === 'string' ? esc(m.text) : '<em class="msg-media">[media]</em>'}</div>
          <div class="msg-meta"><span class="badge">\${esc(m.platform)}</span> \${ts(m.timestamp)}</div>\`;
        panel.appendChild(el);
      });
    }

    async function doSearch() {
      const q = qInput.value.trim();
      if (!q) return;
      const res = await fetch('/api/search?q=' + encodeURIComponent(q));
      const results = await res.json();
      panel.innerHTML = '';
      document.querySelectorAll('.chat-item').forEach(x => x.classList.remove('active'));
      if (results.length === 0) {
        panel.innerHTML = '<div id="placeholder">No results for "' + esc(q) + '"</div>';
        return;
      }
      results.forEach(r => {
        const el = document.createElement('div');
        el.className = 'result-item';
        el.dataset.chatId = r.chat_id;
        el.innerHTML = \`
          <div class="result-chat">\${esc(r.chat_name)} <span class="badge">\${esc(r.platform)}</span></div>
          <div class="result-text">\${r.sender_name ? '<strong>' + esc(r.sender_name) + '</strong>: ' : ''}\${esc(r.text || '')}</div>
          <div class="result-meta"><span>\${ts(r.timestamp)}</span></div>\`;
        el.addEventListener('click', () => {
          document.querySelectorAll('.chat-item').forEach(x => {
            if (x.dataset.chatId === String(r.chat_id)) x.classList.add('active');
            else x.classList.remove('active');
          });
          loadThread(r.chat_id);
        });
        panel.appendChild(el);
      });
    }

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    searchBtn.addEventListener('click', doSearch);
    qInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

    loadChats();
  </script>
</body>
</html>`
