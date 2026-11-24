/* MyDimension — js/media.js
 * Media Vault (all / photos / audio / files).
 * Voice recording lives in the New Entry form (app.js); audio upload
 * fallback is here via uploadFile.
 * Files go to POST /api/media/upload as multipart FormData; the backend stores them
 * in the owner's Google Drive and keeps only metadata / Drive file IDs in Postgres.
 * Media fields (backend): id, drive_file_id, file_name, mime_type,
 * media_type ('photo'|'audio'), file_size, entry_id, caption, transcript, created_at.
 * Nothing here caches media, and delete always asks first.
 */
(function () {
  'use strict';

  // i18n: t() reads the live language.
  function t(key, vars) { return window.MyDimensionI18n ? window.MyDimensionI18n.t(key, vars) : key; }

  var mediaCache = [];

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
        size: m.file_size || 0, entry_id: m.entry_id || null,
        transcript: m.transcript || '',
        created_at: m.created_at || m.uploaded_at || '', drive_file_id: m.drive_file_id || ''
      };
    });
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function loadAllMedia() {
    mediaCache = normaliseMedia(await window.MyDimensionApi.listMedia());
    return mediaCache;
  }
  function getMediaCached() { return mediaCache; }

  function voiceItemHtml(m) {
    return '<div class="voice-item"><strong>' + esc(m.caption || m.name) + '</strong>' +
      '<div class="small muted">' + esc(fmtDate(m.created_at)) + ' · ' + esc(m.name) + (m.size ? ' · ' + esc(fmtSize(m.size)) : '') + '</div>' +
      '<audio controls preload="none" src="' + window.MyDimensionApi.getMediaUrl(m.id) + '"></audio>' +
      '<div class="entry-actions">' +
      '<button class="btn small secondary" data-transcribe-media="' + esc(m.id) + '">' + t('media.transcribeAI') + '</button>' +
      '<button class="btn small ghost" data-delete-media="' + esc(m.id) + '" data-media-name="' + esc(m.name) + '">' + t('media.delete') + '</button>' +
      '</div><div class="small" data-transcript-for="' + esc(m.id) + '">' +
      (m.transcript ? '<strong>' + t('media.transcript') + '</strong> ' + esc(m.transcript) : '') + '</div></div>';
  }

  function photoItemHtml(m) {
    return '<figure class="thumb"><img loading="lazy" alt="' + esc(m.caption || m.name) + '" src="' + window.MyDimensionApi.getMediaUrl(m.id) + '">' +
      '<figcaption><strong>' + esc(m.caption || m.name) + '</strong><br><span class="muted small">' + esc(fmtDate(m.created_at)) + (m.size ? ' · ' + esc(fmtSize(m.size)) : '') + '</span>' +
      '<br><button class="btn small ghost" data-delete-media="' + esc(m.id) + '" data-media-name="' + esc(m.name) + '">' + t('media.delete') + '</button></figcaption></figure>';
  }

  function fileItemHtml(m) {
    var icon = m.kind === 'audio' ? '♪' : '▣';
    var inner = m.kind === 'audio'
      ? '<audio controls preload="none" src="' + window.MyDimensionApi.getMediaUrl(m.id) + '" style="width:100%;margin-top:8px"></audio>'
      : '<img loading="lazy" alt="' + esc(m.caption || m.name) + '" src="' + window.MyDimensionApi.getMediaUrl(m.id) + '" style="width:100%;height:120px;object-fit:cover;border-radius:10px;margin-top:8px">';
    return '<div class="file-item"><span class="file-ico" aria-hidden="true">' + icon + '</span>' +
      '<div class="file-meta"><strong>' + esc(m.caption || m.name) + '</strong><br>' +
      '<span class="muted small">' + esc(fmtDate(m.created_at)) + (m.size ? ' · ' + esc(fmtSize(m.size)) : '') + ' · ' + esc(m.kind || '') + '</span>' +
      inner +
      '<div class="entry-actions"><a class="btn small secondary" href="' + window.MyDimensionApi.getMediaUrl(m.id) + '" download>' + t('media.download') + '</a>' +
      '<button class="btn small ghost" data-delete-media="' + esc(m.id) + '" data-media-name="' + esc(m.name) + '">' + t('media.delete') + '</button></div>' +
      '</div></div>';
  }

  // Media Vault: one list, filtered by the active tab.
  async function refreshVault(tab) {
    var box = document.getElementById('mediaGallery');
    var items = await loadAllMedia();
    if (tab === 'photo') items = items.filter(function (m) { return m.kind === 'photo'; });
    else if (tab === 'audio') items = items.filter(function (m) { return m.kind === 'audio'; });
    if (!box) return items;
    if (!items.length) {
      var label = tab === 'all' ? t('media.noMedia') : tab === 'files' ? t('media.noFiles') : tab === 'photo' ? t('media.noPhotos') : t('media.noAudio');
      box.innerHTML = '<div class="empty"><img class="empty-illus" src="assets/empty-media.svg" alt="" width="240" height="120"><p>' + label + '</p><p class="small">' + t('media.uploadHint') + '</p></div>';
      return items;
    }
    if (tab === 'files') { box.classList.remove('gallery'); box.innerHTML = items.map(fileItemHtml).join(''); }
    else {
      box.classList.add('gallery');
      box.innerHTML = items.map(function (m) { return m.kind === 'audio' ? voiceItemHtml(m) : photoItemHtml(m); }).join('');
    }
    return items;
  }

  async function uploadFile(file, kind, caption, entryId) {
    var fd = new FormData();
    fd.append('file', file);
    // Backend field name is media_type ('photo' | 'audio').
    fd.append('media_type', kind === 'voice' ? 'audio' : kind);
    if (caption) fd.append('caption', caption);
    if (entryId) fd.append('entry_id', entryId);
    return window.MyDimensionApi.uploadMedia(fd);
  }

  window.MyDimensionMedia = {
    refreshVault: refreshVault, loadAllMedia: loadAllMedia, getMediaCached: getMediaCached,
    uploadFile: uploadFile, fmtSize: fmtSize
  };
})();
