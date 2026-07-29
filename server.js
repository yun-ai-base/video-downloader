const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const BILIBILI_PROFILE_DIR = path.join(__dirname, 'chrome-profile'); // B站持久登录配置
const SUB_DIRS = { video: 'video', audio: 'audio', image: 'image' };

// 确保需要的目录存在
[DOWNLOADS_DIR,
  path.join(DOWNLOADS_DIR, SUB_DIRS.video),
  path.join(DOWNLOADS_DIR, SUB_DIRS.audio),
  path.join(DOWNLOADS_DIR, SUB_DIRS.image),
  BILIBILI_PROFILE_DIR,
].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(express.json());
app.use(express.static(__dirname));

// 下载历史管理
function getHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); }
  catch { return []; }
}
function addToHistory(entry) {
  const history = getHistory();
  history.unshift({ ...entry, date: new Date().toISOString() });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 50), null, 2));
}
function deleteFromHistory(filePath) {
  const history = getHistory();
  const filtered = history.filter(e => e.path !== filePath);
  if (filtered.length === history.length) return false;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(filtered, null, 2));
  return true;
}
function getHistoryAPI(req, res) {
  res.json(getHistory());
}

// 平台检测
function detectPlatform(url) {
  if (/v\.douyin\.com/i.test(url) || /douyin\.com/i.test(url)) return 'douyin';
  if (/v\.kuaishou\.com/i.test(url) || /kuaishou\.com/i.test(url)) return 'kuaishou';
  if (/xiaohongshu\.com/i.test(url) || /xhslink\.com/i.test(url)) return 'xiaohongshu';
  if (/x\.com/i.test(url) || /twitter\.com/i.test(url)) return 'x';
  if (/q7u6h\.top/i.test(url)) return 'q7u6h';
  if (/bilibili\.com/i.test(url) || /b23\.tv/i.test(url)) return 'bilibili';
  if (/youtube\.com/i.test(url) || /youtu\.be/i.test(url)) return 'youtube';
  if (/weibo\.com/i.test(url) || /weibo\.cn/i.test(url)) return 'weibo';
  return null;
}

// 从文本中提取干净的分享链接
function normalizeUrl(input) {
  input = input.trim();
  // 尝试从混合文本中提取 https:// 链接
  const urlMatch = input.match(/https?:\/\/[^\s]+/);
  if (urlMatch) return urlMatch[0].replace(/[^a-zA-Z0-9\/:._?=&%-]+$/, '');
  if (!input.startsWith('http://') && !input.startsWith('https://')) {
    input = 'https://' + input;
  }
  return input;
}

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) return browserInstance;
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-web-security',
    '--ignore-certificate-errors',
    '--disable-features=IsolateOrigins,site-per-process',
  ];
  browserInstance = await puppeteer.launch({ headless: 'new', args });
  return browserInstance;
}

// 从 RENDER_DATA 中递归提取图文图片 URL
function extractDouyinNoteImages(data, found = new Set()) {
  if (!data || typeof data !== 'object') return [];
  const urls = [];
  const stack = [data];
  while (stack.length) {
    const val = stack.pop();
    if (Array.isArray(val)) {
      val.forEach(v => stack.push(v));
    } else if (val && typeof val === 'object') {
      for (const key of Object.keys(val)) {
        const v = val[key];
        if (typeof v === 'string' && v.includes('douyinpic.com') && v.includes('aweme_images') && !found.has(v)) {
          const clean = v.replace(/~.*$/, '');
          found.add(clean);
          urls.push(clean);
        } else if (v && typeof v === 'object') {
          stack.push(v);
        }
      }
    }
  }
  return urls;
}

// ===== 抖音解析 =====
async function parseDouyin(shareUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const videoUrls = [];

  try {
    // 网络拦截：捕获所有响应中的视频地址
    page.on('response', async (resp) => {
      const url = resp.url();
      const ct = resp.headers()['content-type'] || '';
      // 抖音视频 CDN 域名或视频格式
      if (
        (url.includes('douyinvod.com') || url.includes('ixigua.com') || url.includes('douyin.com')) &&
        (ct.includes('video') || ct.includes('octet-stream') || url.includes('.mp4'))
      ) {
        videoUrls.push(url);
      }
    });

    await page.goto(shareUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // 等待页面充分渲染
    await page.evaluate(() => new Promise(r => setTimeout(r, 4000)));

    // 提取页面信息
    let title = '';
    let coverUrl = '';
    let author = '';

    try { title = await page.title(); } catch (e) {}

    // meta 封面
    try {
      coverUrl = await page.evaluate(() => {
        const m = document.querySelector('meta[property="og:image"]');
        return m?.content || null;
      });
    } catch (e) {}

    // 作者
    try {
      author = await page.evaluate(() => {
        const m = document.querySelector('meta[property="og:video:actor"]');
        return m?.content || document.querySelector('.author')?.textContent?.trim() || '';
      });
    } catch (e) {}

    // 取视频地址优先级：网络拦截 > 页面 JS 数据
    let videoUrl = videoUrls.find(u => !u.includes('blob:')) || null;
    let audioUrl = null;

    if (!videoUrl) {
      try {
        videoUrl = await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v && v.src && !v.src.startsWith('blob:')) return v.src;
          return null;
        });
      } catch (e) {}
    }

    if (!videoUrl) {
      try {
        const data = await page.evaluate(() => {
          const script = document.querySelector('script#__INITIAL_STATE__');
          if (!script) return null;
          return JSON.parse(script.textContent);
        });
        if (data) {
          const item = data?.videoInfoRes?.item_list?.[0];
          if (item) {
            videoUrl ||= item?.video?.play_addr?.url_list?.[0] || item?.video?.download_addr?.url_list?.[0];
            audioUrl ||= item?.music?.play_url?.url_list?.[0] || item?.music?.play_url?.uri || null;
            coverUrl ||= item?.video?.cover?.url_list?.[0] || item?.video?.dynamic_cover?.url_list?.[0] || coverUrl;
            author ||= item?.author?.nickname || author;
          }
        }
      } catch (e) {}
    }

    if (!videoUrl) {
      try {
        const data = await page.evaluate(() => {
          const script = document.querySelector('script#RENDER_DATA');
          if (!script) return null;
          return JSON.parse(decodeURIComponent(script.textContent));
        });
        if (data) {
          const item = data?.app?.videoInfoRes?.item_list?.[0];
          if (item) {
            videoUrl ||= item?.video?.play_addr?.url_list?.[0] || item?.video?.download_addr?.url_list?.[0];
            audioUrl ||= item?.music?.play_url?.url_list?.[0];
          }
        }
      } catch (e) {}
    }

    // 如果是图文（没有视频），从页面 DOM 提取图片
    let images = [];

    if (!videoUrl || videoUrl.startsWith('blob:')) {
      try {
        images = await page.evaluate(() => {
          const urls = [];
          document.querySelectorAll('img').forEach(img => {
            let src = img.src || img.getAttribute('src') || '';
            if (src.includes('douyinpic.com') && src.includes('aweme_images')) {
              // 去除尺寸后缀，保留原图
              src = src.replace(/~.*$/, '');
              if (!urls.includes(src)) urls.push(src);
            }
          });
          return urls;
        });
      } catch (e) {}

      // 再试 RENDER_DATA 里淘图片
      if (!images.length) {
        try {
          const data = await page.evaluate(() => {
            const script = document.querySelector('script#RENDER_DATA');
            if (!script) return null;
            return JSON.parse(decodeURIComponent(script.textContent));
          });
          if (data) {
            images = extractDouyinNoteImages(data);
          }
        } catch (e) {}
      }

      // 如果还没封面，用第一张图当封面
      if (!coverUrl && images.length) coverUrl = images[0];

      await page.close();

      if (images.length) {
        return { videoUrl: null, audioUrl: null, coverUrl, images, title: title || '抖音图文', author: author || '未知' };
      }

      throw new Error('未能提取到视频地址（抖音已加密），请确认链接有效或稍后重试');
    }

    await page.close();

    if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
    if (audioUrl && audioUrl.startsWith('//')) audioUrl = 'https:' + audioUrl;

    return { videoUrl, audioUrl, coverUrl, images, title: title || '抖音视频', author: author || '未知' };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// ===== 快手解析 =====
async function parseKuaishou(shareUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    let videoUrl = null;
    let title = '';
    let coverUrl = '';
    let author = '';

    await page.goto(shareUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 3000)));

    // 从页面标题
    try { title = await page.title(); } catch (e) {}

    // 提取 video 元素
    try {
      videoUrl = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v?.src || null;
      });
    } catch (e) {}

    // 从页面源代码中提取 video 地址
    if (!videoUrl) {
      try {
        videoUrl = await page.evaluate(() => {
          const html = document.documentElement.innerHTML;
          const match = html.match(/(https?:\\\/\\\/[^"']*?\.mp4[^"']*)/);
          if (match) return match[1].replace(/\\\//g, '/');
          return null;
        });
      } catch (e) {}
    }

    // 封面
    try {
      coverUrl = await page.evaluate(() => {
        const meta = document.querySelector('meta[property="og:image"]');
        return meta?.content || document.querySelector('video')?.poster || null;
      });
    } catch (e) {}

    await page.close();

    if (!videoUrl) {
      throw new Error('未能提取到视频地址，请确认链接有效');
    }

    return { videoUrl, coverUrl, title: title || '快手视频', author: author || '未知' };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// ===== 小红书解析 =====
async function parseXiaohongshu(shareUrl) {
  let httpResult = null;

  // 第一步：尝试 HTTP 直取（快，但可能找不到视频）
  try {
    const xhsHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    const resp = await axios.get(shareUrl, { headers: xhsHeaders, timeout: 15000 });
    const html = resp.data;

    let title = '';
    let author = '';
    let coverUrl = '';
    let videoUrl = null;
    let audioUrl = null;
    let images = [];

    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
    const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
    const ogDesc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/);
    title = ogTitle?.[1] || ogDesc?.[1] || '';
    coverUrl = ogImage?.[1] || '';

    const initMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});\s*<\/script>/);
    if (initMatch) {
      try {
        const data = JSON.parse(initMatch[1]);
        const note = data?.note || data?.noteDetail || {};
        title ||= note?.title || note?.desc || '';
        author ||= note?.user?.nickname || note?.author || '';
        coverUrl ||= note?.cover?.url || note?.cover?.url_default || note?.imageList?.[0]?.url || '';
        const video = note?.video || note?.videoNote || {};
        videoUrl ||= video?.media?.stream?.h264?.[0]?.masterUrl || video?.playUrl || null;
        audioUrl ||= video?.media?.stream?.audio?.[0]?.masterUrl || null;
        if (note?.imageList) {
          images = note.imageList.map(i => i.url || i.infoList?.[0]?.url || '').filter(Boolean);
        }
      } catch (e) {}
    }

    if (!initMatch) {
      const jsonScripts = html.matchAll(/<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/g);
      for (const script of jsonScripts) {
        try {
          const data = JSON.parse(script[1]);
          const noteData = data?.note || data?.mainModule?.note || data;
          const video = noteData?.video || noteData?.media?.video || {};
          videoUrl ||= video?.playUrl || video?.url || video?.masterUrl || null;
          title ||= noteData?.title || noteData?.desc || title;
          author ||= noteData?.user?.nickname || noteData?.author || author;
        } catch (e) {}
      }
    }

    if (!images.length) {
      const imgMatches = html.match(/https?:[^"'\s]+(?:xhscdn\.com|xiaohongshu\.com)[^"'\s]*\.(?:jpg|jpeg|png|webp)/g);
      if (imgMatches) {
        images = [...new Set(imgMatches.map(u => u.replace(/&amp;/g, '&')))].slice(0, 20);
      }
    }

    // 过滤头像/平台图标，统一 https
    images = images.filter(u => !u.includes('/avatar/') && !u.includes('fe-platform.')).map(u => u.startsWith('http://') ? 'https://' + u.slice(7) : u);
    if (coverUrl && coverUrl.startsWith('http://')) coverUrl = 'https://' + coverUrl.slice(7);

    httpResult = { title, author, coverUrl, videoUrl, audioUrl, images };
  } catch (httpErr) {
    console.log('[小红书] HTTP 请求失败:', httpErr.message);
  }

  // 如果 HTTP 找到了视频，直接返回
  if (httpResult?.videoUrl) {
    const r = httpResult;
    return { videoUrl: r.videoUrl, audioUrl: r.audioUrl, coverUrl: r.coverUrl, images: r.images, title: r.title || '小红书视频', author: r.author || '未知' };
  }

  // 第二步：Puppeteer 完整渲染（找视频，也找更全的图片）
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 390, height: 844 });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');

    let puppeteerVideoUrl = null;
    page.on('response', (resp) => {
      const url = resp.url();
      if (!url.includes('blob:') && (url.includes('.mp4') || url.includes('xhscdn') || url.includes('sns-video'))) {
        if (url.includes('.mp4') || resp.headers()['content-type']?.includes('video') || resp.headers()['content-type']?.includes('octet')) {
          puppeteerVideoUrl = url;
        }
      }
    });

    await page.goto(shareUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 5000)));

    // 合并结果：Puppeteer 数据优先，HTTP 数据作为后备
    let title = '';
    let coverUrl = '';
    let author = '';
    let videoUrl = null;
    let audioUrl = null;
    let images = [];

    try { title = await page.title(); } catch (e) {}
    try { coverUrl = await page.evaluate(() => document.querySelector('meta[property="og:image"]')?.content || ''); } catch (e) {}
    try { author = await page.evaluate(() => document.querySelector('.username, .author, .nickname')?.textContent?.trim() || ''); } catch (e) {}

    // 从页面中获取图片
    try {
      images = await page.evaluate(() => {
        const found = new Set();
        document.querySelectorAll('.carousel img, .swiper img, .note-image img, .slide img, img[src*="xhscdn"]').forEach(img => {
          const src = img.src || img.getAttribute('data-src') || '';
          if (src && !src.startsWith('blob:') && !src.startsWith('data:') && !src.includes('/avatar/')) found.add(src);
        });
        if (!found.size) {
          document.querySelectorAll('img').forEach(img => {
            const src = img.src || '';
            if (src && !src.startsWith('blob:') && !src.startsWith('data:') && src.includes('xhscdn') && !src.includes('/avatar/')) found.add(src);
          });
        }
        return [...found];
      });
    } catch (e) {}

    videoUrl = puppeteerVideoUrl || null;
    if (!videoUrl) {
      try {
        videoUrl = await page.evaluate(() => {
          const v = document.querySelector('video');
          return (v && v.src && !v.src.startsWith('blob:')) ? v.src : null;
        });
      } catch (e) {}
    }

    await page.close();

    // 过滤头像/平台图标，统一 https
    images = images.filter(u => !u.includes('/avatar/') && !u.includes('fe-platform.')).map(u => u.startsWith('http://') ? 'https://' + u.slice(7) : u);
    if (coverUrl && coverUrl.startsWith('http://')) coverUrl = 'https://' + coverUrl.slice(7);

    // 合并 HTTP 和 Puppeteer 数据
    title ||= httpResult?.title || '';
    coverUrl ||= httpResult?.coverUrl || '';
    author ||= httpResult?.author || '';
    audioUrl ||= httpResult?.audioUrl || null;
    if (!images.length && httpResult?.images?.length) images = httpResult.images;

    return {
      videoUrl: videoUrl || null,
      audioUrl: audioUrl || null,
      coverUrl: coverUrl || '',
      images,
      title: title || '小红书笔记',
      author: author || '未知',
    };
  } catch (err) {
    await page.close().catch(() => {});
    // Puppeteer 失败，回退到 HTTP 结果
    if (httpResult) {
      return { videoUrl: null, audioUrl: httpResult.audioUrl, coverUrl: httpResult.coverUrl, images: httpResult.images, title: httpResult.title || '小红书笔记', author: httpResult.author || '未知' };
    }
    throw err;
  }
}

// ===== X (Twitter) 解析 =====
async function parseX(shareUrl) {
  // 从 x.com/username/status/id 提取推文 ID
  const idMatch = shareUrl.match(/\/status\/(\d+)/);
  const tweetId = idMatch ? idMatch[1] : null;
  if (!tweetId) throw new Error('无法识别推文 ID，请确认链接格式正确');

  // 优先用 API 获取（无需翻墙、无需 Puppeteer）
  // fxtwitter 提供免费的推文 API，返回包括视频地址
  try {
    const resp = await axios.get(`https://api.fxtwitter.com/status/${tweetId}`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const tweet = resp.data?.tweet;
    if (!tweet) throw new Error('推文不存在或无法访问');

    const author = tweet.author?.name ? `@${tweet.author.screen_name}` : (tweet.author?.screen_name || '未知');
    const title = tweet.text ? tweet.text.replace(/\n/g, ' ').substring(0, 100) : 'X 推文';

    let videoUrl = null;
    let coverUrl = null;
    let images = [];
    let audioUrl = null;

    // 媒体处理
    const media = tweet.media || {};

    // 视频推文（videos 数组或 all 数组中 type=video）
    if (media.videos?.length) {
      videoUrl = media.videos[0].url;
      coverUrl = media.videos[0].thumbnail_url || null;
      // 选最高码率的 mp4
      if (media.videos[0].formats?.length) {
        const mp4s = media.videos[0].formats.filter(f => f.container === 'mp4' && f.bitrate);
        if (mp4s.length) videoUrl = mp4s.sort((a, b) => b.bitrate - a.bitrate)[0].url;
      }
    } else if (media.all?.length) {
      const v = media.all.find(m => m.type === 'video');
      if (v) {
        videoUrl = v.url;
        coverUrl = v.thumbnail_url || null;
      }
    }

    // 图片推文
    if (media.photos?.length) {
      images = media.photos.map(p => p.url).filter(Boolean);
    } else if (media.all?.length) {
      images = media.all.filter(m => m.type === 'photo' || m.type === 'image').map(p => p.url).filter(Boolean);
    }
    if (!coverUrl && images.length) coverUrl = images[0];

    if (!videoUrl && !images.length) {
      throw new Error('该推文中没有可下载的视频或图片');
    }

    return { videoUrl, audioUrl, coverUrl, images, title, author };
  } catch (apiErr) {
    if (apiErr.message.includes('没有可下载')) throw apiErr;
    console.log('[X] API 请求失败，回退到 Puppeteer:', apiErr.message);
  }

  // 回退：Puppeteer + HTTP 代理
  const browser = await getBrowser();
  const page = await browser.newPage();
  const videoUrls = [];

  try {
    // 网络拦截：捕获 video.twimg.com 的视频响应
    page.on('response', async (resp) => {
      const url = resp.url();
      const ct = resp.headers()['content-type'] || '';
      if (
        url.includes('video.twimg.com') &&
        (ct.includes('video') || ct.includes('octet-stream') || url.includes('.mp4'))
      ) {
        videoUrls.push(url);
      }
    });

    await page.goto(shareUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 4000)));

    // 滚动触发懒加载
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.evaluate(() => new Promise(r => setTimeout(r, 1000)));

    let title = '';
    let coverUrl = '';
    let author = '';
    let images = [];

    try { title = await page.title(); } catch (e) {}

    // 封面 meta
    try {
      coverUrl = await page.evaluate(() => {
        return document.querySelector('meta[property="og:image"]')?.content ||
               document.querySelector('meta[name="twitter:image"]')?.content || null;
      });
    } catch (e) {}

    // 作者
    try {
      author = await page.evaluate(() => {
        const creator = document.querySelector('meta[name="twitter:creator"]');
        if (creator?.content) return '@' + creator.content;
        const site = document.querySelector('meta[name="twitter:site"]');
        if (site?.content) return '@' + site.content;
        return '';
      });
    } catch (e) {}

    // 视频地址：优先网络拦截
    let videoUrl = videoUrls.find(u => u.includes('video.twimg.com') && !u.includes('blob:')) || null;

    // 兜底：从 video 元素提取
    if (!videoUrl) {
      try {
        videoUrl = await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v) {
            if (v.src && !v.src.startsWith('blob:')) return v.src;
            const source = v.querySelector('source');
            if (source && source.src && !source.src.startsWith('blob:')) return source.src;
          }
          return null;
        });
      } catch (e) {}
    }

    // 图片
    try {
      images = await page.evaluate(() => {
        const found = new Set();
        document.querySelectorAll('img[src*="pbs.twimg.com"]').forEach(img => {
          const src = img.src.split('?')[0];
          if (src && !src.includes('profile_images') && !src.includes('card_img')) {
            found.add(src);
          }
        });
        return [...found];
      });
    } catch (e) {}

    await page.close();
    

    if (!videoUrl && !images.length) {
      throw new Error('未能提取到媒体内容，请确认推文包含视频或图片');
    }

    return { videoUrl, audioUrl: null, coverUrl, images, title: title || 'X 推文', author: author || '未知' };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// ===== q7u6h.top 解析 =====
async function parseQ7u6h(shareUrl) {
  const resp = await axios.get(shareUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: 15000,
  });
  const html = resp.data;

  // 提取 base64 编码的视频变量
  const videoMatch = html.match(/var video\s*=\s*decodeString\('([^']+)'\)/);
  const hostMatch = html.match(/var m3u8_host\s*=\s*decodeString\('([^']+)'\)/);
  if (!videoMatch || !hostMatch) throw new Error('无法从页面提取视频地址');

  const videoPath = Buffer.from(videoMatch[1], 'base64').toString();
  const m3u8Host = Buffer.from(hostMatch[1], 'base64').toString();
  const m3u8Url = m3u8Host.replace(/\/+$/, '') + videoPath;

  // 尝试提取直接 MP4 下载链接
  let mp4Url = null;
  const mp4Match = html.match(/page-download-button[^>]+href="([^"]+\.mp4)"/);
  if (mp4Match) {
    mp4Url = mp4Match[1].replace(/\/\//g, '/').replace(/^https:\//, 'https://');
  }

  // 提取标题
  let title = '';
  // 尝试从 <h1> 或 <title> 取标题
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  if (h1Match) title = h1Match[1].trim();
  if (!title) {
    const tMatch = html.match(/<title>([^<]*)<\/title>/);
    if (tMatch) title = tMatch[1].trim();
  }

  return {
    videoUrl: m3u8Url,
    mp4Url,
    audioUrl: null,
    coverUrl: null,
    images: [],
    title: title || '视频',
    author: '',
  };
}

// ===== B站解析（多层降级） =====
async function parseBilibili(shareUrl) {
  // 处理 b23.tv 短链接：跟随重定向获取完整 URL
  if (/b23\.tv/i.test(shareUrl)) {
    try {
      const resp = await axios.get(shareUrl, {
        maxRedirects: 0,
        validateStatus: s => s < 400,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        timeout: 10000,
      });
      if (resp.headers.location) shareUrl = resp.headers.location;
    } catch (e) { /* 直接用原链接 */ }
  }

  // 提取 BV 号或 AV 号
  let bvid = null, aid = null;
  const bvMatch = shareUrl.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
  if (bvMatch) bvid = bvMatch[1];
  const avMatch = shareUrl.match(/\/video\/(av\d+)/i);
  if (avMatch) aid = avMatch[1].replace('av', '');

  if (!bvid && !aid) throw new Error('无法识别 B站视频 ID，请确认链接格式（如 https://www.bilibili.com/video/BVxxx）');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
  };

  // 第一步：获取视频基本信息（无需登录）
  const infoUrl = bvid
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
    : `https://api.bilibili.com/x/web-interface/view?aid=${aid}`;

  const infoResp = await axios.get(infoUrl, { headers, timeout: 15000 });
  const infoData = infoResp.data;
  if (infoData.code !== 0 || !infoData.data) throw new Error(infoData.message || '无法获取视频信息');

  const v = infoData.data;
  bvid = v.bvid;
  const cid = v.cid;
  const title = v.title || 'B站视频';
  const coverUrl = v.pic || '';
  const author = v.owner?.name || '';

  // 第二步：尝试 API 获取播放地址（从高画质到低画质）
  const qualities = [
    { qn: 80, desc: '高清 720P' },
    { qn: 64, desc: '高清 720P' },
    { qn: 32, desc: '清晰 480P' },
    { qn: 16, desc: '流畅 360P' },
  ];

  let videoUrl = null;

  for (const q of qualities) {
    try {
      const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${q.qn}&platform=web`;
      const playResp = await axios.get(playUrl, { headers, timeout: 15000 });
      const playData = playResp.data;
      if (playData.code === 0 && playData.data?.durl?.length) {
        const durls = playData.data.durl;
        videoUrl = durls[durls.length - 1].url;
        console.log(`[B站] API 获取成功: ${q.desc}`);
        break;
      }
      // -101 = 需要登录，-400 = 请求错误，继续试低画质
      console.log(`[B站] API ${q.desc} 不可用: ${playData.message || playData.code}`);
    } catch (e) {
      console.log(`[B站] API ${q.desc} 请求失败: ${e.message}`);
    }
  }

  // 第三步：API 全部失败 → Puppeteer 页面截流
  if (!videoUrl) {
    console.log('[B站] API 失败，降级到 Puppeteer 页面截流...');
    try {
      const browserResult = await parseBilibiliViaBrowser(shareUrl, cid);
      // 合并基本信息（Puppeteer 可能也拿到了）
      return {
        videoUrl: browserResult.videoUrl,
        audioUrl: null,
        coverUrl: browserResult.coverUrl || coverUrl,
        images: browserResult.images || [],
        title: browserResult.title || title,
        author: browserResult.author || author,
      };
    } catch (browserErr) {
      console.log('[B站] Puppeteer 截流失效:', browserErr.message);
      throw new Error('B站需要登录才能下载此视频。建议：在 Chrome 中登录 B站 后重启本工具，或换一个不需要登录的视频');
    }
  }

  return { videoUrl, audioUrl: null, coverUrl, images: [], title, author };
}

// Puppeteer 页面截流：打开B站页面，劫持 fetch 捕获播放地址
// 使用 chrome-profile/ 持久化配置，登录一次后 Cookie 永久生效
async function parseBilibiliViaBrowser(shareUrl, cid) {
  let biliBrowser = null;
  try {
    // 用持久配置启动独立浏览器（与全局 getBrowser() 隔离），自动带上 B站 Cookie
    biliBrowser = await require('puppeteer-extra').launch({
      headless: 'new',
      userDataDir: BILIBILI_PROFILE_DIR,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
    });
    const page = await biliBrowser.newPage();

    let apiVideoUrl = null;
    let pageTitle = '';
    let pageCover = '';
    let pageAuthor = '';

    // 劫持 fetch 和 XHR，捕获 playurl 响应（不跟页面 JS 抢 body）
    await page.evaluateOnNewDocument(() => {
      // 劫持 fetch
      const origFetch = window.fetch;
      window.fetch = async (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const resp = await origFetch(...args);
        if (url.includes('playurl') || url.includes('bilivideo.com')) {
          resp.clone().json().then(d => {
            window.__biliPlayData = d;
          }).catch(() => {});
        }
        return resp;
      };
      // 劫持 XHR
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(...args) {
        this.__biliUrl = args[1] || '';
        return origOpen.apply(this, args);
      };
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function(...args) {
        if (this.__biliUrl && (this.__biliUrl.includes('playurl') || this.__biliUrl.includes('bilivideo.com'))) {
          this.addEventListener('load', () => {
            try { window.__biliPlayData = JSON.parse(this.responseText); } catch(e) {}
          });
        }
        return origSend.apply(this, args);
      };
    });

    await page.goto(shareUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 5000)));

    // 尝试从劫持数据提取
    try {
      const data = await page.evaluate(() => window.__biliPlayData);
      if (data?.data?.durl?.length) {
        const last = data.data.durl[data.data.durl.length - 1];
        apiVideoUrl = last.url;
      } else if (data?.data?.dash?.video?.length) {
        apiVideoUrl = data.data.dash.video[0].base_url;
        if (apiVideoUrl && !apiVideoUrl.startsWith('http')) {
          apiVideoUrl = 'https://' + apiVideoUrl;
        }
      }
    } catch (e) {}

    // 提取页面信息
    try { pageTitle = await page.title(); } catch (e) {}
    try {
      pageCover = await page.evaluate(() => {
        const m = document.querySelector('meta[property="og:image"]');
        return m?.content || '';
      });
    } catch (e) {}
    try {
      pageAuthor = await page.evaluate(() => {
        const el = document.querySelector('.up-name, .author-name, .video-data .name, .video-uploader .name');
        return el?.textContent?.trim() || '';
      });
    } catch (e) {}

    // 从 video 元素取
    if (!apiVideoUrl) {
      try {
        apiVideoUrl = await page.evaluate(() => {
          const v = document.querySelector('video');
          return (v && v.src && !v.src.startsWith('blob:')) ? v.src : null;
        });
      } catch (e) {}
    }

    // 从页面嵌入数据提取（window.__playinfo__）
    if (!apiVideoUrl) {
      try {
        apiVideoUrl = await page.evaluate(() => {
          const scripts = document.querySelectorAll('script');
          for (const s of scripts) {
            const t = s.textContent || '';
            if (t.includes('window.__playinfo__')) {
              try {
                const match = t.match(/window\.__playinfo__\s*=\s*({.*?})\s*;/);
                if (match) {
                  const info = JSON.parse(match[1]);
                  if (info?.data?.durl?.length) return info.data.durl[info.data.durl.length - 1].url;
                  if (info?.data?.dash?.video?.length) return info.data.dash.video[0].base_url;
                }
              } catch (e2) {}
            }
          }
          return null;
        });
      } catch (e) {}
    }

    await page.close();
    await biliBrowser.close();

    if (!apiVideoUrl) {
      throw new Error('页面截流未能获取视频地址');
    }

    return {
      videoUrl: apiVideoUrl,
      coverUrl: pageCover,
      title: pageTitle || '',
      author: pageAuthor || '',
    };
  } catch (err) {
    if (biliBrowser) await biliBrowser.close().catch(() => {});
    throw err;
  }
}

// ===== YouTube 解析（用 yt-dlp 提取信息） =====
async function parseYoutube(shareUrl) {
  const ytDlp = 'D:\\yt-dlp.exe';
  const proxy = '--proxy http://127.0.0.1:1080';
  const cmd = `"${ytDlp}" ${proxy} --dump-json --no-playlist --no-warnings "${shareUrl}"`;

  return new Promise((resolve, reject) => {
    require('child_process').exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error('解析失败: ' + (stderr || err.message).substring(0, 200)));
        return;
      }
      try {
        const line = stdout.trim().split('\n')[0];
        const info = JSON.parse(line);
        resolve({
          videoUrl: shareUrl, // 下载时用 yt-dlp 直下
          audioUrl: null,
          coverUrl: info.thumbnail || '',
          images: [],
          title: info.title || 'YouTube视频',
          author: info.uploader || info.channel || info.uploader_id || '',
        });
      } catch (e) {
        reject(new Error('解析失败: ' + e.message));
      }
    });
  });
}

// ===== 微博视频解析（SPA 页面，Puppeteer 渲染） =====
async function parseWeibo(shareUrl) {
  // 统一转为 weibo.com/tv/show/ 格式
  let pageUrl = shareUrl;
  const fidMatch = shareUrl.match(/fid=(\d+:\d+)/);
  if (fidMatch) {
    pageUrl = `https://weibo.com/tv/show/${fidMatch[1]}`;
  }

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    let videoUrl = null;
    let title = '';
    let coverUrl = '';
    let author = '';
    let apiVideoUrl = null;

    // 劫持 fetch 和 XHR 捕获视频地址
    await page.evaluateOnNewDocument(() => {
      const origFetch = window.fetch;
      window.fetch = async (...args) => {
        const resp = await origFetch(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (url.includes('video') || url.includes('stream') || url.includes('media')) {
          resp.clone().text().then(t => {
            window.__wbVideoData = t;
          }).catch(() => {});
        }
        return resp;
      };
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(...args) {
        this.__wbUrl = args[1] || '';
        return origOpen.apply(this, args);
      };
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function(...args) {
        if (this.__wbUrl && (this.__wbUrl.includes('ajax') || this.__wbUrl.includes('video') || this.__wbUrl.includes('media') || this.__wbUrl.includes('statuses'))) {
          this.addEventListener('load', () => {
            try { window.__wbVideoData = this.responseText; } catch(e) {}
          });
        }
        return origSend.apply(this, args);
      };
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 5000)));

    // 尝试从劫持的数据提取
    try {
      const raw = await page.evaluate(() => window.__wbVideoData || '');
      if (raw) {
        const data = JSON.parse(raw);
        // 尝试各种可能的视频字段
        const deepFind = (obj, depth = 0) => {
          if (!obj || depth > 6 || typeof obj !== 'object') return null;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const r = deepFind(item, depth + 1);
              if (r) return r;
            }
            return null;
          }
          // 检查常见视频 URL 字段
          for (const key of ['stream_url', 'video_url', 'play_url', 'url', 'media_url', 'mp4_url', 'high_url', 'normal_url']) {
            if (obj[key] && typeof obj[key] === 'string' && (obj[key].includes('.mp4') || obj[key].includes('.m3u8'))) {
              return obj[key];
            }
          }
          for (const key of Object.keys(obj)) {
            const r = deepFind(obj[key], depth + 1);
            if (r) return r;
          }
          return null;
        };
        videoUrl = deepFind(data);

        // 提取标题封面
        if (data?.data?.page_info?.page_title) title = data.data.page_info.page_title;
        if (data?.data?.user?.screen_name) author = data.data.user.screen_name;
        if (data?.data?.page_info?.page_pic) coverUrl = data.data.page_info.page_pic;
      }
    } catch (e) {}

    // 从 video 元素取
    if (!videoUrl) {
      try {
        videoUrl = await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v && v.src && !v.src.startsWith('blob:')) return v.src;
          const source = v?.querySelector('source');
          if (source?.src && !source.src.startsWith('blob:')) return source.src;
          return null;
        });
      } catch (e) {}
    }

    // 提取标题和封面
    if (!title) {
      try { title = await page.title(); } catch (e) {}
    }
    if (!coverUrl) {
      try {
        coverUrl = await page.evaluate(() => {
          const m = document.querySelector('meta[property="og:image"]');
          return m?.content || '';
        });
      } catch (e) {}
    }
    if (!author) {
      try {
        author = await page.evaluate(() => {
          const m = document.querySelector('meta[name="author"]');
          return m?.content || document.querySelector('.name, .username, .W_autocut')?.textContent?.trim() || '';
        });
      } catch (e) {}
    }

    await page.close();

    if (!videoUrl) {
      throw new Error('未能提取到视频地址');
    }

    return { videoUrl, audioUrl: null, coverUrl, images: [], title: title || '微博视频', author: author || '' };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// 用 yt-dlp 下载（主要用于 m3u8）
async function downloadWithYtdlp(url, filePath, res, useProxy) {
  if (!res.headersSent) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  }

  return new Promise((resolve, reject) => {
    const ytDlp = 'D:\\yt-dlp.exe';
    const proxy = useProxy ? '--proxy http://127.0.0.1:1080' : '';
    const cmd = `"${ytDlp}" ${proxy} -o "${filePath}" --no-playlist --progress --newline --no-warnings "${url}"`;

    const proc = require('child_process').exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err && !stdout.includes('100%')) {
        reject(new Error('下载失败: ' + (stderr || err.message).substring(0, 200)));
        return;
      }
      try {
        const stats = fs.statSync(filePath);
        resolve(stats.size);
      } catch {
        reject(new Error('下载后文件未找到'));
      }
    });

    // 解析 yt-dlp 进度
    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        const text = data.toString();
        const pctMatch = text.match(/(\d+\.?\d*)%/);
        if (pctMatch) {
          const pct = Math.round(parseFloat(pctMatch[1]));
          res.write(`data: ${JSON.stringify({ progress: pct, status: `${pct}%` })}\n\n`);
        }
      });
    }

    // 定期检查文件大小作为进度兜底
    const checkInterval = setInterval(() => {
      try {
        if (fs.existsSync(filePath)) {
          const size = fs.statSync(filePath).size;
          res.write(`data: ${JSON.stringify({ progress: -1, downloaded: size })}\n\n`);
        }
      } catch {}
    }, 2000);

    proc.on('exit', () => {
      clearInterval(checkInterval);
    });
  });
}

// ===== API: 解析视频 =====
app.post('/api/parse', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '请提供视频链接' });

  const shareUrl = normalizeUrl(url);
  const platform = detectPlatform(shareUrl);
  if (!platform) return res.status(400).json({ error: '暂不支持该平台，目前支持抖音、快手、小红书、X、B站、YouTube、微博' });

  console.log(`[解析] 平台: ${platform}, 链接: ${shareUrl}`);

  try {
    let result;
    if (platform === 'douyin') {
      result = await parseDouyin(shareUrl);
    } else if (platform === 'kuaishou') {
      result = await parseKuaishou(shareUrl);
    } else if (platform === 'xiaohongshu') {
      result = await parseXiaohongshu(shareUrl);
    } else if (platform === 'x') {
      result = await parseX(shareUrl);
    } else if (platform === 'q7u6h') {
      result = await parseQ7u6h(shareUrl);
    } else if (platform === 'bilibili') {
      result = await parseBilibili(shareUrl);
    } else if (platform === 'youtube') {
      result = await parseYoutube(shareUrl);
    } else if (platform === 'weibo') {
      result = await parseWeibo(shareUrl);
    }
    res.json({ success: true, ...result, platform, shareUrl });
  } catch (err) {
    console.error('[解析失败]', err.message);
    res.status(500).json({ error: `解析失败: ${err.message}` });
  }
});

// ===== 下载文件（视频/音频/图片） =====
async function downloadFile(url, filePath, platform, res) {
  const referers = { douyin: 'https://www.douyin.com/', kuaishou: 'https://www.kuaishou.com/', xiaohongshu: 'https://www.xiaohongshu.com/', x: 'https://x.com/', bilibili: 'https://www.bilibili.com/', weibo: 'https://www.weibo.com/' };
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Referer': referers[platform] || 'https://www.douyin.com/',
    },
    timeout: 120000,
  });

  const totalSize = parseInt(response.headers['content-length'] || '0');
  const writer = fs.createWriteStream(filePath);
  let downloadedSize = 0;
  let lastProgress = 0;

  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
  }

  return new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      downloadedSize += chunk.length;
      writer.write(chunk);
      if (totalSize > 0) {
        const pct = Math.round((downloadedSize / totalSize) * 100);
        if (pct !== lastProgress) {
          lastProgress = pct;
          res.write(`data: ${JSON.stringify({ progress: pct, downloaded: downloadedSize, total: totalSize })}\n\n`);
        }
      } else {
        res.write(`data: ${JSON.stringify({ progress: -1, downloaded: downloadedSize })}\n\n`);
      }
    });

    response.data.on('end', () => {
      writer.end();
      resolve(downloadedSize);
    });

    response.data.on('error', (err) => {
      writer.end();
      reject(new Error('下载中断: ' + err.message));
    });
  });
}

// ===== Puppeteer 下载 =====
// 禁用 JS → 直接访问视频 URL → 浏览器返回原始数据 → 保存
async function downloadViaBrowser(url, filePath, res) {
  if (!res.headersSent) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  }

  const MAX_RETRIES = 3;
  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const launchArgs = [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--ignore-certificate-errors',
      '--disable-web-security',
    ];
    // X_PROFILE=1：用本地 Chrome 配置（含 X 登录态），需先关闭 Chrome 再启动服务器
    if (process.env.X_PROFILE) {
      launchArgs.push('--user-data-dir=C:/Users/yun/AppData/Local/Google/Chrome/User Data');
    }
    const browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 600000,
      args: launchArgs,
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Origin': 'https://x.com', 'Referer': 'https://x.com/' });

    try {
      if (attempt === 0) {
        res.write(`data: ${JSON.stringify({ progress: 0, status: '浏览器下载中...' })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ progress: 0, status: `重试 ${attempt + 1}/${MAX_RETRIES}...` })}\n\n`);
      }

      // 导航到视频 URL → 页面 origin 自动设为 video.twimg.com → 同源 fetch 无 CORS
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 3000));

      // 分块传输，避免大文件 base64 导致页崩溃
      const chunks = [];
      const CHUNK_SIZE = 512 * 1024;
      await page.exposeFunction('sendChunk', (b64) => {
        chunks.push(Buffer.from(b64, 'base64'));
        return Promise.resolve();
      });

      const result = await page.evaluate(async (videoUrl, chunkSize) => {
        try {
          const resp = await fetch(videoUrl);
          const blob = await resp.blob();
          const total = blob.size;
          let offset = 0;
          const reader = new FileReader();
          while (offset < total) {
            const slice = blob.slice(offset, offset + chunkSize);
            const buf = await new Promise((resolve, reject) => {
              reader.onload = () => resolve(new Uint8Array(reader.result));
              reader.onerror = reject;
              reader.readAsArrayBuffer(slice);
            });
            let binary = '';
            for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
            await window.sendChunk(btoa(binary));
            offset += chunkSize;
          }
          return JSON.stringify({ ok: true, size: total });
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      }, url, CHUNK_SIZE);

      const r = JSON.parse(result);
      if (!r.ok) throw new Error(r.error || 'fetch failed');

      const buf = Buffer.concat(chunks);
      fs.writeFileSync(filePath, buf);
      await browser.close();
      const sz = (buf.length / 1024 / 1024).toFixed(1);
      console.log(`  [下载完成] ${sz}MB (${chunks.length}块)${attempt > 0 ? ' 重试' + attempt + '次' : ''}`);
      return buf.length;
    } catch (err) {
      lastError = err;
      await browser.close().catch(() => {});

      if (attempt < MAX_RETRIES - 1) {
        const delay = 3000 * Math.pow(2, attempt); // 3s, 6s, 12s
        console.log(`  [下载失败] ${err.message.substring(0, 60)}，${delay/1000}s 后重试...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError || new Error('下载失败，已达最大重试次数');
}

// ===== API: 下载 =====
app.post('/api/download', async (req, res) => {
  const { videoUrl, title, platform, coverUrl, author, shareUrl, audioUrl, images, type, selectedImages } = req.body;
  const dlType = type || 'video';

  if (dlType === 'image') {
    const imgList = selectedImages && selectedImages.length ? selectedImages : (coverUrl ? [coverUrl] : (images && images.length ? [images[0]] : []));
    if (!imgList.length) return res.status(400).json({ error: '没有可下载的图片' });

    const results = [];
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    for (let i = 0; i < imgList.length; i++) {
      const imgUrl = imgList[i];
      const safeName = (title || 'image').replace(/[<>:"\/\\|?*]/g, '_').substring(0, 50);
      const ext = imgUrl.match(/\.(jpg|jpeg|png|webp)/)?.[1] || 'jpg';
      const fileName = `${safeName}_${i + 1}_${Date.now()}.${ext}`;
      const filePath = path.join(DOWNLOADS_DIR, SUB_DIRS.image, fileName);
      try {
        res.write(`data: ${JSON.stringify({ progress: -1, status: `下载图片 ${i + 1}/${imgList.length}...`, fileName })}\n\n`);
        const size = platform === 'x' ? await downloadViaBrowser(imgUrl, filePath, res) : await downloadFile(imgUrl, filePath, platform, res);
        results.push({ fileName, filePath, size });
        addToHistory({ fileName, title: `${title || '图片'} (${i + 1}/${imgList.length})`, platform, coverUrl, author, path: filePath, size });
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: `图片 ${i + 1} 下载失败: ${err.message}` })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ done: true, files: results, count: results.length })}\n\n`);
    res.end();
    return;
  }

  if (dlType === 'audio') {
    if (!audioUrl) return res.status(400).json({ error: '没有可下载的音频' });
    const safeName = (title || 'audio').replace(/[<>:"\/\\|?*]/g, '_').substring(0, 60);
    const fileName = `${safeName}_${Date.now()}.mp3`;
    const filePath = path.join(DOWNLOADS_DIR, SUB_DIRS.audio, fileName);
    try {
      const size = await downloadFile(audioUrl, filePath, platform, res);
      const entry = { fileName, title: `${title} (音频)`, platform, coverUrl, author, path: filePath, size };
      addToHistory(entry);
      res.write(`data: ${JSON.stringify({ done: true, fileName, filePath, size })}\n\n`);
      res.end();
    } catch (err) {
      if (!res.headersSent) return res.status(500).json({ error: `音频下载失败: ${err.message}` });
      res.end();
    }
    return;
  }

  // 默认：下载视频
  if (!videoUrl) return res.status(400).json({ error: '缺少视频地址' });

  // X 平台用 Puppeteer 下载（twimg CDN 被墙，Node.js 直连不行）
  if (platform === 'x') {
    const safeName = (title || 'x_video').replace(/[<>:"\/\\|?*]/g, '_').substring(0, 80);
    const fileName = `${safeName}_${Date.now()}.mp4`;
    const filePath = path.join(DOWNLOADS_DIR, SUB_DIRS.video, fileName);
    console.log(`[下载-Puppeteer] ${fileName}`);
    try {
      const size = await downloadViaBrowser(videoUrl, filePath, res);
      const entry = { fileName, title: title || fileName, platform, coverUrl, author, path: filePath, size };
      addToHistory(entry);
      res.write(`data: ${JSON.stringify({ done: true, fileName, filePath, size })}\n\n`);
      res.end();
      console.log(`[完成] ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (err) {
      console.error('[下载-Puppeteer 失败]', err.message);
      if (!res.headersSent) return res.status(500).json({ error: `下载失败: ${err.message}` });
      res.end();
    }
    return;
  }

  // q7u6h 平台用 yt-dlp 下载 m3u8
  if (platform === 'q7u6h') {
    const safeName = (title || 'video').replace(/[<>:"\/\\|?*]/g, '_').substring(0, 80);
    const fileName = `${safeName}_${Date.now()}.mp4`;
    const filePath = path.join(DOWNLOADS_DIR, SUB_DIRS.video, fileName);
    console.log(`[下载-yt-dlp] ${fileName}`);

    // 优先尝试直接 MP4
    const mp4Url = req.body.mp4Url;
    if (mp4Url) {
      try {
        console.log('[下载] 尝试直接 MP4...');
        const size = await downloadFile(mp4Url, filePath, platform, res);
        const entry = { fileName, title: title || fileName, platform, coverUrl, author, path: filePath, size };
        addToHistory(entry);
        res.write(`data: ${JSON.stringify({ done: true, fileName, filePath, size })}\n\n`);
        res.end();
        console.log(`[完成] ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)`);
        return;
      } catch (e) {
        console.log('[下载] 直接 MP4 失败，回退 yt-dlp:', e.message);
      }
    }

    // 回退 yt-dlp 下载 m3u8
    try {
      const size = await downloadWithYtdlp(videoUrl, filePath, res);
      const entry = { fileName, title: title || fileName, platform, coverUrl, author, path: filePath, size };
      addToHistory(entry);
      res.write(`data: ${JSON.stringify({ done: true, fileName, filePath, size })}\n\n`);
      res.end();
      console.log(`[完成] ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (err) {
      console.error('[下载-yt-dlp 失败]', err.message);
      if (!res.headersSent) return res.status(500).json({ error: `下载失败: ${err.message}` });
      res.end();
    }
    return;
  }

  // YouTube 用 yt-dlp 下载
  if (platform === 'youtube') {
    const safeName = (title || 'youtube_video').replace(/[<>:"\/\\|?*]/g, '_').substring(0, 80);
    const fileName = `${safeName}_${Date.now()}.mp4`;
    const filePath = path.join(DOWNLOADS_DIR, SUB_DIRS.video, fileName);
    console.log(`[下载-yt-dlp-YouTube] ${fileName}`);
    try {
      const size = await downloadWithYtdlp(videoUrl || shareUrl, filePath, res, true);
      const entry = { fileName, title: title || fileName, platform, coverUrl, author, path: filePath, size };
      addToHistory(entry);
      res.write(`data: ${JSON.stringify({ done: true, fileName, filePath, size })}\n\n`);
      res.end();
      console.log(`[完成] ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (err) {
      console.error('[下载-yt-dlp-YouTube 失败]', err.message);
      if (!res.headersSent) return res.status(500).json({ error: `下载失败: ${err.message}` });
      res.end();
    }
    return;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const safeName = (title || 'video').replace(/[<>:"\/\\|?*]/g, '_').substring(0, 80);
      const fileName = `${safeName}_${Date.now()}.mp4`;
      const filePath = path.join(DOWNLOADS_DIR, SUB_DIRS.video, fileName);
      console.log(`[下载] 尝试 ${attempt}: ${fileName}`);
      const size = await downloadFile(videoUrl, filePath, platform, res);
      const entry = { fileName, title: title || fileName, platform, coverUrl, author, path: filePath, size };
      addToHistory(entry);
      res.write(`data: ${JSON.stringify({ done: true, fileName, filePath, size })}\n\n`);
      res.end();
      console.log(`[完成] ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)`);
      return;
    } catch (err) {
      console.error(`[下载] 尝试 ${attempt} 失败:`, err.message);
      if (attempt === 1 && shareUrl) {
        console.log('[下载] 尝试重新解析视频地址...');
        try {
          const platform2 = detectPlatform(shareUrl);
          let result;
          if (platform2 === 'douyin') result = await parseDouyin(shareUrl);
          else if (platform2 === 'kuaishou') result = await parseKuaishou(shareUrl);
          else if (platform2 === 'xiaohongshu') result = await parseXiaohongshu(shareUrl);
          else if (platform2 === 'x') result = await parseX(shareUrl);
          else if (platform2 === 'bilibili') result = await parseBilibili(shareUrl);
          else if (platform2 === 'youtube') result = await parseYoutube(shareUrl);
          else if (platform2 === 'weibo') result = await parseWeibo(shareUrl);
          if (result && result.videoUrl) {
            finalVideoUrl = result.videoUrl;
            continue;
          }
        } catch (e) {
          console.error('[下载] 重新解析失败:', e.message);
        }
      }
      if (!res.headersSent) {
        return res.status(500).json({ error: `下载失败: ${err.message}` });
      }
      res.end();
      return;
    }
  }
});

// ===== API: 清除下载记录（不删文件） =====
app.post('/api/clear-history', (req, res) => {
  fs.writeFileSync(HISTORY_FILE, '[]');
  res.json({ success: true });
});

// ===== API: 下载历史 =====
app.get('/api/history', getHistoryAPI);

// ===== API: 删除下载记录 =====
app.post('/api/delete-record', (req, res) => {
  const { filePath, deleteFile } = req.body;
  if (!filePath) return res.status(400).json({ error: '缺少文件路径' });
  const removed = deleteFromHistory(filePath);
  if (deleteFile) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
  }
  res.json({ success: removed });
});

// ===== API: 打开文件夹 =====
app.post('/api/open-folder', (req, res) => {
  const { filePath } = req.body;
  if (filePath && fs.existsSync(filePath)) {
    const dir = path.dirname(filePath);
    require('child_process').exec(`start "" "${dir}"`);
    res.json({ success: true });
  } else {
    require('child_process').exec(`start "" "${DOWNLOADS_DIR}"`);
    res.json({ success: true });
  }
});

// ===== 手机下载记录（先记历史，再重定向到代理下载） =====
app.get('/api/phone-download', async (req, res) => {
  const { url, name, platform, title, coverUrl, author } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  // 先存一条下载记录
  const fileName = (name || 'video').substring(0, 60) + '.mp4';
  addToHistory({
    fileName,
    title: title || name || fileName,
    platform: platform || '',
    coverUrl: coverUrl || '',
    author: author || '',
    path: '',
    size: 0,
    phoneDownload: true,
    date: new Date().toISOString(),
  });

  // 重定向到代理下载
  res.redirect(`/api/proxy?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}&platform=${platform}`);
});

// ===== 代理下载：直接流式下载到浏览器（手机端使用） =====
app.get('/api/proxy', async (req, res) => {
  const { url, name, platform } = req.query;
  console.log('[代理下载] 请求:', { name, platform, urlLen: url ? url.length : 0 });
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const referers = { douyin: 'https://www.douyin.com/', kuaishou: 'https://www.kuaishou.com/', xiaohongshu: 'https://www.xiaohongshu.com/', x: 'https://x.com/', bilibili: 'https://www.bilibili.com/' };
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Referer': referers[platform] || 'https://www.douyin.com/',
      },
      timeout: 120000,
    });

    const fileName = encodeURIComponent((name || 'video').replace(/[<>:"\/\\|?*]/g, '_').substring(0, 60));
    const ext = response.headers['content-type']?.includes('audio') ? '.mp3' : '.mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}${ext}"`);
    res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    response.data.pipe(res);
  } catch (err) {
    console.log('[代理下载] 失败:', err.message);
    if (!res.headersSent) res.status(500).json({ error: '代理下载失败: ' + err.message });
  }
});

// ===== API: B站登录状态检查 =====
app.get('/api/bilibili-status', (req, res) => {
  const cookieFile = path.join(BILIBILI_PROFILE_DIR, 'Default', 'Cookies');
  const LocalState = path.join(BILIBILI_PROFILE_DIR, 'Local State');
  // 简单判断：配置文件目录存在且非空说明至少初始化过
  const hasProfile = fs.existsSync(cookieFile) || fs.existsSync(LocalState);
  res.json({ loggedIn: hasProfile });
});

// ===== API: B站登录（打开可见浏览器让用户扫码） =====
app.post('/api/bilibili-login', async (req, res) => {
  let loginBrowser = null;
  try {
    // 打开可见浏览器，使用持久配置
    loginBrowser = await require('puppeteer-extra').launch({
      headless: false, // 可见窗口，让用户扫码
      userDataDir: BILIBILI_PROFILE_DIR,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const pages = await loginBrowser.pages();
    const page = pages[0] || await loginBrowser.newPage();
    await page.goto('https://passport.bilibili.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

    // 等用户扫码登录（最多等5分钟）
    let loggedIn = false;
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const cookies = await page.cookies();
      if (cookies.some(c => c.name === 'SESSDATA' && c.value)) {
        loggedIn = true;
        break;
      }
      // 如果页面被关闭，退出
      if (page.isClosed()) break;
    }

    const pages2 = await loginBrowser.pages();
    for (const p of pages2) await p.close().catch(() => {});
    await loginBrowser.close();

    if (loggedIn) {
      console.log('[B站] 登录成功！');
      res.json({ success: true, message: 'B站登录成功，Cookie 已持久化' });
    } else {
      res.json({ success: false, message: '登录超时或窗口已关闭，请重试' });
    }
  } catch (err) {
    if (loginBrowser) await loginBrowser.close().catch(() => {});
    console.error('[B站登录] 失败:', err.message);
    res.status(500).json({ error: '登录失败: ' + err.message });
  }
});

// ===== 启动 =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 视频下载器已启动: http://localhost:${PORT}`);
  // 显示局域网地址
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`📱 手机访问: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`📁 下载目录: ${DOWNLOADS_DIR}`);
});
