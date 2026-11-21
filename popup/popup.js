// RePost for X — Popup Script

const toggle = document.getElementById('enabled-toggle');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

// Load current state
(async () => {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  toggle.checked = response?.enabled ?? true;

  const status = response?.lastStatus;
  if (status) {
    const when = status.at ? ` · ${new Date(status.at).toLocaleString()}` : '';
    if (status.type === 'ready' || status.type === 'success') {
      statusDot.className = 'popup-status-dot success';
      statusText.textContent = `✓ Composer filled — post it from X${when}`;
    } else if (status.type === 'error') {
      statusDot.className = 'popup-status-dot error';
      statusText.textContent = `Error: ${status.message}${when}`;
    }
  }
})();

// Toggle handler
toggle.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: 'SET_STATE', enabled: toggle.checked });

  // Notify all x.com tabs
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'TOGGLE_ENABLED',
      enabled: toggle.checked,
    }).catch(() => {}); // ignore tabs where content script isn't injected
  }
});
