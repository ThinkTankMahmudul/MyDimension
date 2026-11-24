/* MyDimension — js/journal.js
 * Diary entries: create / read / update / delete, search and filters.
 * No fake entries: an empty list renders an empty state with a CTA.
 * Dates are local (YYYY-MM-DD) so the calendar matches the owner's timezone.
 */
(function () {
  'use strict';

  var MOODS = ['Happy', 'Calm', 'Grateful', 'Excited', 'Tired', 'Sad', 'Anxious', 'Angry', 'Stressed', 'Thoughtful'];
  var entriesCache = [];
  var editingId = null;

  function todayLocal() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Normalise backend shapes: { entries: [...] } or a bare array; fields may be
  // title/body/content, entry_date/date, mood, tags (array or comma string).
  function normalise(list) {
    var arr = Array.isArray(list) ? list : (list && Array.isArray(list.entries) ? list.entries : []);
    return arr.map(function (e) {
      return {
        id: e.id, title: e.title || 'Untitled entry',
        body: e.body || e.content || '',
        date: (e.entry_date || e.date || '').slice(0, 10),
        mood: e.mood || '', tags: Array.isArray(e.tags) ? e.tags : (e.tags ? String(e.tags).split(',').map(function (t) { return t.trim(); }).filter(Boolean) : []),
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

  function entryCard(e) {
    var excerpt = e.body.length > 180 ? e.body.slice(0, 180) + '…' : e.body;
    return '<article class="entry"><h4>' + esc(e.title) + '</h4>' +
      '<div class="entry-meta">' + esc(fmtDate(e.date)) +
      (e.mood ? ' · <span class="mood-pill">' + esc(e.mood) + '</span>' : '') +
      e.tags.map(function (t) { return ' <span class="tag-pill">' + esc(t) + '</span>'; }).join('') + '</div>' +
      '<p>' + esc(excerpt) + '</p>' +
      '<div class="entry-actions">' +
      '<button class="btn small secondary" data-edit-entry="' + esc(e.id) + '">Edit</button>' +
      '<button class="btn small ghost" data-delete-entry="' + esc(e.id) + '" data-entry-title="' + esc(e.title) + '">Delete</button>' +
      '<button class="btn small ghost" data-ai-entry="' + esc(e.id) + '">AI reflection</button>' +
      '</div></article>';
  }

  function renderList(container, list) {
    if (!container) return;
    if (!list.length) {
      container.innerHTML = '<div class="empty"><p>No entries yet.</p>' +
        '<button class="btn" data-goto-new-entry>Write your first memory</button></div>';
      return;
    }
    container.innerHTML = list.map(entryCard).join('');
  }

  function readForm() {
    return {
      title: document.getElementById('entryTitle').value.trim(),
      body: document.getElementById('entryBody').value,
      entry_date: document.getElementById('entryDate').value || todayLocal(),
      mood: document.getElementById('entryMood').value || null,
      tags: document.getElementById('entryTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
    };
  }

  function fillForm(e) {
    document.getElementById('entryTitle').value = e.title || '';
    document.getElementById('entryBody').value = e.body || '';
    document.getElementById('entryDate').value = e.date || todayLocal();
    document.getElementById('entryMood').value = e.mood || '';
    document.getElementById('entryTags').value = (e.tags || []).join(', ');
    document.getElementById('entryFormTitle').textContent = 'Edit entry';
    document.getElementById('cancelEditBtn').classList.remove('hidden');
    editingId = e.id;
    document.getElementById('entryFormCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('entryTitle').focus();
  }

  function resetForm(presetDate) {
    editingId = null;
    document.getElementById('entryForm').reset();
    document.getElementById('entryDate').value = presetDate || todayLocal();
    document.getElementById('entryFormTitle').textContent = 'New entry';
    document.getElementById('cancelEditBtn').classList.add('hidden');
  }

  async function saveCurrent() {
    var data = readForm();
    if (!data.title && !data.body.trim()) throw new Error('Please write a title or some text first.');
    if (editingId) await window.MyDimensionApi.updateEntry(editingId, data);
    else await window.MyDimensionApi.createEntry(data);
    resetForm();
    await refreshJournalList();
    return true;
  }

  async function refreshJournalList() {
    var q = (document.getElementById('journalSearch') || {}).value || '';
    var mood = (document.getElementById('journalMoodFilter') || {}).value || '';
    var date = (document.getElementById('journalDateFilter') || {}).value || '';
    var params = {};
    if (q) params.q = q; if (q) params.search = q; // backend may use either; harmless if ignored
    if (mood) params.mood = mood;
    if (date) params.date = date;
    var list = await loadEntries(params);
    // Client-side filter as a safety net if the backend ignores a param.
    list = list.filter(function (e) {
      if (mood && e.mood !== mood) return false;
      if (date && e.date !== date) return false;
      if (q) { var hay = (e.title + ' ' + e.body).toLowerCase(); if (!hay.includes(q.toLowerCase())) return false; }
      return true;
    });
    renderList(document.getElementById('journalList'), list);
    return list;
  }

  function startNew(presetDate) {
    resetForm(presetDate);
    window.location.hash = '#/journal';
    setTimeout(function () { document.getElementById('entryTitle').focus(); }, 50);
  }

  window.MyDimensionJournal = {
    MOODS: MOODS, todayLocal: todayLocal, fmtDate: fmtDate, esc: esc,
    loadEntries: loadEntries, getCached: getCached, findCached: findCached,
    renderList: renderList, refreshJournalList: refreshJournalList,
    saveCurrent: saveCurrent, fillForm: fillForm, resetForm: resetForm,
    startNew: startNew, getEditingId: function () { return editingId; }
  };
})();
