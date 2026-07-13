function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function buildAccountFilterHtml(
  accounts: { platform: string; account: string }[],
  selectedAccount: string | undefined,
): string {
  // Determine which platforms have more than one account
  const platformCounts = new Map<string, number>()
  for (const { platform } of accounts) {
    platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + 1)
  }
  const isMultiAccount = [...platformCounts.values()].some(c => c > 1)
  if (!isMultiAccount) return ''

  // Collect distinct account names
  const accountNames = [...new Set(accounts.map(a => a.account))]

  const options = [
    `<option value=""${!selectedAccount ? ' selected' : ''}>All Accounts</option>`,
    ...accountNames.map(name =>
      `<option value="${escHtml(name)}"${selectedAccount === name ? ' selected' : ''}>${escHtml(name)}</option>`,
    ),
  ].join('\n        ')

  return `<div id="account-filter" style="padding:6px 8px;border-bottom:1px solid #ddd;">
      <select id="account-select" style="padding:4px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;cursor:pointer;" onchange="location.href='/?account='+encodeURIComponent(this.value)">
        ${options}
      </select>
    </div>`
}

export const CHATS_JS = `
    function isDirectChat(c) { return c.type === 'private' || c.type === 'user'; }
    function platformLabel(p) {
      var icon = PLATFORM_ICONS[p];
      return icon || '<span style="font-weight:700;font-size:12px">' + esc(p.charAt(0).toUpperCase()) + '</span>';
    }

    function renderPlatformFilter() {
      var platformFilter = document.getElementById('platform-filter');
      var platforms = [...new Set(allChats.map(function(c) { return c.platform; }))].sort();
      platformFilter.innerHTML = '';
      var allBtn = document.createElement('button');
      allBtn.dataset.platform = 'all'; allBtn.textContent = 'All';
      if (activePlatform === 'all') allBtn.classList.add('active');
      platformFilter.appendChild(allBtn);
      platforms.forEach(function(p) {
        var btn = document.createElement('button');
        btn.dataset.platform = p; btn.innerHTML = platformLabel(p); btn.title = p;
        if (activePlatform === p) btn.classList.add('active');
        platformFilter.appendChild(btn);
      });
    }

    function renderChatList() {
      chatList.innerHTML = '';
      var filtered = allChats;
      if (activeType === 'direct') filtered = filtered.filter(isDirectChat);
      else if (activeType !== 'all') filtered = filtered.filter(function(c) { return c.type === activeType; });
      if (activePlatform !== 'all') filtered = filtered.filter(function(c) { return c.platform === activePlatform; });
      filtered.forEach(function(c) {
        var el = document.createElement('div');
        el.className = 'chat-item'; el.dataset.chatId = c.chat_id;
        var isGroup = c.type === 'group';
        var typeClass = isGroup ? 'group' : isDirectChat(c) ? 'private' : '';
        var showAccount = MULTI_ACCOUNT_PLATFORMS.has(c.platform) && c.account;
        var accountLabel = showAccount ? ' (' + esc(c.account) + ')' : '';
        el.innerHTML = '<div class="chat-name">' + esc(c.name) + '</div>' +
          '<div class="chat-meta"><span class="badge ' + typeClass + '">' + platformLabel(c.platform) + (isGroup ? ' Group' : '') + accountLabel + '</span>' +
          '<span>' + c.message_count + ' msgs</span></div>';
        el.addEventListener('click', function() {
          document.querySelectorAll('.chat-item').forEach(function(x) { x.classList.remove('active'); });
          el.classList.add('active');
          currentChatType = c.type;
          openThread(c.chat_id);
        });
        chatList.appendChild(el);
      });
    }
`
