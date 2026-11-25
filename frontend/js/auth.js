/* MyDimension — js/auth.js
 * Two sign-in methods, both verified by the backend only:
 *   1. User ID + Password (POST /api/auth/login) — the primary form.
 *   2. Google OAuth (GET /auth/google/login) — alternative below it.
 * The frontend never checks an email allowlist and never stores a
 * token: the backend verifies the identity and enforces the configured
 * owner, and the session lives in a cookie.
 * /api/me returns { email, is_owner, name? } — when the server sends a
 * name it is shown as-is; otherwise the display name is derived from
 * the owner email for the greeting/sidebar, and service status
 * (Drive / Gemini / database) comes from the public /health endpoint.
 */
(function () {
  'use strict';

  var currentUser = null;

  // Sign-up state: the email waiting for a verification code, and the
  // 60-second resend countdown.
  var pendingVerifyEmail = null;
  var resendTimer = null;
  var resendSecondsLeft = 0;

  // Password-reset state: the email waiting for a reset code.
  var pendingResetEmail = null;

  // i18n shortcut (falls back to the key itself when i18n is absent).
  function tr(key, vars) {
    return window.MyDimensionI18n ? window.MyDimensionI18n.t(key, vars) : key;
  }

  // Display name for the known owner account; any other owner email is
  // prettified from its local part. Display only — never an auth check.
  // The owner's name follows the app language: English in English mode,
  // Bengali in Bengali mode.
  function displayName(email) {
    if (!email) return 'Owner';
    if (email.toLowerCase() === 'technicalmahmudull@gmail.com') {
      return (window.MyDimensionI18n && window.MyDimensionI18n.getLanguage() === 'bn')
        ? 'মাহমুদুল হাসান ওয়ালিদ' : 'Mahmudul Hasan Walid';
    }
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
    // Always land on the Login face, never mid-sign-up / verification.
    resetAuthFlip();
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

  // If no password is set up yet, say so. (Boolean only — no secret
  // leaks. Login is User ID + password only for now; no Google link
  // is shown on the login page.)
  async function refreshPasswordHint() {
    var hint = document.getElementById('passwordHint');
    if (!hint) return;
    try {
      var st = await window.MyDimensionApi.getPasswordStatus();
      if (st && st.password_set === false) {
        hint.textContent = window.MyDimensionI18n ? window.MyDimensionI18n.t('auth.noPassword') : 'No password is set yet. Sign-in is not available until a password is set.';
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

  function hideLoginError() {
    var err = document.getElementById('loginError');
    if (err) err.classList.add('hidden');
  }
  function showSignupError(message) {
    var err = document.getElementById('signupError');
    if (!err) return;
    err.textContent = message;
    err.classList.remove('hidden');
  }
  function hideSignupError() {
    var err = document.getElementById('signupError');
    if (err) err.classList.add('hidden');
  }
  function showVerifyError(message) {
    var err = document.getElementById('verifyError');
    if (!err) return;
    err.textContent = message;
    err.classList.remove('hidden');
  }
  function hideVerifyError() {
    var err = document.getElementById('verifyError');
    if (err) err.classList.add('hidden');
  }
  function showResetError(message) {
    var err = document.getElementById('resetError');
    if (!err) return;
    err.textContent = message;
    err.classList.remove('hidden');
  }
  function hideResetError() {
    var err = document.getElementById('resetError');
    if (err) err.classList.add('hidden');
  }

  // Back to the Login face: hide the sign-up / verification / reset
  // panels, clear their errors and stop any resend countdown.
  function resetAuthFlip() {
    var flip = document.getElementById('authFlip');
    if (flip) flip.classList.remove('flipped');
    var signup = document.getElementById('signupForm');
    if (signup) signup.classList.remove('hidden');
    var panel = document.getElementById('verifyPanel');
    if (panel) panel.classList.add('hidden');
    var reset = document.getElementById('resetPanel');
    if (reset) reset.classList.add('hidden');
    var forgot = document.getElementById('forgotForm');
    if (forgot) forgot.classList.remove('hidden');
    var resetForm = document.getElementById('resetForm');
    if (resetForm) resetForm.classList.add('hidden');
    pendingResetEmail = null;
    hideSignupError();
    hideVerifyError();
    hideResetError();
    stopResendCountdown();
  }

  // Flip to the Sign Up face (errors cleared).
  function showSignup() {
    hideLoginError();
    hideSignupError();
    hideVerifyError();
    hideResetError();
    var panel = document.getElementById('verifyPanel');
    if (panel) panel.classList.add('hidden');
    var reset = document.getElementById('resetPanel');
    if (reset) reset.classList.add('hidden');
    var form = document.getElementById('signupForm');
    if (form) form.classList.remove('hidden');
    var flip = document.getElementById('authFlip');
    if (flip) flip.classList.add('flipped');
    var name = document.getElementById('signupName');
    if (name) name.focus();
  }

  // Flip to the back face and show the password-reset panel instead
  // of the sign-up form (step 1: ask for the email).
  function showForgot() {
    hideLoginError();
    hideSignupError();
    hideVerifyError();
    hideResetError();
    var form = document.getElementById('signupForm');
    if (form) form.classList.add('hidden');
    var panel = document.getElementById('verifyPanel');
    if (panel) panel.classList.add('hidden');
    var reset = document.getElementById('resetPanel');
    if (reset) reset.classList.remove('hidden');
    var forgot = document.getElementById('forgotForm');
    if (forgot) forgot.classList.remove('hidden');
    var resetForm = document.getElementById('resetForm');
    if (resetForm) resetForm.classList.add('hidden');
    pendingResetEmail = null;
    var flip = document.getElementById('authFlip');
    if (flip) flip.classList.add('flipped');
    var email = document.getElementById('resetEmail');
    if (email) email.focus();
  }

  // Flip back to the Login face (errors cleared).
  function showLoginForm() {
    hideLoginError();
    resetAuthFlip();
    var user = document.getElementById('loginUsername');
    if (user) user.focus();
  }

  // The verification hint sentence, rebuilt from the i18n string so
  // the wording follows the app language — with #verifyEmail kept as
  // the email itself inside the sentence.
  function updateVerifyHint(email) {
    var hint = document.getElementById('verifyHint');
    var emailEl = document.getElementById('verifyEmail');
    if (!hint || !emailEl) return;
    emailEl.textContent = email;
    var msg = tr('auth.verifyHint', { email: '\u0000' });
    var parts = msg.split('\u0000');
    hint.textContent = '';
    hint.appendChild(document.createTextNode(parts[0] || ''));
    hint.appendChild(emailEl);
    hint.appendChild(document.createTextNode(parts[1] || ''));
  }

  function updateResendButton() {
    var btn = document.getElementById('resendCodeBtn');
    if (!btn) return;
    if (resendSecondsLeft > 0) {
      btn.disabled = true;
      btn.textContent = tr('auth.resendIn', { seconds: resendSecondsLeft });
    } else {
      btn.disabled = false;
      btn.textContent = tr('auth.resend');
    }
  }

  function stopResendCountdown() {
    if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
    resendSecondsLeft = 0;
    updateResendButton();
  }

  function startResendCountdown() {
    stopResendCountdown();
    resendSecondsLeft = 60;
    updateResendButton();
    resendTimer = setInterval(function () {
      resendSecondsLeft -= 1;
      if (resendSecondsLeft <= 0) { stopResendCountdown(); return; }
      updateResendButton();
    }, 1000);
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Sign-up submit: validate locally, then ask the backend to send a
  // verification code. On success the form is replaced by the
  // verification panel (still on the back face of the flip).
  async function submitSignup(e) {
    e.preventDefault();
    hideSignupError();
    var name = document.getElementById('signupName').value.trim();
    var email = document.getElementById('signupEmail').value.trim().toLowerCase();
    var password = document.getElementById('signupPassword').value;
    var confirm = document.getElementById('signupConfirm').value;
    if (!name) { showSignupError(tr('auth.nameRequired')); return; }
    if (!EMAIL_RE.test(email)) { showSignupError(tr('auth.invalidEmail')); return; }
    if (password.length < 4) {
      showSignupError(window.MyDimensionI18n && window.MyDimensionI18n.getLanguage() === 'bn'
        ? 'পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে।'
        : 'Password must be at least 4 characters.');
      return;
    }
    if (password !== confirm) { showSignupError(tr('auth.passwordsNoMatch')); return; }
    var btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    try {
      var res = await window.MyDimensionApi.register(name, email, password);
      pendingVerifyEmail = (res && res.email) ? res.email : email;
      document.getElementById('signupForm').classList.add('hidden');
      document.getElementById('verifyPanel').classList.remove('hidden');
      updateVerifyHint(pendingVerifyEmail);
      var code = document.getElementById('verifyCode');
      if (code) { code.value = ''; code.focus(); }
      // The backend refuses a new code for 60 seconds after sending one.
      startResendCountdown();
    } catch (err) {
      showSignupError(err && err.message ? err.message : 'Could not create the account. Please try again.');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    }
  }

  // Verification submit: a correct 6-digit code signs the new user in,
  // exactly like a successful password login (fade out, then checkAuth).
  async function submitVerify(e) {
    e.preventDefault();
    hideVerifyError();
    var codeEl = document.getElementById('verifyCode');
    var code = codeEl ? codeEl.value.trim() : '';
    if (!/^\d{6}$/.test(code)) {
      showVerifyError(tr('auth.enterCode'));
      if (codeEl) codeEl.focus();
      return;
    }
    if (!pendingVerifyEmail) { showVerifyError(tr('auth.enterCode')); return; }
    var btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    try {
      await window.MyDimensionApi.verifyCode(pendingVerifyEmail, code);
      var wrap = document.getElementById('loginView');
      if (wrap) wrap.classList.add('login-exit');
      await new Promise(function (res) { setTimeout(res, 320); });
      await checkAuth();
    } catch (err) {
      showVerifyError(err && err.message ? err.message : 'That code is incorrect. Please try again.');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    }
  }

  async function resendCode() {
    if (!pendingVerifyEmail || resendSecondsLeft > 0) return;
    hideVerifyError();
    try {
      await window.MyDimensionApi.resendCode(pendingVerifyEmail);
      if (window.MyDimensionApp && window.MyDimensionApp.toast) {
        window.MyDimensionApp.toast(tr('auth.codeSent'));
      }
      startResendCountdown();
      var code = document.getElementById('verifyCode');
      if (code) code.focus();
    } catch (err) {
      showVerifyError(err && err.message ? err.message : 'Could not resend the code. Please try again.');
    }
  }

  // Forgot password, step 1: ask for the reset code. The server
  // always answers 200 (it never says whether the account exists), so
  // step 2 is shown either way; a real account gets the code by email.
  async function submitForgot(e) {
    e.preventDefault();
    hideResetError();
    var emailEl = document.getElementById('resetEmail');
    var email = emailEl ? emailEl.value.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) { showResetError(tr('auth.invalidEmail')); return; }
    var btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    try {
      await window.MyDimensionApi.forgotPassword(email);
      pendingResetEmail = email;
      var emailStrong = document.getElementById('resetCodeEmail');
      if (emailStrong) emailStrong.textContent = email;
      updateResetCodeHint(email);
      document.getElementById('forgotForm').classList.add('hidden');
      document.getElementById('resetForm').classList.remove('hidden');
      var code = document.getElementById('resetCode');
      if (code) { code.value = ''; code.focus(); }
    } catch (err) {
      showResetError(err && err.message ? err.message : 'Could not send the reset code. Please try again.');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    }
  }

  // The reset-code hint sentence, rebuilt from the i18n string so the
  // wording follows the app language — same pattern as updateVerifyHint.
  function updateResetCodeHint(email) {
    var hint = document.getElementById('resetCodeHint');
    var emailEl = document.getElementById('resetCodeEmail');
    if (!hint || !emailEl) return;
    emailEl.textContent = email;
    var msg = tr('auth.resetCodeHint', { email: '\u0000' });
    var parts = msg.split('\u0000');
    hint.textContent = '';
    hint.appendChild(document.createTextNode(parts[0] || ''));
    hint.appendChild(emailEl);
    hint.appendChild(document.createTextNode(parts[1] || ''));
  }

  // Forgot password, step 2: code + new password. On success the card
  // flips back to the login form (the new password works from there).
  async function submitReset(e) {
    e.preventDefault();
    hideResetError();
    var codeEl = document.getElementById('resetCode');
    var code = codeEl ? codeEl.value.trim() : '';
    var newPassword = document.getElementById('resetNewPassword').value;
    var confirm = document.getElementById('resetConfirmPassword').value;
    if (!/^\d{6}$/.test(code)) {
      showResetError(tr('auth.enterCode'));
      if (codeEl) codeEl.focus();
      return;
    }
    if (!pendingResetEmail) { showResetError(tr('auth.enterCode')); return; }
    if (newPassword.length < 4) { showResetError(tr('auth.passwordTooShort')); return; }
    if (newPassword !== confirm) { showResetError(tr('auth.passwordsNoMatch')); return; }
    var btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    try {
      await window.MyDimensionApi.resetPassword(pendingResetEmail, code, newPassword);
      if (window.MyDimensionApp && window.MyDimensionApp.toast) {
        window.MyDimensionApp.toast(tr('auth.resetSuccess'));
      }
      showLoginForm();
    } catch (err) {
      showResetError(err && err.message ? err.message : 'That code is incorrect. Please try again.');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
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

  // Change the password from Settings (signed in). The current
  // password is checked first; returns true on success. The password
  // is never logged or displayed.
  async function changePassword(currentPassword, newPassword, confirmPassword) {
    if (!currentPassword) {
      return { ok: false, message: tr('auth.currentPasswordRequired') };
    }
    if (!newPassword || newPassword.length < 4) {
      return { ok: false, message: tr('auth.passwordTooShort') };
    }
    if (newPassword !== confirmPassword) {
      return { ok: false, message: tr('auth.passwordsNoMatch') };
    }
    try {
      await window.MyDimensionApi.changePassword(currentPassword, newPassword);
      return { ok: true, message: tr('auth.passwordChanged') };
    } catch (err) {
      return { ok: false, message: err && err.message ? err.message : 'Could not change the password. Please try again.' };
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
    // The name from the server is shown as-is for registered users.
    // For the owner, the stored name is always the English one, so use
    // the language-aware display name instead — otherwise the greeting
    // would never follow the app language (English / Bengali).
    var isOwner = user && (user.is_owner || (user.email && user.email.toLowerCase() === 'technicalmahmudull@gmail.com'));
    var name = isOwner ? displayName(user.email) : ((user && user.name) ? user.name : displayName(user.email));
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

  // Service status lives on /health: { ai_configured, storage }.
  // Drive status is per user (/api/drive/status): each user connects
  // their own Google Drive in Settings.
  async function refreshServiceStatus() {
    try {
      var h = await window.MyDimensionApi.getHealth();
      setStatus('geminiStatus', !!h.ai_configured, 'Configured', 'Not configured');
      setStatus('dbStatus', h.storage === 'postgresql', 'PostgreSQL connected', 'Not using PostgreSQL');
    } catch (e) { /* status stays Unknown; the app still works */ }
    try {
      var d = await window.MyDimensionApi.driveStatus();
      setStatus('driveStatus', !!d.connected, 'Connected', 'Not connected');
      var dc = document.getElementById('driveConnectBtn'), dd = document.getElementById('driveDisconnectBtn');
      if (dc) dc.classList.toggle('hidden', !!d.connected);
      if (dd) dd.classList.toggle('hidden', !d.connected);
    } catch (e) { /* drive status stays Unknown */ }
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

  // When the app language changes, refresh the displayed name so it
  // follows the new language too (English name in English mode, Bengali
  // name in Bengali mode).
  document.addEventListener('mydimension:language', function () {
    if (currentUser) renderProfile(currentUser);
    var panel = document.getElementById('verifyPanel');
    if (pendingVerifyEmail && panel && !panel.classList.contains('hidden')) {
      updateVerifyHint(pendingVerifyEmail);
    }
    var resetForm = document.getElementById('resetForm');
    if (pendingResetEmail && resetForm && !resetForm.classList.contains('hidden')) {
      updateResetCodeHint(pendingResetEmail);
    }
    if (resendSecondsLeft > 0) updateResendButton();
  });

  // Sign-up / verification controls (login form wiring lives in app.js
  // and is untouched).
  var showSignupBtn = document.getElementById('showSignupBtn');
  if (showSignupBtn) showSignupBtn.addEventListener('click', showSignup);
  var showLoginBtn = document.getElementById('showLoginBtn');
  if (showLoginBtn) showLoginBtn.addEventListener('click', showLoginForm);
  var signupForm = document.getElementById('signupForm');
  if (signupForm) signupForm.addEventListener('submit', submitSignup);
  var verifyForm = document.getElementById('verifyForm');
  if (verifyForm) verifyForm.addEventListener('submit', submitVerify);
  var resendBtn = document.getElementById('resendCodeBtn');
  if (resendBtn) resendBtn.addEventListener('click', resendCode);
  var diffEmailBtn = document.getElementById('useDifferentEmailBtn');
  if (diffEmailBtn) diffEmailBtn.addEventListener('click', function () {
    hideVerifyError();
    stopResendCountdown();
    pendingVerifyEmail = null;
    var panel = document.getElementById('verifyPanel');
    if (panel) panel.classList.add('hidden');
    var form = document.getElementById('signupForm');
    if (form) form.classList.remove('hidden');
    var email = document.getElementById('signupEmail');
    if (email) email.focus();
  });
  // Verification code: digits only, max 6.
  var codeInput = document.getElementById('verifyCode');
  if (codeInput) codeInput.addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 6);
  });

  // Password reset controls (on the back face of the flip card).
  var forgotBtn = document.getElementById('forgotPasswordBtn');
  if (forgotBtn) forgotBtn.addEventListener('click', showForgot);
  var forgotForm = document.getElementById('forgotForm');
  if (forgotForm) forgotForm.addEventListener('submit', submitForgot);
  var resetForm = document.getElementById('resetForm');
  if (resetForm) resetForm.addEventListener('submit', submitReset);
  var showLoginFromResetBtn = document.getElementById('showLoginFromResetBtn');
  if (showLoginFromResetBtn) showLoginFromResetBtn.addEventListener('click', showLoginForm);
  var resetCodeInput = document.getElementById('resetCode');
  if (resetCodeInput) resetCodeInput.addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 6);
  });

  window.MyDimensionAuth = {
    checkAuth: checkAuth, login: login, logout: logout,
    showLogin: showLogin, showApp: showApp,
    loginPassword: loginPassword, setPassword: setPassword,
    changePassword: changePassword,
    showSignup: showSignup, showLoginForm: showLoginForm,
    showForgot: showForgot,
    refreshPasswordHint: refreshPasswordHint,
    getUser: function () { return currentUser; },
    displayName: displayName, refreshServiceStatus: refreshServiceStatus
  };
})();
