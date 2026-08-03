import { api, post } from '../api.js';
import { h } from '../util.js';

export function renderLogin(app, onSuccess) {
  app.innerHTML = '';
  const box = h(`
    <div class="login-wrap">
      <form class="login">
        <h1>5 Circles CRM</h1>
        <div class="sub">Sales floor sign in</div>
        <div class="err" data-testid="login-error"></div>
        <label class="f">Email
          <input name="email" type="email" autocomplete="username" required data-testid="login-email">
        </label>
        <label class="f">Password
          <input name="password" type="password" autocomplete="current-password" required data-testid="login-password">
        </label>
        <button class="btn primary" type="submit" style="width:100%" data-testid="login-submit">Sign in</button>
      </form>
    </div>`);

  const form = box.querySelector('form');
  const err = box.querySelector('.err');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const email = form.email.value.trim();
    const password = form.password.value;
    try {
      const res = await api('/auth/login', { method: 'POST', body: { email, password } });
      if (res.mustChangePassword) {
        renderChangePassword(app, password, onSuccess);
        return;
      }
      onSuccess(res.user);
    } catch (ex) {
      err.textContent =
        ex.code === 'account_locked'
          ? 'Too many failed attempts — account locked for a few minutes.'
          : 'Invalid email or password.';
    }
  });

  app.appendChild(box);
  box.querySelector('input[name=email]').focus();
}

function renderChangePassword(app, currentPassword, onSuccess) {
  app.innerHTML = '';
  const box = h(`
    <div class="login-wrap">
      <form class="login">
        <h1>Set a new password</h1>
        <div class="sub">Your temporary password must be changed before you continue.</div>
        <div class="err"></div>
        <label class="f">New password <span class="hint">(at least 10 characters)</span>
          <input name="p1" type="password" autocomplete="new-password" minlength="10" required>
        </label>
        <label class="f">Repeat new password
          <input name="p2" type="password" autocomplete="new-password" minlength="10" required>
        </label>
        <button class="btn primary" type="submit" style="width:100%">Save and continue</button>
      </form>
    </div>`);

  const form = box.querySelector('form');
  const err = box.querySelector('.err');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (form.p1.value !== form.p2.value) {
      err.textContent = 'Passwords do not match.';
      return;
    }
    try {
      await post('/auth/change-password', { currentPassword, newPassword: form.p1.value });
      onSuccess();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  app.appendChild(box);
}
