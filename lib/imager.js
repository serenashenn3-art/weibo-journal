// 把微博各尺寸缩略图 URL 还原为原图 URL
export function toLarge(url) {
  if (!url) return url;
  return url
    .replace(/\/(orj\d+|bmiddle|mw\d+|small|thumbnail|square|thumb\d+|wap\d+|crop\.[a-z0-9.]+|bmiddle_flag[^/]*)\//, '/large/')
    .replace(/^http:\/\//, 'https://');
}

// 从 URL 推断扩展名
export function extOf(url, fallback = 'jpg') {
  const m = url.split('?')[0].match(/\.(jpe?g|png|gif|webp|bmp)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : fallback;
}

// 图片落盘相对路径：images/original/2026/202605/{mid}_{i}.jpg（原创图）
//                    images/repost/2026/202605/{mid}_rt_{i}.jpg（转发图）
export function imageRelPath(url, mid, idx, createdTs, kind = 'original') {
  const d = createdTs ? new Date(createdTs) : new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const sub = kind === 'repost' ? 'repost' : 'original';
  return `images/${sub}/${ym.slice(0, 4)}/${ym}/${mid}_${idx}.${extOf(url)}`;
}

export function videoRelPath(mid, createdTs) {
  const d = createdTs ? new Date(createdTs) : new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `videos/${ym.slice(0, 4)}/${ym}/${mid}.mp4`;
}
