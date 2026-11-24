/* MyDimension — js/ai.js
 * Gemini features, via the backend only (spec §6.7).
 * Each action is explicit: the user picks an entry / audio file and clicks.
 * Only the selected content is sent. Results are shown, never written over
 * the original — the owner chooses whether to use a suggestion.
 * AI mood output is labelled a suggestion, not a fact or diagnosis.
 */
(function () {
  'use strict';

  function esc(s) { return window.MyDimensionJournal.esc(s); }

  function showResult(html) {
    var box = document.getElementById('aiResult');
    box.innerHTML = html; box.classList.remove('hidden');
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function showLoading(label) {
    var box = document.getElementById('aiResult');
    box.innerHTML = '<p>' + esc(label) + '…</p>'; box.classList.remove('hidden');
  }
  function showError(err) {
    showResult('<p><strong>Could not complete that AI request.</strong></p><p>' + esc(err.message || err) + '</p><p class="small muted">If Gemini is not configured yet, check Settings. You can try again later — your original text is unchanged.</p>');
  }
  function setBusy(busy) {
    document.querySelectorAll('#page-ai button[data-ai-action]').forEach(function (b) { b.disabled = busy; });
  }
  function selectedEntry() {
    var id = document.getElementById('aiEntrySelect').value;
    return id ? window.MyDimensionJournal.findCached(id) : null;
  }
  function resultText(data) {
    // Accept several backend shapes: { summary }, { text }, { result }, { mood }, { improved_text }…
    if (!data) return '';
    if (typeof data === 'string') return data;
    return data.summary || data.improved_text || data.improved || data.text || data.result || data.transcript || data.transcription || '';
  }

  async function run(action) {
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
        var mood = await window.MyDimensionApi.aiMood({ entry_id: entry ? entry.id : undefined, text: text, title: title });
        var label = mood.mood || mood.suggested_mood || resultText(mood) || 'No suggestion returned';
        showResult('<p><strong>Suggested mood: ' + esc(label) + '</strong></p>' +
          '<p class="small muted">This is an AI suggestion, not a fact or a diagnosis. You can keep your own mood, or change it when editing the entry.</p>' +
          (mood.reason || mood.explanation ? '<p>' + esc(mood.reason || mood.explanation) + '</p>' : ''));
      } else if (action === 'summary') {
        showLoading('Summarising');
        var sum = await window.MyDimensionApi.aiSummary({ entry_id: entry ? entry.id : undefined, text: text, title: title });
        showResult('<p><strong>Summary</strong></p><p>' + esc(resultText(sum) || 'No summary returned.') + '</p><p class="small muted">Your original entry was not changed.</p>');
      } else if (action === 'improve') {
        showLoading('Improving writing');
        var imp = await window.MyDimensionApi.aiImprove({ entry_id: entry ? entry.id : undefined, text: text, title: title });
        var improved = resultText(imp);
        showResult('<p><strong>Improved version (suggestion only)</strong></p><p>' + esc(improved || 'No suggestion returned.') + '</p>' +
          '<p class="small muted">Your original text was not overwritten. Use the button below only if you want this as a draft.</p>' +
          (improved ? '<button class="btn secondary" id="useImprovedBtn">Use as a draft in My Journal</button>' : ''));
        var btn = document.getElementById('useImprovedBtn');
        if (btn) btn.addEventListener('click', function () {
          // Draft only: fills the journal editor; the owner still has to press Save.
          window.MyDimensionJournal.startNew();
          document.getElementById('entryTitle').value = title ? title + ' (AI draft)' : 'AI draft';
          document.getElementById('entryBody').value = improved;
          window.MyDimensionApp.toast('Draft ready in My Journal — review it, then press Save.');
        });
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
          window.MyDimensionJournal.startNew();
          document.getElementById('entryTitle').value = 'Voice memory — ' + window.MyDimensionJournal.todayLocal();
          document.getElementById('entryBody').value = transcript;
          window.MyDimensionApp.toast('Transcript is a draft in My Journal — review it, then press Save.');
        });
      }
    } catch (err) { showError(err); }
    setBusy(false);
  }

  function populateEntrySelect() {
    var sel = document.getElementById('aiEntrySelect');
    if (!sel) return;
    var current = sel.value;
    var entries = window.MyDimensionJournal.getCached();
    sel.innerHTML = '<option value="">— No entry selected (use the text box below) —</option>' +
      entries.map(function (e) { return '<option value="' + esc(e.id) + '">' + esc((e.date ? e.date + ' — ' : '') + e.title) + '</option>'; }).join('');
    if (current) sel.value = current;
  }

  window.MyDimensionAI = { run: run, populateEntrySelect: populateEntrySelect };
})();
