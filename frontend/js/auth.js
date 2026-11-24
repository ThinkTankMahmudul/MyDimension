/* MyDimension — js/auth.js
 * Google OAuth via the backend only. The frontend never checks an email
 * allowlist and never stores a token: the backend verifies the Google
 * identity and enforces the configured owner email, and the session
 * lives in a cookie.
 * /api/me returns only { email, is_owner } — the display name is derived
 * from the owner email for the greeting/sidebar, and service status
 * (Drive / Gemini / database) comes from the public /health endpoint.
 */
(function () {
  'use strict';

  var currentUser = null;

  // Display name for the known owner account; any other owner email is
  // prettified from its local part. Display only — never an auth check.
  function displayName(email) {
    if (!email) return 'Owner';
    if (email.toLowerCase() === 'technicalmahmudull@gmail.com') return 'Mahmudul Hasan';
    var local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
    return local ? local.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : 'Owner';
  }

  function showLogin() {
    document.getElementById('loginView').classList.remove('hidden');
    document.getElementById('appView').classList.add('hidden');
    var err = document.getElementById('loginError');
    if (err) err.classList.add('hidden');
  }

  function showApp(user) {
    currentUser = user || null;
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('appView').classList.remove('hidden');
    renderProfile(user);
  }

  function renderProfile(user) {
    if (!user) return;
    var name = displayName(user.email);
    var email = user.email || '';
    document.querySelectorAll('[data-profile-name]').forEach(function (el) { el.textContent = name; });
    document.querySelectorAll('[data-profile-email]').forEach(function (el) { el.textContent = email; });
    var initial = name.charAt(0).toUpperCase();
    document.querySelectorAll('[data-profile-initial]').forEach(function (el) { el.textContent = initial; });
    var greet = document.getElementById('greetingName');
    if (greet) greet.textContent = name;
  }

  function setStatus(id, ok, labelOk, labelNo) {
    var el = document.getElementById(id);
    if (!el) return;
    if (ok === true) { el.innerHTML = '<span class="status-dot ok"></span>' + (labelOk || 'Connected / configured'); }
    else if (ok === false) { el.innerHTML = '<span class="status-dot no"></span>' + (labelNo || 'Not connected'); }
    else { el.innerHTML = '<span class="status-dot"></span>Unknown — sign in again if this persists'; }
  }

  // Service status lives on /health: { ai_configured, drive_configured, storage }.
  async function refreshServiceStatus() {
    try {
      var h = await window.MyDimensionApi.getHealth();
      setStatus('driveStatus', !!h.drive_configured, 'Connected', 'Not connected');
      setStatus('geminiStatus', !!h.ai_configured, 'Configured', 'Not configured');
      setStatus('dbStatus', h.storage === 'postgresql', 'PostgreSQL connected', 'Not using PostgreSQL');
    } catch (e) { /* status stays Unknown; the app still works */ }
  }

  async function checkAuth() {
    try {
      var user = await window.MyDimensionApi.getMe();
      showApp(user);
      refreshServiceStatus();
      return user;
    } catch (err) {
      // 401 (or unreachable /api/me before login) means: stay on the login screen.
      showLogin();
      return null;
    }
  }

  function login() {
    // Backend starts the Google OAuth flow. No credentials in the frontend.
    window.location.href = '/auth/google/login';
  }

  async function logout() {
    try { await window.MyDimensionApi.logout(); } catch (e) { /* session may already be gone */ }
    currentUser = null;
    showLogin();
    window.location.hash = '#/dashboard';
  }

  window.MyDimensionAuth = {
    checkAuth: checkAuth, login: login, logout: logout,
    showLogin: showLogin, showApp: showApp,
    getUser: function () { return currentUser; },
    displayName: displayName, refreshServiceStatus: refreshServiceStatus
  };
})();
