// 在 weibo.com 页面读取全局配置，把当前登录用户的 uid 交给插件
function readConfig() {
  try {
    const cfg = window.$CONFIG || {};
    return { uid: cfg.uid ? String(cfg.uid) : '', screen_name: cfg.nick || '' };
  } catch (e) {
    return { uid: '', screen_name: '' };
  }
}

setTimeout(() => {
  const c = readConfig();
  if (c.uid) {
    chrome.runtime.sendMessage(
      { type: 'page-config', uid: c.uid, screen_name: c.screen_name },
      () => { void chrome.runtime.lastError; },
    );
  }
}, 0);

// 插件主动询问页面配置（登录检测 / UID 获取）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'get-config') {
    sendResponse(readConfig());
  }
  return true;
});
