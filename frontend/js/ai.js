/* MyDimension — js/ai.js
 * Gemini features, via the backend only.
 * Each action is explicit: the user picks an entry / audio file and clicks.
 * Only the selected content is sent. Results are shown, never written over
 * the original — the owner chooses whether to use a suggestion.
 * AI mood output is labelled a suggestion, not a fact or diagnosis.
 * API truth (routes_ai.py + schemas.py): request { text, entry_id? },
 * response { result, model?, note? }. There is no separate Q&A endpoint,
 * so "Ask me anything" reflects on the chosen entry with your question
 * included in the text sent to the summary task.
 */
(function () {
  'use strict';

  // i18n: t() reads the live language.
  function t(key, vars) { return window.MyDimensionI18n ? window.MyDimensionI18n.t(key, vars) : key; }

  function esc(s) { return window.MyDimensionJournal.esc(s); }

  function aiEnabled() {
    var pref = document.getElementById('aiPrefEnabled');
    return !pref || pref.checked;
  }

  function showResult(html) {
    var box = document.getElementById('aiResult');
    box.innerHTML = html;
    if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function showLoading(label) {
    var box = document.getElementById('aiResult');
    box.innerHTML = '<p>' + esc(label) + '…</p>';
  }
  function showError(err) {
    showResult('<p><strong>' + t('ai.couldNot') + '</strong></p><p>' + esc(err.message || err) + '</p><p class="small muted">' + t('ai.checkSettings') + '</p>');
  }
  function setBusy(busy) {
    document.querySelectorAll('#page-ai button[data-ai-action], #aiChatSend').forEach(function (b) { b.disabled = busy; });
  }
  function selectedEntry() {
    var sel = document.getElementById('aiEntrySelect');
    var id = sel ? sel.value : '';
    if (id) return window.MyDimensionJournal.findCached(id) || null;
    var cached = window.MyDimensionJournal.sortedEntries();
    return cached.length ? cached[0] : null;
  }
  function resultText(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    return data.result || data.text || '';
  }

  async function run(action) {
    if (!aiEnabled()) {
      showResult('<p>' + t('ai.off') + '</p>');
      return;
    }
    var entry = selectedEntry();
    var freeText = document.getElementById('aiFreeText').value.trim();
    // Pasted text wins when present: the owner typed it for this exact task.
    // Otherwise use the chosen entry (or the most recent one).
    var text = freeText || (entry ? entry.body : '');
    var title = freeText ? '' : (entry ? entry.title : '');
    var source = freeText ? t('ai.sourceText') : (entry ? t('ai.sourceEntry', { title: entry.title }) : '');
    if (action !== 'transcribe' && !text) {
      showResult('<p>' + t('ai.chooseFirst') + '</p>');
      return;
    }
    setBusy(true);
    try {
      if (action === 'mood') {
        showLoading(t('ai.loadingMood'));
        var mood = await window.MyDimensionApi.aiMood({ entry_id: entry ? entry.id : undefined, text: text });
        var label = resultText(mood) || t('ai.noSuggestion');
        showResult('<p><strong>' + t('ai.suggestedMood') + ' ' + esc(label) + '</strong></p>' +
          (source ? '<p class="small muted">' + esc(source) + '</p>' : '') +
          '<p class="small muted">' + t('ai.suggestionNote') + '</p>' +
          (mood.note ? '<p class="small muted">' + esc(mood.note) + '</p>' : ''));
      } else if (action === 'summary') {
        showLoading(t('ai.loadingSummary'));
        var sum = await window.MyDimensionApi.aiSummary({ entry_id: entry ? entry.id : undefined, text: text });
        showResult('<p><strong>' + t('ai.summaryTitle') + (title ? ' — ' + esc(title) : '') + '</strong></p>' + (source ? '<p class="small muted">' + esc(source) + '</p>' : '') + '<p>' + esc(resultText(sum) || t('ai.noSummary')) + '</p><p class="small muted">' + t('ai.originalUnchanged') + '</p>');
      } else if (action === 'improve') {
        showLoading(t('ai.loadingImprove'));
        var imp = await window.MyDimensionApi.aiImprove({ entry_id: entry ? entry.id : undefined, text: text });
        var improved = resultText(imp);
        showResult('<p><strong>' + t('ai.improvedTitle') + '</strong></p>' + (source ? '<p class="small muted">' + esc(source) + '</p>' : '') + '<p>' + esc(improved || t('ai.noImproved')) + '</p>' +
          '<p class="small muted">' + t('ai.originalNotOverwritten') + '</p>' +
          (improved ? '<button class="btn secondary" id="useImprovedBtn">' + t('ai.useAsDraft') + '</button>' : ''));
        var btn = document.getElementById('useImprovedBtn');
        if (btn) btn.addEventListener('click', function () {
          window.MyDimensionJournal.startNew({ title: title ? title + t('ai.draftSuffix') : t('ai.draftTitle'), body: improved });
          window.MyDimensionApp.toast(t('ai.draftReady'));
        });
      } else if (action === 'reflect') {
        showLoading(t('ai.loadingReflect'));
        // Reflect on what the owner actually chose: pasted text, or the entry.
        var entryText = freeText ? freeText : (entry ? ('Diary entry "' + entry.title + '" (' + entry.date + '):\n' + entry.body) : text);
        var ref = await window.MyDimensionApi.aiSummary({
          entry_id: entry ? entry.id : undefined,
          text: 'Give a short, kind daily reflection on this diary entry — one insight and one gentle question for tomorrow:\n\n' + entryText
        });
        showResult('<p><strong>' + t('ai.reflectionTitle') + (entry ? ' — ' + esc(entry.title) : '') + '</strong></p>' + (source ? '<p class="small muted">' + esc(source) + '</p>' : '') + '<p>' + esc(resultText(ref) || t('ai.noReflection')) + '</p><p class="small muted">' + t('ai.reflectionNote') + '</p>');
      } else if (action === 'transcribe') {
        var file = document.getElementById('aiAudioFile').files[0];
        if (!file) { showResult('<p>' + t('ai.chooseAudio') + '</p>'); setBusy(false); return; }
        showLoading(t('ai.loadingTranscribe'));
        var fd = new FormData(); fd.append('file', file);
        var tr = await window.MyDimensionApi.aiTranscribe(fd);
        var transcript = resultText(tr);
        showResult('<p><strong>' + t('ai.transcriptTitle') + '</strong></p><p>' + esc(transcript || t('ai.noTranscript')) + '</p>' +
          (transcript ? '<button class="btn secondary" id="saveTranscriptBtn">' + t('ai.saveTranscript') + '</button>' : ''));
        var saveBtn = document.getElementById('saveTranscriptBtn');
        if (saveBtn) saveBtn.addEventListener('click', function () {
          window.MyDimensionJournal.startNew({ title: t('ai.voiceMemory') + window.MyDimensionJournal.todayLocal(), body: transcript });
          window.MyDimensionApp.toast(t('ai.transcriptDraft'));
        });
      }
    } catch (err) { showError(err); }
    setBusy(false);
  }

  // Chat: reflect on the chosen entry, answering the owner's question.
  async function askChat(question) {
    if (!aiEnabled()) {
      appendChat('ai', t('ai.off'));
      return;
    }
    var q = (question || '').trim();
    if (!q) return;
    appendChat('user', q);
    var entry = selectedEntry();
    if (!entry) { appendChat('ai', t('ai.needEntry')); return; }
    setBusy(true);
    try {
      var res = await window.MyDimensionApi.aiSummary({
        entry_id: entry.id,
        text: 'The owner asks about this diary entry: "' + q + '"\n\nDiary entry "' + entry.title + '" (' + entry.date + '):\n' + entry.body + '\n\nAnswer briefly, as a reflection on the entry.'
      });
      appendChat('ai', resultText(res) || t('ai.noAnswer'));
    } catch (err) {
      appendChat('ai', t('ai.answerFailed') + ' ' + (err.message || err));
    }
    setBusy(false);
  }

  function appendChat(who, text) {
    var log = document.getElementById('aiChatLog');
    if (!log) return;
    var div = document.createElement('div');
    div.className = 'chat-msg ' + (who === 'user' ? 'user' : 'ai');
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function populateEntrySelect() {
    var sel = document.getElementById('aiEntrySelect');
    if (!sel) return;
    var current = sel.value;
    var entries = window.MyDimensionJournal.sortedEntries();
    sel.innerHTML = '<option value="">' + t('ai.recentOption') + '</option>' +
      entries.map(function (e) { return '<option value="' + esc(e.id) + '">' + esc((e.date ? e.date + ' — ' : '') + e.title) + '</option>'; }).join('');
    if (current) sel.value = current;
  }

  window.MyDimensionAI = { run: run, populateEntrySelect: populateEntrySelect, askChat: askChat, appendChat: appendChat };
})();
