import { runCrawl, initProfile } from '../lib/crawl.js';
import { detectLogin } from '../lib/api.js';
import { getMeta, setMeta, resetAll } from '../lib/db.js';

let activeLoop = false;
let runningFlag = false;
let pauseRequested = false;
let keepAlivePort = null;

async function refreshRunningFlag() {
  runningFlag = !!(await getMeta('running'));
}

async function ensureAlarm() {
  const alarms = await chrome.alarms.getAll();
  if (!alarms.some((a) => a.name === 'crawl-resume')) {
    await chrome.alarms.create('crawl-resume', { periodInMinutes: 1 });
  }
}

async function clearAlarm() {
  await chrome.alarms.clear('crawl-resume');
}

function broadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
  } catch (e) { /* 无接收者时忽略 */ }
}

async function kickLoop() {
  if (activeLoop) return;
  activeLoop = true;
  try {
    for (;;) {
      await refreshRunningFlag();
      if (!runningFlag) break;
      pauseRequested = false;
      await runCrawl({
        shouldStop: () => pauseRequested || !runningFlag,
        onProgress: (p) => broadcast({ type: 'progress', ...p }),
      });
      await refreshRunningFlag();
      if (!runningFlag) break;
      // 连续失败导致 runCrawl 提前交还控制时，稍等再进（由 alarm 兜底唤醒）
      await new Promise((r) => setTimeout(r, 10000));
    }
  } catch (e) {
    broadcast({ type: 'progress', fatal: e.message });
  } finally {
    activeLoop = false;
    await clearAlarm();
    broadcast({ type: 'progress', phase: 'idle', idle: true });
  }
}

async function startCrawl(uid, options) {
  const prev = await getMeta('profile');
  if (!prev || prev.uid !== String(uid)) {
    await resetAll();
  }
  await setMeta('options', options);
  await initProfile(uid);
  // 已完成状态下再点「开始」= 增量重扫：重建断点（数据保留，靠 mid 去重）
  const cp = await getMeta('checkpoint');
  if (cp && cp.phase === 'done') {
    cp.phase = 'phaseA';
    cp.a = {}; cp.b = {}; cp.lt = { idx: 0 }; cp.media = null; cp.likes = {}; cp.cmt = {};
    await setMeta('checkpoint', cp);
  }
  await setMeta('running', true);
  runningFlag = true;
  await ensureAlarm();
  kickLoop();
}

async function getState() {
  const [profile, checkpoint, stats, failedMedia, running, pageConfig, options] = await Promise.all([
    getMeta('profile'), getMeta('checkpoint'), getMeta('stats'),
    getMeta('failedMedia'), getMeta('running'), getMeta('pageConfig'), getMeta('options'),
  ]);
  return {
    profile, checkpoint, stats, failedMedia: failedMedia || [],
    running: !!running, pageConfig, options,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'page-config':
        await setMeta('pageConfig', { uid: msg.uid, screen_name: msg.screen_name });
        sendResponse({ ok: true });
        break;
      case 'detect-login':
        sendResponse(await detectLogin().catch(() => null));
        break;
      case 'get-state':
        sendResponse(await getState());
        break;
      case 'start':
        try {
          await startCrawl(msg.uid, msg.options || {
            images: true, articles: true, video: false, likes: true, comments: true,
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      case 'pause':
        pauseRequested = true;
        runningFlag = false;
        await setMeta('running', false);
        sendResponse({ ok: true });
        break;
      case 'resume':
        await setMeta('running', true);
        runningFlag = true;
        pauseRequested = false;
        await ensureAlarm();
        kickLoop();
        sendResponse({ ok: true });
        break;
      case 'reset':
        pauseRequested = true;
        runningFlag = false;
        await resetAll();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse(null);
    }
  })();
  return true; // 异步响应
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'crawl-resume') {
    (async () => {
      await refreshRunningFlag();
      if (runningFlag && !activeLoop) kickLoop();
    })();
  }
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    await refreshRunningFlag();
    if (runningFlag) { await ensureAlarm(); kickLoop(); }
  })();
});

// 插件重载/更新后恢复
(async () => {
  await refreshRunningFlag();
  if (runningFlag) { await ensureAlarm(); kickLoop(); }
})();

// popup 保持连接期间 service worker 不会被回收
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keep-alive') {
    keepAlivePort = port;
    port.onDisconnect.addListener(() => { keepAlivePort = null; });
  }
});
