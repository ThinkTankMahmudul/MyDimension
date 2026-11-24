/* MyDimension — js/auth.js
 * Two sign-in methods, both verified by the backend only:
 *   1. User ID + Password (POST /api/auth/login) — the primary form.
 *   2. Google OAuth (GET /auth/google/login) — alternative below it.
 * The frontend never checks an email allowlist and never stores a
 * token: the backend verifies the identity and enforces the configured
 * owner, and the session lives in a cookie.
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
    if (email.toLowerCase() === 'technicalmahmudull@gmail.com') return 'মাহমুদুল হাসান ওয়ালিদ';
    var local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
    return local ? local.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : 'Owner';
  }

  function showLogin() {
    document.getElementById('loginView').classList.remove('hidden', 'login-exit');
    document.getElementById('appView').classList.add('hidden');
    var card = document.getElementById('loginCard');
    if (card) card.classList.remove('shake');
    var err = document.getElementById('loginError');
    if (err) err.classList.add('hidden');
    // Remember me: prefill the saved User ID, if the owner asked for it.
    try {
      var saved = localStorage.getItem('mydimension-remember-user');
      var userInput = document.getElementById('loginUsername');
      var remember = document.getElementById('rememberMe');
      if (userInput && saved) {
        userInput.value = saved;
        if (remember) remember.checked = true;
      }
    } catch (e) { /* private mode; login still works */ }
    refreshPasswordHint();
  }

  // If no password is set up yet, tell the owner to use Google first
  // and set a password in Settings. (Boolean only — no secret leaks.)
  async function refreshPasswordHint() {
    var hint = document.getElementById('passwordHint');
    if (!hint) return;
    try {
      var st = await window.MyDimensionApi.getPasswordStatus();
      if (st && st.password_set === false) {
        hint.textContent = 'No password set yet — sign in with Google below, then set a password in Settings.';
        hint.classList.remove('hidden');
      } else {
        hint.classList.add('hidden');
      }
    } catch (e) { /* hint stays hidden; login still works */ }
  }

  function showLoginError(message) {
    var err = document.getElementById('loginError');
    if (!err) return;
    err.textContent = message;
    err.classList.remove('hidden');
    // Wrong credentials: the card shakes lightly (video-style feedback).
    var card = document.getElementById('loginCard');
    if (card) {
      card.classList.remove('shake');
      void card.offsetWidth; // restart the animation
      card.classList.add('shake');
    }
  }

  // User ID + Password sign-in. On success the session cookie is set
  // by the server; re-check /api/me to enter the app.
  async function loginPassword(username, password) {
    if (!username || !password) {
      showLoginError('Please enter your User ID and password.');
      return false;
    }
    try {
      await window.MyDimensionApi.loginPassword(username, password);
      // Success: let the login card fade out, then enter the app.
      var wrap = document.getElementById('loginView');
      if (wrap) wrap.classList.add('login-exit');
      await new Promise(function (res) { setTimeout(res, 320); });
      var user = await checkAuth();
      if (user) {
        try {
          var remember = document.getElementById('rememberMe');
          if (remember && remember.checked) localStorage.setItem('mydimension-remember-user', username);
          else localStorage.removeItem('mydimension-remember-user');
        } catch (e) { /* private mode; login still works */ }
      }
      return !!user;
    } catch (err) {
      // Generic message only — never says whether the ID or the
      // password was wrong (the server does not either).
      showLoginError(err && err.message ? err.message : 'User ID or password is incorrect. Please try again.');
      return false;
    }
  }

  // Set / change the password from Settings (signed-in admin only).
  // Returns true on success; the password is never logged or displayed.
  async function setPassword(newPassword, confirmPassword) {
    if (!newPassword || newPassword.length < 4) {
      return { ok: false, message: 'Password must be at least 4 characters.' };
    }
    if (newPassword !== confirmPassword) {
      return { ok: false, message: 'The two passwords do not match.' };
    }
    try {
      await window.MyDimensionApi.setPassword(newPassword);
      return { ok: true, message: 'Password saved. You can now sign in with your User ID and password.' };
    } catch (err) {
      return { ok: false, message: err && err.message ? err.message : 'Could not save the password. Please try again.' };
    }
  }

  function showApp(user) {
    currentUser = user || null;
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('appView').classList.remove('hidden');
    renderProfile(user);
    // After a fresh login the router does not run on its own (it only
    // runs on page load and on hash changes), so render the current
    // route now — otherwise the dashboard stays empty until the user
    // clicks a menu item.
    if (window.MyDimensionApp && window.MyDimensionApp.showRoute) {
      window.MyDimensionApp.showRoute();
    } else if (!window.location.hash) {
      window.location.hash = '#/dashboard';
    }
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
    loginPassword: loginPassword, setPassword: setPassword,
    refreshPasswordHint: refreshPasswordHint,
    getUser: function () { return currentUser; },
    displayName: displayName, refreshServiceStatus: refreshServiceStatus
  };
})();
