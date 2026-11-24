/* MyDimension — js/app.js
 * App shell: hash routing, dashboard, calendar, mood insights, settings,
 * shared confirm modal + toast. Screens are sections in index.html (SPA);
 * routes: #/dashboard, #/journal, #/entry/<id>, #/ai, #/media,
 *          #/calendar, #/insights, #/settings
 * Mood math is always from real API data — no hard-coded 82%/128 numbers.
 * Calendars are Monday-first, as on the design board.
 */
(function () {
  'use strict';

  // i18n: t() reads the live language; loc() is the date locale for it.
  function t(key, vars) { return window.MyDimensionI18n ? window.MyDimensionI18n.t(key, vars) : key; }
  function loc() { return window.MyDimensionI18n ? window.MyDimensionI18n.locale() : undefined; }

  var ROUTES = ['dashboard', 'journal', 'entry', 'ai', 'media', 'calendar', 'insights', 'settings'];
  var calCursor = new Date(); calCursor.setDate(1);
  var miniCursor = new Date(); miniCursor.setDate(1);
  var selectedDay = null;
  var mediaTab = 'all';
  var entryRec = { recorder: null, chunks: [], timer: null, blob: null };

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
        (opts.strong ? '<div class="field"><label for="modalConfirmText">' + t('confirm.typeDelete') + '</label><input id="modalConfirmText" autocomplete="off" placeholder="DELETE"></div>' : '') +
        '<div class="modal-actions"><button class="btn ghost" data-modal-no>' + t('confirm.cancel') + '</button>' +
        '<button class="btn danger" data-modal-yes>' + window.MyDimensionJournal.esc(opts.yes || t('confirm.delete')) + '</button></div></div>';
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
  function parseRoute() {
    var hash = (window.location.hash || '#/dashboard').replace('#/', '');
    var parts = hash.split('/');
    var route = ROUTES.indexOf(parts[0]) >= 0 ? parts[0] : 'dashboard';
    return { route: route, param: parts[1] || null };
  }
  function showRoute() {
    var parsed = parseRoute();
    var route = parsed.route;
    document.querySelectorAll('.page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + route); });
    document.querySelectorAll('[data-route-link]').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      a.classList.toggle('active', href === '#/' + route || (route === 'entry' && href === '#/journal'));
    });
    document.getElementById('sidebar').classList.remove('open');
    var loaders = { dashboard: loadDashboard, journal: loadJournalPage, entry: function () { return loadEntryDetail(parsed.param); }, ai: loadAiPage, media: loadMediaPage, calendar: loadCalendarPage, insights: loadInsights, settings: loadSettings };
    if (loaders[route]) loaders[route]().catch(function (err) { showError(err.message || err); });
    window.scrollTo(0, 0);
  }

  /* ---------- mood math (real data only) ---------- */
  function moodGroups(entries) {
    var total = 0, positive = 0, neutral = 0, challenging = 0;
    var counts = {};
    entries.forEach(function (e) {
      if (!e.mood) return;
      total++;
      counts[e.mood] = (counts[e.mood] || 0) + 1;
      if (window.MyDimensionJournal.POSITIVE_MOODS.indexOf(e.mood) >= 0) positive++;
      else if (e.mood === 'Tired' || e.mood === 'Thoughtful') neutral++;
      else challenging++;
    });
    function pct(n) { return total ? Math.round(n / total * 100) : 0; }
    return { total: total, positive: positive, neutral: neutral, challenging: challenging,
      pctPositive: pct(positive), pctNeutral: pct(neutral), pctChallenging: pct(challenging), counts: counts };
  }
  // SVG donut: positive share of mood-tagged entries. Empty state when no mood data.
  function donutHtml(groups, size) {
    size = size || 180;
    if (!groups.total) {
      return '<div class="empty"><p>' + t('dash.noMood') + '</p><p class="small">' + t('dash.noMoodHint') + '</p></div>';
    }
    var r = (size / 2) - 14, c = 2 * Math.PI * r, cx = size / 2, cy = size / 2;
    var segs = [
      { value: groups.positive, color: '#14B8A6' },
      { value: groups.neutral, color: '#AFA0E8' },
      { value: groups.challenging, color: '#245C49' }
    ];
    var offset = 0, circles = '';
    segs.forEach(function (s) {
      if (!s.value) return;
      var len = c * s.value / groups.total;
      // Start invisible (dasharray 0); animateDonuts() draws each segment
      // to its final length once the SVG is in the DOM.
      circles += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + s.color + '" stroke-width="18" style="stroke-dasharray:0 ' + c + ';stroke-dashoffset:0" data-dash="' + len + ' ' + (c - len) + '" data-off="' + (-offset) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>';
      offset += len;
    });
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="Mood overview">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#EDE9FE" stroke-width="18"/>' + circles +
      '<text x="50%" y="47%" text-anchor="middle" font-size="30" font-weight="700" fill="#0F766E" font-family="Poppins, sans-serif">' + groups.pctPositive + '%</text>' +
      '<text x="50%" y="60%" text-anchor="middle" font-size="11" fill="#87918D">' + t('dash.positive') + '</text></svg>';
  }
  // Draw the donut segments: set each segment to its final dash length on
  // the next frame so the CSS transition on stroke-dasharray animates it.
  // With prefers-reduced-motion the transition is ~0ms, so it just appears.
  function animateDonuts(root) {
    if (!root) return;
    var circles = root.querySelectorAll('circle[data-dash]');
    if (!circles.length) return;
    function draw() {
      circles.forEach(function (ci) {
        ci.style.strokeDasharray = ci.getAttribute('data-dash');
        ci.style.strokeDashoffset = ci.getAttribute('data-off');
      });
    }
    if (window.requestAnimationFrame) requestAnimationFrame(function () { requestAnimationFrame(draw); });
    else draw();
  }
  function legendHtml(groups) {
    if (!groups.total) return '';
    var rows = [
      [t('dash.legendPositive'), groups.positive, groups.pctPositive, '#14B8A6'],
      [t('dash.legendNeutral'), groups.neutral, groups.pctNeutral, '#AFA0E8'],
      [t('dash.legendChallenging'), groups.challenging, groups.pctChallenging, '#245C49']
    ];
    return rows.map(function (r) {
      return '<div class="legend-row"><span><span class="dot" style="background:' + r[3] + '"></span>' + r[0] + '</span><strong>' + r[2] + '% · ' + r[1] + '</strong></div>';
    }).join('') + '<div class="legend-row"><span>' + t('dash.allJournals') + '</span><strong>' + groups.total + ' ' + t('dash.moodTagged') + '</strong></div>';
  }

  /* ---------- dashboard ---------- */
  async function loadDashboard() {
    hideError();
    var entries = await window.MyDimensionJournal.loadEntries({});
    var sorted = window.MyDimensionJournal.sortedEntries(entries);
    var today = window.MyDimensionJournal.todayLocal();
    var thisMonth = entries.filter(function (e) { return e.date && e.date.slice(0, 7) === today.slice(0, 7); }).length;
    document.getElementById('statTotal').textContent = entries.length;
    document.getElementById('statMonth').textContent = thisMonth;
    try {
      var media = await window.MyDimensionMedia.loadAllMedia();
      document.getElementById('statMedia').textContent = media.length;
    } catch (e) { document.getElementById('statMedia').textContent = '—'; }

    // My Journals: 3 most recent entries as cover cards (CSS gradients, no external images).
    var cards = document.getElementById('journalCards');
    if (!sorted.length) {
      cards.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>' + t('dash.noJournals') + '</p><button class="btn" data-goto-new-entry>' + t('dash.writeFirst') + '</button></div>';
    } else {
      cards.innerHTML = sorted.slice(0, 3).map(function (e, i) {
        return '<button type="button" class="journal-cover ' + window.MyDimensionJournal.coverClass(e, i) + '" data-open-entry="' + window.MyDimensionJournal.esc(e.id) + '">' +
          '<span class="cover-badge" aria-hidden="true">' + (window.MyDimensionJournal.MOOD_EMOJI[e.mood] || '✎') + '</span>' +
          '<span class="cover-art" aria-hidden="true"><img class="cover-img" src="' + window.MyDimensionJournal.coverArt(i) + '" alt="' + window.MyDimensionJournal.esc(window.MyDimensionJournal.coverArtAlt(i)) + '" loading="lazy"></span>' +
          '<span class="cover-body"><span class="cover-title">' + window.MyDimensionJournal.esc(e.title) + '</span>' +
          '<span class="cover-meta">' + t('dash.createdAt') + ' ' + window.MyDimensionJournal.esc(window.MyDimensionJournal.fmtDate(e.date)) + '</span></span></button>';
      }).join('');
    }

    // Recent entries + mood donut (real data).
    window.MyDimensionJournal.renderList(document.getElementById('recentEntries'), sorted.slice(0, 5));
    var groups = moodGroups(entries);
    document.getElementById('moodDonut').innerHTML = donutHtml(groups);
    animateDonuts(document.getElementById('moodDonut'));
    document.getElementById('moodLegend').innerHTML = legendHtml(groups);

    renderMiniCalendar(entries);
    renderTodayActivity(entries);
  }

  function renderTodayActivity(entries) {
    var box = document.getElementById('todayActivity');
    var badge = document.getElementById('bellBadge');
    if (!box) return;
    var today = window.MyDimensionJournal.todayLocal();
    var todays = window.MyDimensionJournal.sortedEntries(entries).filter(function (e) { return e.date === today; });
    if (badge) {
      badge.textContent = todays.length;
      badge.classList.toggle('hidden', !todays.length);
    }
    if (!todays.length) {
      box.innerHTML = '<div class="activity-empty"><span class="activity-empty-ico" aria-hidden="true">🌙</span><p class="small muted">' + t('dash.nothingToday') + '</p></div>';
    } else {
      box.innerHTML = todays.map(function (e) {
        return '<div class="activity-item"><span class="activity-ico" aria-hidden="true">' + (window.MyDimensionJournal.MOOD_EMOJI[e.mood] || '📖') + '</span>' +
          '<div><p><strong>' + window.MyDimensionJournal.esc(e.title) + '</strong></p>' +
          '<p class="small muted">' + t('dash.newEntryActivity') + ' · ' + window.MyDimensionJournal.esc(window.MyDimensionJournal.relTime(e.created_at)) + '</p></div></div>';
      }).join('');
    }
    var panel = document.getElementById('bellPanel');
    if (panel) panel.innerHTML = '<h4>' + t('bell.today') + '</h4>' + box.innerHTML;
  }

  /* ---------- calendar (Monday-first, as on the design board) ---------- */
  function entryDaysMap(entries) {
    var map = {};
    entries.forEach(function (e) { if (e.date) map[e.date] = (map[e.date] || 0) + 1; });
    return map;
  }
  function renderCalendarInto(container, year, month /* 0-based */, daysMap, onPick) {
    var first = new Date(year, month, 1);
    var startDow = (first.getDay() + 6) % 7; // Monday-first
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var today = window.MyDimensionJournal.todayLocal();
    var dowFmt = new Intl.DateTimeFormat(loc() || 'en-US', { weekday: 'short' });
    var dowBase = new Date(2026, 0, 5); // a Monday — calendars are Monday-first
    var html = '<div class="cal-grid">' +
      [0, 1, 2, 3, 4, 5, 6].map(function (i) { var d = new Date(dowBase); d.setDate(dowBase.getDate() + i); return '<div class="dow">' + dowFmt.format(d) + '</div>'; }).join('');
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
    document.getElementById('miniCalLabel').textContent = miniCursor.toLocaleDateString(loc(), { month: 'long', year: 'numeric' });
    renderCalendarInto(box, miniCursor.getFullYear(), miniCursor.getMonth(), entryDaysMap(entries), function (iso) {
      selectedDay = iso; window.location.hash = '#/calendar';
    });
  }
  async function loadCalendarPage() {
    hideError();
    var year = calCursor.getFullYear(), month = calCursor.getMonth();
    document.getElementById('calLabel').textContent = calCursor.toLocaleDateString(loc(), { month: 'long', year: 'numeric' });
    var entries = await window.MyDimensionJournal.loadEntries({});
    var daysMap = entryDaysMap(entries);
    try {
      // Backend returns [{ date, entry_count, has_entry }] for the month.
      var cal = await window.MyDimensionApi.getCalendar(year, month + 1);
      if (Array.isArray(cal)) {
        daysMap = {};
        cal.forEach(function (d) { if (d.has_entry) daysMap[d.date] = d.entry_count || 1; });
      }
    } catch (e) { /* entry list already covers the marks */ }
    var pickDay = function (iso) {
      selectedDay = iso;
      renderCalendarInto(document.getElementById('bigCalendar'), year, month, daysMap, pickDay);
      showDayEntries(iso);
    };
    renderCalendarInto(document.getElementById('bigCalendar'), year, month, daysMap, pickDay);
    if (selectedDay) showDayEntries(selectedDay);
    else document.getElementById('dayEntries').innerHTML = '<p class="muted">' + t('cal.chooseDay') + '</p>';
  }
  function showDayEntries(iso) {
    var box = document.getElementById('dayEntries');
    document.getElementById('selectedDayLabel').textContent = window.MyDimensionJournal.fmtDate(iso);
    var list = window.MyDimensionJournal.getCached().filter(function (e) { return e.date === iso; });
    window.MyDimensionJournal.renderList(box, window.MyDimensionJournal.sortedEntries(list));
    var btn = document.getElementById('newEntryForDayBtn');
    btn.classList.remove('hidden');
    btn.onclick = function () {
      window.MyDimensionJournal.startNew();
      if (iso !== window.MyDimensionJournal.todayLocal()) {
        toast(t('toast.entryDated'));
      }
    };
  }

  /* ---------- journal page / detail ---------- */
  async function loadJournalPage() {
    hideError();
    var sel = document.getElementById('journalMoodFilter');
    if (sel.options.length <= 1) {
      window.MyDimensionJournal.MOODS.forEach(function (m) { var o = document.createElement('option'); o.value = m; o.textContent = window.MyDimensionI18n ? window.MyDimensionI18n.moodLabel(m) : m; sel.appendChild(o); });
    }
    // First option ("All moods") re-translates on every language switch.
    if (sel.options.length) sel.options[0].textContent = t('journal.allMoods');
    window.MyDimensionJournal.renderMoodPicker();
    window.MyDimensionJournal.restoreDraftIfAny();
    await window.MyDimensionJournal.refreshJournalList();
  }
  async function loadEntryDetail(id) {
    hideError();
    var box = document.getElementById('entryDetail');
    if (!id) { box.innerHTML = '<p class="muted">' + t('entry.noEntry') + '</p>'; return; }
    var entry = window.MyDimensionJournal.findCached(id);
    if (!entry) {
      try { entry = (await window.MyDimensionJournal.loadEntries({})).find(function (e) { return String(e.id) === String(id); }); }
      catch (e) { /* fall through */ }
    }
    if (!entry) { box.innerHTML = '<div class="empty"><p>' + t('entry.notFound') + '</p><a class="btn" href="#/journal">' + t('entry.back') + '</a></div>'; return; }
    var J = window.MyDimensionJournal;
    box.innerHTML =
      '<div class="entry-row"><span class="entry-thumb ' + J.coverClass(entry, 0) + '" aria-hidden="true">' + (J.MOOD_EMOJI[entry.mood] || '✎') + '</span>' +
      '<div class="entry-body"><h3>' + J.esc(entry.title) + '</h3>' +
      '<p class="muted small">' + J.esc(J.fmtDate(entry.date)) + (entry.created_at ? ' · ' + J.esc(J.fmtTime(entry.created_at)) : '') +
      (entry.mood ? ' · <span class="mood-pill">' + J.esc(J.MOOD_EMOJI[entry.mood] || '') + ' ' + J.esc(window.MyDimensionI18n ? window.MyDimensionI18n.moodLabel(entry.mood) : entry.mood) + '</span>' : '') +
      entry.tags.map(function (t) { return ' <span class="tag-pill">' + J.esc(t) + '</span>'; }).join('') + '</p></div></div>' +
      '<div class="detail-content">' + J.esc(entry.body) + '</div>' +
      (entry.summary ? '<h4>' + t('entry.aiSummary') + '</h4><p class="muted">' + J.esc(entry.summary) + '</p>' : '') +
      '<div class="entry-actions">' +
      '<button class="btn secondary" data-edit-entry="' + J.esc(entry.id) + '">' + t('journal.edit') + '</button>' +
      '<button class="btn ghost" data-delete-entry="' + J.esc(entry.id) + '" data-entry-title="' + J.esc(entry.title) + '">' + t('journal.delete') + '</button>' +
      '<button class="btn ghost" data-ai-entry="' + J.esc(entry.id) + '">' + t('journal.aiReflection') + '</button></div>';
    // Media linked to this entry (media rows carry entry_id).
    var mediaBox = document.getElementById('entryDetailMedia');
    try {
      var all = await window.MyDimensionMedia.loadAllMedia();
      var linked = all.filter(function (m) { return String(m.entry_id || '') === String(entry.id); });
      mediaBox.innerHTML = linked.length ? linked.map(function (m) {
        return m.kind === 'audio'
          ? '<div class="voice-item"><strong>' + J.esc(m.caption || m.name) + '</strong><audio class="detail-audio" controls preload="none" src="' + window.MyDimensionApi.getMediaUrl(m.id) + '"></audio></div>'
          : '<figure class="thumb"><img loading="lazy" alt="' + J.esc(m.caption || m.name) + '" src="' + window.MyDimensionApi.getMediaUrl(m.id) + '"><figcaption>' + J.esc(m.caption || m.name) + '</figcaption></figure>';
      }).join('') : '<p class="small muted">' + t('entry.noMedia') + '</p>';
    } catch (e) { mediaBox.innerHTML = '<p class="small muted">' + t('entry.mediaFailed') + '</p>'; }
  }

  /* ---------- insights ---------- */
  async function loadInsights() {
    hideError();
    var entries = window.MyDimensionJournal.getCached().length ? window.MyDimensionJournal.getCached() : await window.MyDimensionJournal.loadEntries({});
    var counts = {};
    try {
      var data = await window.MyDimensionApi.getMoodInsights();
      if (Array.isArray(data)) data.forEach(function (r) { if (r.mood) counts[r.mood] = r.count || 0; });
    } catch (e) { /* fall through to entry-derived counts */ }
    if (!Object.keys(counts).length) {
      entries.forEach(function (e) { if (e.mood) counts[e.mood] = (counts[e.mood] || 0) + 1; });
    }
    var total = Object.values(counts).reduce(function (a, b) { return a + b; }, 0);
    document.getElementById('insightsTotal').textContent = total + ' ' + t(total === 1 ? 'ins.moodTaggedOne' : 'ins.moodTaggedMany');
    var box = document.getElementById('moodChart');
    if (!total) { box.innerHTML = '<div class="empty"><p>' + t('ins.noMood') + '</p><p class="small">' + t('ins.noMoodHint') + '</p></div>'; }
    else {
      var max = Math.max.apply(null, Object.values(counts));
      box.innerHTML = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).map(function (mood, i) {
        var pct = Math.round(counts[mood] / max * 100);
        return '<div class="bar-row"><span>' + window.MyDimensionJournal.esc(mood) + '</span>' +
          '<div class="bar-track"><div class="bar-fill' + (i % 2 ? ' lav' : '') + '" style="width:' + pct + '%"></div></div>' +
          '<strong>' + counts[mood] + '</strong></div>';
      }).join('') + '<p class="small muted">' + t('ins.countsNote') + '</p>';
    }
    // Overall mood donut + stats (real data).
    var groups = moodGroups(entries);
    document.getElementById('overallMood').innerHTML = donutHtml(groups, 160);
    animateDonuts(document.getElementById('overallMood'));
    document.getElementById('overallLegend').innerHTML = legendHtml(groups);
    var media = [];
    try { media = await window.MyDimensionMedia.loadAllMedia(); } catch (e) { /* stats show entries only */ }
    var photos = media.filter(function (m) { return m.kind === 'photo'; }).length;
    var audio = media.filter(function (m) { return m.kind === 'audio'; }).length;
    var thisMonth = entries.filter(function (e) { return e.date && e.date.slice(0, 7) === window.MyDimensionJournal.todayLocal().slice(0, 7); }).length;
    document.getElementById('diaryStats').innerHTML =
      '<div class="legend-row"><span>' + t('ins.totalEntries') + '</span><strong>' + entries.length + '</strong></div>' +
      '<div class="legend-row"><span>' + t('ins.withVoice') + '</span><strong>' + audio + '</strong></div>' +
      '<div class="legend-row"><span>' + t('ins.withPhotos') + '</span><strong>' + photos + '</strong></div>' +
      '<div class="legend-row"><span>' + t('ins.thisMonth') + '</span><strong>' + thisMonth + '</strong></div>' +
      '<div class="legend-row"><span>' + t('ins.moodTagged') + '</span><strong>' + total + '</strong></div>';
    renderTrend(entries);
  }
  function renderTrend(entries) {
    var box = document.getElementById('moodTrend');
    if (!box) return;
    var days = [];
    for (var i = 29; i >= 0; i--) {
      var d = new Date(); d.setDate(d.getDate() - i);
      days.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    }
    var perDay = days.map(function (iso) { return entries.filter(function (e) { return e.date === iso; }).length; });
    var max = Math.max.apply(null, perDay.concat([1]));
    var W = 560, H = 180, PL = 34, PB = 22, PT = 12, PR = 8;
    var x = function (i) { return PL + i * (W - PL - PR) / 29; };
    var y = function (v) { return PT + (H - PT - PB) * (1 - v / max); };
    var points = perDay.map(function (v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
    var area = PL + ',' + y(0) + ' ' + points + ' ' + x(29).toFixed(1) + ',' + y(0);
    var grid = '';
    for (var g = 0; g <= max; g++) {
      grid += '<line class="grid" x1="' + PL + '" y1="' + y(g) + '" x2="' + (W - PR) + '" y2="' + y(g) + '"/><text x="6" y="' + (y(g) + 4) + '">' + g + '</text>';
    }
    box.innerHTML = '<svg class="trend-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Entries per day, last 30 days">' +
      grid + '<polygon class="area" points="' + area + '"/>' +
      '<polyline class="line" points="' + points + '"/>' +
      perDay.map(function (v, i) { return '<circle class="dot" cx="' + x(i) + '" cy="' + y(v) + '" r="3"/>'; }).join('') +
      '<text x="' + PL + '" y="' + (H - 6) + '">' + days[0].slice(5) + '</text>' +
      '<text x="' + (W - PR - 34) + '" y="' + (H - 6) + '">' + days[29].slice(5) + '</text></svg>';
  }

  /* ---------- AI / media pages ---------- */
  async function loadAiPage() {
    hideError();
    if (!window.MyDimensionJournal.getCached().length) { try { await window.MyDimensionJournal.loadEntries({}); } catch (e) { /* entry list is optional here */ } }
    window.MyDimensionAI.populateEntrySelect();
  }
  async function loadMediaPage() {
    hideError();
    try { await window.MyDimensionMedia.refreshVault(mediaTab); }
    catch (err) { showError(err.message); }
  }

  /* ---------- settings ---------- */
  async function loadSettings() {
    hideError();
    applyTheme();
    window.MyDimensionAuth.refreshServiceStatus();
  }
  function applyTheme() {
    var saved = null;
    try { saved = localStorage.getItem('mydimension-theme'); } catch (e) { /* ignore */ }
    var dark = saved === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var btn = document.getElementById('themeToggle');
    if (btn) { btn.textContent = dark ? t('theme.light') : t('theme.dark'); btn.setAttribute('aria-pressed', String(dark)); }
  }
  function toggleTheme() {
    var dark = document.documentElement.getAttribute('data-theme') !== 'dark';
    try { localStorage.setItem('mydimension-theme', dark ? 'dark' : 'light'); } catch (e) { /* ignore */ }
    applyTheme();
  }

  async function exportData() {
    try {
      var entries = await window.MyDimensionJournal.loadEntries({});
      var blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), entries: entries }, null, 2)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'mydimension-export-' + window.MyDimensionJournal.todayLocal() + '.json'; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast(t('toast.exported'));
    } catch (err) { showError(err.message || err); }
  }

  /* ---------- entry-form tabs / rich text / voice note ---------- */
  function setEntryTab(name) {
    document.querySelectorAll('[data-entry-tab]').forEach(function (b) {
      var on = b.getAttribute('data-entry-tab') === name;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
    });
    ['write', 'voice', 'photo', 'file'].forEach(function (n) {
      document.getElementById('tab-' + n).classList.toggle('hidden', n !== name);
    });
  }
  function entryRecTimerText() {
    var el = document.getElementById('entryRecTimer');
    if (el && entryRec.start) el.textContent = new Date(Date.now() - entryRec.start).toISOString().slice(14, 19);
  }
  async function startEntryRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      throw new Error(t('journal.noRecord'));
    }
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    entryRec.chunks = [];
    entryRec.recorder = new MediaRecorder(stream);
    entryRec.recorder.ondataavailable = function (e) { if (e.data && e.data.size) entryRec.chunks.push(e.data); };
    entryRec.recorder.onstop = function () {
      stream.getTracks().forEach(function (t) { t.stop(); });
      entryRec.blob = new Blob(entryRec.chunks, { type: entryRec.recorder.mimeType || 'audio/webm' });
      var preview = document.getElementById('entryRecPreview');
      preview.src = URL.createObjectURL(entryRec.blob); preview.classList.remove('hidden');
      document.getElementById('entryTranscribeBtn').classList.remove('hidden');
      document.getElementById('entryRecBtn').disabled = false;
      document.getElementById('entryRecStopBtn').disabled = true;
    };
    entryRec.recorder.start();
    entryRec.start = Date.now();
    entryRec.timer = setInterval(entryRecTimerText, 500);
    document.getElementById('entryRecBtn').disabled = true;
    document.getElementById('entryRecStopBtn').disabled = false;
  }
  function stopEntryRecording() {
    if (entryRec.timer) clearInterval(entryRec.timer);
    if (entryRec.recorder && entryRec.recorder.state !== 'inactive') entryRec.recorder.stop();
  }
  async function transcribeEntryRecording() {
    if (!entryRec.blob) { toast(t('toast.recordFirst')); return; }
    var status = document.getElementById('entryTranscribeStatus');
    status.textContent = t('toast.transcribing');
    try {
      var fd = new FormData();
      fd.append('file', new File([entryRec.blob], 'voice-note.webm', { type: entryRec.blob.type || 'audio/webm' }));
      var tr = await window.MyDimensionApi.aiTranscribe(fd);
      var text = tr.result || tr.text || '';
      status.textContent = text ? t('toast.transcriptAdded') : t('toast.noTranscript');
      if (text) {
        var cur = document.getElementById('entryBody').innerText.trim();
        document.getElementById('entryBody').innerText = cur ? cur + '\n\n' + text : text;
        setEntryTab('write');
      }
    } catch (err) { status.textContent = t('toast.transcriptFailed') + ' ' + err.message; }
  }

  /* ---------- events ---------- */
  function bindEvents() {
    // Google sign-in is hidden from the login page for now (User ID +
    // password only); the button may not exist — bind it only if present.
    var googleBtn = document.getElementById('loginBtn');
    if (googleBtn) googleBtn.addEventListener('click', window.MyDimensionAuth.login);
    // User ID + Password sign-in form.
    document.getElementById('passwordLoginForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.classList.add('is-busy');
      try {
        await window.MyDimensionAuth.loginPassword(
          document.getElementById('loginUsername').value.trim(),
          document.getElementById('loginPassword').value);
      } finally { btn.disabled = false; btn.classList.remove('is-busy'); }
    });
    // Show / hide the password (eye icon on the pill input).
    document.getElementById('togglePassword').addEventListener('click', function () {
      var input = document.getElementById('loginPassword');
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      this.setAttribute('aria-pressed', String(show));
      this.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      this.classList.toggle('on', show);
      input.focus();
    });
    // Forgot password: there is no reset on this page yet — login is
    // User ID + password only.
    document.getElementById('forgotPasswordBtn').addEventListener('click', function () {
      var hint = document.getElementById('forgotHint');
      hint.textContent = 'Forgot your password? There is no password reset on this page yet.';
      hint.classList.remove('hidden');
      document.getElementById('loginUsername').focus();
    });
    // Set / change password from Settings.
    document.getElementById('savePasswordBtn').addEventListener('click', async function () {
      var msg = document.getElementById('passwordMsg');
      var result = await window.MyDimensionAuth.setPassword(
        document.getElementById('newPassword').value,
        document.getElementById('confirmPassword').value);
      msg.textContent = result.message;
      msg.classList.remove('hidden');
      if (result.ok) {
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmPassword').value = '';
      }
    });
    document.getElementById('logoutBtn').addEventListener('click', window.MyDimensionAuth.logout);
    document.getElementById('logoutBtn2').addEventListener('click', window.MyDimensionAuth.logout);
    document.getElementById('menuBtn').addEventListener('click', function () { document.getElementById('sidebar').classList.toggle('open'); });
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    var aiPref = document.getElementById('aiPrefEnabled');
    try { aiPref.checked = localStorage.getItem('mydimension-ai-off') !== '1'; } catch (e) { /* default on */ }
    aiPref.addEventListener('change', function () {
      try { localStorage.setItem('mydimension-ai-off', aiPref.checked ? '0' : '1'); } catch (e) { /* ignore */ }
      toast(aiPref.checked ? t('toast.aiOn') : t('toast.aiOff'));
    });

    // Bell: today's activity panel.
    function toggleBell() {
      var panel = document.getElementById('bellPanel');
      var btn = document.getElementById('bellBtn');
      var open = panel.classList.toggle('hidden');
      btn.setAttribute('aria-expanded', String(!open));
    }
    document.getElementById('bellBtn').addEventListener('click', function (e) { e.stopPropagation(); toggleBell(); });
    document.getElementById('bellBtnMobile').addEventListener('click', function () { window.location.hash = '#/dashboard'; toast(t('toast.todayActivity')); });
    document.addEventListener('click', function (e) {
      var panel = document.getElementById('bellPanel');
      if (panel && !panel.classList.contains('hidden') && !e.target.closest('.bell-wrap')) panel.classList.add('hidden');
    });

    // Dashboard search: filter recent entries live; Enter jumps to My Journal.
    document.getElementById('dashboardSearch').addEventListener('input', function (e) {
      var q = e.target.value.toLowerCase();
      var entries = window.MyDimensionJournal.getCached();
      var filtered = q ? entries.filter(function (en) { return (en.title + ' ' + en.body).toLowerCase().includes(q); }) : window.MyDimensionJournal.sortedEntries(entries).slice(0, 5);
      window.MyDimensionJournal.renderList(document.getElementById('recentEntries'), window.MyDimensionJournal.sortedEntries(filtered).slice(0, 5));
    });
    document.getElementById('dashboardSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        document.getElementById('journalSearch').value = e.target.value;
        window.location.hash = '#/journal';
      }
    });

    // Mini calendar month navigation.
    document.getElementById('miniPrevBtn').addEventListener('click', function () { miniCursor.setMonth(miniCursor.getMonth() - 1); loadDashboard(); });
    document.getElementById('miniNextBtn').addEventListener('click', function () { miniCursor.setMonth(miniCursor.getMonth() + 1); loadDashboard(); });

    // Entry form: submit, draft, cancel, tabs, rich text, voice, photo/file.
    document.getElementById('entryForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      try { await window.MyDimensionJournal.saveCurrent(); toast(t('toast.saved')); loadDashboard().catch(function () {}); }
      catch (err) { showError(err.message || err); }
    });
    document.getElementById('saveDraftBtn').addEventListener('click', function () {
      try { window.MyDimensionJournal.saveDraft(); toast(t('toast.draftSaved')); }
      catch (err) { showError(err.message || err); }
    });
    document.getElementById('discardDraftBtn').addEventListener('click', function () {
      window.MyDimensionJournal.clearDraft(); window.MyDimensionJournal.resetForm(); toast(t('toast.draftDiscarded'));
    });
    document.getElementById('cancelEditBtn').addEventListener('click', function () { window.MyDimensionJournal.resetForm(); });
    document.querySelectorAll('[data-entry-tab]').forEach(function (b) {
      b.addEventListener('click', function () { setEntryTab(b.getAttribute('data-entry-tab')); });
    });
    document.querySelectorAll('[data-rte]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.getElementById('entryBody').focus();
        document.execCommand(b.getAttribute('data-rte'), false, null);
      });
    });
    document.getElementById('entryRecBtn').addEventListener('click', async function () {
      try { await startEntryRecording(); } catch (err) { showError(err.message); }
    });
    document.getElementById('entryRecStopBtn').addEventListener('click', stopEntryRecording);
    document.getElementById('entryTranscribeBtn').addEventListener('click', transcribeEntryRecording);
    document.getElementById('entryPhoto').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var img = document.getElementById('entryPhotoPreview');
      img.src = URL.createObjectURL(f); img.classList.remove('hidden');
    });
    document.getElementById('entryFile').addEventListener('change', function (e) {
      var f = e.target.files[0];
      document.getElementById('entryFileName').textContent = f ? 'Selected: ' + f.name + ' (' + window.MyDimensionMedia.fmtSize(f.size) + ')' : '';
    });

    // Journal filters.
    ['journalSearch', 'journalMoodFilter', 'journalDateFilter'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', function () { window.MyDimensionJournal.refreshJournalList().catch(function (err) { showError(err.message); }); });
    });
    document.getElementById('clearJournalFilters').addEventListener('click', function () {
      document.getElementById('journalSearch').value = ''; document.getElementById('journalMoodFilter').value = ''; document.getElementById('journalDateFilter').value = '';
      window.MyDimensionJournal.refreshJournalList();
    });

    // Calendar navigation.
    document.getElementById('prevMonthBtn').addEventListener('click', function () { calCursor.setMonth(calCursor.getMonth() - 1); loadCalendarPage(); });
    document.getElementById('nextMonthBtn').addEventListener('click', function () { calCursor.setMonth(calCursor.getMonth() + 1); loadCalendarPage(); });
    document.getElementById('todayMonthBtn').addEventListener('click', function () { calCursor = new Date(); calCursor.setDate(1); selectedDay = window.MyDimensionJournal.todayLocal(); loadCalendarPage(); });

    // Media Vault: tabs + upload.
    document.querySelectorAll('[data-media-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        mediaTab = b.getAttribute('data-media-tab');
        document.querySelectorAll('[data-media-tab]').forEach(function (x) {
          var on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on));
        });
        window.MyDimensionMedia.refreshVault(mediaTab).catch(function (err) { showError(err.message); });
      });
    });
    document.getElementById('mediaUploadBtn').addEventListener('click', function () { document.getElementById('mediaUploadInput').click(); });
    document.getElementById('mediaUploadInput').addEventListener('change', async function (e) {
      var f = e.target.files[0]; if (!f) return;
      var kind = f.type.indexOf('audio/') === 0 ? 'audio' : 'photo';
      try { await window.MyDimensionMedia.uploadFile(f, kind, ''); toast(t('toast.uploaded')); await loadMediaPage(); }
      catch (err) { showError(err.message); }
      e.target.value = '';
    });

    // AI actions + chat.
    document.querySelectorAll('[data-ai-action]').forEach(function (btn) {
      btn.addEventListener('click', function () { window.MyDimensionAI.run(btn.getAttribute('data-ai-action')); });
    });
    function sendChat() {
      var input = document.getElementById('aiChatInput');
      var q = input.value.trim(); if (!q) return;
      input.value = '';
      window.MyDimensionAI.askChat(q);
    }
    document.getElementById('aiChatSend').addEventListener('click', sendChat);
    document.getElementById('aiChatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });

    document.getElementById('clearDataBtn').addEventListener('click', async function () {
      var ok = await confirmDialog({ title: t('confirm.deleteAllTitle'), text: t('confirm.deleteAllText'), yes: t('confirm.deleteAllYes'), strong: true });
      if (!ok) return;
      try {
        var entries = await window.MyDimensionJournal.loadEntries({});
        for (var i = 0; i < entries.length; i++) { await window.MyDimensionApi.deleteEntry(entries[i].id); }
        toast(t('toast.allDeleted')); loadDashboard();
      } catch (err) { showError(err.message || err); }
    });

    // Delegated clicks for dynamically rendered lists.
    document.addEventListener('click', async function (e) {
      var t = e.target.closest('[data-edit-entry],[data-delete-entry],[data-ai-entry],[data-delete-media],[data-transcribe-media],[data-goto-new-entry],[data-open-entry]');
      if (!t) return;
      if (t.hasAttribute('data-goto-new-entry')) { window.MyDimensionJournal.startNew(); return; }
      if (t.hasAttribute('data-open-entry')) { window.location.hash = '#/entry/' + t.getAttribute('data-open-entry'); return; }
      if (t.hasAttribute('data-edit-entry')) {
        var entry = window.MyDimensionJournal.findCached(t.getAttribute('data-edit-entry'));
        if (entry) { window.location.hash = '#/journal'; setTimeout(function () { window.MyDimensionJournal.fillForm(entry); }, 50); }
        return;
      }
      if (t.hasAttribute('data-delete-entry')) {
        var title = t.getAttribute('data-entry-title') || 'this entry';
        var ok = await confirmDialog({ title: t('confirm.deleteEntryTitle'), text: t('confirm.deleteEntryText', { title: title }), yes: t('confirm.delete') });
        if (!ok) return;
        try { await window.MyDimensionApi.deleteEntry(t.getAttribute('data-delete-entry')); toast(t('toast.entryDeleted')); await window.MyDimensionJournal.refreshJournalList(); loadDashboard().catch(function () {}); }
        catch (err) { showError(err.message); }
        return;
      }
      if (t.hasAttribute('data-ai-entry')) {
        window.location.hash = '#/ai';
        setTimeout(function () {
          var sel = document.getElementById('aiEntrySelect');
          if (sel) sel.value = t.getAttribute('data-ai-entry');
        }, 100);
        return;
      }
      if (t.hasAttribute('data-delete-media')) {
        var name = t.getAttribute('data-media-name') || 'this file';
        var okM = await confirmDialog({ title: t('confirm.deleteFileTitle'), text: t('confirm.deleteFileText', { name: name }), yes: t('confirm.delete') });
        if (!okM) return;
        try { await window.MyDimensionApi.deleteMedia(t.getAttribute('data-delete-media')); toast(t('toast.fileDeleted')); loadMediaPage(); }
        catch (err) { showError(err.message); }
        return;
      }
      if (t.hasAttribute('data-transcribe-media')) {
        var id = t.getAttribute('data-transcribe-media');
        var out = document.querySelector('[data-transcript-for="' + id + '"]');
        if (out) out.textContent = t('media.transcribing');
        try {
          // Transcription needs the audio file; fetch it back through the API and re-send it.
          var res = await fetch(window.MyDimensionApi.getMediaUrl(id), { credentials: 'include' });
          if (!res.ok) throw new Error(t('media.loadFailed'));
          var blob = await res.blob();
          var fd = new FormData(); fd.append('file', blob, 'voice-memory.webm');
          var tr = await window.MyDimensionApi.aiTranscribe(fd);
          var text = tr.result || tr.text || '';
          if (out) out.innerHTML = text ? '<strong>' + t('media.transcript') + '</strong> ' + window.MyDimensionJournal.esc(text) : t('media.noTranscript');
        } catch (err) { if (out) out.textContent = t('media.transcriptFailed') + ' ' + err.message; }
      }
    });

    document.querySelectorAll('[data-quick]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-quick');
        if (kind === 'note') window.MyDimensionJournal.startNew();
        else window.location.hash = kind === 'voice' ? '#/media' : '#/media';
      });
    });
    window.addEventListener('hashchange', showRoute);
  }

  /* ---------- init ---------- */
  var initialized = false;
  async function init() {
    // Guard against double init (e.g. DOMContentLoaded firing twice):
    // without it every handler — including the password eye toggle —
    // would be bound twice and fire twice per click.
    if (initialized) return;
    initialized = true;
    applyTheme();
    bindEvents();
    var user = await window.MyDimensionAuth.checkAuth();
    if (user) showRoute();
    if ('serviceWorker' in navigator) {
      // PWA shell only; the worker never caches API responses, media or tokens.
      navigator.serviceWorker.register('service-worker.js').catch(function () { /* PWA is optional; the app works without it */ });
    }
  }

  window.MyDimensionApp = { toast: toast, showError: showError, confirmDialog: confirmDialog, showRoute: showRoute };
  document.addEventListener('DOMContentLoaded', init);
})();
