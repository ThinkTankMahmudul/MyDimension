/* MyDimension — js/api.js
 * Thin fetch wrapper for the backend API.
 * Same-origin, cookies included. No secrets / keys here.
 * Verified against the backend routes (schemas.py / api/*.py):
 *   GET  /health                      -> { status, app, storage, ai_configured, drive_configured }
 *   GET  /api/me                      -> { email, is_owner, name? }  (no picture/status fields)
 *   POST /api/auth/register { name, email, password } -> { detail, email } (code sent)
 *   POST /api/auth/verify-code { email, code } -> { email, name, is_owner } + session cookie
 *   POST /api/auth/resend-code { email } -> { detail }
 *   GET  /api/entries?search=&mood=&month=YYYY-MM   (no q/date params)
 *   POST /api/entries  { title, content, mood, tags }
 *   PUT  /api/entries/{id}  { title?, content?, mood?, tags?, summary? }
 *   GET  /api/calendar?year=&month=   -> [{ date, entry_count, has_entry }]
 *   GET  /api/insights/moods          -> [{ mood, count }]
 *   POST /api/media/upload  FormData: file, media_type ('photo'|'audio'), caption?, entry_id?
 *   GET  /api/media?media_type=       -> [{ id, drive_file_id, file_name, mime_type,
 *                                          media_type, file_size, entry_id, caption,
 *                                          transcript, created_at }]
 *   GET  /api/media/{id}/file         -> file bytes for <img>/<audio>
 *   POST /api/ai/mood|summary|improve { text, entry_id? } -> { result, model?, note? }
 *   POST /api/ai/transcribe  FormData: file (audio/*)     -> { result, ... }
 *   GET  /auth/google/login (redirect), POST /auth/logout
 *   POST /api/auth/login { username, password } -> session cookie
 *   GET  /api/auth/password-status -> { password_set }
 *   POST /api/auth/set-password { new_password } (signed-in admin only)
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
    // Pre-auth endpoints never carry a session, so a 401 there is not
    // an expired session — it must reach the form, not showLogin.
    var preAuth = path === '/api/auth/register' || path === '/api/auth/verify-code' || path === '/api/auth/resend-code' || path === '/api/auth/forgot-password' || path === '/api/auth/reset-password';
    if (res.status === 401 && !preAuth && !path.startsWith('/api/auth/login') && path !== '/api/auth/password-status') {
      // Session expired or not signed in: hand control to auth.js.
      // The password-login endpoint is excluded: its 401 means "wrong
      // User ID or password" and its server detail must reach the form.
      // password-status is excluded too: it is public, and calling
      // showLogin from it would loop (showLogin refreshes the hint).
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
    // Public health check — also the only source for Drive/Gemini status
    // (/api/me returns only email + is_owner).
    getHealth: function () { return request('/health'); },

    // Auth / profile. Response shape (backend): { email, is_owner, name? }
    getMe: function () { return request('/api/me'); },
    logout: function () { return json('/auth/logout', 'POST', {}); },

    // Password login (alternative to Google). POST /api/auth/login
    // { username, password } -> { email, is_owner } + session cookie.
    // 409 = no password set yet; 401 = wrong User ID or password (the
    // server never says which one); 429 = too many failed attempts.
    loginPassword: function (username, password) {
      return json('/api/auth/login', 'POST', { username: username, password: password });
    },
    getPasswordStatus: function () { return request('/api/auth/password-status'); },
    setPassword: function (newPassword) {
      return json('/api/auth/set-password', 'POST', { new_password: newPassword });
    },

    // Sign-up (email verification). POST /api/auth/register
    // { name, email, password } -> { detail, email } (200: code sent).
    // 400 = validation, 409 = email already verified, 429 = too many
    // codes, 503 = email not configured.
    register: function (name, email, password) {
      return json('/api/auth/register', 'POST', { name: name, email: email, password: password });
    },
    // POST /api/auth/verify-code { email, code } -> { email, name,
    // is_owner } + session cookie. 400 = wrong/expired code, 429 =
    // too many attempts.
    verifyCode: function (email, code) {
      return json('/api/auth/verify-code', 'POST', { email: email, code: code });
    },
    // POST /api/auth/resend-code { email } -> { detail }. 429 if a code
    // was sent in the last 60 seconds or more than 5 in an hour.
    resendCode: function (email) {
      return json('/api/auth/resend-code', 'POST', { email: email });
    },
    // Password reset. POST /api/auth/forgot-password { email } -> a
    // generic { detail } (always 200: the server never says whether
    // the account exists). 429 if a reset code was sent in the last
    // 60 seconds or more than 5 in an hour; 503 if email is not set up.
    forgotPassword: function (email) {
      return json('/api/auth/forgot-password', 'POST', { email: email });
    },
    // POST /api/auth/reset-password { email, code, new_password } ->
    // { detail }. 400 = wrong/expired code or short password, 429 =
    // too many attempts.
    resetPassword: function (email, code, newPassword) {
      return json('/api/auth/reset-password', 'POST', { email: email, code: code, new_password: newPassword });
    },
    // POST /api/auth/change-password { current_password, new_password }
    // (signed in) -> { detail }. 400 = current password wrong or new
    // password too short.
    changePassword: function (currentPassword, newPassword) {
      return json('/api/auth/change-password', 'POST', { current_password: currentPassword, new_password: newPassword });
    },

    // Entries. Entry fields: id, title, content, mood, tags, summary,
    // created_at, updated_at. The entry "date" is created_at's date —
    // there is no separate entry_date field on the API.
    listEntries: function (params) {
      var clean = {};
      if (params) {
        if (params.search) clean.search = params.search;
        if (params.mood) clean.mood = params.mood;
        if (params.month) clean.month = params.month;
      }
      var q = Object.keys(clean).length ? '?' + new URLSearchParams(clean).toString() : '';
      return request('/api/entries' + q);
    },
    getEntry: function (id) { return request('/api/entries/' + encodeURIComponent(id)); },
    createEntry: function (data) { return json('/api/entries', 'POST', data); },
    updateEntry: function (id, data) { return json('/api/entries/' + encodeURIComponent(id), 'PUT', data); },
    deleteEntry: function (id) { return request('/api/entries/' + encodeURIComponent(id), { method: 'DELETE' }); },

    // Calendar + insights
    getCalendar: function (year, month) {
      // month: 1-12. Backend returns [{ date, entry_count, has_entry }].
      return request('/api/calendar?year=' + year + '&month=' + month);
    },
    getMoodInsights: function () { return request('/api/insights/moods'); },

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
    // Request: { text, entry_id? }. Response: { result, model?, note? }.
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
