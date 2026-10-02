import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

const socket = io('http://localhost:4000');

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function App() {
  const [url, setUrl] = useState('');
  const [outDir, setOutDir] = useState(() => {
    return localStorage.getItem('yt_downloader_outDir') || 'C:\\Users\\ravis\\Desktop';
  });
  const [format, setFormat] = useState('mp4'); // mp4, mp3, mkv
  const [quality, setQuality] = useState('1080p (if available)'); // 1080p, best, 720p, 480p

  const [videos, setVideos] = useState([]);
  const [isFetching, setIsFetching] = useState(false);
  const [globalStatus, setGlobalStatus] = useState('idle'); // idle, downloading, paused

  useEffect(() => {
    if (outDir) {
      localStorage.setItem('yt_downloader_outDir', outDir);
    }
  }, [outDir]);

  useEffect(() => {
    socket.on('playlist_fetched', (data) => {
      setVideos(data.map(v => ({ ...v, selected: true })));
      setIsFetching(false);
    });

    socket.on('video_update', (update) => {
      setVideos(prev => prev.map(v => v.id === update.id ? { ...v, ...update } : v));
    });

    socket.on('error', (err) => {
      alert(err);
      setIsFetching(false);
    });

    return () => socket.off();
  }, []);

  const handleSelectFolder = async () => {
    if (window.electronAPI) {
      const folder = await window.electronAPI.selectFolder(outDir);
      if (folder) {
        setOutDir(folder);
        localStorage.setItem('yt_downloader_outDir', folder);
      }
    } else {
      alert("Folder selection only works in the Electron App.");
    }
  };

  const handleFetch = () => {
    if (!url) return;
    setIsFetching(true);
    socket.emit('fetch_playlist', url);
  };

  const handleStartAllSelected = () => {
    if (!outDir) return alert('Please select an output folder first.');
    const selectedVideos = videos.filter(v => v.selected);
    if (selectedVideos.length === 0) return alert('Please select at least one video to download.');

    setGlobalStatus('downloading');
    socket.emit('start_downloads', { videos: selectedVideos, outDir, format, quality });
  };

  const handleStartSingle = (video) => {
    if (!outDir) return alert('Please select an output folder first.');
    setVideos(prev => prev.map(v => v.id === video.id ? { ...v, selected: true, status: 'pending', progress: 0 } : v));
    setGlobalStatus('downloading');
    socket.emit('start_downloads', { videos: [video], outDir, format, quality });
  };

  const toggleVideoSelection = (id) => {
    setVideos(prev => prev.map(v => v.id === id ? { ...v, selected: !v.selected } : v));
  };

  const toggleAllSelection = (e) => {
    const isChecked = e.target.checked;
    setVideos(prev => prev.map(v => ({ ...v, selected: isChecked })));
  };

  const selectedCount = videos.filter(v => v.selected).length;
  const allSelected = videos.length > 0 && selectedCount === videos.length;

  return (
    <div className="min-h-screen bg-[#f4f6f8] text-gray-900 font-sans p-6 selection:bg-blue-500 selection:text-white">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* Top Header */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-blue-500/25">
              ⚡
            </div>
            <div>
              <h1 className="text-xl font-black text-gray-900 tracking-tight">
                YT Downloader
              </h1>
              <p className="text-xs text-gray-500 font-medium">Download your favorite videos, fast & easy</p>
            </div>
          </div>
        </header>

        {/* Input & Settings Card (Matching Screenshot 2) */}
        <div className="bg-white border border-gray-200/90 rounded-3xl p-5 shadow-sm space-y-4">
          {/* URL Search Bar */}
          <div className="flex gap-3">
            <div className="flex-1 bg-gray-50/80 border border-gray-200/80 rounded-2xl px-4 py-3 flex items-center gap-3 focus-within:border-blue-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-500/10 transition-all">
              <span className="text-gray-400 text-lg">🔗</span>
              <input 
                type="text" 
                value={url} 
                onChange={e => setUrl(e.target.value)} 
                placeholder="Paste video or playlist URL here..." 
                className="flex-1 bg-transparent text-sm font-medium text-gray-900 placeholder-gray-400 focus:outline-none"
              />
              {url && (
                <button 
                  onClick={() => setUrl('')} 
                  className="text-gray-400 hover:text-gray-600 text-xs px-1"
                  title="Clear input"
                >
                  ✕
                </button>
              )}
            </div>

            <button 
              onClick={handleFetch} 
              disabled={isFetching || !url.trim()} 
              className="px-7 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-500/20 shrink-0 flex items-center gap-2"
            >
              {isFetching ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                  <span>Detecting...</span>
                </>
              ) : (
                <>
                  <span>⚡ Detect Videos</span>
                </>
              )}
            </button>
          </div>

          {/* Options Grid (Format, Quality, Save to) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
            {/* Format Dropdown */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5 pl-1">Format</label>
              <div className="relative">
                <select 
                  value={format} 
                  onChange={e => setFormat(e.target.value)}
                  className="w-full bg-gray-50 border border-gray-200/90 rounded-2xl px-4 py-2.5 text-sm font-semibold text-gray-800 focus:outline-none focus:border-blue-500 appearance-none cursor-pointer pr-10"
                >
                  <option value="mp4">📹 MP4 (Best Quality)</option>
                  <option value="mp3">🎵 MP3 (Audio Only)</option>
                  <option value="mkv">🎬 MKV (High Quality)</option>
                </select>
                <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-xs">▼</div>
              </div>
            </div>

            {/* Quality Dropdown */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5 pl-1">Quality</label>
              <div className="relative">
                <select 
                  value={quality} 
                  onChange={e => setQuality(e.target.value)}
                  className="w-full bg-gray-50 border border-gray-200/90 rounded-2xl px-4 py-2.5 text-sm font-semibold text-gray-800 focus:outline-none focus:border-blue-500 appearance-none cursor-pointer pr-10"
                >
                  <option value="1080p (if available)">📺 1080p (if available)</option>
                  <option value="best">🌟 Best Available</option>
                  <option value="720p">📺 720p HD</option>
                  <option value="480p">📺 480p SD</option>
                </select>
                <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-xs">▼</div>
              </div>
            </div>

            {/* Save To Output Selector */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5 pl-1">Save to</label>
              <div className="bg-gray-50 border border-gray-200/90 rounded-2xl px-3 py-1.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 pl-1">
                  <span className="text-base text-gray-500">📁</span>
                  <span className="text-xs font-semibold text-gray-700 truncate" title={outDir}>
                    {outDir}
                  </span>
                </div>
                <button 
                  onClick={handleSelectFolder} 
                  className="px-4 py-1.5 bg-white hover:bg-gray-100 text-gray-800 border border-gray-200 rounded-xl text-xs font-bold shadow-xs transition-colors shrink-0"
                >
                  Browse
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Videos Found & List Container (Matching Screenshot 2) */}
        <div className="bg-white border border-gray-200/90 rounded-3xl p-6 shadow-sm space-y-4">
          {/* Header Row */}
          <div className="flex items-center justify-between pb-2 border-b border-gray-100">
            <div>
              <h2 className="text-base font-bold text-gray-900">
                {videos.length} Videos Found
              </h2>
              <p className="text-xs text-gray-500 font-medium">Select the videos you want to download</p>
            </div>

            {videos.length > 0 && (
              <button 
                onClick={handleStartAllSelected}
                disabled={selectedCount === 0 || globalStatus === 'downloading'}
                className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-md shadow-blue-500/20 flex items-center gap-2"
              >
                <span>📥 Download Selected ({selectedCount})</span>
              </button>
            )}
          </div>

          {/* Video List */}
          <div className="space-y-3">
            {videos.map((v, i) => (
              <div 
                key={v.id + i} 
                className={`border border-gray-200/80 hover:border-gray-300 rounded-2xl p-4 flex items-center gap-4 transition-all ${
                  v.selected ? 'bg-white shadow-xs' : 'bg-gray-50/50 opacity-60'
                }`}
              >
                {/* Selection Checkbox */}
                <input 
                  type="checkbox" 
                  checked={v.selected} 
                  onChange={() => toggleVideoSelection(v.id)} 
                  disabled={v.status === 'downloading'}
                  className="w-4 h-4 rounded text-blue-600 border-gray-300 accent-blue-600 cursor-pointer"
                />

                {/* Video Thumbnail with Duration Overlay */}
                <div className="relative w-32 h-20 rounded-xl overflow-hidden border border-gray-200 bg-gray-100 shrink-0 shadow-xs">
                  {v.thumbnail ? (
                    <img 
                      src={v.thumbnail} 
                      alt={v.title} 
                      className="w-full h-full object-cover"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400 text-2xl">📹</div>
                  )}
                  {v.duration > 0 && (
                    <span className="absolute bottom-1 right-1 bg-black/80 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                      {formatDuration(v.duration)}
                    </span>
                  )}
                </div>

                {/* Video Info Column */}
                <div className="flex-1 min-w-0 space-y-1.5">
                  <h3 className="font-bold text-sm text-gray-900 truncate" title={v.title}>
                    {v.title}
                  </h3>

                  {/* Details metadata row */}
                  <div className="flex items-center gap-2 text-xs font-semibold text-gray-500">
                    <span>📄 {v.filesizeFormatted || '350.0 MB'}</span>
                    <span>•</span>
                    <span>{quality.includes('1080p') ? '1080p' : 'HD'}</span>
                  </div>

                  {/* Progress Bar & Realtime Download Metrics */}
                  {(v.status === 'downloading' || v.status === 'completed' || v.progress > 0) && (
                    <div className="space-y-1 pt-1">
                      <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden border border-gray-200/80">
                        <div 
                          className="h-full bg-blue-600 rounded-full transition-all duration-300"
                          style={{ width: `${v.progress || 0}%` }}
                        ></div>
                      </div>

                      {v.status === 'downloading' && (
                        <div className="flex items-center justify-between text-xs font-medium text-gray-500">
                          <span>{v.progress}% downloaded</span>
                          <div className="flex items-center gap-3">
                            {v.speed && <span>Speed: {v.speed}</span>}
                            {v.eta && <span>ETA: {v.eta}</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Status Badge (Matching Screenshot 2) */}
                <div className="shrink-0 flex items-center gap-3">
                  {v.status === 'completed' || v.status === 'skipped' ? (
                    <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 px-3.5 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                      Completed
                    </span>
                  ) : v.status === 'downloading' ? (
                    <span className="bg-blue-50 text-blue-700 border border-blue-200 px-3.5 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 animate-pulse">
                      <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                      Downloading {v.progress}%
                    </span>
                  ) : v.status === 'failed' ? (
                    <span className="bg-rose-50 text-rose-700 border border-rose-200 px-3.5 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                      Failed
                    </span>
                  ) : (
                    <span className="bg-emerald-50/70 text-emerald-700 border border-emerald-200/80 px-3.5 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                      Ready to download
                    </span>
                  )}

                  {/* Action Button (Download) */}
                  <button 
                    onClick={() => handleStartSingle(v)}
                    disabled={v.status === 'downloading'}
                    className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-xs transition-colors shadow-xs flex items-center gap-1.5 disabled:opacity-40"
                  >
                    <span>📥</span>
                    <span>Download</span>
                  </button>

                  <button className="text-gray-400 hover:text-gray-600 p-1 text-base">
                    ⋮
                  </button>
                </div>
              </div>
            ))}

            {videos.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-gray-400 space-y-2">
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 text-2xl">
                  📥
                </div>
                <p className="text-sm font-semibold text-gray-600">No videos detected yet</p>
                <p className="text-xs text-gray-400">Paste a YouTube link above and click Detect Videos</p>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}