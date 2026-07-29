# 视频下载器 - 云端版
# 使用 yt-dlp 解析视频链接，不下载文件到服务器

FROM node:20-alpine

# 安装 yt-dlp 和依赖
RUN apk add --no-cache python3 py3-pip && \
    pip3 install --break-system-packages yt-dlp && \
    yt-dlp --version

WORKDIR /app

# 只安装云版本需要的包（轻量）
RUN npm init -y && npm install express axios

# 复制应用代码
COPY server-cloud.js ./
COPY index-cloud.html ./index.html

EXPOSE 3000

CMD ["node", "server-cloud.js"]
