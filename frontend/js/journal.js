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
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function relTime(iso) {
    if (!iso) return '';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
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
        id: e.id, title: e.title || 'Untitled entry',
        body: e.content || e.body || '', content: e.content || e.body || '',
        date: (e.created_at || '').slice(0, 10),
        mood: e.mood || '', tags: Array.isArray(e.tags) ? e.tags : (e.tags ? String(e.tags).split(',').map(function (t) { return t.trim(); }).filter(Boolean) : []),
        summary: e.summary || '',
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

  function entryCard(e, i) {
    var excerpt = e.body.length > 180 ? e.body.slice(0, 180) + '…' : e.body;
    return '<article class="entry"><div class="entry-row">' +
      '<span class="entry-thumb ' + coverClass(e, i) + '" aria-hidden="true">' + (MOOD_EMOJI[e.mood] || '✎') + '</span>' +
      '<div class="entry-body"><h4><a href="#/entry/' + esc(e.id) + '">' + esc(e.title) + '</a></h4>' +
      '<div class="entry-meta">' + esc(fmtDate(e.date)) + (e.created_at ? ' · ' + esc(fmtTime(e.created_at)) : '') +
      (e.mood ? ' · <span class="mood-pill">' + esc(MOOD_EMOJI[e.mood] || '') + ' ' + esc(e.mood) + '</span>' : '') +
      e.tags.map(function (t) { return ' <span class="tag-pill">' + esc(t) + '</span>'; }).join('') + '</div>' +
      '<p>' + esc(excerpt) + '</p>' +
      '<div class="entry-actions">' +
      '<a class="btn small secondary" href="#/entry/' + esc(e.id) + '">View</a>' +
      '<button class="btn small secondary" data-edit-entry="' + esc(e.id) + '">Edit</button>' +
      '<button class="btn small ghost" data-delete-entry="' + esc(e.id) + '" data-entry-title="' + esc(e.title) + '">Delete</button>' +
      '<button class="btn small ghost" data-ai-entry="' + esc(e.id) + '">AI reflection</button>' +
      '</div></div></div></article>';
  }

  function renderList(container, list) {
    if (!container) return;
    if (!list.length) {
      container.innerHTML = '<div class="empty"><p>No entries yet.</p>' +
        '<button class="btn" data-goto-new-entry>Write your first memory</button></div>';
      return;
    }
    container.innerHTML = list.map(function (e, i) { return entryCard(e, i); }).join('');
  }

  /* ---------- editor ---------- */
  function readForm() {
    var bodyEl = document.getElementById('entryBody');
    return {
      title: document.getElementById('entryTitle').value.trim() || 'Untitled entry',
      content: bodyEl.innerText.trim(),
      mood: document.getElementById('entryMood').value || null,
      tags: document.getElementById('entryTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
    };
  }

  function setBody(text) { document.getElementById('entryBody').innerText = text || ''; }

  function fillForm(e) {
    document.getElementById('entryTitle').value = e.title === 'Untitled entry' ? '' : (e.title || '');
    setBody(e.body || '');
    document.getElementById('entryMood').value = e.mood || '';
    renderMoodPicker();
    document.getElementById('entryTags').value = (e.tags || []).join(', ');
    document.getElementById('entryFormTitle').textContent = 'Edit entry';
    document.getElementById('cancelEditBtn').classList.remove('hidden');
    editingId = e.id;
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
    document.getElementById('entryFormTitle').textContent = 'New Journal Entry';
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
      return '<button type="button" class="mood-opt' + (m === current ? ' selected' : '') + '" data-mood="' + esc(m) + '" role="radio" aria-checked="' + (m === current) + '" title="' + esc(m) + '">' +
        esc(MOOD_EMOJI[m] || '•') + '<small>' + esc(m) + '</small></button>';
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
    if (!data.title && !data.content) throw new Error('Please write a title or some text first.');
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
    document.getElementById('entryTitle').value = d.title === 'Untitled entry' ? '' : (d.title || '');
    setBody(d.content || '');
    document.getElementById('entryMood').value = d.mood || '';
    document.getElementById('entryTags').value = (d.tags || []).join(', ');
    renderMoodPicker();
    var note = document.getElementById('draftNote');
    if (note) note.classList.remove('hidden');
    var discard = document.getElementById('discardDraftBtn');
    if (discard) discard.classList.remove('hidden');
    return true;
  }

  async function saveCurrent() {
    var data = readForm();
    if (!data.title && !data.content.trim()) throw new Error('Please write a title or some text first.');
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
    if (!file) return;
    var kind = file.type.indexOf('audio/') === 0 ? 'audio' : 'photo';
    try { await window.MyDimensionMedia.uploadFile(file, kind, '', entryId); }
    catch (err) { window.MyDimensionApp.toast('Entry saved, but the attachment failed: ' + err.message); }
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
    todayLocal: todayLocal, fmtDate: fmtDate, fmtTime: fmtTime, relTime: relTime, esc: esc,
    entryDate: entryDate, coverClass: coverClass,
    loadEntries: loadEntries, getCached: getCached, findCached: findCached,
    sortedEntries: sortedEntries, renderList: renderList, refreshJournalList: refreshJournalList,
    saveCurrent: saveCurrent, fillForm: fillForm, resetForm: resetForm,
    startNew: startNew, getEditingId: function () { return editingId; },
    renderMoodPicker: renderMoodPicker, saveDraft: saveDraft, clearDraft: clearDraft,
    restoreDraftIfAny: restoreDraftIfAny, readForm: readForm, setBody: setBody
  };
})();
