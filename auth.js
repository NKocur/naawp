(() => {
  const api = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'The server could not complete that request.');
    return body;
  };

  const topActions = document.querySelector('.top-actions');
  if (!topActions) return;
  topActions.insertAdjacentHTML('afterbegin', '<button class="account-button" id="open-account">Sign in</button>');
  document.body.insertAdjacentHTML('beforeend', `<dialog class="auth-dialog" id="account-modal"><button class="close-modal" type="button" aria-label="Close">×</button><p class="eyebrow">SHARED WORKSPACE</p><h2 id="account-title">Sign in</h2><form id="account-form"><label>Email<input name="email" type="email" autocomplete="email" required /></label><label>Password<input name="password" type="password" autocomplete="current-password" minlength="12" required /></label><div class="register-only hidden"><label>Your name<input name="displayName" autocomplete="name" /></label><label>Wedding workspace name<input name="weddingName" placeholder="e.g. Andrea & Nash" /></label></div><p class="auth-error" id="account-error"></p><button class="add-button" type="submit" id="account-submit">Sign in</button><button class="auth-switch" type="button" id="account-switch">Create an account</button></form></dialog>`);

  const button = document.querySelector('#open-account');
  const modal = document.querySelector('#account-modal');
  const form = document.querySelector('#account-form');
  const title = document.querySelector('#account-title');
  const error = document.querySelector('#account-error');
  const submit = document.querySelector('#account-submit');
  const registerFields = document.querySelector('.register-only');
  const switcher = document.querySelector('#account-switch');
  let registering = false;

  const setMode = mode => {
    registering = mode === 'register';
    title.textContent = registering ? 'Create your workspace' : 'Sign in';
    submit.textContent = registering ? 'Create account' : 'Sign in';
    switcher.textContent = registering ? 'I already have an account' : 'Create an account';
    registerFields.classList.toggle('hidden', !registering);
    form.elements.password.autocomplete = registering ? 'new-password' : 'current-password';
    form.elements.displayName.required = registering;
    form.elements.weddingName.required = registering;
    error.textContent = '';
  };
  const refresh = async () => {
    try {
      const result = await api('/api/auth/me');
      if (result.user) {
        const workspaces = await api('/api/weddings');
        const workspace = workspaces.weddings[0] || null;
        window.everAfterWorkspaceId = workspace?.id || null;
        window.dispatchEvent(new CustomEvent('ever-after-auth-changed', { detail: { user: result.user, workspace } }));
        button.textContent = result.user.display_name;
        button.onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); window.everAfterWorkspaceId = null; window.dispatchEvent(new CustomEvent('ever-after-auth-changed', { detail: { user: null, workspace: null } })); await refresh(); };
        button.title = 'Click to sign out';
        return;
      }
    } catch { /* The static demo can still run without the API. */ }
    window.everAfterWorkspaceId = null;
    button.textContent = 'Sign in';
    button.title = 'Sign in to the production workspace';
    button.onclick = () => modal.showModal();
  };
  document.querySelector('#account-modal .close-modal').onclick = () => modal.close();
  switcher.onclick = () => setMode(registering ? 'login' : 'register');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      await api(registering ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(values) });
      modal.close(); form.reset(); setMode('login'); await refresh();
    } catch (requestError) {
      error.textContent = requestError.message;
    } finally {
      submit.disabled = false;
    }
  });
  setMode('login');
  refresh();
})();
