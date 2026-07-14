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

// Download Binaries if missing
async function ensureBinaries() {
  if (!fs.existsSync(ytDlpPath)) {
    console.log('Downloading yt-dlp.exe...');
    const res = await axios({ url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', responseType: 'stream' });
    const writer = fs.createWriteStream(ytDlpPath);
    res.data.pipe(writer);
    await new Promise(r => writer.on('finish', r));
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
      
      const args = ['--flat-playlist', '-J', url];
      const proc = spawn(ytDlpPath, args);
      let output = '';

      proc.stdout.on('data', d => output += d.toString());
      proc.on('close', (code) => {
        if (code !== 0) return socket.emit('error', 'Failed to fetch URL. May be invalid or private.');
        try {
          const data = JSON.parse(output);
          const entries = data.entries || [data];
          const videos = entries.map(v => ({
            id: v.id,
            title: v.title || `[Unavailable Video]`, // Prevent blank names
            url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
            status: 'pending',
            progress: 0,
            speed: '',
            eta: ''
          }));
          socket.emit('playlist_fetched', videos);
        } catch (e) {
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
      if (!downloadQueue.find(q => q.id === v.id)) {
        downloadQueue.push({ ...v, outDir });
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
    '--ffmpeg-location', ffmpegPath,
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--no-overwrites',
    '--retries', 'infinite',          // Feature: Auto-retry infinitely on network drop
    '--fragment-retries', 'infinite', // Feature: Wait for internet to reconnect gracefully
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
      downloadQueue.shift(); // Move past failed
    }
    processQueue();
  });
}

server.listen(4000, () => console.log('Backend running on port 4000'));