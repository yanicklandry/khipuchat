export const SCROLL_JS = `
  var _observer = null;
  var _isFetching = false;

  function scrollToBottom(container) {
    requestAnimationFrame(function() {
      container.scrollTop = container.scrollHeight;
    });
  }

  function attachScrollSentinel(container, chatId, oldestId, onOlderLoaded, hasMore) {
    // Disconnect any previous observer
    disconnectScroll();
    _isFetching = false;

    // No more pages to load — skip sentinel
    if (hasMore === false) return;

    // Insert sentinel as first child
    var sentinel = document.createElement('div');
    sentinel.id = 'scroll-sentinel';
    sentinel.style.height = '1px';
    container.insertBefore(sentinel, container.firstChild);

    _observer = new IntersectionObserver(function(entries) {
      if (!entries[0].isIntersecting) return;
      if (_isFetching) return;

      // Record first visible message before fetching
      var messages = container.querySelectorAll('.message');
      var firstVisible = null;
      for (var i = 0; i < messages.length; i++) {
        if (messages[i].getBoundingClientRect().top >= 0) {
          firstVisible = messages[i];
          break;
        }
      }

      _isFetching = true;

      // Show loading indicator
      var loading = document.getElementById('scroll-loading');
      if (!loading) {
        loading = document.createElement('div');
        loading.id = 'scroll-loading';
        loading.textContent = 'Loading older messages...';
        loading.style.cssText = 'text-align:center;padding:8px;color:#888;font-size:0.85em;';
        container.insertBefore(loading, sentinel.nextSibling);
      }
      loading.style.display = 'block';

      // Remove any previous error
      var prevError = document.getElementById('scroll-error');
      if (prevError) prevError.remove();

      fetch('/api/messages/' + chatId + '?before=' + oldestId + '&limit=50')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var msgs = data.messages || [];
          if (loading) loading.style.display = 'none';

          if (msgs.length > 0) {
            onOlderLoaded(msgs);
            // Restore scroll position
            if (firstVisible) {
              var offsetBefore = firstVisible.offsetTop - container.offsetTop;
              firstVisible.scrollIntoView({ block: 'start' });
              // Fallback: manual offset restore
              container.scrollTop = firstVisible.offsetTop - container.offsetTop;
            }
          }

          if (data.has_more === false) {
            disconnectScroll();
            var s = document.getElementById('scroll-sentinel');
            if (s) s.remove();
          } else {
            _isFetching = false;
          }
        })
        .catch(function(err) {
          if (loading) loading.style.display = 'none';
          _isFetching = false;

          var errDiv = document.getElementById('scroll-error');
          if (!errDiv) {
            errDiv = document.createElement('div');
            errDiv.id = 'scroll-error';
            errDiv.style.cssText = 'text-align:center;padding:8px;color:#c00;font-size:0.85em;';
          }
          errDiv.innerHTML = 'Failed to load older messages. ';
          var retryBtn = document.createElement('button');
          retryBtn.textContent = 'Retry';
          retryBtn.onclick = function() {
            errDiv.remove();
            attachScrollSentinel(container, chatId, oldestId, onOlderLoaded);
          };
          errDiv.appendChild(retryBtn);
          var s = document.getElementById('scroll-sentinel');
          if (s) {
            container.insertBefore(errDiv, s.nextSibling);
          } else {
            container.insertBefore(errDiv, container.firstChild);
          }
        });
    }, { threshold: 0, rootMargin: '100px' });

    _observer.observe(sentinel);
  }

  function disconnectScroll() {
    if (_observer) {
      _observer.disconnect();
      _observer = null;
    }
  }
`;
