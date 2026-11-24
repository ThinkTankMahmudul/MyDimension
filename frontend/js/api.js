/* MyDimension — js/api.js
 * Thin fetch wrapper for the backend API (spec §10).
 * Same-origin, cookies included. No secrets / keys here.
 * Endpoints used (relative, so the same frontend works on Vercel or any host):
 *   GET  /api/me, GET/POST /api/entries, PUT/DELETE /api/entries/{id}
 *   POST /api/media/upload, GET /api/media, GET /api/media/{id} (metadata),
 *   GET /api/media/{id}/file (file bytes for <img>/<audio>), DELETE /api/media/{id}
 *   POST /api/ai/mood, /api/ai/summary, /api/ai/improve, /api/ai/transcribe
 *   GET  /api/calendar, GET /api/insights/moods
 *   GET  /auth/google/login (redirect), POST /auth/logout
 */
(function () {
  'use strict';

  /** Friendly message for a failed response; never leaks raw server detail. */
  function friendlyMessage(status) {
    if (status === 401) return 'Your session has expired. Please sign in again.';
    if (status === 403) return 'This account is not allowed to use MyDimension.';
    if (status === 404) return 'That item could not be found. It may already have been deleted.';
    if (status === 413) return 'That file is too large. Please try a smaller file.';
    if (status === 429) return 'Too many requests. Please wait a moment and try again.';
    if (status >= 500) return 'The server had a problem. Please try again in a moment.';
    return 'Something went wrong. Please try again.';
  }

  async function request(path, options) {
    var opts = Object.assign({ credentials: 'include', headers: {} }, options || {});
    var res;
    try {
      res = await fetch(path, opts);
    } catch (err) {
      // Network / offline — do not invent data.
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    if (res.status === 401) {
      // Session expired or not signed in: hand control to auth.js.
      if (window.MyDimensionAuth && window.MyDimensionAuth.showLogin) {
        window.MyDimensionAuth.showLogin();
      }
      throw new Error('Your session has expired. Please sign in again.');
    }
    if (!res.ok) {
      var msg = friendlyMessage(res.status);
      try {
        var data = await res.clone().json();
        if (data && typeof data.detail === 'string' && data.detail.length < 200) msg = data.detail;
        else if (data && typeof data.message === 'string' && data.message.length < 200) msg = data.message;
      } catch (e) { /* keep the friendly message */ }
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    var text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  function json(path, method, body) {
    return request(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  var api = {
    // Auth / profile. Response shape (backend): { email, name, picture?, drive_connected, gemini_configured }
    getMe: function () { return request('/api/me'); },
    logout: function () { return json('/auth/logout', 'POST', {}); },

    // Entries
    listEntries: function (params) {
      var q = params ? '?' + new URLSearchParams(params).toString() : '';
      return request('/api/entries' + q);
    },
    getEntry: function (id) { return request('/api/entries/' + encodeURIComponent(id)); },
    createEntry: function (data) { return json('/api/entries', 'POST', data); },
    updateEntry: function (id, data) { return json('/api/entries/' + encodeURIComponent(id), 'PUT', data); },
    deleteEntry: function (id) { return request('/api/entries/' + encodeURIComponent(id), { method: 'DELETE' }); },

    // Calendar + insights
    getCalendar: function (year, month) {
      // month: 1-12. Backend returns days with entries, e.g. { days: { "2026-11-25": 2 } } or a list — both handled by callers.
      return request('/api/calendar?year=' + year + '&month=' + month);
    },
    getMoodInsights: function (params) {
      var q = params ? '?' + new URLSearchParams(params).toString() : '';
      return request('/api/insights/moods' + q);
    },

    // Media (photos + voice). Upload uses FormData — never set Content-Type manually.
    listMedia: function (kind) {
      return request('/api/media' + (kind ? '?media_type=' + encodeURIComponent(kind) : ''));
    },
    // File bytes for <img>/<audio> tags — the metadata route returns JSON, not bytes.
    getMediaUrl: function (id) { return '/api/media/' + encodeURIComponent(id) + '/file'; },
    uploadMedia: function (formData) {
      return request('/api/media/upload', { method: 'POST', body: formData });
    },
    deleteMedia: function (id) { return request('/api/media/' + encodeURIComponent(id), { method: 'DELETE' }); },

    // AI — each call sends ONLY the selected entry/audio, on an explicit user action.
    aiMood: function (payload) { return json('/api/ai/mood', 'POST', payload); },
    aiSummary: function (payload) { return json('/api/ai/summary', 'POST', payload); },
    aiImprove: function (payload) { return json('/api/ai/improve', 'POST', payload); },
    aiTranscribe: function (formData) {
      // Audio upload for transcription; FormData so the file travels as multipart.
      return request('/api/ai/transcribe', { method: 'POST', body: formData });
    }
  };

  window.MyDimensionApi = api;
})();
