/* MyDimension — js/auth.js
 * Google OAuth via the backend only. The frontend never checks an email
 * allowlist and never stores a token: the backend verifies the Google
 * identity and enforces the configured owner email, and the session
 * lives in a cookie.
 */
(function () {
  'use strict';

  var currentUser = null;

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
    var name = user.name || (user.email ? user.email.split('@')[0] : 'Owner');
    var email = user.email || '';
    document.querySelectorAll('[data-profile-name]').forEach(function (el) { el.textContent = name; });
    document.querySelectorAll('[data-profile-email]').forEach(function (el) { el.textContent = email; });
    var initial = name.charAt(0).toUpperCase();
    document.querySelectorAll('[data-profile-initial]').forEach(function (el) { el.textContent = initial; });
    var pic = document.querySelector('[data-profile-picture]');
    if (pic && user.picture) { pic.src = user.picture; pic.classList.remove('hidden'); }
    // Settings page: service status is shown as configured / not configured — never a key.
    setStatus('driveStatus', user.drive_connected);
    setStatus('geminiStatus', user.gemini_configured);
  }

  function setStatus(id, ok) {
    var el = document.getElementById(id);
    if (!el) return;
    if (ok === true) { el.innerHTML = '<span class="status-dot ok"></span>Connected / configured'; }
    else if (ok === false) { el.innerHTML = '<span class="status-dot no"></span>Not connected'; }
    else { el.innerHTML = '<span class="status-dot"></span>Unknown — sign in again if this persists'; }
  }

  async function checkAuth() {
    try {
      var user = await window.MyDimensionApi.getMe();
      showApp(user);
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
    getUser: function () { return currentUser; }
  };
})();
