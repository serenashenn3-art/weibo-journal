const $ = (id) => document.getElementById(id);

// 保持 service worker 存活：popup 打开期间连接不断
chrome.runtime.connect({ name: 'keep-alive' });

let state = { running: false, checkpoint: null, profile: null };

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res); });
  });
}

function render() {
  const cp = state.checkpoint;
  const running = state.running && cp && cp.phase !== 'done';
  const hasWork = cp && cp.phase && cp.phase !== 'done';
  const done = cp && cp.phase === 'done';

  $('btnStart').disabled = running || !currentUid();
  $('btnStart').textContent = done ? '再次抓取（增量）' : hasWork && !running ? '抓取中（可继续）' : '开始导出';
  $('btnPause').disabled = !running;
  $('btnResume').disabled = running || !hasWork;
  $('btnExport').disabled = !(cp && (cp.phase === 'done' || hasWork));

  if (state.profile) {
    $('uidInput').placeholder = `当前：${state.profile.screen_name}（${state.profile.uid}）`;
  }
  if (hasWork || done) $('progress').classList.remove('hidden');
  if (!hasWork && !done) $('progress').classList.add('hidden');
  if (state.stats && state.stats.errors && state.stats.errors.length) {
    $('errBox').innerHTML = state.stats.errors
      .slice(-3)
      .map((e) => `<div>⚠ ${escapeHtml(e.msg)}</div>`)
      .join('');
  }
  if (!hasWork && !done) $('progress').classList.add('hidden');
  if (done) {
    $('phaseLabel').textContent = '抓取完成，可到导出页生成手账本';
  }
}

function currentUid() {
  const v = $('uidInput').value.trim();
  if (v) return v;
  if (state.profile && state.profile.uid) return state.profile.uid;
  if (state.pageConfig && state.pageConfig.uid) return state.pageConfig.uid;
  return '';
}

function renderProgress(p) {
  if (!p || p.idle) return;
  $('progress').classList.remove('hidden');
  $('phaseLabel').textContent = p.phaseLabel || p.phase;
  $('stTimeline').textContent = p.timeline ?? '0';
  $('stTotal').textContent = p.statusesCount || '?';
  $('stFoot').textContent = p.footprint ?? '0';
  if (p.stats) {
    $('stImgOk').textContent = p.stats.imagesOk;
    $('stImgFail').textContent = p.stats.imagesFail;
    $('stVidOk').textContent = p.stats.videosOk;
    $('stVidFail').textContent = p.stats.videosFail;
    $('stArtOk').textContent = p.stats.articlesOk || 0;
    $('stArtFail').textContent = p.stats.articlesFail || 0;
  }
  if (typeof p.mediaTotal === 'number' && p.mediaTotal > 0) {
    const pct = Math.round(((p.mediaDone || 0) / p.mediaTotal) * 100);
    $('barFill').style.width = `${pct}%`;
  } else if (p.statusesCount > 0) {
    const pct = Math.min(100, Math.round(((p.timeline || 0) / p.statusesCount) * 100));
    $('barFill').style.width = `${pct}%`;
  }
  if (p.stats && p.stats.errors && p.stats.errors.length) {
    $('errBox').innerHTML = p.stats.errors
      .slice(-3)
      .map((e) => `<div>⚠ ${escapeHtml(e.msg)}</div>`)
      .join('');
  }
  if (p.fatal) {
    $('errBox').innerHTML = `<div>⚠ ${escapeHtml(p.fatal)}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'progress') {
    renderProgress(msg);
    if (msg.phase) refreshState();
  }
});

async function refreshState() {
  state = (await send({ type: 'get-state' })) || state;
  if (state.options) {
    $('optImages').checked = state.options.images !== false;
    $('optArticles').checked = state.options.articles !== false;
    $('optVideo').checked = !!state.options.video;
    $('optLikes').checked = state.options.likes !== false;
    $('optComments').checked = state.options.comments !== false;
  }
  render();
}

$('uidInput').addEventListener('input', render);

$('btnStart').addEventListener('click', async () => {
  const uid = currentUid();
  if (!uid) { $('loginStatus').textContent = '请先填写 UID（登录 weibo.com 可自动获取）'; return; }
  $('btnStart').disabled = true;
  const res = await send({
    type: 'start',
    uid,
    options: {
      images: $('optImages').checked,
      articles: $('optArticles').checked,
      video: $('optVideo').checked,
      likes: $('optLikes').checked,
      comments: $('optComments').checked,
    },
  });
  if (res && res.ok === false) {
    $('loginStatus').textContent = `开始失败：${res.error}`;
  }
  await refreshState();
});

$('btnPause').addEventListener('click', async () => {
  await send({ type: 'pause' });
  await refreshState();
});

$('btnResume').addEventListener('click', async () => {
  await send({ type: 'resume' });
  await refreshState();
});

$('btnReset').addEventListener('click', async () => {
  if (!confirm('确定清空已抓取的微博和媒体数据？此操作不可恢复。')) return;
  await send({ type: 'reset' });
  $('progress').classList.add('hidden');
  $('barFill').style.width = '0%';
  await refreshState();
});

$('btnExport').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('export/export.html') });
});

// 初始化：读状态 + 检测登录
(async () => {
  await refreshState();
  const login = await send({ type: 'detect-login' });
  if (login && login.uid) {
    state.profile = { uid: login.uid, screen_name: login.screen_name, statuses_count: login.statuses_count };
    $('loginStatus').textContent = `已登录微博：${login.screen_name}（共 ${login.statuses_count} 条）`;
    if (!$('uidInput').value) $('uidInput').placeholder = `当前：${login.screen_name}（${login.uid}）`;
  } else {
    $('loginStatus').textContent = '未检测到 weibo.com 登录（可先登录，或直接填 UID）';
  }
  if (state.pageConfig && state.pageConfig.uid && !state.profile) {
    $('uidInput').placeholder = `页面检测到：${state.pageConfig.screen_name || ''}（${state.pageConfig.uid}）`;
  }
  render();
})();
