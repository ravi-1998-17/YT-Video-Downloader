const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const binPath = path.join(__dirname, 'bin');
const ytDlpPath = path.join(binPath, 'yt-dlp.exe');
const ffmpegPath = path.join(binPath, 'ffmpeg.exe');

if (!fs.existsSync(binPath)) fs.mkdirSync(binPath, { recursive: true });

let downloadQueue = [];
let isDownloading = false;
let isPaused = false;
let currentProcess = null;

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1000) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function stopCurrentProcess() {
  if (!currentProcess) return;
  try {
    const pid = currentProcess.pid;
    if (pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', pid.toString()]);
      } else {
        currentProcess.kill('SIGKILL');
      }
    }
  } catch (err) {
    console.error('Error stopping process tree:', err);
  }
  currentProcess = null;
}

// Download Binaries if missing & auto-update yt-dlp
async function ensureBinaries() {
  if (!fs.existsSync(ytDlpPath)) {
    console.log('Downloading yt-dlp.exe...');
    const res = await axios({ url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', responseType: 'stream' });
    const writer = fs.createWriteStream(ytDlpPath);
    res.data.pipe(writer);
    await new Promise(r => writer.on('finish', r));
  } else {
    try {
      const upProc = spawn(ytDlpPath, ['-U']);
      upProc.on('error', () => {});
    } catch (e) {}
  }
  if (!fs.existsSync(ffmpegPath)) {
    console.log('Downloading ffmpeg...');
    const zipPath = path.join(binPath, 'ffmpeg.zip');
    const res = await axios({ url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', responseType: 'arraybuffer' });
    fs.writeFileSync(zipPath, res.data);
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    entries.forEach(entry => {
      if (entry.entryName.endsWith('ffmpeg.exe')) {
        fs.writeFileSync(ffmpegPath, entry.getData());
      }
    });
    fs.unlinkSync(zipPath);
  }
}

io.on('connection', (socket) => {
  socket.on('fetch_playlist', async (rawUrl) => {
    try {
      await ensureBinaries();
      const cleanUrl = rawUrl.trim().replace(/[\?&]si=[^&]+/, '');
      socket.emit('log', `Fetching metadata for: ${cleanUrl}`);
      
      const runYtDlp = (args) => {
        return new Promise((resolve) => {
          const proc = spawn(ytDlpPath, args);
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', d => stdout += d.toString());
          proc.stderr.on('data', d => stderr += d.toString());
          proc.on('close', (code) => resolve({ code, stdout, stderr }));
        });
      };

      let res = await runYtDlp(['--flat-playlist', '-J', '--no-warnings', '--js-runtimes', 'node', cleanUrl]);
      let parsed = null;
      try {
        if (res.stdout) parsed = JSON.parse(res.stdout);
      } catch (e) {}

      if (!parsed || (!parsed.entries && !parsed.id && !parsed.title)) {
        res = await runYtDlp(['-J', '--no-warnings', '--js-runtimes', 'node', cleanUrl]);
        try {
          if (res.stdout) parsed = JSON.parse(res.stdout);
        } catch (e) {}
      }

      if (!parsed) {
        return socket.emit('error', 'Failed to fetch video details. Check link or network connection.');
      }

      let rawEntries = [];
      if (parsed.entries && Array.isArray(parsed.entries) && parsed.entries.length > 0) {
        rawEntries = parsed.entries;
      } else if (parsed.id || parsed.title) {
        rawEntries = [parsed];
      }

      const videos = rawEntries
        .filter(v => v != null)
        .map((v, index) => {
          const videoId = v.id || `vid_${index}_${Date.now()}`;
          const videoTitle = v.title || `Video ${index + 1}`;
          const videoUrl = v.webpage_url || v.url || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : cleanUrl);
          const durationSec = v.duration || 0;
          const approxBytes = v.filesize || v.filesize_approx || (durationSec ? durationSec * 150000 : 0);

          let thumbUrl = v.thumbnail;
          if (!thumbUrl && Array.isArray(v.thumbnails) && v.thumbnails.length > 0) {
            thumbUrl = v.thumbnails[v.thumbnails.length - 1].url;
          }
          if (!thumbUrl && v.id) {
            thumbUrl = `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`;
          }

          return {
            id: videoId,
            title: videoTitle,
            url: videoUrl,
            duration: durationSec,
            filesizeBytes: approxBytes,
            filesizeFormatted: approxBytes ? formatBytes(approxBytes) : '350.0 MB',
            thumbnail: thumbUrl || '',
            status: 'pending',
            progress: 0,
            totalSize: approxBytes ? formatBytes(approxBytes) : '',
            speed: '',
            eta: ''
          };
        });

      if (videos.length === 0) {
        return socket.emit('error', 'No downloadable videos found at this URL.');
      }

      socket.emit('playlist_fetched', videos);
    } catch (err) {
      console.error('Fetch error:', err);
      socket.emit('error', 'Failed to initialize downloader.');
    }
  });

  socket.on('start_downloads', (data) => {
    const { videos, outDir, format, quality } = data;
    videos.forEach(v => {
      const existing = downloadQueue.find(q => q.id === v.id);
      const item = { ...v, status: 'pending', outDir, format: format || 'mp4', quality: quality || '1080p' };
      if (!existing) {
        downloadQueue.push(item);
      } else if (existing.status === 'failed' || existing.status === 'pending') {
        Object.assign(existing, item);
      }
    });
    if (!isDownloading && !isPaused) processQueue();
  });

  socket.on('action', (data) => {
    if (data.type === 'cancel' || data.type === 'clear') {
      isPaused = false;
      downloadQueue = [];
      isDownloading = false;
      stopCurrentProcess();
      io.emit('log', 'All downloads cancelled and queue cleared.');
    } else if (data.type === 'pause') {
      isPaused = true;
      stopCurrentProcess();
    } else if (data.type === 'resume') {
      isPaused = false;
      processQueue();
    }
  });
});

async function processQueue() {
  if (isPaused) {
    isDownloading = false;
    return;
  }
  
  if (downloadQueue.length === 0) {
    isDownloading = false;
    return;
  }
  
  isDownloading = true;
  const video = downloadQueue[0];
  
  if (video.status === 'completed' || video.status === 'skipped') {
    downloadQueue.shift();
    return processQueue();
  }

  io.emit('video_update', { id: video.id, status: 'downloading' });

  const tempDir = path.join(video.outDir, '.temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  let formatArg = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
  if (video.format === 'mp3') {
    formatArg = 'bestaudio/best';
  } else if (video.quality && video.quality !== 'best' && video.quality !== '1080p (if available)') {
    const height = video.quality.replace('p', '');
    if (!isNaN(height)) {
      formatArg = `bestvideo[height<=${height}]+bestaudio/bestvideo[height<=${height}]+bestaudio/best`;
    }
  }

  const args = [
    '--newline', 
    '--js-runtimes', 'node',
    '--ffmpeg-location', ffmpegPath,
    '--temp-directory', tempDir,
    '-f', formatArg,
    '--windows-filenames',
    '--no-playlist',
    '--no-overwrites',
    '--no-write-thumbnail',
    '--no-embed-thumbnail',
    '--retries', '20',
    '--fragment-retries', '20',
    '--retry-sleep', 'linear=1:5:2',
    '--concurrent-fragments', '4',
    '--no-check-certificates',
    '--geo-bypass'
  ];

  if (video.format === 'mp3') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push('--merge-output-format', 'mp4');
  }

  args.push('-o', path.join(video.outDir, '%(title)s.%(ext)s'), video.url);

  currentProcess = spawn(ytDlpPath, args);

  currentProcess.stdout.on('data', (data) => {
    const text = data.toString();
    const lines = text.split(/\r?\n/);

    lines.forEach(line => {
      if (!line.includes('[download]')) return;

      const percentMatch = line.match(/\[download\]\s+([\d.]+)%/i);
      const sizeMatch = line.match(/of\s+~?\s*([\d.]+\s*[a-zA-Z]+)/i);
      const speedMatch = line.match(/at\s+([\d.]+\s*\w+\/s)/i);
      const etaMatch = line.match(/(?:ETA|in)\s+([\d:]+)/i);

      if (percentMatch) {
        const updateObj = {
          id: video.id,
          progress: parseFloat(percentMatch[1])
        };
        if (sizeMatch) updateObj.totalSize = sizeMatch[1].trim();
        if (speedMatch) updateObj.speed = speedMatch[1].trim();
        if (etaMatch) updateObj.eta = etaMatch[1].trim();

        io.emit('video_update', updateObj);
      }
      if (line.includes('has already been downloaded')) {
        io.emit('video_update', { id: video.id, status: 'skipped', progress: 100, speed: '', eta: '' });
      }
    });
  });

  currentProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) io.emit('log', `[info] ${line}`);
  });

  currentProcess.on('close', (code) => {
    currentProcess = null;
    
    if (isPaused) {
      io.emit('video_update', { id: video.id, status: 'paused' });
      return; 
    }

    if (code === 0) {
      io.emit('video_update', { 
        id: video.id, 
        status: 'completed', 
        progress: 100, 
        speed: '', 
        eta: '' 
      });
      downloadQueue.shift();
    } else {
      console.log(`Initial download failed for ${video.title}, retrying with fallback format...`);
      retryFallback(video);
      return;
    }
    processQueue();
  });
}

function retryFallback(video) {
  const tempDir = path.join(video.outDir, '.temp');
  const fallbackArgs = [
    '--newline',
    '--js-runtimes', 'node',
    '--ffmpeg-location', ffmpegPath,
    '--temp-directory', tempDir,
    '-f', 'best',
    '--no-playlist',
    '--no-overwrites',
    '--no-write-thumbnail',
    '--no-embed-thumbnail',
    '--retries', '10',
    '-o', path.join(video.outDir, '%(title)s.%(ext)s'),
    video.url
  ];

  const fallbackProc = spawn(ytDlpPath, fallbackArgs);
  fallbackProc.on('close', (code) => {
    if (code === 0) {
      io.emit('video_update', { id: video.id, status: 'completed', progress: 100, speed: '', eta: '' });
    } else {
      io.emit('video_update', { id: video.id, status: 'failed', speed: '', eta: '' });
    }
    downloadQueue.shift();
    processQueue();
  });
}

// Emergency process cleanup on exit
process.on('SIGINT', () => { stopCurrentProcess(); process.exit(0); });
process.on('SIGTERM', () => { stopCurrentProcess(); process.exit(0); });
process.on('exit', () => { stopCurrentProcess(); });

server.listen(4000, () => console.log('Backend running on port 4000'));