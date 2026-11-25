/* MyDimension — js/journal.js
 * Diary entries: create / read / update / delete, search and filters.
 * API truth (schemas.py): an entry is { id, title, content, mood, tags,
 * summary, created_at, updated_at }. There is NO entry_date field — an
 * entry's date is its created_at date. Drafts are NOT a backend state:
 * "Save as Draft" keeps the draft in this browser only (localStorage)
 * until you press Save Entry.
 * No fake entries: an empty list renders an empty state with a CTA.
 * Dates are local (YYYY-MM-DD) so the calendar matches the owner's timezone.
 */
(function () {
  'use strict';

  // i18n: t() reads the live language; loc() is the date locale for it.
  function t(key, vars) { return window.MyDimensionI18n ? window.MyDimensionI18n.t(key, vars) : key; }
  function loc() { return window.MyDimensionI18n ? window.MyDimensionI18n.locale() : undefined; }

  var MOODS = ['Happy', 'Calm', 'Grateful', 'Excited', 'Tired', 'Sad', 'Anxious', 'Angry', 'Stressed', 'Thoughtful'];
  var MOOD_EMOJI = { Happy: '😊', Calm: '😌', Grateful: '🙏', Excited: '🤩', Tired: '😴', Sad: '😢', Anxious: '😟', Angry: '😠', Stressed: '😫', Thoughtful: '🤔' };
  // Moods the dashboard donut counts as "positive".
  var POSITIVE_MOODS = ['Happy', 'Calm', 'Grateful', 'Excited'];
  var entriesCache = [];
  var editingId = null;
  var DRAFT_KEY = 'mydimension-draft-v1';

  function todayLocal() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
    return isNaN(d) ? iso : d.toLocaleDateString(loc(), { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString(loc(), { hour: 'numeric', minute: '2-digit' });
  }
  function relTime(iso) {
    if (!iso) return '';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return t('rel.justNow');
    if (mins < 60) return t(mins === 1 ? 'rel.minute' : 'rel.minutes', { n: mins });
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return t(hrs === 1 ? 'rel.hour' : 'rel.hours', { n: hrs });
    return fmtDate(iso);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Entry "date" is created_at's date (the API has no entry_date).
  function entryDate(e) { return (e.created_at || '').slice(0, 10); }

  // Normalise backend shapes: { entries: [...] } or a bare array.
  // Internal shape keeps `body` as the display alias of `content`.
  function normalise(list) {
    var arr = Array.isArray(list) ? list : (list && Array.isArray(list.entries) ? list.entries : []);
    return arr.map(function (e) {
      return {
        id: e.id, title: e.title || t('journal.untitled'),
        body: e.content || e.body || '', content: e.content || e.body || '',
        date: (e.created_at || '').slice(0, 10),
        mood: e.mood || '', tags: Array.isArray(e.tags) ? e.tags : (e.tags ? String(e.tags).split(',').map(function (t) { return t.trim(); }).filter(Boolean) : []),
        summary: e.summary || '',
        theme: e.theme || 'default',
        created_at: e.created_at || '', updated_at: e.updated_at || ''
      };
    });
  }

  async function loadEntries(params) {
    var data = await window.MyDimensionApi.listEntries(params || {});
    entriesCache = normalise(data);
    return entriesCache;
  }

  function getCached() { return entriesCache; }
  function findCached(id) { return entriesCache.find(function (e) { return String(e.id) === String(id); }); }
  function sortedEntries(list) {
    return (list || entriesCache).slice().sort(function (a, b) {
      return (b.created_at || b.date || '').localeCompare(a.created_at || a.date || '');
    });
  }

  function coverClass(e, i) { return 'cover-' + ((i || 0) % 6); }

  // Dashboard cover illustrations (local SVG, no external images).
  // Neutral space / nature scenes only: astronaut, ringed planet,
  // crescent moon, stars, hot-air balloon, mountains, sailboat —
  // drawn in the design-board palette.
  var COVER_ART = ['assets/cover-diary.svg', 'assets/cover-future.svg', 'assets/cover-sunset.svg'];
  var COVER_ALT = ['Astronaut under a crescent moon beside a ringed planet', 'Hot-air balloon over mountains at dawn', 'Sailboat on calm water at sunset'];
  function coverArt(i) { return COVER_ART[((i || 0) % 3 + 3) % 3]; }
  function coverArtAlt(i) { return COVER_ALT[((i || 0) % 3 + 3) % 3]; }

  function entryCard(e, i) {
    var excerpt = e.body.length > 180 ? e.body.slice(0, 180) + '…' : e.body;
    return '<article class="entry"><div class="entry-row">' +
      '<span class="entry-thumb ' + coverClass(e, i) + '" aria-hidden="true"><img class="entry-thumb-img" src="' + coverArt(i) + '" alt="" loading="lazy"><span class="entry-thumb-emoji">' + (MOOD_EMOJI[e.mood] || '✎') + '</span></span>' +
      '<div class="entry-body"><h4><a href="#/entry/' + esc(e.id) + '">' + esc(e.title) + '</a></h4>' +
      '<div class="entry-meta">' + esc(fmtDate(e.date)) + (e.created_at ? ' · ' + esc(fmtTime(e.created_at)) : '') +
      (e.mood ? ' · <span class="mood-pill">' + esc(MOOD_EMOJI[e.mood] || '') + ' ' + esc(window.MyDimensionI18n ? window.MyDimensionI18n.moodLabel(e.mood) : e.mood) + '</span>' : '') +
      e.tags.map(function (t) { return ' <span class="tag-pill">' + esc(t) + '</span>'; }).join('') + '</div>' +
      '<p>' + esc(excerpt) + '</p>' +
      '<div class="entry-actions">' +
      '<a class="btn small secondary" href="#/entry/' + esc(e.id) + '">' + t('journal.view') + '</a>' +
      '<button class="btn small secondary" data-edit-entry="' + esc(e.id) + '">' + t('journal.edit') + '</button>' +
      '<button class="btn small ghost" data-delete-entry="' + esc(e.id) + '" data-entry-title="' + esc(e.title) + '">' + t('journal.delete') + '</button>' +
      '<button class="btn small ghost" data-ai-entry="' + esc(e.id) + '">' + t('journal.aiReflection') + '</button>' +
      '</div></div></div></article>';
  }

  function renderList(container, list) {
    if (!container) return;
    if (!list.length) {
      container.innerHTML = '<div class="empty"><p>' + t('journal.noEntries') + '</p>' +
        '<button class="btn" data-goto-new-entry>' + t('dash.writeFirst') + '</button></div>';
      return;
    }
    container.innerHTML = list.map(function (e, i) { return entryCard(e, i); }).join('');
  }

  /* ---------- editor ---------- */

  // Note themes (Google Keep-style). bg: two gradient stops; ink: text colour.
  // Keep in sync with the .theme-* classes in styles.css and the canvas
  // share renderer in app.js.
  var THEMES = [
    { id: 'default', bg: ['#ffffff', '#f2fbf8'], ink: '#26352f' },
    { id: 'mint', bg: ['#d1fae5', '#a7f3d0'], ink: '#14532d' },
    { id: 'lavender', bg: ['#ede9fe', '#ddd6fe'], ink: '#4c1d95' },
    { id: 'peach', bg: ['#ffedd5', '#fed7aa'], ink: '#7c2d12' },
    { id: 'sky', bg: ['#dbeafe', '#bfdbfe'], ink: '#1e3a8a' },
    { id: 'rose', bg: ['#fce7f3', '#fbcfe8'], ink: '#831843' },
    { id: 'sand', bg: ['#fef3c7', '#fde68a'], ink: '#78350f' },
    { id: 'forest', bg: ['#0f766e', '#14b8a6'], ink: '#ffffff' },
    // Illustrated themes: an SVG scene (app palette) on the right edge of
    // the note, like the pencil-and-path Keep note — the solid gradient
    // stays underneath, so text stays readable.
    { id: 'pencil', bg: ['#fef3c7', '#fde68a'], ink: '#78350f', art: 'assets/theme-pencil.svg' },
    { id: 'river', bg: ['#dbeafe', '#a7f3d0'], ink: '#134e4a', art: 'assets/theme-river.svg' },
    { id: 'garden', bg: ['#ede9fe', '#fce7f3'], ink: '#4c1d95', art: 'assets/theme-garden.svg' },
    { id: 'space', bg: ['#d1fae5', '#a7f3d0'], ink: '#134e4a', art: 'assets/theme-space.svg' }
  ];
  var formTheme = 'default';

  function themeById(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return THEMES[0];
  }

  function setFormTheme(id) {
    formTheme = themeById(id).id;
    var card = document.getElementById('entryFormCard');
    if (card) {
      THEMES.forEach(function (th) { card.classList.remove('theme-' + th.id); });
      card.classList.add('theme-' + formTheme);
    }
    renderThemePicker();
  }

  function renderThemePicker() {
    var box = document.getElementById('themePicker');
    if (!box) return;
    box.innerHTML = THEMES.map(function (th) {
      var label = t('theme.' + th.id);
      return '<button type="button" class="theme-dot' + (th.id === formTheme ? ' selected' : '') +
        '" data-form-theme="' + th.id + '" title="' + esc(label) + '" aria-label="' + esc(label) +
        '" aria-pressed="' + (th.id === formTheme) + '" style="background:linear-gradient(135deg,' +
        th.bg[0] + ',' + th.bg[1] + ')"></button>';
    }).join('');
    box.querySelectorAll('[data-form-theme]').forEach(function (btn) {
      btn.addEventListener('click', function () { setFormTheme(btn.getAttribute('data-form-theme')); });
    });
  }

  // Attachments already saved on this entry (voice recordings, photos,
  // files) — shown inside the edit form so the voice you recorded earlier
  // is visible while editing, not only after saving.
  function isAudioMedia(m) { return (m.mime_type || '').indexOf('audio/') === 0 || m.media_type === 'audio'; }
  function isImageMedia(m) { return (m.mime_type || '').indexOf('image/') === 0 || m.media_type === 'photo'; }

  async function loadEntryAttachments(entryId) {
    var voiceBox = document.getElementById('entryVoiceList');
    var photoBox = document.getElementById('entryPhotoList');
    var fileBox = document.getElementById('entryFileList');
    [voiceBox, photoBox, fileBox].forEach(function (b) { if (b) b.innerHTML = ''; });
    if (!entryId) return;
    var list;
    try { list = await window.MyDimensionApi.listMedia(null, entryId); }
    catch (e) { return; }
    var voices = list.filter(isAudioMedia);
    var photos = list.filter(isImageMedia);
    var files = list.filter(function (m) { return !isAudioMedia(m) && !isImageMedia(m); });
    if (voiceBox) voiceBox.innerHTML = voices.length ? voices.map(function (m) {
      return '<div class="voice-item"><strong>' + esc(m.caption || m.file_name) + '</strong>' +
        '<audio controls preload="none" src="' + window.MyDimensionApi.getMediaUrl(m.id) + '"></audio></div>';
    }).join('') : '<p class="small muted">' + t('entry.noVoice') + '</p>';
    if (photoBox) photoBox.innerHTML = photos.length ? photos.map(function (m) {
      return '<figure class="thumb"><img loading="lazy" alt="' + esc(m.caption || m.file_name) +
        '" src="' + window.MyDimensionApi.getMediaUrl(m.id) + '"><figcaption>' +
        esc(m.caption || m.file_name) + '</figcaption></figure>';
    }).join('') : '<p class="small muted">' + t('entry.noPhoto') + '</p>';
    if (fileBox) fileBox.innerHTML = files.length ? files.map(function (m) {
      return '<div class="file-chip"><a href="' + window.MyDimensionApi.getMediaUrl(m.id) +
        '" download="' + esc(m.file_name) + '">' + esc(m.file_name) + '</a></div>';
    }).join('') : '<p class="small muted">' + t('entry.noFile') + '</p>';
  }

  function readForm() {
    var bodyEl = document.getElementById('entryBody');
    return {
      title: document.getElementById('entryTitle').value.trim() || t('journal.untitled'),
      content: bodyEl.innerText.trim(),
      mood: document.getElementById('entryMood').value || null,
      tags: document.getElementById('entryTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
      theme: formTheme
    };
  }

  function setBody(text) { document.getElementById('entryBody').innerText = text || ''; }

  function fillForm(e) {
    document.getElementById('entryTitle').value = e.title === t('journal.untitled') ? '' : (e.title || '');
    setBody(e.body || '');
    document.getElementById('entryMood').value = e.mood || '';
    renderMoodPicker();
    document.getElementById('entryTags').value = (e.tags || []).join(', ');
    document.getElementById('entryFormTitle').textContent = t('journal.editEntry');
    document.getElementById('cancelEditBtn').classList.remove('hidden');
    editingId = e.id;
    setFormTheme(e.theme || 'default');
    loadEntryAttachments(e.id);
    var card = document.getElementById('entryFormCard');
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('entryTitle').focus();
  }

  function resetForm(preset) {
    editingId = null;
    document.getElementById('entryTitle').value = '';
    setBody('');
    document.getElementById('entryMood').value = '';
    document.getElementById('entryTags').value = '';
    renderMoodPicker();
    setFormTheme('default');
    loadEntryAttachments(null);
    if (window.MyDimensionApp && window.MyDimensionApp.clearEntryVoiceBlob) {
      window.MyDimensionApp.clearEntryVoiceBlob();
    }
    document.getElementById('entryFormTitle').textContent = t('journal.formTitle');
    document.getElementById('cancelEditBtn').classList.add('hidden');
    if (preset && preset.title) document.getElementById('entryTitle').value = preset.title;
    if (preset && preset.body) setBody(preset.body);
    if (preset && preset.mood) { document.getElementById('entryMood').value = preset.mood; renderMoodPicker(); }
    var fileInput = document.getElementById('entryPhoto'); if (fileInput) fileInput.value = '';
    var fileInput2 = document.getElementById('entryFile'); if (fileInput2) fileInput2.value = '';
    var prev = document.getElementById('entryPhotoPreview'); if (prev) prev.classList.add('hidden');
  }

  function renderMoodPicker() {
    var box = document.getElementById('moodPicker');
    if (!box) return;
    var current = document.getElementById('entryMood').value;
    box.innerHTML = MOODS.map(function (m) {
      var label = window.MyDimensionI18n ? window.MyDimensionI18n.moodLabel(m) : m;
      return '<button type="button" class="mood-opt' + (m === current ? ' selected' : '') + '" data-mood="' + esc(m) + '" role="radio" aria-checked="' + (m === current) + '" title="' + esc(label) + '">' +
        esc(MOOD_EMOJI[m] || '•') + '<small>' + esc(label) + '</small></button>';
    }).join('');
    box.querySelectorAll('[data-mood]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var hidden = document.getElementById('entryMood');
        hidden.value = hidden.value === btn.getAttribute('data-mood') ? '' : btn.getAttribute('data-mood');
        renderMoodPicker();
      });
    });
  }

  /* ---------- drafts (this browser only — the backend has no draft state) ---------- */
  function saveDraft() {
    var data = readForm();
    if (!data.title && !data.content) throw new Error(t('journal.needTitle'));
    data.savedAt = new Date().toISOString();
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
    var note = document.getElementById('draftNote');
    if (note) note.classList.remove('hidden');
    var discard = document.getElementById('discardDraftBtn');
    if (discard) discard.classList.remove('hidden');
    return data;
  }
  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
    var note = document.getElementById('draftNote');
    if (note) note.classList.add('hidden');
    var discard = document.getElementById('discardDraftBtn');
    if (discard) discard.classList.add('hidden');
  }
  function restoreDraftIfAny() {
    var d = loadDraft();
    if (!d || editingId) return false;
    if (!d.title && !d.content) return false;
    document.getElementById('entryTitle').value = d.title === t('journal.untitled') ? '' : (d.title || '');
    setBody(d.content || '');
    document.getElementById('entryMood').value = d.mood || '';
    document.getElementById('entryTags').value = (d.tags || []).join(', ');
    renderMoodPicker();
    setFormTheme(d.theme || 'default');
    var note = document.getElementById('draftNote');
    if (note) note.classList.remove('hidden');
    var discard = document.getElementById('discardDraftBtn');
    if (discard) discard.classList.remove('hidden');
    return true;
  }

  async function saveCurrent() {
    var data = readForm();
    if (!data.title && !data.content.trim()) throw new Error(t('journal.needTitle'));
    var saved;
    if (editingId) saved = await window.MyDimensionApi.updateEntry(editingId, data);
    else saved = await window.MyDimensionApi.createEntry(data);
    clearDraft();
    // Attach a photo/file chosen on the Photo/File tabs to the saved entry.
    await uploadEntryAttachments(saved && saved.id);
    resetForm();
    await refreshJournalList();
    return saved;
  }

  async function uploadEntryAttachments(entryId) {
    if (!entryId) return;
    var photo = document.getElementById('entryPhoto');
    var fileInput = document.getElementById('entryFile');
    var file = (photo && photo.files[0]) || (fileInput && fileInput.files[0]);
    if (file) {
      var kind = file.type.indexOf('audio/') === 0 ? 'audio' : 'photo';
      try { await window.MyDimensionMedia.uploadFile(file, kind, '', entryId); }
      catch (err) { window.MyDimensionApp.toast(t('toast.attachmentFailed') + ' ' + err.message); }
    }
    // A voice recording made on the Voice tab is an attachment too: until
    // now it was only transcribed into text and the audio itself was lost
    // on save, so the note never showed which voice belonged to it.
    var voiceBlob = window.MyDimensionApp && window.MyDimensionApp.getEntryVoiceBlob
      ? window.MyDimensionApp.getEntryVoiceBlob() : null;
    if (voiceBlob) {
      try {
        await window.MyDimensionMedia.uploadFile(
          new File([voiceBlob], 'voice-note.webm', { type: voiceBlob.type || 'audio/webm' }),
          'audio', '', entryId);
        window.MyDimensionApp.clearEntryVoiceBlob();
      } catch (err) { window.MyDimensionApp.toast(t('toast.attachmentFailed') + ' ' + err.message); }
    }
  }

  async function refreshJournalList() {
    var q = (document.getElementById('journalSearch') || {}).value || '';
    var mood = (document.getElementById('journalMoodFilter') || {}).value || '';
    var date = (document.getElementById('journalDateFilter') || {}).value || '';
    var params = {};
    if (q) params.search = q; // backend param is `search` (title/content)
    if (mood) params.mood = mood;
    var list = await loadEntries(params);
    // Client-side filter as a safety net: the backend has no date filter,
    // and its search is title/content only.
    list = list.filter(function (e) {
      if (date && e.date !== date) return false;
      if (q) { var hay = (e.title + ' ' + e.body).toLowerCase(); if (!hay.includes(q.toLowerCase())) return false; }
      return true;
    });
    renderList(document.getElementById('journalList'), sortedEntries(list));
    return list;
  }

  function startNew(preset) {
    resetForm(preset);
    window.location.hash = '#/journal';
    setTimeout(function () { document.getElementById('entryTitle').focus(); }, 50);
  }

  window.MyDimensionJournal = {
    MOODS: MOODS, MOOD_EMOJI: MOOD_EMOJI, POSITIVE_MOODS: POSITIVE_MOODS,
    THEMES: THEMES, themeById: themeById, setFormTheme: setFormTheme,
    renderThemePicker: renderThemePicker, loadEntryAttachments: loadEntryAttachments,
    isAudioMedia: isAudioMedia, isImageMedia: isImageMedia,
    todayLocal: todayLocal, fmtDate: fmtDate, fmtTime: fmtTime, relTime: relTime, esc: esc,
    entryDate: entryDate, coverClass: coverClass, coverArt: coverArt, coverArtAlt: coverArtAlt, COVER_ART: COVER_ART,
    loadEntries: loadEntries, getCached: getCached, findCached: findCached,
    sortedEntries: sortedEntries, renderList: renderList, refreshJournalList: refreshJournalList,
    saveCurrent: saveCurrent, fillForm: fillForm, resetForm: resetForm,
    startNew: startNew, getEditingId: function () { return editingId; },
    renderMoodPicker: renderMoodPicker, saveDraft: saveDraft, clearDraft: clearDraft,
    restoreDraftIfAny: restoreDraftIfAny, readForm: readForm, setBody: setBody
  };
})();
