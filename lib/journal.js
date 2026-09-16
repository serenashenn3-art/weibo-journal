// 生成手账本 HTML（完全自包含，离线可开，图片为相对路径）
// 支持：原创/转发/含图片/含视频/纯文字 勾选筛选、月份目录跳转、原创图与转发图分目录

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function decorate(text) {
  let s = esc(text);
  s = s.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/#([^#\s<][^#<]{0,60}?)#/g, '<span class="topic">#$1#</span>');
  s = s.replace(/@([A-Za-z0-9_一-龥-]{1,30})/g, '<span class="mention">@$1</span>');
  return s.replace(/\n/g, '<br>');
}

function asMap(m) {
  if (!m) return new Map();
  return m instanceof Map ? m : new Map(Object.entries(m));
}

function imgHtml(url, mediaMap, failedSet) {
  const rel = mediaMap.get(url);
  if (rel) {
    return `<figure class="pic"><img loading="lazy" src="${esc(rel)}" alt="" onclick="openLb(this.src)"></figure>`;
  }
  if (failedSet.has(url)) {
    return `<figure class="pic broken"><div>图片下载失败<br><a href="${esc(url)}" target="_blank" rel="noopener">原图链接</a></div></figure>`;
  }
  return `<figure class="pic broken"><div>图片未下载<br><a href="${esc(url)}" target="_blank" rel="noopener">在线查看</a></div></figure>`;
}

function picsHtml(urls, mediaMap, failedSet, label) {
  if (!urls || !urls.length) return '';
  const n = Math.min(urls.length, 9);
  const figs = urls.map((u) => imgHtml(u, mediaMap, failedSet)).join('');
  const cap = label ? `<div class="piclabel">${esc(label)}（${urls.length}）</div>` : '';
  return `${cap}<div class="pics n${n}">${figs}</div>`;
}

function videoHtml(post, mediaMap, videoMap, failedSet) {
  const v = post.video;
  if (!v || !v.url) return '';
  const poster = v.poster && mediaMap.get(v.poster) ? ` poster="${esc(mediaMap.get(v.poster))}"` : '';
  const rel = videoMap.get(post.mid);
  if (rel) {
    return `<div class="video"><video controls preload="metadata"${poster} src="${esc(rel)}"></video></div>`;
  }
  return `<div class="video offline">${poster ? `<img loading="lazy" src="${esc(mediaMap.get(v.poster))}" alt="">` : ''}<a href="${esc(v.url)}" target="_blank" rel="noopener">▶ 视频未下载（在线观看）</a></div>`;
}

function articleHtml(a) {
  if (!a || !a.url) return '';
  return `<div class="article"><a href="${esc(a.url)}" target="_blank" rel="noopener">📄 ${esc(a.title || '头条文章')}</a></div>`;
}

function retweetedHtml(rt, mediaMap, failedSet) {
  if (!rt) return '';
  if (rt.deleted) return '<div class="rt deleted">该微博已被删除</div>';
  const who = rt.user ? `<span class="rt-user">@${esc(rt.user)}</span>：` : '';
  return `<div class="rt">${who}<div class="rt-text">${decorate(rt.text_raw || '')}</div>${picsHtml(rt.pics, mediaMap, failedSet, '转发图片')}${articleHtml(rt.article)}</div>`;
}

function cardHtml(post, mediaMap, failedSet, videoMap, tag) {
  const url = post.bid
    ? `https://weibo.com/${(post.user && post.user.id) || ''}/${post.bid}`
    : `https://weibo.com/detail/${post.mid}`;
  const d = new Date(post.created_at);
  const isRt = post.category === 'repost' || !!post.retweeted;
  const ownPics = post.pics || [];
  const rtPics = (post.retweeted && post.retweeted.pics) || [];
  const hasPics = ownPics.length + rtPics.length > 0;
  const hasVideo = !!(post.video && post.video.url);
  const media = hasVideo ? 'video' : hasPics ? 'pics' : 'text';
  // 原创图标签：仅在转发微博里需要区分两类图时标注
  const ownLabel = isRt && rtPics.length ? '原创图片' : '';
  return `<article class="card" data-year="${d.getFullYear()}" data-cat="${isRt ? 'repost' : 'original'}" data-media="${media}">
    <div class="date"><span class="day">${fmtDay(post.created_at)}</span><span class="time">${fmtTime(post.created_at)}</span></div>
    ${isRt ? '<span class="tag tag-rt">转发</span>' : ''}
    ${tag ? `<span class="tag tag-${tag}">${tag === '赞' ? '赞过' : '评过'}</span>` : ''}
    <div class="body">
      <div class="text">${decorate(post.text_raw || '')}</div>
      ${retweetedHtml(post.retweeted, mediaMap, failedSet)}
      ${picsHtml(ownPics, mediaMap, failedSet, ownLabel)}
      ${videoHtml(post, mediaMap, videoMap, failedSet)}
      ${articleHtml(post.article)}
      <div class="meta">
        <span>${esc(post.source_device || '')}</span>
        <span>转发 ${post.reposts_count || 0} · 评论 ${post.comments_count || 0} · 赞 ${post.attitudes_count || 0}</span>
        <a href="${esc(url)}" target="_blank" rel="noopener">原文</a>
      </div>
    </div>
  </article>`;
}

function timelineHtml(posts, mediaMap, failedSet, videoMap, tagFor) {
  const sorted = [...posts].sort((a, b) => b.created_at - a.created_at);
  let out = '';
  let lastYm = '';
  for (const p of sorted) {
    const d = new Date(p.created_at);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (ym !== lastYm) {
      lastYm = ym;
      const [y, m] = ym.split('-');
      out += `<div class="month" data-year="${y}" id="m-${ym}"><span>${y} 年 ${Number(m)} 月</span></div>`;
    }
    out += cardHtml(p, mediaMap, failedSet, videoMap, tagFor ? tagFor(p) : '');
  }
  return out;
}

export function buildJournal({ profile, posts, stats, mediaMap: mm, videoMap: vm, failedMedia = [], initialFilters = {} }) {
  const mediaMap = asMap(mm);
  const videoMap = asMap(vm);
  const failedSet = new Set(failedMedia.map((f) => f.url));

  const timeline = posts.filter((p) => p.source === 'timeline');
  const likes = posts.filter((p) => p.source === 'like');
  const comments = posts.filter((p) => p.source === 'comment');
  const total = profile.statuses_count || 0;
  const imgCount = [...mediaMap.keys()].length;
  const vidCount = [...videoMap.keys()].length;
  const failCount = failedMedia.length;
  const exported = fmtDate(Date.now());

  const nOriginal = timeline.filter((p) => p.category !== 'repost').length;
  const nRepost = timeline.length - nOriginal;
  const nWithPics = timeline.filter((p) => (p.pics || []).length || (p.retweeted && (p.retweeted.pics || []).length)).length;
  const nWithVideo = timeline.filter((p) => p.video && p.video.url).length;

  const years = [...new Set(posts.map((p) => new Date(p.created_at).getFullYear()))].sort((a, b) => b - a);

  const footSection = (likes.length || comments.length) ? `
    <div class="month foot-title" id="m-foot"><span>我的足迹</span></div>
    <p class="foot-note">你点赞和评论过的微博。这部分受微博接口限制，只能回溯到平台保留的最近记录，不代表全部历史。</p>
    ${timelineHtml([...likes, ...comments], mediaMap, failedSet, videoMap, (p) => (p.source === 'like' ? '赞' : '评'))}
  ` : '';

  const F = {
    original: initialFilters.original !== false,
    repost: initialFilters.repost !== false,
    pics: !!initialFilters.pics,
    video: !!initialFilters.video,
    textonly: !!initialFilters.textonly,
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微博手账本 · ${esc(profile.screen_name)}</title>
<style>
:root{--ink:#3a3632;--muted:#9a917f;--line:#d8cfc0;--accent:#d96f57;--blue:#7ba2c9;--paper:#f6f1e7;--card:#fffdf8}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.8 "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
h1,h2,.month span{font-family:"Kaiti SC","STKaiti",KaiTi,"Songti SC",serif}
a{color:#b3543f;text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:760px;margin:0 auto;padding:0 20px 80px}

.report{position:sticky;top:0;z-index:9;background:#fff8ec;border-bottom:1px dashed var(--line);padding:10px 20px;font-size:13px}
.report .wrap{padding:0;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline}
.report b{color:var(--accent)}

.controls{position:sticky;top:41px;z-index:8;background:var(--paper);display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 0;border-bottom:1px solid #ece4d4}
.controls .lab{display:flex;align-items:center;gap:4px;font-size:13px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:3px 12px;cursor:pointer;user-select:none}
.controls .lab input{accent-color:var(--accent);margin:0}
.controls .lab.on{background:#fdeee6;border-color:var(--accent)}
.controls button{border:1px solid var(--line);background:#fff;border-radius:14px;padding:3px 14px;font-size:13px;cursor:pointer;color:var(--ink)}
.controls button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.controls input[type=search]{flex:1;min-width:120px;border:1px solid var(--line);border-radius:14px;padding:4px 14px;font-size:13px;background:#fff}
.divider{width:1px;height:18px;background:var(--line)}

header.cover{text-align:center;padding:44px 0 8px}
header.cover .avatar{width:76px;height:76px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 10px rgba(90,70,40,.2)}
header.cover h1{font-size:30px;margin:10px 0 2px;letter-spacing:2px}
header.cover .sub{color:var(--muted);font-size:13px}

.tl{position:relative;padding-left:96px}
.tl::before{content:"";position:absolute;left:74px;top:0;bottom:0;width:2px;background:var(--line)}
.month{position:relative;margin:40px 0 16px;scroll-margin-top:110px}
.month span{display:inline-block;background:var(--accent);color:#fff;padding:4px 18px;border-radius:4px;transform:rotate(-1.2deg);box-shadow:1px 2px 6px rgba(90,70,40,.25);font-size:17px;letter-spacing:2px}
.month::before{content:"";position:absolute;left:-30px;top:12px;width:10px;height:10px;border-radius:50%;background:var(--accent);border:2px solid #fff;z-index:1}

.card{position:relative;background:var(--card);border:1px solid #e8dfd0;border-radius:4px;padding:14px 18px;margin:0 0 20px;box-shadow:2px 3px 8px rgba(90,70,40,.08)}
.card::before{content:"";position:absolute;top:-9px;left:26px;width:64px;height:18px;background:rgba(217,111,87,.32);transform:rotate(-3deg);pointer-events:none}
.card .date{position:absolute;left:-96px;width:66px;text-align:right;top:14px}
.card .day{display:block;font-weight:700;font-size:15px}
.card .time{display:block;color:var(--muted);font-size:12px}
.card.hidden,.month.hidden{display:none}
.tag{position:absolute;top:-8px;right:14px;font-size:11px;background:#e9b949;color:#fff;padding:1px 8px;border-radius:3px;transform:rotate(2deg)}
.tag-rt{right:14px;background:var(--blue)}
.tag-赞{right:64px}
.tag-评{background:#8fae7f;right:64px}
.tag-赞{ background:#e9b949}
.text{white-space:normal;word-break:break-word}
.topic{color:#b3543f}
.mention{color:#4a7ba6}
.rt{border-left:3px solid #e0d5c0;background:#faf5ea;padding:8px 12px;margin-top:8px;border-radius:0 4px 4px 0;font-size:14px}
.rt-user{color:#4a7ba6;font-weight:600}
.rt.deleted{color:var(--muted);font-style:italic}
.piclabel{color:var(--muted);font-size:12px;margin-top:10px}
.pics{display:grid;gap:8px;margin-top:6px}
.pics.n1{grid-template-columns:minmax(0,420px)}
.pics.n2,.pics.n4{grid-template-columns:repeat(2,1fr)}
.pics.n3,.pics.n5,.pics.n6,.pics.n7,.pics.n8,.pics.n9{grid-template-columns:repeat(3,1fr)}
.pic{margin:0;background:#fff;padding:6px;border:1px solid #eee5d5;box-shadow:1px 2px 5px rgba(90,70,40,.12);border-radius:2px}
.pic img{width:100%;display:block;border-radius:2px;cursor:zoom-in;background:#f3eee2}
.pics.n1 .pic img{max-height:520px;object-fit:contain}
.pic.broken div{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:90px;color:var(--muted);font-size:12px}
.video{margin-top:10px;max-width:480px}
.video video,.video img{width:100%;border-radius:4px;background:#000}
.video.offline a{display:inline-block;margin-top:6px}
.article{margin-top:8px;background:#faf5ea;border-radius:4px;padding:6px 10px;font-size:14px}
.meta{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;color:var(--muted);font-size:12px}
.foot-note{color:var(--muted);font-size:13px;background:#fff8ec;border:1px dashed var(--line);border-radius:6px;padding:8px 12px}
.foot-title span{background:var(--blue)}

#toc{position:fixed;right:14px;top:50%;transform:translateY(-50%);max-height:70vh;overflow-y:auto;background:#fffdf8;border:1px solid var(--line);border-radius:10px;padding:10px 6px;z-index:20;box-shadow:2px 4px 14px rgba(90,70,40,.15);display:none;width:150px}
#toc.open{display:block}
#toc a{display:block;padding:3px 10px;font-size:12px;color:var(--ink);border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#toc a:hover{background:#fdeee6;text-decoration:none}
#toc a.cur{background:var(--accent);color:#fff}
#tocBtn{position:fixed;right:14px;bottom:70px;z-index:20;border:1px solid var(--line);background:#fff;border-radius:16px;padding:5px 12px;font-size:13px;cursor:pointer;box-shadow:1px 2px 6px rgba(90,70,40,.15)}

#lb{display:none;position:fixed;inset:0;background:rgba(30,25,20,.9);z-index:99;align-items:center;justify-content:center;cursor:zoom-out}
#lb img{max-width:94vw;max-height:94vh;box-shadow:0 6px 40px rgba(0,0,0,.5)}
#top{position:fixed;right:22px;bottom:22px;width:40px;height:40px;border-radius:50%;border:none;background:var(--accent);color:#fff;font-size:18px;cursor:pointer;box-shadow:0 2px 10px rgba(90,70,40,.3);display:none;z-index:20}
.empty-hint{text-align:center;color:var(--muted);padding:40px 0;display:none}
footer.end{text-align:center;color:var(--muted);font-size:12px;margin-top:50px}
.print-head{display:none;text-align:center;margin:10px 0 24px}
.print-head h1{font-size:24px;margin:0 0 6px;letter-spacing:2px}
.print-head div{color:var(--muted);font-size:13px}

@media print{
  @page{margin:14mm}
  body{background:#fff;font-size:12px}
  .report,.controls,#top,#lb,#toc,#tocBtn,#pj-bar,.video{display:none!important}
  .print-head{display:block!important}
  .card{box-shadow:none;break-inside:avoid;border:1px solid #ddd}
  .tl{padding-left:80px}
  .card .date{left:-80px}
  .month{break-after:avoid}
}
</style>
</head>
<body>
<div class="report"><div class="wrap">
  <span>已收录 <b>${timeline.length}</b> / 共 ${total || '？'} 条</span>
  <span>原创 <b>${nOriginal}</b></span>
  <span>转发 <b>${nRepost}</b></span>
  <span>含图 <b>${nWithPics}</b></span>
  ${nWithVideo ? `<span>视频 <b>${nWithVideo}</b></span>` : ''}
  <span>图片 <b>${imgCount}</b> 张</span>
  ${vidCount ? `<span>视频文件 <b>${vidCount}</b></span>` : ''}
  ${failCount ? `<span style="color:#b3402e">媒体失败 <b>${failCount}</b></span>` : ''}
  <span style="margin-left:auto">导出于 ${exported}</span>
</div></div>

<div class="wrap">
<header class="cover">
  ${profile.avatar_rel ? `<img class="avatar" src="${esc(profile.avatar_rel)}" alt="">` : ''}
  <h1>${esc(profile.screen_name)} 的微博手账本</h1>
  <div class="sub">${total ? `共发布 ${total} 条微博 · ` : ''}${esc(profile.description || '')}</div>
</header>

<div class="controls" id="controls">
  <label class="lab ${F.original ? 'on' : ''}" data-k="original"><input type="checkbox" ${F.original ? 'checked' : ''}>原创</label>
  <label class="lab ${F.repost ? 'on' : ''}" data-k="repost"><input type="checkbox" ${F.repost ? 'checked' : ''}>转发</label>
  <span class="divider"></span>
  <label class="lab ${F.pics ? 'on' : ''}" data-k="pics"><input type="checkbox" ${F.pics ? 'checked' : ''}>含图片</label>
  <label class="lab ${F.video ? 'on' : ''}" data-k="video"><input type="checkbox" ${F.video ? 'checked' : ''}>含视频</label>
  <label class="lab ${F.textonly ? 'on' : ''}" data-k="textonly"><input type="checkbox" ${F.textonly ? 'checked' : ''}>纯文字</label>
  <span class="divider"></span>
  <button class="on" data-year="all">全部</button>
  ${years.map((y) => `<button data-year="${y}">${y}</button>`).join('')}
  <input id="search" type="search" placeholder="搜索微博内容…">
  <button id="printBtn" title="打印或另存为 PDF">🖨 打印</button>
</div>

<div class="print-head">
  <h1>${esc(profile.screen_name)} 的微博手账本</h1>
  <div>共收录 ${timeline.length} 条（原创 ${nOriginal} · 转发 ${nRepost}） · 图片 ${imgCount} 张${vidCount ? ` · 视频 ${vidCount} 个` : ''} · 导出于 ${exported}</div>
</div>

<div class="tl" id="tl">
${timelineHtml(timeline, mediaMap, failedSet, videoMap, null)}
${footSection}
</div>
<div class="empty-hint" id="emptyHint">没有符合筛选条件的微博，调整上方勾选试试。</div>

<footer class="end">由「微博手账本」浏览器插件生成 · 数据与图片保存在本文件夹内 · ${exported}</footer>
</div>

<button id="tocBtn" onclick="document.getElementById('toc').classList.toggle('open')">☰ 目录</button>
<div id="toc"></div>
<div id="lb" onclick="this.style.display='none'"><img alt=""></div>
<button id="top" onclick="scrollTo({top:0,behavior:'smooth'})">↑</button>

<script>
var FILTER=${JSON.stringify(F)};
(function(){
  var cards=[].slice.call(document.querySelectorAll('.card'));
  var months=[].slice.call(document.querySelectorAll('.month'));
  var labs=[].slice.call(document.querySelectorAll('#controls .lab'));
  var ybtns=[].slice.call(document.querySelectorAll('#controls button[data-year]'));
  var box=document.getElementById('search');
  var curYear='all';

  function mediaOk(c){
    var pics=FILTER.pics, video=FILTER.video, textonly=FILTER.textonly;
    if(!pics&&!video&&!textonly) return true;
    var m=c.getAttribute('data-media');
    if(pics&&m==='pics') return true;
    if(video&&m==='video') return true;
    if(textonly&&m==='text') return true;
    return false;
  }
  function apply(){
    var q=(box.value||'').toLowerCase();
    var visible=0;
    cards.forEach(function(c){
      var cat=c.getAttribute('data-cat');
      var okC=(cat==='original'&&FILTER.original)||(cat==='repost'&&FILTER.repost);
      var okY=curYear==='all'||c.getAttribute('data-year')===curYear;
      var okQ=!q||c.textContent.toLowerCase().indexOf(q)>-1;
      var show=okC&&mediaOk(c)&&okY&&okQ;
      c.classList.toggle('hidden',!show);
      if(show)visible++;
    });
    months.forEach(function(m){
      var y=m.getAttribute('data-year');
      var okY=curYear==='all'||y===curYear;
      var vis=false,n=m.nextElementSibling;
      while(n&&n.classList.contains('card')){if(!n.classList.contains('hidden')){vis=true;break}n=n.nextElementSibling}
      m.classList.toggle('hidden',!(okY&&vis));
    });
    document.getElementById('emptyHint').style.display=visible?'none':'block';
    buildToc();
  }
  labs.forEach(function(l){
    l.addEventListener('click',function(){
      var k=l.getAttribute('data-k');
      FILTER[k]=!FILTER[k];
      l.querySelector('input').checked=FILTER[k];
      l.classList.toggle('on',FILTER[k]);
      apply();
    });
  });
  ybtns.forEach(function(b){b.onclick=function(){
    ybtns.forEach(function(x){x.classList.remove('on')});b.classList.add('on');
    curYear=b.getAttribute('data-year');apply();
  }});
  box.addEventListener('input',apply);
  var pb=document.getElementById('printBtn');
  if(pb)pb.onclick=function(){window.print()};

  // 月份目录
  var toc=document.getElementById('toc');
  function buildToc(){
    toc.innerHTML='';
    months.forEach(function(m){
      if(m.classList.contains('hidden'))return;
      var a=document.createElement('a');
      a.textContent=m.querySelector('span').textContent;
      a.href='javascript:void(0)';
      (function(mm,aa){aa.onclick=function(){
        mm.scrollIntoView({behavior:'smooth',block:'start'});
      }})(m,a);
      toc.appendChild(a);
    });
  }
  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){
      if(e.isIntersecting){
        [].forEach.call(toc.querySelectorAll('a'),function(a){a.classList.remove('cur')});
        var i=months.indexOf(e.target);
        if(toc.children[i])toc.children[i].classList.add('cur');
      }
    });
  },{rootMargin:'-110px 0px -60% 0px'});
  months.forEach(function(m){io.observe(m)});

  var top=document.getElementById('top');
  addEventListener('scroll',function(){top.style.display=scrollY>600?'block':'none'});
  apply();
})();
function openLb(src){
  var lb=document.getElementById('lb');lb.querySelector('img').src=src;lb.style.display='flex';
}
</script>
</body>
</html>`;
}
