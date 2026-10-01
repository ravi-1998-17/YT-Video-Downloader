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
let isPaused = false; // Track explicit manual pause state
let currentProcess = null;

// Download Binaries if missing & auto-update yt-dlp
async function ensureBinaries() {
  if (!fs.existsSync(ytDlpPath)) {
    console.log('Downloading yt-dlp.exe...');
    const res = await axios({ url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', responseType: 'stream' });
    const writer = fs.createWriteStream(ytDlpPath);
    res.data.pipe(writer);
    await new Promise(r => writer.on('finish', r));
  } else {
    // Attempt auto-update in background
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
  socket.on('fetch_playlist', async (url) => {
    try {
      await ensureBinaries();
      socket.emit('log', `Fetching metadata for: ${url}`);
      
      const args = ['--flat-playlist', '-J', '--js-runtimes', 'node', url];
      const proc = spawn(ytDlpPath, args);
      let output = '';
      let errorOutput = '';

      proc.stdout.on('data', d => output += d.toString());
      proc.stderr.on('data', d => errorOutput += d.toString());

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('yt-dlp error:', errorOutput);
          return socket.emit('error', `Failed to fetch URL. ${errorOutput.split('\n')[0] || 'May be invalid or private.'}`);
        }
        try {
          const data = JSON.parse(output);
          const rawEntries = (data.entries && data.entries.length > 0) ? data.entries : [data];
          const videos = rawEntries
            .filter(v => v != null)
            .map((v, index) => ({
              id: v.id || `vid_${index}_${Date.now()}`,
              title: v.title || `Video ${index + 1}`,
              url: v.url || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : url),
              status: 'pending',
              progress: 0,
              speed: '',
              eta: ''
            }));
          socket.emit('playlist_fetched', videos);
        } catch (e) {
          console.error('JSON parse error:', e);
          socket.emit('error', 'Failed to parse metadata.');
        }
      });
    } catch (err) {
      socket.emit('error', 'Failed to initialize downloader.');
    }
  });

  socket.on('start_downloads', (data) => {
    const { videos, outDir } = data;
    videos.forEach(v => {
      const existing = downloadQueue.find(q => q.id === v.id);
      if (!existing) {
        downloadQueue.push({ ...v, status: 'pending', outDir });
      } else if (existing.status === 'failed' || existing.status === 'pending') {
        existing.status = 'pending';
        existing.outDir = outDir;
      }
    });
    // If not actively downloading, start it
    if (!isDownloading && !isPaused) processQueue();
  });

  socket.on('action', (data) => {
    if (data.type === 'cancel') {
      isPaused = false;
      downloadQueue = [];
      isDownloading = false;
      if (currentProcess) currentProcess.kill('SIGINT');
    } else if (data.type === 'pause') {
      isPaused = true;
      if (currentProcess) currentProcess.kill('SIGINT');
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
  
  const args = [
    '--newline', 
    '--js-runtimes', 'node',
    '--ffmpeg-location', ffmpegPath,
    '-f', 'bestvideo+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--windows-filenames',
    '--no-playlist',
    '--no-overwrites',
    '--retries', '10',
    '--fragment-retries', '10',
    '--retry-sleep', 'linear=1:5:2',
    '--concurrent-fragments', '4',
    '-o', path.join(video.outDir, '%(title)s.%(ext)s'),
    video.url
  ];

  currentProcess = spawn(ytDlpPath, args);

  currentProcess.stdout.on('data', (data) => {
    const line = data.toString();
    io.emit('log', line.trim());
    
    const progressMatch = line.match(/\[download\]\s+([\d.]+)%.*at\s+(.*\/s)\s+ETA\s+([\d:]+)/);
    if (progressMatch) {
      io.emit('video_update', {
        id: video.id,
        progress: parseFloat(progressMatch[1]),
        speed: progressMatch[2],
        eta: progressMatch[3]
      });
    }
    if (line.includes('has already been downloaded')) {
      io.emit('video_update', { id: video.id, status: 'skipped', progress: 100 });
    }
  });

  currentProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) io.emit('log', `[info] ${line}`);
  });

  currentProcess.on('close', (code) => {
    currentProcess = null;
    
    // Feature: If user hit pause, stop processing but DO NOT remove video from queue
    if (isPaused) {
      io.emit('video_update', { id: video.id, status: 'paused' });
      return; 
    }

    if (code === 0) {
      io.emit('video_update', { id: video.id, status: 'completed', progress: 100 });
      downloadQueue.shift();
    } else {
      io.emit('video_update', { id: video.id, status: 'failed' });
      downloadQueue.shift(); // Move past failed video to avoid blocking queue
    }
    processQueue();
  });
}

server.listen(4000, () => console.log('Backend running on port 4000'));