/* MyDimension — js/media.js
 * Voice Memories (MediaRecorder + file-upload fallback) and Photo Memories.
 * Files go to POST /api/media/upload as multipart FormData; the backend stores them
 * in the owner's Google Drive and keeps only metadata / Drive file IDs in Postgres.
 * Nothing here caches media, and delete always asks first.
 */
(function () {
  'use strict';

  var recorder = null, chunks = [], recStart = 0, recTimer = null, recBlob = null;

  function esc(s) { return window.MyDimensionJournal.esc(s); }
  function fmtDate(iso) { return window.MyDimensionJournal.fmtDate(iso); }

  /* ---------- shared list rendering ---------- */
  function normaliseMedia(data) {
    var arr = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : (data && Array.isArray(data.media) ? data.media : []));
    return arr.map(function (m) {
      return {
        id: m.id, kind: m.media_type || m.kind || m.type || '',
        name: m.file_name || m.filename || m.name || m.original_filename || 'File',
        caption: m.caption || m.title || '', mime: m.mime_type || m.mimeType || '',
        created_at: m.created_at || m.uploaded_at || '', drive_file_id: m.drive_file_id || ''
      };
    });
  }

  async function refreshVoiceList() {
    var list = normaliseMedia(await window.MyDimensionApi.listMedia('audio'));
    var box = document.getElementById('voiceList');
    if (!box) return list;
    var items = list.filter(function (m) { return !m.kind || /audio|voice/.test(m.kind + m.mime); });
    if (!items.length) {
      box.innerHTML = '<div class="empty"><p>No voice memories yet.</p><p class="small">Record one above, or upload an audio file.</p></div>';
      return items;
    }
    box.innerHTML = items.map(function (m) {
      return '<div class="voice-item"><strong>' + esc(m.caption || m.name) + '</strong>' +
        '<div class="small muted">' + esc(fmtDate(m.created_at)) + ' · ' + esc(m.name) + '</div>' +
        '<audio controls preload="none" src="' + window.MyDimensionApi.getMediaUrl(m.id) + '"></audio>' +
        '<div class="entry-actions">' +
        '<button class="btn small secondary" data-transcribe-media="' + esc(m.id) + '">Transcribe with AI</button>' +
        '<button class="btn small ghost" data-delete-media="' + esc(m.id) + '" data-media-name="' + esc(m.name) + '">Delete</button>' +
        '</div><div class="small" data-transcript-for="' + esc(m.id) + '"></div></div>';
    }).join('');
    return items;
  }

  async function refreshPhotoList() {
    var list = normaliseMedia(await window.MyDimensionApi.listMedia('photo'));
    var box = document.getElementById('photoGallery');
    if (!box) return list;
    var items = list.filter(function (m) { return !m.kind || /image|photo/.test(m.kind + m.mime); });
    if (!items.length) {
      box.innerHTML = '<div class="empty"><p>No photos yet.</p><p class="small">Upload your first photo above.</p></div>';
      return items;
    }
    box.innerHTML = items.map(function (m) {
      return '<figure class="thumb"><img loading="lazy" alt="' + esc(m.caption || m.name) + '" src="' + window.MyDimensionApi.getMediaUrl(m.id) + '">' +
        '<figcaption><strong>' + esc(m.caption || m.name) + '</strong><br><span class="muted small">' + esc(fmtDate(m.created_at)) + '</span>' +
        '<br><button class="btn small ghost" data-delete-media="' + esc(m.id) + '" data-media-name="' + esc(m.name) + '">Delete</button></figcaption></figure>';
    }).join('');
    return items;
  }

  async function uploadFile(file, kind, caption) {
    var fd = new FormData();
    fd.append('file', file);
    // Backend field name is media_type ('photo' | 'audio').
    fd.append('media_type', kind === 'voice' ? 'audio' : kind);
    if (caption) fd.append('caption', caption);
    return window.MyDimensionApi.uploadMedia(fd);
  }

  /* ---------- voice recording ---------- */
  function setRecUI(state, secs) {
    var status = document.getElementById('recStatus'), timer = document.getElementById('recTimer');
    var startBtn = document.getElementById('startRecBtn'), stopBtn = document.getElementById('stopRecBtn');
    if (status) status.innerHTML = state === 'recording' ? '<span class="rec-dot"></span> Recording…' : state === 'ready' ? 'Ready to record.' : 'Recording stopped — preview it below, then save or discard it.';
    if (timer) timer.textContent = secs != null ? new Date(secs * 1000).toISOString().slice(14, 19) : '00:00';
    if (startBtn) startBtn.disabled = state === 'recording';
    if (stopBtn) stopBtn.disabled = state !== 'recording';
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot record audio here. Please use the file-upload option below instead.');
    }
    if (!window.MediaRecorder) throw new Error('Audio recording is not supported in this browser. Please upload an audio file instead.');
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = function () {
      stream.getTracks().forEach(function (t) { t.stop(); });
      recBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      var url = URL.createObjectURL(recBlob);
      var preview = document.getElementById('recPreview');
      preview.src = url; preview.classList.remove('hidden');
      document.getElementById('saveRecBtn').classList.remove('hidden');
      document.getElementById('discardRecBtn').classList.remove('hidden');
      setRecUI('stopped');
    };
    recorder.start();
    recStart = Date.now();
    recTimer = setInterval(function () { setRecUI('recording', Math.floor((Date.now() - recStart) / 1000)); }, 500);
    setRecUI('recording', 0);
  }

  function stopRecording() {
    if (recTimer) clearInterval(recTimer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function discardRecording() {
    recBlob = null; chunks = [];
    var preview = document.getElementById('recPreview');
    preview.removeAttribute('src'); preview.classList.add('hidden');
    document.getElementById('saveRecBtn').classList.add('hidden');
    document.getElementById('discardRecBtn').classList.add('hidden');
    setRecUI('ready');
  }

  async function saveRecording() {
    if (!recBlob) throw new Error('Nothing to save yet — record something first.');
    var caption = (document.getElementById('recCaption') || {}).value || '';
    var file = new File([recBlob], 'voice-memory-' + new Date().toISOString().slice(0, 10) + '.webm', { type: recBlob.type || 'audio/webm' });
    await uploadFile(file, 'audio', caption);
    discardRecording();
    document.getElementById('recCaption').value = '';
    await refreshVoiceList();
  }

  window.MyDimensionMedia = {
    refreshVoiceList: refreshVoiceList, refreshPhotoList: refreshPhotoList,
    uploadFile: uploadFile, startRecording: startRecording, stopRecording: stopRecording,
    saveRecording: saveRecording, discardRecording: discardRecording
  };
})();
