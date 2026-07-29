/**
 * 视频下载器 - 云端最小版
 * 零外部依赖（express 除外），纯 API 解析
 */

const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

// ===== 工具函数 =====
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' }, rejectUnauthorized: false }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function detectPlatform(url) {
  if (/douyin/i.test(url)) return 'douyin';
  if (/kuaishou/i.test(url)) return 'kuaishou';
  if (/xiaohongshu|xhslink/i.test(url)) return 'xiaohongshu';
  if (/x\.com|twitter/i.test(url)) return 'x';
  if (/bilibili|b23\.tv/i.test(url)) return 'bilibili';
  if (/youtube|youtu\.be/i.test(url)) return 'youtube';
  if (/weibo/i.test(url)) return 'weibo';
  return null;
}

function normalizeUrl(input) {
  input = input.trim();
  const m = input.match(/https?:\/\/[^\s]+/);
  if (m) return m[0];
  if (!input.startsWith('http')) input = 'https://' + input;
  return input;
}

// ===== 解析函数 =====
async function parseBilibili(url) {
  if (/b23\.tv/i.test(url)) {
    try {
      const html = await httpGet(url);
      const loc = html.match(/location\.href\s*=\s*['"]([^'"]+)/);
      if (loc) url = loc[1];
    } catch {}
  }
  const bv = url.match(/\/video\/(BV[a-zA-Z0-9]+)/i)?.[1];
  const av = url.match(/\/video\/(av\d+)/i)?.[1]?.replace('av', '');
  if (!bv && !av) throw new Error('无法识别B站视频ID');

  const qs = bv ? `bvid=${bv}` : `aid=${av}`;
  const info = JSON.parse(await httpGet(`https://api.bilibili.com/x/web-interface/view?${qs}`));
  if (info.code !== 0) throw new Error(info.message || '获取B站信息失败');
  const v = info.data;
  const cid = v.cid;

  for (const qn of [80, 64, 32, 16]) {
    try {
      const play = JSON.parse(await httpGet(`https://api.bilibili.com/x/player/playurl?bvid=${v.bvid}&cid=${cid}&qn=${qn}&platform=web`));
      if (play.code === 0 && play.data?.durl?.length) {
        return {
          videoUrl: play.data.durl[play.data.durl.length - 1].url,
          coverUrl: v.pic || '', images: [],
          title: v.title || 'B站视频', author: v.owner?.name || '',
        };
      }
    } catch {}
  }
  throw new Error('B站视频需要登录才可以获取');
}

async function parseYoutube(url) {
  // YouTube 没有 yt-dlp 无法解析，提示用户
  throw new Error('YouTube 解析需要服务器安装 yt-dlp，暂时不可用');
}

async function parseGeneric(url) {
  throw new Error(`平台解析需安装 yt-dlp，暂时不可用。支持的平台: 抖音/快手/B站/小红书/X/微博`);
}

// ===== API =====
app.post('/api/parse', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '请提供视频链接' });

  const shareUrl = normalizeUrl(url);
  const platform = detectPlatform(shareUrl);
  if (!platform) return res.status(400).json({ error: '暂不支持该平台' });

  try {
    let result;
    if (platform === 'bilibili') result = await parseBilibili(shareUrl);
    else if (platform === 'youtube') result = await parseYoutube(shareUrl);
    else if (['douyin', 'kuaishou', 'xiaohongshu', 'x', 'weibo'].includes(platform)) result = await parseGeneric(shareUrl);
    else throw new Error('不支持');
    res.json({ success: true, ...result, platform, shareUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => res.json({ ok: true, name: '视频下载器', version: '1.0.0' }));

app.get('/', (req, res) => res.sendFile(__dirname + '/index-cloud.html'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 视频下载器运行中: http://0.0.0.0:${PORT}`);
});
