import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

const socket = io('http://localhost:4000');

export default function App() {
  const [url, setUrl] = useState('');
  const [outDir, setOutDir] = useState(() => {
    return localStorage.getItem('yt_downloader_outDir') || '';
  });
  const [videos, setVideos] = useState([]);
  const [logs, setLogs] = useState([]);
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

    socket.on('log', (msg) => {
      if (msg) setLogs(prev => [...prev.slice(-49), msg]);
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

  const handleStart = () => {
    if (!outDir) return alert('Please select an output folder first.');
    const selectedVideos = videos.filter(v => v.selected);
    if (selectedVideos.length === 0) return alert('Please select at least one video to download.');

    setGlobalStatus('downloading');
    socket.emit('start_downloads', { videos: selectedVideos, outDir });
  };

  const handleAction = (type) => {
    if (type === 'cancel') setGlobalStatus('idle');
    else if (type === 'pause') setGlobalStatus('paused');
    else if (type === 'resume') setGlobalStatus('downloading');
    
    socket.emit('action', { type });
  };

  // Feature: Retry a single failed video
  const handleRetrySingle = (id) => {
    const video = videos.find(v => v.id === id);
    setVideos(prev => prev.map(v => v.id === id ? { ...v, status: 'pending', progress: 0 } : v));
    if (globalStatus !== 'downloading') setGlobalStatus('downloading');
    socket.emit('start_downloads', { videos: [video], outDir });
  };

  // Feature: Bulk retry all failed videos
  const handleRetryAllFailed = () => {
    const failedVideos = videos.filter(v => v.status === 'failed');
    if (failedVideos.length === 0) return;
    setVideos(prev => prev.map(v => v.status === 'failed' ? { ...v, status: 'pending', progress: 0 } : v));
    setGlobalStatus('downloading');
    socket.emit('start_downloads', { videos: failedVideos, outDir });
  };

  const openFolder = () => {
    if (window.electronAPI && outDir) window.electronAPI.openFolder(outDir);
  };

  const toggleVideoSelection = (id) => {
    setVideos(prev => prev.map(v => v.id === id ? { ...v, selected: !v.selected } : v));
  };

  const toggleAllSelection = (e) => {
    const isChecked = e.target.checked;
    setVideos(prev => prev.map(v => ({ ...v, selected: isChecked })));
  };

  const completedCount = videos.filter(v => v.status === 'completed' || v.status === 'skipped').length;
  const failedCount = videos.filter(v => v.status === 'failed').length;
  const selectedCount = videos.filter(v => v.selected).length;
  const allSelected = videos.length > 0 && selectedCount === videos.length;

  return (
    <div className="flex flex-col h-screen p-6 max-w-5xl mx-auto space-y-6">
      <header className="flex justify-between items-center pb-4 border-b border-gray-700">
        <h1 className="text-2xl font-bold">YT Downloader Pro</h1>
        <div className="text-sm text-gray-400">
          Completed: <span className="text-green-400">{completedCount}</span> / {videos.length} 
          {failedCount > 0 && <span className="ml-3 text-red-400">Failed: {failedCount}</span>}
        </div>
      </header>

      <div className="flex gap-4">
        <input 
          type="text" 
          value={url} 
          onChange={e => setUrl(e.target.value)} 
          placeholder="Paste YouTube Video or Playlist URL" 
          className="flex-1 px-4 py-2 bg-gray-800 rounded border border-gray-700 focus:outline-none focus:border-blue-500"
        />
        <button onClick={handleFetch} disabled={isFetching} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 rounded font-semibold disabled:opacity-50">
          {isFetching ? 'Detecting...' : 'Detect'}
        </button>
      </div>

      <div className="flex gap-4 items-center">
        <button onClick={handleSelectFolder} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded">
          Choose Output Folder
        </button>
        <span className="text-sm text-gray-400 truncate flex-1">{outDir || 'No folder selected'}</span>
        {outDir && (
          <button onClick={openFolder} className="text-sm text-blue-400 hover:underline">
            Open Folder
          </button>
        )}
      </div>

      <div className="flex gap-4">
        <button onClick={handleStart} disabled={videos.length === 0 || globalStatus === 'downloading'} className="px-6 py-2 bg-green-600 hover:bg-green-500 rounded disabled:opacity-50">
          Start Download
        </button>
        
        {globalStatus === 'paused' ? (
          <button onClick={() => handleAction('resume')} className="px-6 py-2 bg-yellow-600 hover:bg-yellow-500 rounded font-semibold">
            Resume
          </button>
        ) : (
          <button onClick={() => handleAction('pause')} disabled={globalStatus !== 'downloading'} className="px-6 py-2 bg-yellow-600 hover:bg-yellow-500 rounded disabled:opacity-50">
            Pause
          </button>
        )}
        
        <button onClick={() => handleAction('cancel')} disabled={globalStatus === 'idle'} className="px-6 py-2 bg-red-600 hover:bg-red-500 rounded disabled:opacity-50">
          Cancel
        </button>

        {failedCount > 0 && (
          <button onClick={handleRetryAllFailed} className="px-6 py-2 bg-purple-600 hover:bg-purple-500 rounded font-semibold ml-auto transition-colors">
            Retry All Failed
          </button>
        )}
      </div>

      <div className="flex-1 bg-gray-800 rounded border border-gray-700 overflow-hidden flex flex-col">
        {videos.length > 0 && (
          <div className="bg-gray-900 border-b border-gray-700 p-3 flex items-center gap-3">
            <input 
              type="checkbox" 
              checked={allSelected} 
              onChange={toggleAllSelection} 
              disabled={globalStatus === 'downloading' || globalStatus === 'paused'}
              className="w-4 h-4 cursor-pointer accent-blue-500 rounded"
            />
            <span className="text-sm font-semibold text-gray-300">
              Select All ({selectedCount} of {videos.length} selected)
            </span>
          </div>
        )}
        
        <div className="overflow-y-auto flex-1 p-4 space-y-3">
          {videos.map((v, i) => (
            <div key={v.id + i} className={`bg-gray-700 p-3 rounded flex items-start gap-4 transition-opacity ${!v.selected && globalStatus !== 'downloading' && globalStatus !== 'paused' ? 'opacity-50' : ''}`}>
              <div className="pt-1">
                <input 
                  type="checkbox" 
                  checked={v.selected} 
                  onChange={() => toggleVideoSelection(v.id)} 
                  disabled={globalStatus === 'downloading' || globalStatus === 'paused' || v.status === 'completed' || v.status === 'skipped'}
                  className="w-4 h-4 cursor-pointer accent-blue-500 rounded"
                />
              </div>
              <div className="flex flex-col gap-2 flex-1 min-w-0">
                <div className="flex justify-between items-center text-sm">
                  <span className="font-medium truncate pr-4">{v.title}</span>
                  <div className="flex items-center gap-3">
                    <span className={`uppercase text-xs font-bold whitespace-nowrap ${v.status === 'completed' || v.status === 'skipped' ? 'text-green-400' : v.status === 'failed' ? 'text-red-400' : v.status === 'paused' ? 'text-yellow-400' : 'text-gray-400'}`}>
                      {v.status}
                    </span>
                    {v.status === 'failed' && (
                      <button onClick={() => handleRetrySingle(v.id)} className="bg-gray-600 hover:bg-gray-500 px-2 py-1 rounded text-xs font-bold transition-colors">
                        ↻ Retry
                      </button>
                    )}
                  </div>
                </div>
                {(v.status === 'downloading' || v.status === 'paused') && (
                  <>
                    <div className="w-full bg-gray-900 rounded-full h-2">
                      <div className={`h-2 rounded-full transition-all duration-300 ${v.status === 'paused' ? 'bg-yellow-500' : 'bg-blue-500'}`} style={{ width: `${v.progress}%` }}></div>
                    </div>
                    <div className="flex justify-between text-xs text-gray-400">
                      <span>{v.progress}%</span>
                      <span>{v.status === 'paused' ? 'PAUSED' : `Speed: ${v.speed || '--'} | ETA: ${v.eta || '--'}`}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
          {videos.length === 0 && <div className="text-center text-gray-500 mt-10">Paste a URL to get started</div>}
        </div>
        
        <div className="h-32 bg-black p-2 overflow-y-auto text-xs font-mono text-gray-400 border-t border-gray-700">
          {logs.map((log, i) => <div key={i}>{log}</div>)}
        </div>
      </div>
    </div>
  );
}