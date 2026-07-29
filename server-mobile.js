/**
 * video-downloader 手机版服务器
 * 无需 Puppeteer，所有平台通过 yt-dlp 解析 + 下载
 * 适合在 Termux (Android) 上运行
 *
 * 依赖: node.js + yt-dlp
 * Termux 安装: pkg install nodejs && pip install yt-dlp
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execSync } = require('child_process');

const app = express();
const PORT = 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const SUB_DIRS = { video: 'video', audio: 'audio', image: 'image' };

// 检测 yt-dlp 路径（Android Termux 或 Windows）
function findYtDlp() {
  try {
    const r = execSync('which yt-dlp 2>/dev/null || where yt-dlp 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    return r.trim().split('\n')[0];
  } catch {
    // Windows 备选
    const winPath = 'D:\\yt-dlp.exe';
    if (fs.existsSync(winPath)) return winPath;
    return 'yt-dlp'; // 让系统 path 去找
  }
}
const YTDLP = findYtDlp();
console.log(`[手机版] yt-dlp 路径: ${YTDLP}`);

// 检测代理是否可用（国内环境的 YouTube 需要）
function hasProxy() {
  try {
    execSync('curl -s --max-time 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:1080', { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
const PROXY = hasProxy() ? '--proxy http://127.0.0.1:1080' : '';
if (PROXY) console.log('[手机版] 检测到代理，YouTube 可用');

// 确保目录存在
[DOWNLOADS_DIR,
  path.join(DOWNLOADS_DIR, SUB_DIRS.video),
  path.join(DOWNLOADS_DIR, SUB_DIRS.audio),
  path.join(DOWNLOADS_DIR, SUB_DIRS.image),
].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(express.json());
app.use(express.static(__dirname));

// ===== 下载历史管理 =====
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

// ===== 平台检测 =====
function detectPlatform(url) {
  if (/v\.douyin\.com/i.test(url) || /douyin\.com/i.test(url)) return 'douyin';
  if (/v\.kuaishou\.com/i.test(url) || /kuaishou\.com/i.test(url)) return 'kuaishou';
  if (/xiaohongshu\.com/i.test(url) || /xhslink\.com/i.test(url)) return 'xiaohongshu';
  if (/x\.com/i.test(url) || /twitter\.com/i.test(url)) return 'x';
  if (/bilibili\.com/i.test(url) || /b23\.tv/i.test(url)) return 'bilibili';
  if (/youtube\.com/i.test(url) || /youtu\.be/i.test(url)) return 'youtube';
  if (/weibo\.com/i.test(url) || /weibo\.cn/i.test(url)) return 'weibo';
  if (/instagram\.com/i.test(url) || /ins\.com/i.test(url)) return 'instagram';
  return null;
}

// ===== 统一解析：yt-dlp --dump-json =====
function parseWithYtDlp(shareUrl) {
  return new Promise((resolve, reject) => {
    const cmd = `"${YTDLP}" ${PROXY} --dump-json --no-playlist --no-warnings --no-check-certificate "${shareUrl}"`;
    exec(cmd, { maxBuffer: 1024 * 1024 * 10, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').substring(0, 200);
        reject(new Error('解析失败: ' + msg));
        return;
      }
      try {
        const line = stdout.trim().split('\n')[0];
        const info = JSON.parse(line);
        resolve({
          videoUrl: shareUrl,
          audioUrl: null,
          coverUrl: info.thumbnail || '',
          images: info.thumbnails?.map?.(t => t.url)?.filter(Boolean) || [],
          title: info.title || '视频',
          author: info.uploader || info.channel || info.uploader_id || '',
          duration: info.duration || 0,
        });
      } catch (e) {
        reject(new Error('解析数据错误: ' + e.message));
      }
    });
  });
}

// ===== 使用 yt-dlp 下载 =====
function downloadWithYtDlp(url, filePath, res, useProxy) {
  if (!res.headersSent) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  }

  return new Promise((resolve, reject) => {
    const proxy = useProxy && PROXY ? PROXY : '';
    const fmt = url.includes('youtube.com') || url.includes('youtu.be') ? '-f best[height<=1080]' : '';
    const cmd = `"${YTDLP}" ${proxy} ${fmt} -o "${filePath}" --no-playlist --progress --newline --no-warnings --no-check-certificate "${url}"`;

    const proc = exec(cmd, { maxBuffer: 1024 * 1024 * 200, timeout: 600000 }, (err, stdout, stderr) => {
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

    // 文件大小兜底进度
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

// ===== API: 解析 =====
app.post('/api/parse', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '请提供视频链接' });

  const shareUrl = normalizeUrl(url);
  const platform = detectPlatform(shareUrl);
  if (!platform) return res.status(400).json({ error: '暂不支持该平台。目前支持: 抖音/快手/小红书/X/B站/YouTube/微博' });

  console.log(`[解析] 平台: ${platform}, 链接: ${shareUrl}`);

  try {
    const result = await parseWithYtDlp(shareUrl);
    res.json({ success: true, ...result, platform, shareUrl });
  } catch (err) {
    console.error('[解析失败]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== API: 下载 =====
app.post('/api/download', async (req, res) => {
  const { videoUrl, title, platform, coverUrl, author, shareUrl, audioUrl, images, type, selectedImages } = req.body;
  const dlType = type || 'video';

  if (dlType === 'image') {
    const imgList = selectedImages && selectedImages.length ? selectedImages : (coverUrl ? [coverUrl] : (images && images.length ? [images[0]] : []));
    if (!imgList.length) return res.status(400).json({ error: '没有可下载的图片' });
    // 手机版简易图片下载：直接 axios 流式下载
    const axios = require('axios');
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
        const resp = await axios({ method: 'GET', url: imgUrl, responseType: 'stream', timeout: 60000 });
        const writer = fs.createWriteStream(filePath);
        await new Promise((resolve, reject) => {
          resp.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        const size = fs.statSync(filePath).size;
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

  // 视频下载：全部走 yt-dlp
  if (!videoUrl && !shareUrl) return res.status(400).json({ error: '缺少视频地址' });

  const safeName = (title || 'video').replace(/[<>:"\/\\|?*]/g, '_').substring(0, 80);
  const ext = (dlType === 'audio' || platform === 'youtube') ? '.mp4' : '.mp4';
  const fileName = `${safeName}_${Date.now()}${ext}`;
  const filePath = path.join(DOWNLOADS_DIR, SUB_DIRS.video, fileName);
  const dlUrl = videoUrl || shareUrl;

  // YouTube 需要代理
  const useProxy = platform === 'youtube' && !!PROXY;

  try {
    const size = await downloadWithYtDlp(dlUrl, filePath, res, useProxy);
    const entry = { fileName, title: title || fileName, platform, coverUrl, author, path: filePath, size };
    addToHistory(entry);
    res.write(`data: ${JSON.stringify({ done: true, fileName, filePath, size })}\n\n`);
    res.end();
    console.log(`[完成] ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)`);
  } catch (err) {
    console.error('[下载失败]', err.message);
    if (!res.headersSent) return res.status(500).json({ error: `下载失败: ${err.message}` });
    res.end();
  }
});

// ===== API: 下载历史 =====
app.get('/api/history', (req, res) => res.json(getHistory()));

// ===== API: 删除记录 =====
app.post('/api/delete-record', (req, res) => {
  const { filePath, deleteFile } = req.body;
  if (!filePath) return res.status(400).json({ error: '缺少文件路径' });
  const removed = deleteFromHistory(filePath);
  if (deleteFile) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
  }
  res.json({ success: removed });
});

// ===== API: 清除全部记录（不删文件） =====
app.post('/api/clear-history', (req, res) => {
  fs.writeFileSync(HISTORY_FILE, '[]');
  res.json({ success: true });
});

// ===== API: 打开文件夹 =====
app.post('/api/open-folder', (req, res) => {
  const { filePath } = req.body;
  try {
    const dir = filePath && fs.existsSync(filePath) ? path.dirname(filePath) : DOWNLOADS_DIR;
    if (process.platform === 'win32') {
      exec(`start "" "${dir}"`);
    } else {
      // Termux Android: 用 termux-open 或 am 打开文件管理器
      exec(`termux-open "${dir}" 2>/dev/null || am start -a android.intent.action.VIEW -d "file://${dir}" 2>/dev/null || echo "请手动打开: ${dir}"`);
    }
  } catch (e) {}
  res.json({ success: true });
});

// ===== 从文本提取 URL =====
function normalizeUrl(input) {
  input = input.trim();
  const urlMatch = input.match(/https?:\/\/[^\s]+/);
  if (urlMatch) return urlMatch[0].replace(/[^a-zA-Z0-9\/:._?=&%-@#!$+~]+$/, '');
  if (!input.startsWith('http://') && !input.startsWith('https://')) input = 'https://' + input;
  return input;
}

// ===== 启动 =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`📱 视频下载器 (手机版) 已启动: http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`🌐 局域网访问: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`📁 下载目录: ${DOWNLOADS_DIR}`);
  console.log(`   yt-dlp: ${YTDLP}`);
  console.log('   全部平台使用 yt-dlp 解析，无需浏览器');
});
