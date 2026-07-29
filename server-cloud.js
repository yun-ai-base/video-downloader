/**
 * video-downloader 云端版
 * 使用 yt-dlp 解析所有平台，Dockerfile 已预装
 */

const express = require('express');
const path = require('path');
const { exec, execSync } = require('child_process');
const app = express();
const PORT = process.env.PORT || 3000;

let YTDLP = 'yt-dlp';
try { YTDLP = execSync('which yt-dlp || command -v yt-dlp || echo yt-dlp', { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0] || 'yt-dlp'; } catch {}
console.log(`yt-dlp: ${YTDLP}`);

app.use(express.json());
app.use(express.static(__dirname));

const PLATFORMS = { douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', x: 'X', bilibili: 'B站', youtube: 'YouTube', weibo: '微博' };

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
  const m = input.match(/https?:\/\/[^\s]+/); if (m) return m[0];
  if (!input.startsWith('http')) input = 'https://' + input; return input;
}

function parseYtDlp(shareUrl) {
  return new Promise((resolve, reject) => {
    const cmd = `"${YTDLP}" --dump-json --no-playlist --no-warnings --no-check-certificate "${shareUrl}"`;
    exec(cmd, { maxBuffer: 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('解析失败: ' + (stderr || err.message).substring(0, 200)));
      try {
        const info = JSON.parse(stdout.trim().split('\n')[0]);
        resolve({
          videoUrl: shareUrl,
          coverUrl: info.thumbnail || '',
          images: info.thumbnails?.map?.(t => t.url)?.filter(Boolean) || [],
          title: info.title || '视频',
          author: info.uploader || info.channel || info.uploader_id || '',
          duration: info.duration || 0,
        });
      } catch (e) { reject(new Error('解析数据错误')); }
    });
  });
}

// B站 HTTP API 轻量版（比 yt-dlp 快）
async function parseBilibili(shareUrl) {
  const https = require('https');
  function httpGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' }, rejectUnauthorized: false },
        res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d)); }).on('error', reject);
    });
  }
  if (/b23\.tv/i.test(shareUrl)) {
    try { const h = await httpGet(shareUrl); const l = h.match(/location\.href\s*=\s*['"]([^'"]+)/); if(l) shareUrl=l[1]; } catch {}
  }
  const bv = shareUrl.match(/\/video\/(BV[a-zA-Z0-9]+)/i)?.[1];
  const av = shareUrl.match(/\/video\/(av\d+)/i)?.[1]?.replace('av','');
  if (!bv && !av) throw new Error('无法识别B站视频ID');

  const info = JSON.parse(await httpGet(`https://api.bilibili.com/x/web-interface/view?${bv?`bvid=${bv}`:`aid=${av}`}`));
  if (info.code !== 0) throw new Error(info.message || '获取B站信息失败');
  const v = info.data;
  for (const qn of [80,64,32,16]) {
    try {
      const play = JSON.parse(await httpGet(`https://api.bilibili.com/x/player/playurl?bvid=${v.bvid}&cid=${v.cid}&qn=${qn}&platform=web`));
      if (play.code === 0 && play.data?.durl?.length) return {
        videoUrl: play.data.durl[play.data.durl.length-1].url, coverUrl: v.pic || '',
        images: [], title: v.title || 'B站视频', author: v.owner?.name || ''
      };
    } catch {}
  }
  throw new Error('B站需要登录');
}

app.post('/api/parse', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '请提供视频链接' });

  const shareUrl = normalizeUrl(url);
  const platform = detectPlatform(shareUrl);
  if (!platform) return res.status(400).json({ error: `暂不支持，目前支持: ${Object.values(PLATFORMS).join('/')}` });

  try {
    let result;
    if (platform === 'bilibili') {
      try { result = await parseBilibili(shareUrl); } catch { result = await parseYtDlp(shareUrl); }
    } else {
      result = await parseYtDlp(shareUrl);
    }
    res.json({ success: true, ...result, platform, shareUrl });
  } catch (err) {
    console.error('[解析失败]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => res.json({ ok: true, name: '视频下载器', version: '1.0.0' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index-cloud.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`✅ 视频下载器云端版已启动: ${PORT}`));
