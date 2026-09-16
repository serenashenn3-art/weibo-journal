import {
  profileInfo, mymblog, userTimeline, likesTimeline, longtext,
  statusShow, myComment, fetchBlob, sleep, ApiError, mContainer,
} from './api.js';
import { toLarge } from './imager.js';
import {
  getMeta, setMeta, getPost, putPost, allPosts,
  putMedia, getMedia,
} from './db.js';

export const PHASES = ['phaseA', 'phaseB', 'longtext', 'media', 'likes', 'comments', 'done'];
const PHASE_LABEL = {
  phaseA: '抓取近期微博（weibo.com 接口）',
  phaseB: '深挖全部历史（m.weibo.cn 游标）',
  longtext: '补全超长微博全文',
  media: '下载原图与视频',
  likes: '抓取点赞过的微博',
  comments: '抓取评论过的微博',
  done: '完成',
};

const MAX_VIDEO_BYTES = 800 * 1024 * 1024;

// ---------- 工具 ----------

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

export function stripHtml(html) {
  const s = decodeEntities(String(html || '').replace(/<[^>]+>/g, '')).trim();
  // 截断的长文尾巴统一清理（真正的全文由长文接口补全后不会再带这个尾巴）
  return s.replace(/[…\.]{2,3}\s*全文\s*$/, '');
}

function parseTs(createdAt) {
  const ts = Date.parse(createdAt);
  return Number.isNaN(ts) ? Date.now() : ts;
}

// ---------- 归一化 ----------

function extractPics(mblog) {
  let urls = [];
  if (Array.isArray(mblog.pics) && mblog.pics.length) {
    urls = mblog.pics.map((p) => p && (p.large ? p.large.url : p.url)).filter(Boolean);
  } else if (mblog.pic_infos && typeof mblog.pic_infos === 'object') {
    urls = Object.values(mblog.pic_infos)
      .map((i) => i && ((i.large && i.large.url) || i.url))
      .filter(Boolean);
  }
  const seen = new Set();
  return urls.map(toLarge).filter((u) => (u && !seen.has(u) ? seen.add(u) : false));
}

function extractPageInfo(mblog) {
  const pi = mblog.page_info;
  if (!pi || !pi.type) return {};
  if (pi.type === 'video') {
    const mi = pi.media_info || {};
    const url = mi.stream_url || mi.mp4_hd_url || mi.mp4_sd_url || mi.mp4_url || '';
    return {
      video: { url, poster: toLarge((pi.page_pic && pi.page_pic.url) || ''), online: pi.media_info ? 1 : 0 },
    };
  }
  if (pi.type === 'article' || pi.type === 'webpage') {
    let url = pi.page_url || '';
    // weibo.cn/sinaurl 跳转链接：解出真实外链
    try {
      if (url.includes('sinaurl') ) {
        const u = new URL(url).searchParams.get('u');
        if (u) url = decodeURIComponent(u);
      }
    } catch (e) { /* 保留原链接 */ }
    return { article: { title: pi.page_title || '', url } };
  }
  return {};
}

export function normalizePost(mblog, source) {
  if (!mblog || !mblog.id) return null;
  const retweetedRaw = mblog.retweeted_status;
  const post = {
    mid: String(mblog.id),
    bid: mblog.bid || '',
    text_raw: (mblog.text_raw || stripHtml(mblog.text) || '').trim(),
    created_at: parseTs(mblog.created_at),
    created_at_str: mblog.created_at || '',
    source_device: mblog.source || '',
    reposts_count: mblog.reposts_count || 0,
    comments_count: mblog.comments_count || 0,
    attitudes_count: mblog.attitudes_count || 0,
    pics: extractPics(mblog),
    isLongText: !!mblog.isLongText,
    longtext_done: !!(mblog.longText && (mblog.longText.longTextContent || mblog.longText.long_text_content)),
    source,
    user: mblog.user ? {
      id: String(mblog.user.id),
      screen_name: mblog.user.screen_name || '',
    } : undefined,
    retweeted: null,
    ...extractPageInfo(mblog),
  };
  if (post.longtext_done) {
    post.text_raw = mblog.longText.longTextContent || mblog.longText.long_text_content || post.text_raw;
  }
  if (retweetedRaw) {
    if (retweetedRaw.user) {
      const rtLongDone = !!(retweetedRaw.longText && (retweetedRaw.longText.longTextContent || retweetedRaw.longText.long_text_content));
      post.retweeted = {
        mid: String(retweetedRaw.id || ''),
        user: retweetedRaw.user.screen_name || '',
        text_raw: rtLongDone
          ? (retweetedRaw.longText.longTextContent || retweetedRaw.longText.long_text_content)
          : (retweetedRaw.text_raw || stripHtml(retweetedRaw.text) || '').trim(),
        pics: extractPics(retweetedRaw),
        created_at: parseTs(retweetedRaw.created_at),
        isLongText: !!retweetedRaw.isLongText,
        longtext_done: rtLongDone || !retweetedRaw.isLongText,
        ...extractPageInfo(retweetedRaw),
      };
    } else {
      post.retweeted = { deleted: true, text_raw: '', user: '', pics: [], mid: '' };
    }
  }
  // 分类：原创 / 转发
  post.category = post.retweeted ? 'repost' : 'original';
  return post;
}

async function savePost(post) {
  const ex = await getPost(post.mid);
  if (!ex) {
    await putPost(post);
    return 'new';
  }
  const merged = { ...ex };
  if (ex.source !== 'timeline' && post.source === 'timeline') merged.source = 'timeline';
  if (!ex.text_raw || (post.text_raw && post.text_raw.length > ex.text_raw.length)) {
    if (post.text_raw) merged.text_raw = post.text_raw;
  }
  if (!ex.pics || !ex.pics.length) merged.pics = post.pics;
  if (!ex.video && post.video) merged.video = post.video;
  if (!ex.article && post.article) merged.article = post.article;
  if (!ex.retweeted && post.retweeted) merged.retweeted = post.retweeted;
  if (!ex.user && post.user) merged.user = post.user;
  if (post.longtext_done) merged.longtext_done = true;
  if (post.isLongText) merged.isLongText = true;
  await putPost(merged);
  return 'dup';
}

// ---------- 断点 ----------

async function loadCheckpoint() {
  const cp = await getMeta('checkpoint');
  return cp || { phase: 'phaseA', a: {}, b: {}, lt: { idx: 0 }, media: null, likes: {}, cmt: {} };
}

async function saveCheckpoint(cp) {
  await setMeta('checkpoint', cp);
}

async function loadStats() {
  return (await getMeta('stats')) || {
    postsNew: 0, postsDup: 0, imagesOk: 0, imagesFail: 0,
    videosOk: 0, videosFail: 0, articlesOk: 0, articlesFail: 0, likesNew: 0, errors: [],
  };
}

// ---------- 主循环 ----------

export async function runCrawl({ shouldStop, onProgress }) {
  const options = (await getMeta('options')) || { images: true, articles: true, video: false, likes: true, comments: true };
  const profile = await getMeta('profile');
  if (!profile || !profile.uid) throw new Error('缺少 uid：请先登录 weibo.com 或手动填写 uid');
  const cp = await loadCheckpoint();
  let stats = await loadStats();
  let dirtyStats = false;

  const persistStats = async () => { if (dirtyStats) { await setMeta('stats', stats); dirtyStats = false; } };
  const report = async (extra = {}) => {
    await persistStats();
    const timeline = await countBySource('timeline');
    const footprint = await countBySource('like') + await countBySource('comment');
    if (onProgress) {
      onProgress({
        phase: cp.phase,
        phaseLabel: PHASE_LABEL[cp.phase] || cp.phase,
        timeline,
        footprint,
        statusesCount: profile.statuses_count || 0,
        stats,
        ...extra,
      });
    }
  };

  async function countBySource(src) {
    const all = await allPosts();
    return all.filter((p) => p.source === src).length;
  }

  const mediaSkip = new Set(); // 仅本次运行内跳过失败项，下次运行自动重试，避免永久漏抓

  // —— 阶段步函数：每个返回 true 表示本阶段还有更多 ——
  const steps = {
    async phaseA() {
      const page = cp.a.page || 1;
      if (page > 500) return false;
      let res;
      try {
        res = await mymblog(profile.uid, page);
      } catch (e) {
        // 未登录访问 weibo.com 接口会被拒：不纠缠，直接交给 m.weibo.cn 深挖
        if (e instanceof ApiError && (e.status === 403 || e.status === 401)) {
          if (!cp.a.forbiddenNoted) {
            cp.a.forbiddenNoted = true;
            recordError(stats, 'weibo.com 接口拒绝访问（未登录）：已自动切换到移动端接口深挖，登录后可补全近期微博。');
            dirtyStats = true;
            await saveCheckpoint(cp);
          }
          return false;
        }
        throw e;
      }
      const list = (res && res.data && res.data.list) || [];
      if (!list.length) return false;
      const firstMid = String(list[0].id);
      if (firstMid === cp.a.lastFirstMid) return false; // 翻页空转检测
      let added = 0;
      for (const m of list) {
        const post = normalizePost(m, 'timeline');
        if (!post) continue;
        if (await savePost(post) === 'new') { stats.postsNew++; added++; } else stats.postsDup++;
      }
      dirtyStats = true;
      cp.a.page = page + 1;
      cp.a.lastFirstMid = firstMid;
      await saveCheckpoint(cp);
      return true;
    },

    async phaseB() {
      const res = await userTimeline(profile.uid, cp.b.sinceId || undefined);
      const data = res && res.data;
      const cards = (data && data.cards || []).filter((c) => c && c.card_type === 9 && c.mblog);
      if (!cards.length) return false;
      const firstMid = String(cards[0].mblog.id);
      if (firstMid === cp.b.lastFirstMid) return false;
      for (const c of cards) {
        const post = normalizePost(c.mblog, 'timeline');
        if (!post) continue;
        if (await savePost(post) === 'new') stats.postsNew++; else stats.postsDup++;
      }
      dirtyStats = true;
      const newSince = data.cardlistInfo && data.cardlistInfo.since_id;
      if (!newSince || String(newSince) === String(cp.b.sinceId || '')) return false;
      cp.b.sinceId = newSince;
      cp.b.lastFirstMid = firstMid;
      await saveCheckpoint(cp);
      const timeline = await countBySource('timeline');
      const total = profile.statuses_count || 0;
      return total > 0 ? timeline < total : true;
    },

    async longtextPhase() {
      const all = await allPosts();
      const needLt = (p) => {
        const main = p.isLongText && !p.longtext_done;
        const rt = p.retweeted && p.retweeted.isLongText && !p.retweeted.longtext_done && p.retweeted.mid;
        return main || rt;
      };
      const queue = all
        .filter((p) => needLt(p) && (p.source === 'timeline' || p.source === 'like'))
        .sort((x, y) => y.created_at - x.created_at);
      const idx = cp.lt.idx || 0;
      if (idx >= queue.length) { cp.lt.idx = 0; return false; }
      const batch = queue.slice(idx, idx + 4);
      let done = 0;
      for (const p of batch) {
        try {
          const upd = await getPost(p.mid) || p;
          // 正文长文
          if (upd.isLongText && !upd.longtext_done) {
            try {
              const res = await longtext(upd.mid);
              const content = res && res.data && (res.data.longTextContent || res.data.long_text_content);
              if (content) upd.text_raw = content;
              upd.longtext_done = true; // 拿到内容或明确失败都不再重试
            } catch (e) {
              recordError(stats, `长文补全失败 mid=${upd.mid}: ${e.message}`);
              if (!(e instanceof ApiError && e.isRateLimited)) upd.longtext_done = true; // 限流类错误保留待重试
            }
          }
          // 转发原博的长文（内容完整）
          if (upd.retweeted && upd.retweeted.isLongText && !upd.retweeted.longtext_done && upd.retweeted.mid) {
            try {
              const res = await longtext(upd.retweeted.mid);
              const content = res && res.data && (res.data.longTextContent || res.data.long_text_content);
              if (content) upd.retweeted.text_raw = content;
              upd.retweeted.longtext_done = true;
            } catch (e) {
              recordError(stats, `转发原博长文补全失败 mid=${upd.retweeted.mid}: ${e.message}`);
              if (!(e instanceof ApiError && e.isRateLimited)) upd.retweeted.longtext_done = true;
            }
          }
          await putPost(upd);
        } catch (e) {
          recordError(stats, `长文补全失败 mid=${p.mid}: ${e.message}`);
        }
        done++;
      }
      dirtyStats = true;
      cp.lt.idx = idx + done;
      await saveCheckpoint(cp);
      return cp.lt.idx < queue.length;
    },

    async mediaPhase() {
      if (!cp.media) cp.media = { queue: await buildMediaQueue(profile.uid), idx: 0 };
      const { queue } = cp.media;
      let started = 0;
      while (cp.media.idx < queue.length && started < 3) {
        const item = queue[cp.media.idx];
        cp.media.idx++;
        if (mediaSkip.has(item.url)) continue;
        const existing = await getMedia(item.url);
        if (existing && existing.ok) continue;
        try {
          await downloadMedia(item);
          if (item.kind === 'video') stats.videosOk++;
          else if (item.kind === 'article') stats.articlesOk++;
          else stats.imagesOk++;
        } catch (e) {
          if (item.kind === 'video') stats.videosFail++;
          else if (item.kind === 'article') stats.articlesFail++;
          else stats.imagesFail++;
          const fails = (await getMeta('failedMedia')) || [];
          fails.push({ url: item.url, mid: item.mid, kind: item.kind, err: e.message, ts: Date.now() });
          await setMeta('failedMedia', fails.slice(-500));
          mediaSkip.add(item.url);
          recordError(stats, `媒体下载失败 ${item.kind} mid=${item.mid}: ${e.message}`);
        }
        dirtyStats = true;
        started++;
        await saveCheckpoint(cp);
      }
      const remaining = queue.length - cp.media.idx;
      await report({ mediaTotal: queue.length, mediaDone: cp.media.idx, mediaRemaining: remaining });
      return cp.media.idx < queue.length;
    },

    async likesPhase() {
      if (!options.likes) return false;
      const res = await likesTimeline(profile.uid, cp.likes.sinceId || undefined);
      const data = res && res.data;
      const cards = (data && data.cards || []).filter((c) => c && c.card_type === 9 && c.mblog);
      if (!cards.length) return false;
      for (const c of cards) {
        const post = normalizePost(c.mblog, 'like');
        if (!post) continue;
        const ex = await getPost(post.mid);
        if (ex && ex.source === 'timeline') continue; // 已作为时间线微博存在
        if (await savePost(post) === 'new') stats.likesNew++;
      }
      dirtyStats = true;
      const newSince = data.cardlistInfo && data.cardlistInfo.since_id;
      if (!newSince || String(newSince) === String(cp.likes.sinceId || '')) return false;
      cp.likes.sinceId = newSince;
      await saveCheckpoint(cp);
      return true;
    },

    async commentsPhase() {
      if (!options.comments) return false;
      if (cp.cmt.unsupported) return false;
      const page = cp.cmt.page || 1;
      let res;
      try {
        res = await myComment(page);
      } catch (e) {
        cp.cmt.unsupported = true;
        await saveCheckpoint(cp);
        recordError(stats, `评论接口不可用（已被微博限制），跳过：${e.message}`);
        return false;
      }
      const items = parseMyComment(res);
      if (items === null) {
        cp.cmt.unsupported = true;
        await saveCheckpoint(cp);
        recordError(stats, '评论接口返回结构无法识别，跳过（此部分尽力而为）');
        return false;
      }
      if (!items.length) return false;
      for (const it of items) {
        if (!it || !it.id) continue;
        const post = normalizePost({ ...it, text_raw: it.text_raw || it.text }, 'comment');
        if (post && await savePost(post) === 'new') stats.likesNew++;
      }
      dirtyStats = true;
      cp.cmt.page = page + 1;
      await saveCheckpoint(cp);
      return true;
    },
  };

  // —— 驱动循环 ——
  await report();
  let idleRounds = 0;
  while (cp.phase !== 'done') {
    if (shouldStop && shouldStop()) break;
    let more = false;
    try {
      if (cp.phase === 'phaseA') more = await steps.phaseA();
      else if (cp.phase === 'phaseB') more = await steps.phaseB();
      else if (cp.phase === 'longtext') more = await steps.longtextPhase();
      else if (cp.phase === 'media') more = await steps.mediaPhase();
      else if (cp.phase === 'likes') more = await steps.likesPhase();
      else if (cp.phase === 'comments') more = await steps.commentsPhase();
      idleRounds = 0;
    } catch (e) {
      idleRounds++;
      if (cp.phase === 'phaseA' && e instanceof ApiError && e.status === 403) {
        recordError(stats, 'weibo.com 接口返回 403：请先在浏览器中登录 weibo.com，再点「继续」。');
      } else {
        recordError(stats, `${PHASE_LABEL[cp.phase]} 出错：${e.message}`);
      }
      dirtyStats = true;
      if (e.isAuthError || (e instanceof ApiError && e.status === 403)) {
        await sleep(Math.min(300000, 5000 * 2 ** idleRounds));
      } else {
        await sleep(3000);
      }
      if (idleRounds >= 8) {
        recordError(stats, '连续失败次数过多，自动暂停。可点击「继续」重试。');
        break; // 交还控制，用户点继续再跑
      }
    }
    if (!more) {
      const i = PHASES.indexOf(cp.phase);
      let next = PHASES[i + 1] || 'done';
      if (next === 'media' && cp.media === null) cp.media = null;
      if (next === 'likes' && !options.likes) next = 'comments';
      if (next === 'comments' && !options.comments) next = 'done';
      cp.phase = next;
      if (cp.phase === 'longtext') cp.lt = { idx: 0 };
      if (cp.phase === 'media') cp.media = null;
      await saveCheckpoint(cp);
    }
    await report();
    await sleep(50);
  }
  await persistStats();
  await setMeta('running', false);
  await report();
  return cp.phase === 'done';
}

function recordError(stats, msg) {
  stats.errors.push({ ts: Date.now(), msg });
  if (stats.errors.length > 100) stats.errors = stats.errors.slice(-100);
}

// ---------- 媒体 ----------

async function buildMediaQueue(uid) {
  const options = (await getMeta('options')) || {};
  const withImages = options.images !== false;
  const withVideos = !!options.video;
  const withArticles = options.articles !== false;
  const all = await allPosts();
  const q = [];
  for (const p of all) {
    if (p.source !== 'timeline' && p.source !== 'like') continue;
    if (withImages) {
      (p.pics || []).forEach((url, i) => q.push({ url, mid: p.mid, idx: i, kind: 'img', ts: p.created_at }));
      if (p.retweeted && p.retweeted.pics) {
        p.retweeted.pics.forEach((url, i) => q.push({ url, mid: `${p.mid}_rt`, idx: i, kind: 'rtimg', ts: p.created_at }));
      }
    }
    if (withVideos && p.video && p.video.url) q.push({ url: p.video.url, mid: p.mid, kind: 'video', ts: p.created_at });
    if (withArticles && p.article && p.article.url && p.article.url.includes('ttarticle') && !p.article.text) {
      q.push({ url: p.article.url, mid: p.mid, kind: 'article', ts: p.created_at });
    }
  }
  return q;
}

async function downloadMedia(item) {
  if (item.kind === 'article') {
    await downloadArticleText(item);
    return;
  }
  let url = item.url;
  if (item.kind === 'video') {
    // stream_url 是带签名的临时地址，抓取时刻的可能已过期：下载前取最新地址
    try {
      const res = await statusShow(item.mid);
      const mi = res && res.data && res.data.page_info && res.data.page_info.media_info;
      const fresh = mi && (mi.stream_url || mi.mp4_hd_url || mi.mp4_sd_url || mi.mp4_url);
      if (fresh) url = fresh;
    } catch (e) { /* 用原地址兜底 */ }
    try {
      const head = await fetch(url, { method: 'HEAD', credentials: 'include' });
      const len = Number(head.headers.get('content-length') || 0);
      if (len > MAX_VIDEO_BYTES) throw new Error('视频超过 800MB，跳过');
    } catch (e) {
      if (e.message.includes('800MB')) throw e;
      // HEAD 失败不阻塞
    }
  }
  const blob = await fetchBlob(url, item.kind === 'video' ? 300000 : 60000);
  if (!blob || blob.size === 0) throw new Error('下载内容为空');
  if (item.kind !== 'video' && blob.type && !blob.type.startsWith('image/')) {
    throw new Error(`返回非图片内容 ${blob.type}`);
  }
  await putMedia({ url: item.url, blob, kind: item.kind, mid: item.mid, ok: true, ts: Date.now() });
}

// 头条文章：抓取正文文本，离线可读
async function downloadArticleText(item) {
  const res = await fetch(item.url, { credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, item.url);
  const html = await res.text();
  const paras = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRe.exec(html)) && paras.length < 600) {
    const t = stripHtml(m[1]);
    if (t) paras.push(t);
  }
  const text = paras.join('\n\n').slice(0, 200000).trim();
  if (text.length < 50) throw new Error('未提取到文章正文');
  const post = await getPost(item.mid);
  if (post && post.article) {
    post.article.text = text;
    await putPost(post);
  }
}

// 「我的评论」响应结构兼容解析；返回 null 表示不认识
function parseMyComment(res) {
  if (!res || typeof res !== 'object') return null;
  const d = res.data;
  if (!d) return null;
  const candidates = [];
  if (Array.isArray(d.list)) candidates.push(...d.list);
  else if (Array.isArray(d.data)) candidates.push(...d.data);
  else if (Array.isArray(d)) candidates.push(...d);
  if (!candidates.length) return [];
  const out = [];
  for (const it of candidates) {
    const m = it && (it.mblog || it.status || it);
    if (m && m.id && (m.text || m.text_raw)) {
      out.push({ ...m, created_at: m.created_at || it.created_at });
    } else return null;
  }
  return out;
}

// ---------- 供 sw 调用的初始化 ----------

export async function initProfile(uid) {
  // 优先走 weibo.com（登录态信息最全）
  try {
    const res = await profileInfo(uid);
    const u = res && res.data && res.data.user;
    if (u && u.id) {
      const profile = {
        uid: String(u.id),
        screen_name: u.screen_name || '',
        statuses_count: u.statuses_count || 0,
        followers_count: u.followers_count || 0,
        description: u.description || '',
        avatar_hd: u.avatar_hd || (u.profile_image_url ? toLarge(u.profile_image_url) : ''),
        fetched_at: Date.now(),
      };
      await setMeta('profile', profile);
      return profile;
    }
  } catch (e) { /* 未登录或接口受限时走移动端兜底 */ }
  // 兜底：m.weibo.cn 用户信息（公开账号无需登录）
  const res = await mContainer(uid, `100505${uid}`);
  const u = res && res.data && res.data.userInfo;
  if (!u || !u.id) throw new Error('获取用户信息失败：该账号不存在，或需要先在 weibo.com 登录');
  const profile = {
    uid: String(u.id),
    screen_name: u.screen_name || '',
    statuses_count: u.statuses_count || 0,
    followers_count: u.followers_count || 0,
    description: u.description || '',
    avatar_hd: toLarge(u.avatar_hd || u.profile_image_url || ''),
    fetched_at: Date.now(),
  };
  await setMeta('profile', profile);
  return profile;
}
