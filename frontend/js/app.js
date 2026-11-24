/* MyDimension — js/app.js
 * App shell: hash routing, dashboard, calendar, mood insights, settings,
 * shared confirm modal + toast. Screens are sections in index.html (SPA);
 * routes: #/dashboard, #/journal, #/calendar, #/insights, #/voice,
 *          #/photo, #/ai, #/settings
 */
(function () {
  'use strict';

  var ROUTES = ['dashboard', 'journal', 'calendar', 'insights', 'voice', 'photo', 'ai', 'settings'];
  var calCursor = new Date(); calCursor.setDate(1);
  var selectedDay = null;

  /* ---------- helpers ---------- */
  function toast(msg) {
    var old = document.querySelector('.toast'); if (old) old.remove();
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 4000);
  }
  function showError(msg) { toast(msg); var el = document.getElementById('globalError'); if (el) { el.textContent = msg; el.classList.remove('hidden'); } }
  function hideError() { var el = document.getElementById('globalError'); if (el) el.classList.add('hidden'); }

  // Accessible confirm modal. `onYes` runs only after the user confirms.
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      var back = document.createElement('div'); back.className = 'modal-backdrop';
      back.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' +
        '<h3 id="modalTitle">' + window.MyDimensionJournal.esc(opts.title) + '</h3>' +
        '<p>' + window.MyDimensionJournal.esc(opts.text) + '</p>' +
        (opts.strong ? '<div class="field"><label for="modalConfirmText">Type DELETE to confirm</label><input id="modalConfirmText" autocomplete="off" placeholder="DELETE"></div>' : '') +
        '<div class="modal-actions"><button class="btn ghost" data-modal-no>Cancel</button>' +
        '<button class="btn danger" data-modal-yes>' + window.MyDimensionJournal.esc(opts.yes || 'Delete') + '</button></div></div>';
      document.body.appendChild(back);
      var yesBtn = back.querySelector('[data-modal-yes]');
      if (opts.strong) {
        yesBtn.disabled = true;
        back.querySelector('#modalConfirmText').addEventListener('input', function (e) { yesBtn.disabled = e.target.value.trim() !== 'DELETE'; });
      }
      back.querySelector('[data-modal-no]').addEventListener('click', function () { back.remove(); resolve(false); });
      yesBtn.addEventListener('click', function () { back.remove(); resolve(true); });
      back.addEventListener('click', function (e) { if (e.target === back) { back.remove(); resolve(false); } });
      (opts.strong ? back.querySelector('#modalConfirmText') : yesBtn).focus();
    });
  }

  /* ---------- routing ---------- */
  function currentRoute() {
    var r = (window.location.hash || '#/dashboard').replace('#/', '');
    return ROUTES.indexOf(r) >= 0 ? r : 'dashboard';
  }
  function showRoute(route) {
    document.querySelectorAll('.page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + route); });
    document.querySelectorAll('[data-route-link]').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('href') === '#/' + route);
    });
    document.getElementById('sidebar').classList.remove('open');
    var loaders = { dashboard: loadDashboard, journal: loadJournalPage, calendar: loadCalendarPage, insights: loadInsights, voice: loadVoicePage, photo: loadPhotoPage, ai: loadAiPage, settings: loadSettings };
    if (loaders[route]) loaders[route]().catch(function (err) { showError(err.message || err); });
    window.scrollTo(0, 0);
  }

  /* ---------- dashboard ---------- */
  function greeting() {
    var h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }
  var PROMPTS = [
    'What made today feel like yours?',
    'What is one small thing you are grateful for today?',
    'What would you like to remember about today in a year?',
    'What did you learn about yourself today?'
  ];
  async function loadDashboard() {
    hideError();
    var user = window.MyDimensionAuth.getUser();
    var nameEl = document.getElementById('greetingName');
    if (nameEl) nameEl.textContent = (user && user.name ? user.name : 'there');
    document.getElementById('greetingLine').textContent = greeting() + ',';
    document.getElementById('todayPrompt').textContent = PROMPTS[new Date().getDate() % PROMPTS.length];
    document.getElementById('todayDateLine').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    var entries = await window.MyDimensionJournal.loadEntries({});
    document.getElementById('entryCount').textContent = entries.length;
    var thisMonth = entries.filter(function (e) { return e.date && e.date.slice(0, 7) === window.MyDimensionJournal.todayLocal().slice(0, 7); }).length;
    document.getElementById('monthCount').textContent = thisMonth;
    var moods = new Set(entries.map(function (e) { return e.mood; }).filter(Boolean));
    document.getElementById('moodCount').textContent = moods.size;
    var recent = entries.slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); }).slice(0, 5);
    window.MyDimensionJournal.renderList(document.getElementById('recentEntries'), recent);
    renderMiniCalendar(entries);
    renderRecentActivity(entries);
  }
  function renderRecentActivity(entries) {
    var box = document.getElementById('recentActivity');
    if (!box) return;
    var recent = entries.slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); }).slice(0, 4);
    box.innerHTML = recent.length ? recent.map(function (e) {
      return '<p class="small">✎ ' + window.MyDimensionJournal.esc(e.title) + ' <span class="muted">· ' + window.MyDimensionJournal.esc(window.MyDimensionJournal.fmtDate(e.date)) + '</span></p>';
    }).join('') : '<p class="small muted">No activity yet.</p>';
  }

  /* ---------- calendar (shared by dashboard mini-calendar + Calendar page) ---------- */
  function entryDaysMap(entries) {
    var map = {};
    entries.forEach(function (e) { if (e.date) map[e.date] = (map[e.date] || 0) + 1; });
    return map;
  }
  function renderCalendarInto(container, year, month /* 0-based */, daysMap, onPick) {
    var first = new Date(year, month, 1);
    var startDow = first.getDay(); // Sunday-first
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var today = window.MyDimensionJournal.todayLocal();
    var html = '<div class="cal-grid">' +
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(function (d) { return '<div class="dow">' + d + '</div>'; }).join('');
    for (var i = 0; i < startDow; i++) html += '<div class="cal-day blank"></div>';
    for (var d = 1; d <= daysInMonth; d++) {
      var iso = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      var cls = 'cal-day' + (iso === today ? ' today' : '') + (daysMap[iso] ? ' has-entry' : '') + (iso === selectedDay ? ' selected' : '');
      html += '<button type="button" class="' + cls + '" data-cal-day="' + iso + '">' + d + '</button>';
    }
    html += '</div>';
    container.innerHTML = html;
    container.querySelectorAll('[data-cal-day]').forEach(function (btn) {
      btn.addEventListener('click', function () { onPick(btn.getAttribute('data-cal-day')); });
    });
  }
  function renderMiniCalendar(entries) {
    var box = document.getElementById('miniCalendar');
    if (!box) return;
    var now = new Date();
    document.getElementById('miniCalLabel').textContent = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    renderCalendarInto(box, now.getFullYear(), now.getMonth(), entryDaysMap(entries), function (iso) {
      selectedDay = iso; window.location.hash = '#/calendar';
    });
  }
  async function loadCalendarPage() {
    hideError();
    var year = calCursor.getFullYear(), month = calCursor.getMonth();
    document.getElementById('calLabel').textContent = calCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    var entries = await window.MyDimensionJournal.loadEntries({});
    // Prefer the backend calendar endpoint for entry-day marks; fall back to the entry list.
    var daysMap = entryDaysMap(entries);
    try {
      var cal = await window.MyDimensionApi.getCalendar(year, month + 1);
      if (cal && cal.days && typeof cal.days === 'object') daysMap = cal.days;
      else if (Array.isArray(cal)) { daysMap = {}; cal.forEach(function (d) { daysMap[(d.date || d.day || '').slice(0, 10)] = d.count || 1; }); }
    } catch (e) { /* offline calendar marks: entry list already covers it */ }
    var pickDay = function (iso) {
      selectedDay = iso;
      renderCalendarInto(document.getElementById('bigCalendar'), year, month, daysMap, pickDay);
      showDayEntries(iso);
    };
    renderCalendarInto(document.getElementById('bigCalendar'), year, month, daysMap, pickDay);
    if (selectedDay) showDayEntries(selectedDay);
    else document.getElementById('dayEntries').innerHTML = '<p class="muted">Choose a day to see its entries, or write one for that day.</p>';
  }
  function showDayEntries(iso) {
    var box = document.getElementById('dayEntries');
    document.getElementById('selectedDayLabel').textContent = window.MyDimensionJournal.fmtDate(iso);
    var list = window.MyDimensionJournal.getCached().filter(function (e) { return e.date === iso; });
    window.MyDimensionJournal.renderList(box, list);
    var btn = document.getElementById('newEntryForDayBtn');
    btn.classList.remove('hidden');
    btn.onclick = function () { window.MyDimensionJournal.startNew(iso); };
  }

  /* ---------- other pages ---------- */
  async function loadJournalPage() {
    hideError();
    var sel = document.getElementById('journalMoodFilter');
    if (!sel.options.length || sel.options.length === 1) {
      window.MyDimensionJournal.MOODS.forEach(function (m) { var o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
    }
    if (!document.getElementById('entryDate').value) document.getElementById('entryDate').value = window.MyDimensionJournal.todayLocal();
    await window.MyDimensionJournal.refreshJournalList();
  }
  async function loadInsights() {
    hideError();
    var box = document.getElementById('moodChart');
    var counts = {};
    try {
      var data = await window.MyDimensionApi.getMoodInsights({});
      var src = data.counts || data.moods || data;
      if (Array.isArray(src)) src.forEach(function (r) { counts[r.mood || r.label] = r.count || r.total || 0; });
      else if (src && typeof src === 'object') Object.keys(src).forEach(function (k) { counts[k] = src[k]; });
    } catch (e) { /* fall through to entry-derived counts */ }
    if (!Object.keys(counts).length) {
      var entries = window.MyDimensionJournal.getCached().length ? window.MyDimensionJournal.getCached() : await window.MyDimensionJournal.loadEntries({});
      entries.forEach(function (e) { if (e.mood) counts[e.mood] = (counts[e.mood] || 0) + 1; });
    }
    var total = Object.values(counts).reduce(function (a, b) { return a + b; }, 0);
    document.getElementById('insightsTotal').textContent = total + (total === 1 ? ' mood-tagged entry' : ' mood-tagged entries');
    if (!total) { box.innerHTML = '<div class="empty"><p>No mood data yet.</p><p class="small">Add a mood when you write an entry, and your insights will appear here.</p></div>'; return; }
    var max = Math.max.apply(null, Object.values(counts));
    box.innerHTML = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).map(function (mood, i) {
      var pct = Math.round(counts[mood] / max * 100);
      return '<div class="bar-row"><span>' + window.MyDimensionJournal.esc(mood) + '</span>' +
        '<div class="bar-track"><div class="bar-fill' + (i % 2 ? ' lav' : '') + '" style="width:' + pct + '%"></div></div>' +
        '<strong>' + counts[mood] + '</strong></div>';
    }).join('') + '<p class="small muted">Counts of entries by mood. AI mood suggestions are suggestions only — they are not facts or diagnoses.</p>';
  }
  async function loadVoicePage() { hideError(); await window.MyDimensionMedia.refreshVoiceList().catch(function (e) { showError(e.message); }); }
  async function loadPhotoPage() { hideError(); await window.MyDimensionMedia.refreshPhotoList().catch(function (e) { showError(e.message); }); }
  async function loadAiPage() {
    hideError();
    if (!window.MyDimensionJournal.getCached().length) { try { await window.MyDimensionJournal.loadEntries({}); } catch (e) { /* entry list is optional here */ } }
    window.MyDimensionAI.populateEntrySelect();
  }
  async function loadSettings() {
    hideError();
    var user = window.MyDimensionAuth.getUser();
    if (user) { /* profile + status already rendered by auth.js; re-check in case status changed */ }
  }

  async function exportData() {
    try {
      var entries = await window.MyDimensionJournal.loadEntries({});
      var blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), entries: entries }, null, 2)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'mydimension-export-' + window.MyDimensionJournal.todayLocal() + '.json'; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast('Export downloaded.');
    } catch (err) { showError(err.message || err); }
  }

  /* ---------- events (delegated, so dynamically rendered buttons work) ---------- */
  function bindEvents() {
    document.getElementById('loginBtn').addEventListener('click', window.MyDimensionAuth.login);
    document.getElementById('logoutBtn').addEventListener('click', window.MyDimensionAuth.logout);
    document.getElementById('logoutBtn2').addEventListener('click', window.MyDimensionAuth.logout);
    document.getElementById('menuBtn').addEventListener('click', function () { document.getElementById('sidebar').classList.toggle('open'); });
    document.getElementById('exportBtn').addEventListener('click', exportData);

    document.getElementById('dashboardSearch').addEventListener('input', function (e) {
      var q = e.target.value.toLowerCase();
      var entries = window.MyDimensionJournal.getCached();
      var filtered = q ? entries.filter(function (en) { return (en.title + ' ' + en.body).toLowerCase().includes(q); }) : entries.slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); }).slice(0, 5);
      window.MyDimensionJournal.renderList(document.getElementById('recentEntries'), filtered);
    });

    document.getElementById('entryForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      try { await window.MyDimensionJournal.saveCurrent(); toast('Entry saved.'); loadDashboard().catch(function () {}); }
      catch (err) { showError(err.message || err); }
    });
    document.getElementById('cancelEditBtn').addEventListener('click', function () { window.MyDimensionJournal.resetForm(); });
    ['journalSearch', 'journalMoodFilter', 'journalDateFilter'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', function () { window.MyDimensionJournal.refreshJournalList().catch(function (err) { showError(err.message); }); });
    });
    document.getElementById('clearJournalFilters').addEventListener('click', function () {
      document.getElementById('journalSearch').value = ''; document.getElementById('journalMoodFilter').value = ''; document.getElementById('journalDateFilter').value = '';
      window.MyDimensionJournal.refreshJournalList();
    });

    document.getElementById('prevMonthBtn').addEventListener('click', function () { calCursor.setMonth(calCursor.getMonth() - 1); loadCalendarPage(); });
    document.getElementById('nextMonthBtn').addEventListener('click', function () { calCursor.setMonth(calCursor.getMonth() + 1); loadCalendarPage(); });
    document.getElementById('todayMonthBtn').addEventListener('click', function () { calCursor = new Date(); calCursor.setDate(1); selectedDay = window.MyDimensionJournal.todayLocal(); loadCalendarPage(); });

    document.getElementById('startRecBtn').addEventListener('click', async function () { try { await window.MyDimensionMedia.startRecording(); } catch (err) { showError(err.message); } });
    document.getElementById('stopRecBtn').addEventListener('click', function () { window.MyDimensionMedia.stopRecording(); });
    document.getElementById('discardRecBtn').addEventListener('click', function () { window.MyDimensionMedia.discardRecording(); });
    document.getElementById('saveRecBtn').addEventListener('click', async function () { try { await window.MyDimensionMedia.saveRecording(); toast('Voice memory saved.'); } catch (err) { showError(err.message); } });
    document.getElementById('voiceUpload').addEventListener('change', async function (e) {
      var f = e.target.files[0]; if (!f) return;
      try { await window.MyDimensionMedia.uploadFile(f, 'voice', ''); toast('Audio uploaded.'); await loadVoicePage(); } catch (err) { showError(err.message); }
      e.target.value = '';
    });
    document.getElementById('photoUpload').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var img = document.getElementById('photoPreview');
      img.src = URL.createObjectURL(f); img.classList.remove('hidden');
    });
    document.getElementById('photoForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var f = document.getElementById('photoUpload').files[0];
      if (!f) { showError('Choose a photo first.'); return; }
      try {
        await window.MyDimensionMedia.uploadFile(f, 'photo', document.getElementById('photoCaption').value.trim());
        toast('Photo saved.'); e.target.reset(); document.getElementById('photoPreview').classList.add('hidden');
        await loadPhotoPage();
      } catch (err) { showError(err.message); }
    });
    document.getElementById('clearDataBtn').addEventListener('click', async function () {
      var ok = await confirmDialog({ title: 'Delete all diary data?', text: 'This permanently deletes all of your diary entries. Photos and voice memories are deleted separately from their own pages. This cannot be undone.', yes: 'Delete all entries', strong: true });
      if (!ok) return;
      try {
        var entries = await window.MyDimensionJournal.loadEntries({});
        for (var i = 0; i < entries.length; i++) { await window.MyDimensionApi.deleteEntry(entries[i].id); }
        toast('All entries deleted.'); loadDashboard();
      } catch (err) { showError(err.message || err); }
    });

    // Delegated clicks for dynamically rendered lists.
    document.addEventListener('click', async function (e) {
      var t = e.target.closest('[data-edit-entry],[data-delete-entry],[data-ai-entry],[data-delete-media],[data-transcribe-media],[data-goto-new-entry]');
      if (!t) return;
      if (t.hasAttribute('data-goto-new-entry')) { window.MyDimensionJournal.startNew(); return; }
      if (t.hasAttribute('data-edit-entry')) {
        var entry = window.MyDimensionJournal.findCached(t.getAttribute('data-edit-entry'));
        if (entry) { window.location.hash = '#/journal'; window.MyDimensionJournal.fillForm(entry); }
        return;
      }
      if (t.hasAttribute('data-delete-entry')) {
        var title = t.getAttribute('data-entry-title') || 'this entry';
        var ok = await confirmDialog({ title: 'Delete this entry?', text: '“' + title + '” will be permanently deleted. This cannot be undone.', yes: 'Delete entry' });
        if (!ok) return;
        try { await window.MyDimensionApi.deleteEntry(t.getAttribute('data-delete-entry')); toast('Entry deleted.'); await window.MyDimensionJournal.refreshJournalList(); loadDashboard().catch(function () {}); }
        catch (err) { showError(err.message); }
        return;
      }
      if (t.hasAttribute('data-ai-entry')) {
        window.location.hash = '#/ai';
        setTimeout(function () { var sel = document.getElementById('aiEntrySelect'); sel.value = t.getAttribute('data-ai-entry'); }, 100);
        return;
      }
      if (t.hasAttribute('data-delete-media')) {
        var name = t.getAttribute('data-media-name') || 'this file';
        var okM = await confirmDialog({ title: 'Delete this file?', text: '“' + name + '” will be permanently deleted from your Drive storage. This cannot be undone.', yes: 'Delete file' });
        if (!okM) return;
        try { await window.MyDimensionApi.deleteMedia(t.getAttribute('data-delete-media')); toast('File deleted.'); if (currentRoute() === 'voice') loadVoicePage(); else loadPhotoPage(); }
        catch (err) { showError(err.message); }
        return;
      }
      if (t.hasAttribute('data-transcribe-media')) {
        var id = t.getAttribute('data-transcribe-media');
        var out = document.querySelector('[data-transcript-for="' + id + '"]');
        if (out) out.textContent = 'Transcribing…';
        try {
          // Transcription needs the audio file; fetch it back through the API and re-send it.
          var res = await fetch(window.MyDimensionApi.getMediaUrl(id), { credentials: 'include' });
          if (!res.ok) throw new Error('Could not load that recording. Please try again.');
          var blob = await res.blob();
          var fd = new FormData(); fd.append('file', blob, 'voice-memory.webm');
          var tr = await window.MyDimensionApi.aiTranscribe(fd);
          var text = tr.transcript || tr.transcription || tr.text || tr.result || '';
          if (out) out.innerHTML = text ? '<strong>Transcript:</strong> ' + window.MyDimensionJournal.esc(text) : 'No transcript returned.';
        } catch (err) { if (out) out.textContent = 'Transcription failed: ' + err.message; }
      }
    });

    document.querySelectorAll('[data-ai-action]').forEach(function (btn) {
      btn.addEventListener('click', function () { window.MyDimensionAI.run(btn.getAttribute('data-ai-action')); });
    });
    document.querySelectorAll('[data-quick]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-quick');
        if (kind === 'note') window.MyDimensionJournal.startNew();
        else window.location.hash = kind === 'voice' ? '#/voice' : '#/photo';
      });
    });
    window.addEventListener('hashchange', function () { showRoute(currentRoute()); });
  }

  /* ---------- init ---------- */
  async function init() {
    // Mood select options for the entry form.
    var moodSel = document.getElementById('entryMood');
    window.MyDimensionJournal.MOODS.forEach(function (m) { var o = document.createElement('option'); o.value = m; o.textContent = m; moodSel.appendChild(o); });
    bindEvents();
    var user = await window.MyDimensionAuth.checkAuth();
    if (user) showRoute(currentRoute());
    if ('serviceWorker' in navigator) {
      // PWA shell only; the worker never caches API responses, media or tokens.
      navigator.serviceWorker.register('service-worker.js').catch(function () { /* PWA is optional; the app works without it */ });
    }
  }

  window.MyDimensionApp = { toast: toast, showError: showError, confirmDialog: confirmDialog, showRoute: showRoute };
  document.addEventListener('DOMContentLoaded', init);
})();
