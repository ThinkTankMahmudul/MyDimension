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
    showResult('<p><strong>Could not complete that AI request.</strong></p><p>' + esc(err.message || err) + '</p><p class="small muted">If Gemini is not configured yet, check Settings. You can try again later — your original text is unchanged.</p>');
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
      showResult('<p>AI features are turned off in Settings. Turn them back on to use the assistant.</p>');
      return;
    }
    var entry = selectedEntry();
    var freeText = document.getElementById('aiFreeText').value.trim();
    var text = entry ? entry.body : freeText;
    var title = entry ? entry.title : '';
    if (action !== 'transcribe' && !text) {
      showResult('<p>Choose an entry above, or paste some text, then try again.</p>');
      return;
    }
    setBusy(true);
    try {
      if (action === 'mood') {
        showLoading('Detecting mood');
        var mood = await window.MyDimensionApi.aiMood({ entry_id: entry ? entry.id : undefined, text: text });
        var label = resultText(mood) || 'No suggestion returned';
        showResult('<p><strong>Suggested mood: ' + esc(label) + '</strong></p>' +
          '<p class="small muted">This is an AI suggestion, not a fact or a diagnosis. You can keep your own mood, or change it when editing the entry.</p>' +
          (mood.note ? '<p class="small muted">' + esc(mood.note) + '</p>' : ''));
      } else if (action === 'summary') {
        showLoading('Summarising');
        var sum = await window.MyDimensionApi.aiSummary({ entry_id: entry ? entry.id : undefined, text: text });
        showResult('<p><strong>Summary' + (title ? ' — ' + esc(title) : '') + '</strong></p><p>' + esc(resultText(sum) || 'No summary returned.') + '</p><p class="small muted">Your original entry was not changed.</p>');
      } else if (action === 'improve') {
        showLoading('Improving writing');
        var imp = await window.MyDimensionApi.aiImprove({ entry_id: entry ? entry.id : undefined, text: text });
        var improved = resultText(imp);
        showResult('<p><strong>Improved version (suggestion only)</strong></p><p>' + esc(improved || 'No suggestion returned.') + '</p>' +
          '<p class="small muted">Your original text was not overwritten. Use the button below only if you want this as a draft.</p>' +
          (improved ? '<button class="btn secondary" id="useImprovedBtn">Use as a draft in My Journal</button>' : ''));
        var btn = document.getElementById('useImprovedBtn');
        if (btn) btn.addEventListener('click', function () {
          window.MyDimensionJournal.startNew({ title: title ? title + ' (AI draft)' : 'AI draft', body: improved });
          window.MyDimensionApp.toast('Draft ready in My Journal — review it, then press Save.');
        });
      } else if (action === 'reflect') {
        showLoading('Reflecting on your day');
        var entryText = entry ? ('Diary entry "' + entry.title + '" (' + entry.date + '):\n' + entry.body) : text;
        var ref = await window.MyDimensionApi.aiSummary({
          entry_id: entry ? entry.id : undefined,
          text: 'Give a short, kind daily reflection on this diary entry — one insight and one gentle question for tomorrow:\n\n' + entryText
        });
        showResult('<p><strong>Daily Reflection' + (entry ? ' — ' + esc(entry.title) : '') + '</strong></p><p>' + esc(resultText(ref) || 'No reflection returned.') + '</p><p class="small muted">An AI reflection, not advice or a diagnosis. Your original entry was not changed.</p>');
      } else if (action === 'transcribe') {
        var file = document.getElementById('aiAudioFile').files[0];
        if (!file) { showResult('<p>Choose an audio file first, then press Transcribe.</p>'); setBusy(false); return; }
        showLoading('Transcribing audio');
        var fd = new FormData(); fd.append('file', file);
        var tr = await window.MyDimensionApi.aiTranscribe(fd);
        var transcript = resultText(tr);
        showResult('<p><strong>Transcript (review before saving)</strong></p><p>' + esc(transcript || 'No transcript returned.') + '</p>' +
          (transcript ? '<button class="btn secondary" id="saveTranscriptBtn">Save transcript as a journal draft</button>' : ''));
        var saveBtn = document.getElementById('saveTranscriptBtn');
        if (saveBtn) saveBtn.addEventListener('click', function () {
          window.MyDimensionJournal.startNew({ title: 'Voice memory — ' + window.MyDimensionJournal.todayLocal(), body: transcript });
          window.MyDimensionApp.toast('Transcript is a draft in My Journal — review it, then press Save.');
        });
      }
    } catch (err) { showError(err); }
    setBusy(false);
  }

  // Chat: reflect on the chosen entry, answering the owner's question.
  async function askChat(question) {
    if (!aiEnabled()) {
      appendChat('ai', 'AI features are turned off in Settings. Turn them back on to ask a question.');
      return;
    }
    var q = (question || '').trim();
    if (!q) return;
    appendChat('user', q);
    var entry = selectedEntry();
    if (!entry) { appendChat('ai', 'I need a diary entry to reflect on — write one first, or paste text in the box above.'); return; }
    setBusy(true);
    try {
      var res = await window.MyDimensionApi.aiSummary({
        entry_id: entry.id,
        text: 'The owner asks about this diary entry: "' + q + '"\n\nDiary entry "' + entry.title + '" (' + entry.date + '):\n' + entry.body + '\n\nAnswer briefly, as a reflection on the entry.'
      });
      appendChat('ai', resultText(res) || 'No answer returned.');
    } catch (err) {
      appendChat('ai', 'Sorry — I could not answer that: ' + (err.message || err));
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
    sel.innerHTML = '<option value="">— Most recent entry —</option>' +
      entries.map(function (e) { return '<option value="' + esc(e.id) + '">' + esc((e.date ? e.date + ' — ' : '') + e.title) + '</option>'; }).join('');
    if (current) sel.value = current;
  }

  window.MyDimensionAI = { run: run, populateEntrySelect: populateEntrySelect, askChat: askChat, appendChat: appendChat };
})();
