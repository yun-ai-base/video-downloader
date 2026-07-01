const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const SUB_DIRS = { video: 'video', audio: 'audio', image: 'image' };

// 确保分类子目录存在
[DOWNLOADS_DIR,
  path.join(DOWNLOADS_DIR, SUB_DIRS.video),
  path.join(DOWNLOADS_DIR, SUB_DIRS.audio),
  path.join(DOWNLOADS_DIR, SUB_DIRS.image),
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

    await page.close();

    if (!videoUrl || videoUrl.startsWith('blob:')) {
      throw new Error('未能提取到视频地址（抖音已加密），请确认链接有效或稍后重试');
    }

    if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
    if (audioUrl && audioUrl.startsWith('//')) audioUrl = 'https:' + audioUrl;

    return { videoUrl, audioUrl, coverUrl, title: title || '抖音视频', author: author || '未知' };
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

// ===== API: 解析视频 =====
app.post('/api/parse', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '请提供视频链接' });

  const shareUrl = normalizeUrl(url);
  const platform = detectPlatform(shareUrl);
  if (!platform) return res.status(400).json({ error: '暂不支持该平台，目前支持抖音、快手、小红书、X' });

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
    }
    res.json({ success: true, ...result, platform, shareUrl });
  } catch (err) {
    console.error('[解析失败]', err.message);
    res.status(500).json({ error: `解析失败: ${err.message}` });
  }
});

// ===== 下载文件（视频/音频/图片） =====
async function downloadFile(url, filePath, platform, res) {
  const referers = { douyin: 'https://www.douyin.com/', kuaishou: 'https://www.kuaishou.com/', xiaohongshu: 'https://www.xiaohongshu.com/', x: 'https://x.com/' };
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

// ===== 启动 =====
app.listen(PORT, () => {
  console.log(`🚀 视频下载器已启动: http://localhost:${PORT}`);
  console.log(`📁 下载目录: ${DOWNLOADS_DIR}`);
});
