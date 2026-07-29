/**
 * video-downloader 云端版服务器
 * 部署在 Railway 等云平台
 * 只解析不下载：返回视频直链，手机直接去源站下载（不走服务器流量）
 *
 * 依赖: node.js + yt-dlp（通过 Dockerfile 安装）
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, 'history.json');

// yt-dlp 路径
let YTDLP = 'yt-dlp';
try {
  YTDLP = execSync('which yt-dlp 2>/dev/null || command -v yt-dlp 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim() || 'yt-dlp';
} catch { YTDLP = 'yt-dlp'; }
console.log(`[云端] yt-dlp: ${YTDLP}`);

// Railway 上不需要代理（海外部署）
const PROXY = '';

// 平台名
const PLATFORM_NAMES = {
  douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书',
  x: 'X', bilibili: 'B站', youtube: 'YouTube',
  weibo: '微博', instagram: 'Instagram',
};

function detectPlatform(url) {
  if (/v\.douyin\.com/i.test(url) || /douyin\.com/i.test(url)) return 'douyin';
  if (/v\.kuaishou\.com/i.test(url) || /kuaishou\.com/i.test(url)) return 'kuaishou';
  if (/xiaohongshu\.com/i.test(url) || /xhslink\.com/i.test(url)) return 'xiaohongshu';
  if (/x\.com/i.test(url) || /twitter\.com/i.test(url)) return 'x';
  if (/bilibili\.com/i.test(url) || /b23\.tv/i.test(url)) return 'bilibili';
  if (/youtube\.com/i.test(url) || /youtu\.be/i.test(url)) return 'youtube';
  if (/weibo\.com/i.test(url) || /weibo\.cn/i.test(url)) return 'weibo';
  return null;
}

function normalizeUrl(input) {
  input = input.trim();
  const urlMatch = input.match(/https?:\/\/[^\s]+/);
  if (urlMatch) return urlMatch[0].replace(/[^a-zA-Z0-9\/:._?=&%-@#!$+~]+$/, '');
  if (!input.startsWith('http://') && !input.startsWith('https://')) input = 'https://' + input;
  return input;
}

// yt-dlp 解析：返回纯文本信息（几KB），不算流量
function parseWithYtDlp(shareUrl) {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const cmd = `"${YTDLP}" --dump-json --no-playlist --no-warnings --no-check-certificate "${shareUrl}"`;
    exec(cmd, { maxBuffer: 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error('解析失败: ' + (stderr || err.message).substring(0, 200)));
        return;
      }
      try {
        const line = stdout.trim().split('\n')[0];
        const info = JSON.parse(line);
        resolve({
          videoUrl: shareUrl,          // yt-dlp --dump-json 返回的 info 中有 URL
          directUrl: info.url || null, // 直链地址
          ext: info.ext || 'mp4',
          coverUrl: info.thumbnail || '',
          images: [],
          title: info.title || '视频',
          author: info.uploader || info.channel || info.uploader_id || '',
          duration: info.duration || 0,
          platform: info.extractor || '',
        });
      } catch (e) {
        reject(new Error('解析数据错误: ' + e.message));
      }
    });
  });
}

app.use(express.json());
app.use(express.static(__dirname));

// ===== 唯一的 API：解析 =====
app.post('/api/parse', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '请提供视频链接' });

  const shareUrl = normalizeUrl(url);
  const platform = detectPlatform(shareUrl);
  if (!platform) return res.status(400).json({
    error: `暂不支持该平台。目前支持: ${Object.values(PLATFORM_NAMES).join('/')}`
  });

  console.log(`[解析] ${PLATFORM_NAMES[platform]}: ${shareUrl.substring(0, 60)}`);

  try {
    // 对于 B站，优先用轻量 HTTP API（比 yt-dlp 快）
    let result;
    if (platform === 'bilibili') {
      try { result = await parseBilibiliHttp(shareUrl); } catch { result = await parseWithYtDlp(shareUrl); }
    } else if (platform === 'youtube') {
      try { result = await parseWithYtDlp(shareUrl); } catch { throw new Error('YouTube 解析失败，可能是平台限制'); }
    } else {
      result = await parseWithYtDlp(shareUrl);
    }
    res.json({ success: true, ...result, platform, shareUrl });
  } catch (err) {
    console.error('[解析失败]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// B站 HTTP API（轻量，不需要 yt-dlp）
async function parseBilibiliHttp(shareUrl) {
  const axios = require('axios');
  if (/b23\.tv/i.test(shareUrl)) {
    const resp = await axios.get(shareUrl, { maxRedirects: 0, validateStatus: s => s < 400, timeout: 10000 });
    if (resp.headers.location) shareUrl = resp.headers.location;
  }
  const bvMatch = shareUrl.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
  const avMatch = shareUrl.match(/\/video\/(av\d+)/i);
  const bvid = bvMatch?.[1];
  const aid = avMatch?.[1]?.replace('av', '');
  if (!bvid && !aid) throw new Error('无法识别B站视频ID');

  const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' };
  const infoResp = await axios.get(
    `https://api.bilibili.com/x/web-interface/view?${bvid ? `bvid=${bvid}` : `aid=${aid}`}`,
    { headers, timeout: 15000 }
  );
  if (infoResp.data.code !== 0) throw new Error(infoResp.data.message || 'B站视频信息获取失败');
  const v = infoResp.data.data;
  const cid = v.cid;

  // 从高到低试画质
  for (const qn of [80, 64, 32, 16]) {
    try {
      const playResp = await axios.get(
        `https://api.bilibili.com/x/player/playurl?bvid=${v.bvid}&cid=${cid}&qn=${qn}&platform=web`,
        { headers, timeout: 10000 }
      );
      if (playResp.data.code === 0 && playResp.data.data?.durl?.length) {
        return {
          videoUrl: playResp.data.data.durl[playResp.data.data.durl.length - 1].url,
          directUrl: null,
          ext: 'mp4',
          coverUrl: v.pic || '',
          images: [],
          title: v.title || 'B站视频',
          author: v.owner?.name || '',
          duration: v.duration || 0,
          platform: 'bilibili',
        };
      }
    } catch {}
  }
  throw new Error('B站视频需要登录才能获取');
}

// ===== 状态检查 =====
app.get('/api/status', (req, res) => {
  res.json({ ok: true, name: '视频下载器云端版', version: '1.0.0' });
});

// ===== 静态文件 =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index-cloud.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`☁️ 视频下载器 (云端版) 已启动: http://0.0.0.0:${PORT}`);
  console.log(`   只解析不下视频，手机直达源站下载`);
});
