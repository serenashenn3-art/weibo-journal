export class ApiError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} @ ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
  get isRateLimited() {
    return this.status === 418 || this.status === 403 || this.status === 429 || this.status === 414 || this.status === 432;
  }
  get isAuthError() {
    return this.status === 401 || this.status === 40301;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIN_INTERVAL = 1200;
let lastHit = 0;
let xsrfToken = null;

async function throttle() {
  const wait = MIN_INTERVAL + Math.random() * 600;
  const now = Date.now();
  const gap = now - lastHit;
  if (gap < wait) await sleep(wait - gap);
  lastHit = Date.now();
}

export async function getXsrfToken() {
  if (xsrfToken) return xsrfToken;
  try {
    const c = await chrome.cookies.get({ url: 'https://weibo.com/', name: 'XSRF-TOKEN' });
    xsrfToken = c ? c.value : '';
  } catch (e) {
    xsrfToken = '';
  }
  return xsrfToken;
}

export function invalidateXsrf() {
  xsrfToken = null;
}

async function fetchJSON(url, { weiboHeaders = false, retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    await throttle();
    const headers = {};
    if (weiboHeaders) {
      const token = await getXsrfToken();
      headers['X-Requested-With'] = 'XMLHttpRequest';
      if (token) headers['X-Xsrf-Token'] = token;
    }
    let res;
    try {
      res = await fetch(url, { credentials: 'include', headers });
    } catch (e) {
      if (++attempt > retries) throw e;
      await sleep(1500 * attempt);
      continue;
    }
    if (res.status === 204) return null;
    if (!res.ok) {
      const err = new ApiError(res.status, url);
      if (err.isRateLimited && ++attempt <= retries) {
        await sleep(Math.min(30000, 2000 * 2 ** attempt) + Math.random() * 1000);
        continue;
      }
      throw err;
    }
    try {
      return await res.json();
    } catch (e) {
      throw new ApiError(200, url, 'bad-json');
    }
  }
}

// ---------- 微博接口 ----------

export function profileInfo(uid) {
  return fetchJSON(`https://weibo.com/ajax/profile/info?uid=${uid}`, { weiboHeaders: true });
}

export function mymblog(uid, page) {
  return fetchJSON(`https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=${page}&feature=0`, { weiboHeaders: true });
}

export function mContainer(uid, containerid, sinceId) {
  const q = `type=uid&value=${uid}&containerid=${containerid}${sinceId ? `&since_id=${sinceId}` : ''}`;
  return fetchJSON(`https://m.weibo.cn/api/container/getIndex?${q}`);
}

export function userTimeline(uid, sinceId) {
  return mContainer(uid, `107603${uid}`, sinceId);
}

export function likesTimeline(uid, sinceId) {
  return mContainer(uid, `200063${uid}`, sinceId);
}

export function longtext(mid) {
  return fetchJSON(`https://weibo.com/ajax/statuses/longtext?id=${mid}`, { weiboHeaders: true });
}

export function statusShow(mid) {
  return fetchJSON(`https://weibo.com/ajax/statuses/show?id=${mid}`, { weiboHeaders: true });
}

// 「我的评论」接口形态历史上多次变动，实现期探测，失败由上层标记为不支持
export function myComment(page) {
  return fetchJSON(`https://weibo.com/ajax/statuses/mycomment?page=${page}`, { weiboHeaders: true });
}

// 登录检测：从 weibo.com 页面配置拿 uid，再带 ajax 头验证会话
export async function detectLogin() {
  let uid = '';
  try {
    const tabs = await chrome.tabs.query({ url: 'https://weibo.com/*' });
    for (const t of tabs) {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'get-config' }).catch(() => null);
      if (r && r.uid) { uid = r.uid; break; }
    }
  } catch (e) { /* 无标签页时走下面的兜底 */ }
  if (!uid) {
    try {
      const { getMeta } = await import('./db.js');
      const p = await getMeta('profile');
      if (p && p.uid) uid = p.uid;
    } catch (e) { /* 忽略 */ }
  }
  if (!uid) return null;
  const res = await fetchJSON(`https://weibo.com/ajax/profile/info?uid=${uid}`, { weiboHeaders: true, retries: 0 })
    .catch(() => null);
  if (!res || res.ok !== 1 || !res.data || !res.data.user || !res.data.user.id) return null;
  const u = res.data.user;
  return { uid: String(u.id), screen_name: u.screen_name, statuses_count: u.statuses_count };
}

// 轻量图片下载（不进 fetchJSON 的重试/节流主链，调用方自行重试）
export async function fetchBlob(url, timeoutMs = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: 'include', signal: ctl.signal });
    if (!res.ok) throw new ApiError(res.status, url);
    return await res.blob();
  } finally {
    clearTimeout(t);
  }
}
