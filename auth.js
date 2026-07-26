(() => {
  const api = async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'The server could not complete that request.');
    return body;
  };
  window.everAfterApi = api;
  const topActions = document.querySelector('.top-actions');
  if (!topActions) return;
  const appShell = document.querySelector('.app-shell');
  document.body.insertAdjacentHTML('afterbegin', `<section class="auth-gate" id="auth-gate"><div class="auth-gate-card"><p class="eyebrow">ANDREA & NASH</p><h1>Welcome to our wedding workspace.</h1><p>Sign in to plan together, track the details, and keep every decision in one private place.</p><div class="auth-gate-actions"><button class="add-button" id="gate-sign-in">Sign in</button><button class="secondary-button hidden" id="gate-create-account">Create owner account</button></div><small id="gate-help">Your access is protected by Cloudflare and your personal planner account.</small></div></section>`);
  topActions.insertAdjacentHTML('afterbegin', `<button class="account-button hidden" id="manage-people" type="button">People & access</button><button class="account-button" id="open-account" type="button">Sign in</button><button class="account-button hidden" id="sign-out" type="button">Sign out</button>`);
  document.body.insertAdjacentHTML('beforeend', `<dialog class="auth-dialog" id="account-modal"><button class="close-modal" type="button" aria-label="Close">×</button><p class="eyebrow">SHARED WORKSPACE</p><h2 id="account-title">Sign in</h2><p class="auth-help hidden" id="invite-help"></p><form id="account-form"><label>Email<input name="email" type="email" autocomplete="email" required /></label><label>Password<input name="password" type="password" autocomplete="current-password" minlength="12" required /></label><div class="register-only hidden"><label>Your name<input name="displayName" autocomplete="name" /></label><label class="workspace-name">Wedding workspace name<input name="weddingName" placeholder="e.g. Andrea & Nash" /></label></div><p class="auth-error" id="account-error"></p><button class="add-button" type="submit" id="account-submit">Sign in</button><button class="auth-switch" type="button" id="account-switch">Create an account</button></form></dialog>
  <dialog class="auth-dialog people-dialog" id="people-modal"><button class="close-modal" type="button" aria-label="Close">×</button><p class="eyebrow">COLLABORATION</p><h2>People & access</h2><p class="auth-help">Cloudflare controls who reaches the site. Add the same email to Cloudflare Access before sharing an invitation.</p><form id="invite-form" class="invite-form"><label>Email<input name="email" type="email" required placeholder="family@example.com" /></label><label>Role<select name="role"><option value="contributor">Contributor</option><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="owner">Owner</option></select></label><label>Expires in<select name="expiresInDays"><option value="14">14 days</option><option value="7">7 days</option><option value="30">30 days</option></select></label><button class="add-button" type="submit">Create invitation</button></form><p class="auth-error" id="people-error"></p><div class="people-section"><p class="eyebrow">MEMBERS</p><div id="member-list"></div></div><div class="people-section"><p class="eyebrow">PENDING INVITATIONS</p><div id="invitation-list"></div></div></dialog>`);

  const button = document.querySelector('#open-account');
  const signOutButton = document.querySelector('#sign-out');
  const peopleButton = document.querySelector('#manage-people');
  const modal = document.querySelector('#account-modal');
  const peopleModal = document.querySelector('#people-modal');
  const form = document.querySelector('#account-form');
  const title = document.querySelector('#account-title');
  const error = document.querySelector('#account-error');
  const submit = document.querySelector('#account-submit');
  const registerFields = document.querySelector('.register-only');
  const workspaceName = document.querySelector('.workspace-name');
  const switcher = document.querySelector('#account-switch');
  const inviteHelp = document.querySelector('#invite-help');
  let registering = false;
  let user = null;
  let workspace = null;
  let workspaceRegistrationOpen = false;
  let inviteToken = new URLSearchParams(location.search).get('invite');

  const setGate = open => {
    document.body.classList.toggle('app-authenticated', !open);
    appShell.inert = open;
    document.querySelector('#auth-gate').classList.toggle('hidden', !open);
  };

  const setMode = mode => {
    registering = mode === 'register';
    const joining = registering && Boolean(inviteToken);
    title.textContent = joining ? 'Join wedding workspace' : registering ? 'Create your workspace' : 'Sign in';
    submit.textContent = joining ? 'Join workspace' : registering ? 'Create account' : 'Sign in';
    switcher.textContent = registering ? 'I already have an account' : 'Create an account';
    registerFields.classList.toggle('hidden', !registering);
    workspaceName.classList.toggle('hidden', joining);
    form.elements.displayName.required = registering;
    form.elements.weddingName.required = registering && !joining;
    form.elements.password.autocomplete = registering ? 'new-password' : 'current-password';
    inviteHelp.classList.toggle('hidden', !joining);
    if (joining) inviteHelp.textContent = 'Use the same email address the owner invited. After joining, this link will stop working.';
    switcher.classList.toggle('hidden', !joining && !workspaceRegistrationOpen);
    error.textContent = '';
  };
  const clearInviteFromUrl = () => { inviteToken = null; const url = new URL(location.href); url.searchParams.delete('invite'); history.replaceState({}, '', url); };
  const renderCollaboration = async () => {
    if (!workspace || workspace.role !== 'owner') return;
    const data = await api(`/api/weddings/${workspace.id}/collaboration`);
    document.querySelector('#member-list').innerHTML = data.members.map(member => `<div class="person-row"><div><strong>${escapeHtml(member.display_name)}</strong><small>${escapeHtml(member.email)}</small></div><select data-member-role="${member.id}">${['owner','editor','contributor','viewer'].map(role => `<option value="${role}" ${role === member.role ? 'selected' : ''}>${role}</option>`).join('')}</select>${member.id === user.id ? '' : '<button type="button" class="text-button" data-remove-member="' + member.id + '">Remove</button>'}</div>`).join('') || '<p class="auth-help">No members yet.</p>';
    document.querySelector('#invitation-list').innerHTML = data.invitations.map(invitation => `<div class="person-row"><div><strong>${escapeHtml(invitation.email)}</strong><small>${invitation.role} · expires ${new Date(invitation.expires_at).toLocaleDateString()}</small></div><button type="button" class="text-button" data-revoke-invitation="${invitation.id}">Revoke</button></div>`).join('') || '<p class="auth-help">No pending invitations.</p>';
  };
  const openPeople = async () => {
    if (!workspace || workspace.role !== 'owner') return;
    document.querySelector('#people-error').textContent = '';
    peopleModal.showModal();
    try { await renderCollaboration(); } catch (requestError) { document.querySelector('#people-error').textContent = requestError.message; }
  };
  const refresh = async () => {
    try {
      const result = await api('/api/auth/me');
      if (result.user) {
        user = result.user;
        window.everAfterUser = user;
        const workspaces = await api('/api/weddings');
        workspace = workspaces.weddings[0] || null;
        if (inviteToken) {
          try { await api('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token: inviteToken }) }); clearInviteFromUrl(); return refresh(); }
          catch (requestError) { modal.showModal(); setMode('login'); error.textContent = requestError.message; }
        }
        window.everAfterWorkspaceId = workspace?.id || null;
        setGate(false);
        window.dispatchEvent(new CustomEvent('ever-after-auth-changed', { detail: { user, workspace } }));
        button.textContent = user.display_name;
        button.title = `Signed in as ${user.email}`;
        button.onclick = null;
        signOutButton.classList.remove('hidden');
        signOutButton.onclick = async event => {
          event.preventDefault();
          event.stopPropagation();
          signOutButton.disabled = true;
          try {
            await api('/api/auth/logout', { method: 'POST' });
            location.replace(location.pathname);
          } catch (requestError) {
            window.alert(`Could not sign out: ${requestError.message}`);
            signOutButton.disabled = false;
          }
        };
        peopleButton.classList.toggle('hidden', workspace?.role !== 'owner');
        renderTeamSummary();
        return;
      }
    } catch { /* The local demo remains usable when the API is unavailable. */ }
    try { workspaceRegistrationOpen = (await api('/api/auth/setup')).workspaceCreationOpen; } catch { workspaceRegistrationOpen = false; }
    user = null; workspace = null; window.everAfterUser = null; window.everAfterWorkspaceId = null; setGate(true);
    document.querySelector('#team-list').innerHTML = '<p class="empty-state">Sign in to see the people planning with you.</p>';
    peopleButton.classList.add('hidden'); signOutButton.classList.add('hidden'); button.textContent = 'Sign in'; button.title = 'Sign in to the production workspace';
    button.onclick = () => { setMode(inviteToken ? 'register' : 'login'); modal.showModal(); };
    document.querySelector('#gate-create-account').classList.toggle('hidden', !workspaceRegistrationOpen);
    if (inviteToken) { setMode('register'); modal.showModal(); }
  };
  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
  const renderTeamSummary = async () => {
    const list = document.querySelector('#team-list');
    const inviteControls = [document.querySelector('#invite-button'), document.querySelector('#invite-wide')];
    if (!user || !workspace) { list.innerHTML = '<p class="empty-state">Sign in to see the people planning with you.</p>'; return; }
    let members = [{ ...user, role: workspace.role }];
    if (workspace.role === 'owner') {
      try { members = (await api(`/api/weddings/${workspace.id}/collaboration`)).members; } catch { /* Keep the signed-in owner visible if the request is unavailable. */ }
    }
    list.innerHTML = members.map(member => {
      const initials = (member.display_name || member.email).split(/\s+/).map(part => part[0] || '').join('').slice(0, 2).toUpperCase();
      const label = member.role[0].toUpperCase() + member.role.slice(1);
      return `<div class="team-list"><span class="avatar sage">${escapeHtml(initials)}</span><div><strong>${escapeHtml(member.display_name)}</strong><small>${label}</small></div>${member.id === user.id ? '<span class="status">You</span>' : ''}</div>`;
    }).join('');
    inviteControls.forEach(control => control.classList.toggle('hidden', workspace.role !== 'owner'));
  };

  document.querySelector('#account-modal .close-modal').onclick = () => modal.close();
  document.querySelector('#people-modal .close-modal').onclick = () => peopleModal.close();
  peopleButton.onclick = openPeople;
  document.querySelector('#gate-sign-in').onclick = () => { setMode(inviteToken ? 'register' : 'login'); modal.showModal(); };
  document.querySelector('#gate-create-account').onclick = () => { setMode('register'); modal.showModal(); };
  document.querySelector('#invite-button').onclick = openPeople;
  document.querySelector('#invite-wide').onclick = openPeople;
  switcher.onclick = () => setMode(registering ? 'login' : 'register');
  form.addEventListener('submit', async event => {
    event.preventDefault(); error.textContent = ''; submit.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      if (registering && inviteToken) values.invitationToken = inviteToken;
      await api(registering ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(values) });
      modal.close(); form.reset(); if (registering && inviteToken) clearInviteFromUrl(); setMode('login'); await refresh();
    } catch (requestError) { error.textContent = requestError.message; }
    finally { submit.disabled = false; }
  });
  document.querySelector('#invite-form').addEventListener('submit', async event => {
    event.preventDefault();
    const inviteForm = event.currentTarget;
    const peopleError = document.querySelector('#people-error'); peopleError.textContent = '';
    try {
      const values = Object.fromEntries(new FormData(inviteForm));
      values.expiresInDays = Number(values.expiresInDays);
      const result = await api(`/api/weddings/${workspace.id}/invitations`, { method: 'POST', body: JSON.stringify(values) });
      const link = new URL(location.href); link.searchParams.set('invite', result.token);
      await navigator.clipboard?.writeText(link.toString());
      window.prompt('Copy this private invitation link and send it only to the invited person:', link.toString());
      inviteForm.reset(); await renderCollaboration();
    } catch (requestError) { peopleError.textContent = requestError.message; }
  });
  document.querySelector('#people-modal').addEventListener('change', async event => {
    const control = event.target.closest('[data-member-role]'); if (!control) return;
    try { await api(`/api/weddings/${workspace.id}/members/${control.dataset.memberRole}`, { method: 'PATCH', body: JSON.stringify({ role: control.value }) }); await renderCollaboration(); }
    catch (requestError) { document.querySelector('#people-error').textContent = requestError.message; await renderCollaboration(); }
  });
  document.querySelector('#people-modal').addEventListener('click', async event => {
    const revoke = event.target.closest('[data-revoke-invitation]');
    const remove = event.target.closest('[data-remove-member]');
    if (!revoke && !remove) return;
    try {
      if (revoke) await api(`/api/weddings/${workspace.id}/invitations/${revoke.dataset.revokeInvitation}`, { method: 'DELETE' });
      if (remove && window.confirm('Remove this person from the wedding workspace?')) await api(`/api/weddings/${workspace.id}/members/${remove.dataset.removeMember}`, { method: 'DELETE' });
      await renderCollaboration();
    } catch (requestError) { document.querySelector('#people-error').textContent = requestError.message; }
  });
  setMode(inviteToken ? 'register' : 'login');
  refresh();
})();
