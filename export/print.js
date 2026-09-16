// 打印页：从 IndexedDB 构建完整手账本，图片/视频用 blob 地址，随后可打印或另存为 PDF
import { getMeta, allPosts, openDB } from '../lib/db.js';
import { buildJournal } from '../lib/journal.js';

const $ = (id) => document.getElementById(id);
let lastFetch = 0;
const filters = (() => { try { return JSON.parse(localStorage.getItem('wj-print-filters') || '{}'); } catch (e) { return {}; } })();

function loadmsg(t, pct) {
  if ($('loadmsg')) $('loadmsg').textContent = t;
  if (typeof pct === 'number' && $('loadfill')) $('loadfill').style.width = `${pct}%`;
}

function matchFilters(p) {
  const isRt = p.category === 'repost' || !!p.retweeted;
  const catOk = (isRt && filters.repost !== false) || (!isRt && filters.original !== false);
  if (!catOk) return false;
  const hasPics = (p.pics || []).length > 0 || (p.retweeted && (p.retweeted.pics || []).length > 0);
  const hasVideo = !!(p.video && p.video.url);
  if (!filters.pics && !filters.video && !filters.textonly) return true;
  if (filters.pics && hasPics) return true;
  if (filters.video && hasVideo) return true;
  if (filters.textonly && !hasPics && !hasVideo) return true;
  return false;
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

async function main() {
  loadmsg('读取微博数据…', 5);
  const [profile, stats, failedMedia, all] = await Promise.all([
    getMeta('profile'), getMeta('stats'), getMeta('failedMedia'), allPosts(),
  ]);
  const posts = all || [];
  if (!posts.length) {
    document.body.innerHTML = '<div style="max-width:420px;margin:120px auto;text-align:center">还没有数据，请先在插件里完成抓取。</div>';
    return;
  }

  // 构建 blob 地址映射
  const mediaMap = new Map();
  const videoMap = new Map();
  const need = [];
  for (const p of posts) {
    if (p.source !== 'timeline' && p.source !== 'like') continue;
    if (p.source === 'timeline' && !matchFilters(p)) continue;
    (p.pics || []).forEach((u) => need.push(u));
    if (p.video && p.video.url) need.push({ v: p.video.url, mid: p.mid });
    if (p.retweeted && p.retweeted.pics) p.retweeted.pics.forEach((u) => need.push(u));
  }
  let done = 0;
  for (const item of need) {
    const url = typeof item === 'string' ? item : item.v;
    let blob = null;
    try {
      const rec = await readBlob(url);
      if (rec && rec.ok) blob = rec.blob;
    } catch (e) { /* 本地缺失，尝试回补 */ }
    if (!blob) {
      try {
        const gap = Date.now() - lastFetch;
        if (gap < 400) await new Promise((r) => setTimeout(r, 400 - gap));
        lastFetch = Date.now();
        const res = await fetch(url, { credentials: 'include' });
        if (res.ok) blob = await res.blob();
      } catch (e) { /* 放弃，显示占位 */ }
    }
    if (blob) {
      const objUrl = URL.createObjectURL(blob);
      if (typeof item === 'object') videoMap.set(item.mid, objUrl);
      else if (!mediaMap.has(url)) mediaMap.set(url, objUrl);
    }
    done++;
    if (done % 50 === 0) loadmsg(`装载媒体 ${done}/${need.length}…`, 10 + Math.round((done / need.length) * 80));
  }

  let avatarRel = '';
  if (profile && profile.avatar_hd) {
    try {
      const rec = await readBlob(profile.avatar_hd);
      if (rec && rec.ok) avatarRel = URL.createObjectURL(rec.blob);
    } catch (e) { /* 忽略 */ }
  }

  loadmsg('生成手账本页面…', 95);
  const included = posts.filter((p) => p.source !== 'timeline' || matchFilters(p));
  const html = buildJournal({
    profile: { ...profile, avatar_rel: avatarRel },
    posts: included,
    stats,
    mediaMap,
    videoMap,
    failedMedia: failedMedia || [],
    initialFilters: {
      original: filters.original !== false,
      repost: filters.repost !== false,
      pics: !!filters.pics,
      video: !!filters.video,
      textonly: !!filters.textonly,
    },
  });

  document.open();
  document.write(html);
  document.close();

  // 打印工具条 + 自动呼出打印
  const bar = document.createElement('div');
  bar.id = 'pj-bar';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fff8ec;border-bottom:1px dashed #d8cfc0;padding:10px 16px;text-align:center;font:14px "PingFang SC",sans-serif;color:#3a3632';
  bar.innerHTML = '<b>打印 / 另存为 PDF：</b>点右侧按钮，目标选「存储为 PDF」即可 '
    + '<button id="pj-print" style="margin-left:10px;padding:6px 18px;border:none;border-radius:7px;background:#d96f57;color:#fff;font-size:14px;cursor:pointer">🖨 打印 / 另存为 PDF</button> '
    + '<button id="pj-hide" style="margin-left:8px;padding:6px 12px;border:1px solid #d8cfc0;border-radius:7px;background:#fff;cursor:pointer">隐藏</button>';
  document.body.appendChild(bar);
  document.body.style.paddingTop = '54px';
  document.getElementById('pj-print').onclick = () => window.print();
  document.getElementById('pj-hide').onclick = () => { bar.remove(); document.body.style.paddingTop = '0'; };

  // 等图片开个头后自动呼出打印（被拦截时点按钮即可）
  setTimeout(() => { try { window.print(); } catch (e) { /* 用户手动点按钮 */ } }, 1200);
}

main().catch((e) => {
  document.body.innerHTML = `<div style="max-width:480px;margin:120px auto;text-align:center;color:#b3402e">打印页生成失败：${e.message}</div>`;
});
