import { openDB, getMeta, setMeta, allPosts } from '../lib/db.js';
import { imageRelPath, videoRelPath, extOf } from '../lib/imager.js';
import { buildJournal } from '../lib/journal.js';
import { createZip } from '../lib/zip.js';

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

let profile, posts, stats, failedMedia;

function log(msg, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = msg;
  $('log').appendChild(div);
  div.scrollIntoView({ block: 'nearest' });
}

async function loadData() {
  // 显式设定筛选框默认值，避免浏览器表单恢复干扰
  $('fOriginal').checked = true;
  $('fRepost').checked = true;
  $('fPics').checked = false;
  $('fVideo').checked = false;
  $('fText').checked = false;
  [profile, stats, failedMedia] = await Promise.all([
    getMeta('profile'), getMeta('stats'), getMeta('failedMedia'),
  ]);
  posts = (await allPosts()) || [];
  const timeline = posts.filter((p) => p.source === 'timeline');
  const foot = posts.length - timeline.length;
  const nOriginal = timeline.filter((p) => p.category !== 'repost').length;
  const mediaCount = posts.reduce((n, p) => {
    let c = (p.pics || []).length + (p.retweeted && p.retweeted.pics ? p.retweeted.pics.length : 0);
    if (p.video && p.video.url) c += 1;
    return n + c;
  }, 0);
  $('stats').innerHTML =
    `时间线 <b>${timeline.length}</b> 条` +
    `（原创 <b>${nOriginal}</b> · 转发 <b>${timeline.length - nOriginal}</b>）` +
    (profile && profile.statuses_count ? ` / 账号共 <b>${profile.statuses_count}</b> 条` : '') +
    (foot ? ` · 足迹 <b>${foot}</b> 条` : '') +
    ` · 媒体 <b>${mediaCount}</b> 个` +
    (failedMedia && failedMedia.length ? ` · 已记录失败 <b>${failedMedia.length}</b> 个` : '');
  const hasDir = !!(await getMeta('dirHandle'));
  $('btnReuse').classList.toggle('hidden', !hasDir);
  if (!posts.length) {
    log('还没有抓到任何微博。请先在插件弹窗里点击「开始导出」。', 'err');
    ['btnPick', 'btnReuse', 'btnZip'].forEach((id) => { $(id).disabled = true; });
  }
}

// ---------- 与 crawl.js 保持一致的媒体清单 ----------

// 分类筛选：与手账本内的筛选语义一致
function readFilters() {
  return {
    original: $('fOriginal').checked,
    repost: $('fRepost').checked,
    pics: $('fPics').checked,
    video: $('fVideo').checked,
    textonly: $('fText').checked,
  };
}

function matchFilters(p, f) {
  const isRt = p.category === 'repost' || !!p.retweeted;
  const catOk = (isRt && f.repost) || (!isRt && f.original);
  if (!catOk) return false;
  const hasPics = (p.pics || []).length > 0 || (p.retweeted && (p.retweeted.pics || []).length > 0);
  const hasVideo = !!(p.video && p.video.url);
  if (!f.pics && !f.video && !f.textonly) return true;
  if (f.pics && hasPics) return true;
  if (f.video && hasVideo) return true;
  if (f.textonly && !hasPics && !hasVideo) return true;
  return false;
}

// kind: img=原创图, rtimg=转发图, video=视频
function buildPlan(filters) {
  const items = [];
  for (const p of posts) {
    if (p.source !== 'timeline' && p.source !== 'like') continue;
    if (p.source === 'timeline' && filters && !matchFilters(p, filters)) continue;
    (p.pics || []).forEach((url, i) => items.push({ url, mid: p.mid, idx: i, kind: 'img', ts: p.created_at }));
    if (p.video && p.video.url) items.push({ url: p.video.url, mid: p.mid, kind: 'video', ts: p.created_at });
    if (p.retweeted && p.retweeted.pics) {
      p.retweeted.pics.forEach((url, i) => items.push({ url, mid: `${p.mid}_rt`, idx: i, kind: 'rtimg', ts: p.created_at }));
    }
  }
  return items;
}

function relFor(item) {
  if (item.kind === 'video') return videoRelPath(item.mid, item.ts);
  return imageRelPath(item.url, item.mid, item.idx, item.ts, item.kind === 'rtimg' ? 'repost' : 'original');
}

// ---------- 写文件 ----------

async function ensureDir(root, path) {
  const parts = path.split('/').filter(Boolean);
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = await cur.getDirectoryHandle(part, { create: true });
  }
  return cur;
}

async function writeToDir(root, path, data) {
  const dir = await ensureDir(root, path);
  const name = path.split('/').filter(Boolean).pop();
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function readBlob(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('media', 'readonly');
    const req = t.objectStore('media').get(url);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 读本地媒体；缺失时从微博实时回补（带限速，成功后回写本地库）
let lastBackfill = 0;
async function readBlobOrFetch(item) {
  try {
    const rec = await readBlob(item.url);
    if (rec && rec.ok && rec.blob && rec.blob.size > 0) return rec.blob;
  } catch (e) { /* 本地缺失 */ }
  const gap = Date.now() - lastBackfill;
  if (gap < 400) await new Promise((r) => setTimeout(r, 400 - gap));
  lastBackfill = Date.now();
  const res = await fetch(item.url, { credentials: 'include' });
  if (!res.ok) throw new Error(`回补下载 HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob || blob.size === 0) throw new Error('回补内容为空');
  if (item.kind !== 'video' && blob.type && !blob.type.startsWith('image/')) {
    throw new Error(`回补返回非图片内容 ${blob.type}`);
  }
  try {
    const { putMedia } = await import('../lib/db.js');
    await putMedia({ url: item.url, blob, kind: item.kind, mid: item.mid, ok: true, ts: Date.now() });
  } catch (e) { /* 回写失败不影响导出 */ }
  return blob;
}

// ---------- 主流程 ----------

async function gatherFiles(filters, onItem) {
  // 返回 { files, mediaMap, videoMap, avatarRel, postsIncluded }
  const mediaMap = new Map();
  const videoMap = new Map();
  const files = [];
  const plan = buildPlan(filters);
  const postsIncluded = posts.filter((p) => p.source !== 'timeline' || !filters || matchFilters(p, filters));
  let done = 0;

  for (const item of plan) {
    const rel = relFor(item);
    try {
      const blob = await readBlobOrFetch(item);
      if (item.kind === 'video') {
        videoMap.set(item.mid, rel);
      } else if (!mediaMap.has(item.url)) {
        mediaMap.set(item.url, rel);
      }
      files.push({ path: rel, data: blob });
      if (blob._backfilled) log(`回补成功：${rel}`);
    } catch (e) {
      log(`读取媒体失败 ${item.url}: ${e.message}`, 'err');
    }
    done++;
    if (onItem && done % 25 === 0) onItem(done, plan.length);
  }

  // 头像（本地没有则直接下载，头像不参与抓取期限速）
  let avatarRel = '';
  if (profile && profile.avatar_hd) {
    try {
      let blob = null;
      try {
        const rec = await readBlob(profile.avatar_hd);
        if (rec && rec.ok && rec.blob && rec.blob.size > 0) blob = rec.blob;
      } catch (e) { /* 本地没有 */ }
      if (!blob) {
        const res = await fetch(profile.avatar_hd, { credentials: 'include' });
        if (!res.ok) throw new Error(String(res.status));
        blob = await res.blob();
        if (!blob || blob.size === 0) throw new Error('头像内容为空');
      }
      avatarRel = `images/avatar.${extOf(profile.avatar_hd)}`;
      if (!mediaMap.has(profile.avatar_hd)) mediaMap.set(profile.avatar_hd, avatarRel);
      files.push({ path: avatarRel, data: blob });
    } catch (e) { log(`头像下载失败（不影响正文）：${e.message}`); }
  }

  return { files, mediaMap, videoMap, avatarRel, postsIncluded };
}

function buildStaticFiles(mediaMap, videoMap, avatarRel, filters) {
  const postsIncluded = posts.filter((p) => p.source !== 'timeline' || !filters || matchFilters(p, filters));
  const journal = buildJournal({
    profile: { ...profile, avatar_rel: avatarRel },
    posts: postsIncluded, stats, mediaMap, videoMap, failedMedia: failedMedia || [],
    initialFilters: filters || {},
  });
  const dataJson = JSON.stringify({ profile, posts: postsIncluded, stats, failedMedia: failedMedia || [], exported_at: new Date().toISOString() }, null, 2);
  const timelineCount = postsIncluded.filter((p) => p.source === 'timeline').length;
  const nOriginal = postsIncluded.filter((p) => p.source === 'timeline' && p.category !== 'repost').length;
  const nRepost = timelineCount - nOriginal;
  const report = [
    '微博手账本 · 导出报告',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    `用户：${profile ? profile.screen_name : ''}（uid: ${profile ? profile.uid : ''}）`,
    `本次范围：原创 ${nOriginal} 条 · 转发 ${nRepost} 条` + (filters && (filters.pics || filters.video || filters.textonly) ? '（含媒体筛选）' : ''),
    `时间线微博合计：${timelineCount} 条` + (profile && profile.statuses_count ? ` / 账号共 ${profile.statuses_count} 条` : ''),
    `足迹（点赞/评论）：${postsIncluded.length - timelineCount} 条`,
    `媒体文件：${mediaMap.size} 张图片（原创图在 images/original，转发图在 images/repost），${videoMap.size} 个视频`,
    `媒体失败：${(failedMedia || []).length} 个（明细见 data.json 的 failedMedia 字段）`,
    '',
    '说明：点赞/评论足迹受微博接口限制，仅包含平台保留的最近记录。',
  ].join('\n');
  return [
    { path: '手账本.html', text: journal },
    { path: 'data.json', text: dataJson },
    { path: '导出报告.txt', text: report },
  ];
}

async function doExport(root) {
  $('btnPick').disabled = $('btnReuse').disabled = $('btnZip').disabled = true;
  const filters = readFilters();
  if (!filters.original && !filters.repost) {
    log('请至少勾选「原创」或「转发」之一。', 'err');
    $('btnPick').disabled = $('btnZip').disabled = false;
    $('btnReuse').disabled = false;
    return;
  }
  log('开始整理媒体文件…');
  const t0 = Date.now();
  const { files, mediaMap, videoMap, avatarRel } = await gatherFiles(filters, (d, t) => {
    if (d % 100 === 0) log(`媒体整理 ${d}/${t}…`);
  });
  log(`媒体就绪：图片 ${mediaMap.size} 张，视频 ${videoMap.size} 个（${((Date.now() - t0) / 1000).toFixed(1)}s）`, 'ok');

  const statics = buildStaticFiles(mediaMap, videoMap, avatarRel, filters);
  const total = files.length + statics.length;
  let written = 0;
  for (const f of files) {
    await writeToDir(root, f.path, f.data);
    written++;
    if (written % 50 === 0) log(`写入文件 ${written}/${total}…`);
  }
  for (const s of statics) {
    await writeToDir(root, s.path, enc.encode(s.text));
    written++;
  }
  log(`完成！共写入 ${written} 个文件。打开文件夹里的「手账本.html」即可翻阅。`, 'ok');
  $('btnPick').disabled = $('btnZip').disabled = false;
  $('btnReuse').disabled = false;
}

$('btnPick').addEventListener('click', async () => {
  try {
    const root = await window.showDirectoryPicker({ mode: 'readwrite' });
    await setMeta('dirHandle', root);
    $('btnReuse').classList.remove('hidden');
    await doExport(root);
  } catch (e) {
    if (e.name !== 'AbortError') log(`导出失败：${e.message}`, 'err');
  }
});

$('btnReuse').addEventListener('click', async () => {
  try {
    const root = await getMeta('dirHandle');
    if (!root) throw new Error('没有上次的文件夹记录');
    let perm = await root.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await root.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('未获得文件夹写入权限');
    await doExport(root);
  } catch (e) {
    log(`导出失败：${e.message}`, 'err');
  }
});

// 打印 / PDF：把当前勾选的分类传给打印页，新标签页生成完整手账本并呼出打印
$('btnPrint').addEventListener('click', () => {
  try {
    localStorage.setItem('wj-print-filters', JSON.stringify(readFilters()));
    chrome.tabs.create({ url: chrome.runtime.getURL('export/print.html') });
  } catch (e) {
    log(`打开打印页失败：${e.message}`, 'err');
  }
});

// 免选择的文件夹导出：经 chrome.downloads 直接写入下载目录的「微博手账本/」子目录
$('btnAuto').addEventListener('click', async () => {
  try {
    $('btnPick').disabled = $('btnReuse').disabled = $('btnZip').disabled = $('btnAuto').disabled = true;
    const filters = readFilters();
    log('开始整理媒体文件…');
    const { files, mediaMap, videoMap, avatarRel } = await gatherFiles(filters, (d, t) => {
      if (d % 200 === 0) log(`媒体整理 ${d}/${t}…`);
    });
    const statics = buildStaticFiles(mediaMap, videoMap, avatarRel, filters);
    const enc2 = new TextEncoder();
    const typeOf = (p) => (p.endsWith('.html') ? 'text/html;charset=utf-8'
      : p.endsWith('.json') ? 'application/json' : 'text/plain;charset=utf-8');
    const all = [
      ...files.map((f) => ({ path: f.path, blob: f.data })),
      ...statics.map((s) => ({ path: s.path, blob: new Blob([enc2.encode(s.text)], { type: typeOf(s.path) }) })),
    ];
    log(`开始写入 ${all.length} 个文件到 ~/Downloads/微博手账本/ …`);
    let done = 0;
    let failed = 0;
    for (const f of all) {
      const url = URL.createObjectURL(f.blob);
      try {
        await new Promise((resolve) => {
          chrome.downloads.download(
            { url, filename: `微博手账本/${f.path}`, conflictAction: 'overwrite' },
            (id) => {
              if (id === undefined) { failed++; resolve(); return; }
              const listener = (delta) => {
                if (delta.id !== id || !delta.state) return;
                if (delta.state.current === 'complete') { done++; chrome.downloads.onChanged.removeListener(listener); resolve(); }
                else if (delta.state.current === 'interrupted') { failed++; chrome.downloads.onChanged.removeListener(listener); resolve(); }
              };
              chrome.downloads.onChanged.addListener(listener);
            },
          );
        });
      } finally {
        URL.revokeObjectURL(url);
      }
      if ((done + failed) % 200 === 0) log(`写入 ${done + failed}/${all.length}…`);
    }
    log(`完成：成功 ${done}，失败 ${failed}。文件夹在 ~/Downloads/微博手账本/`, 'ok');
  } catch (e) {
    log(`自动导出失败：${e.message}`, 'err');
  } finally {
    $('btnPick').disabled = $('btnZip').disabled = $('btnAuto').disabled = false;
    $('btnReuse').disabled = false;
  }
});

$('btnZip').addEventListener('click', async () => {
  try {
    $('btnPick').disabled = $('btnReuse').disabled = $('btnZip').disabled = true;
    log('ZIP 打包会把所有文件载入内存，媒体很多时可能较慢…');
    const filters = readFilters();
    const { files, mediaMap, videoMap, avatarRel } = await gatherFiles(filters, null);
    const statics = buildStaticFiles(mediaMap, videoMap, avatarRel, filters);
    const entries = [];
    for (const f of files) entries.push({ name: f.path, data: new Uint8Array(await f.data.arrayBuffer()) });
    for (const s of statics) entries.push({ name: s.path, data: enc.encode(s.text) });
    log(`打包 ${entries.length} 个文件…`);
    const zipBytes = createZip(entries);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `微博手账本-${profile ? profile.screen_name : 'export'}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    log(`完成！ZIP 大小 ${(blob.size / 1024 / 1024).toFixed(1)} MB。`, 'ok');
  } catch (e) {
    log(`打包失败：${e.message}`, 'err');
  } finally {
    $('btnPick').disabled = $('btnZip').disabled = false;
    $('btnReuse').disabled = false;
  }
});

loadData();
