import { api, getToken, setToken } from './api.js';

/** Admin login state, the password dialog and the "관리자 모드" badge. */
export class AdminController extends EventTarget {
  constructor({ button, badge, modal, toast }) {
    super();
    this.button = button;
    this.badge = badge;
    this.modal = modal;
    this.toast = toast;
    this.form = modal.querySelector('form');
    this.input = modal.querySelector('input[name="password"]');
    this.error = modal.querySelector('.form-error');
    this.pending = null;
    this.isAdmin = false;

    button.addEventListener('click', () => this.openLogin());
    badge.querySelector('[data-act="logout"]').addEventListener('click', () => this.logout());
    modal.querySelector('[data-act="cancel"]').addEventListener('click', () => this.closeLogin(false));
    modal.addEventListener('pointerdown', (e) => {
      if (e.target === modal) this.closeLogin(false);
    });
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeLogin(false);
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.setAdmin(Boolean(getToken()));
  }

  /** Confirm a saved login with the server (the password may have been changed since). */
  async verify() {
    if (!getToken()) return this.setAdmin(false);
    try {
      await api.checkSession();
      this.setAdmin(true);
    } catch (err) {
      if (err.status === 401) this.setAdmin(false);
    }
  }

  setAdmin(on) {
    const changed = on !== this.isAdmin;
    this.isAdmin = on;
    this.button.hidden = on;
    this.badge.hidden = !on;
    document.body.classList.toggle('is-admin', on);
    if (changed) this.dispatchEvent(new CustomEvent('change', { detail: { isAdmin: on } }));
  }

  /** Shows the password dialog. Resolves true once logged in, false if cancelled. */
  openLogin({ message } = {}) {
    if (this.pending) return this.pending.promise;
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    this.pending = { promise, resolve };
    this.error.textContent = message || '';
    this.input.value = '';
    this.modal.hidden = false;
    setTimeout(() => this.input.focus(), 30);
    return promise;
  }

  closeLogin(result) {
    this.modal.hidden = true;
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(result);
  }

  async submit() {
    const password = this.input.value;
    if (!password) {
      this.error.textContent = '비밀번호를 입력하세요.';
      return;
    }
    const btn = this.form.querySelector('button[type="submit"]');
    btn.disabled = true;
    this.error.textContent = '';
    try {
      setToken(await api.login(password));
      this.setAdmin(true);
      this.closeLogin(true);
      this.toast('관리자 모드가 켜졌습니다. 오른쪽 아래 "식물 추가"로 등록하세요.');
    } catch (err) {
      this.error.textContent = err.message;
      this.input.select();
    } finally {
      btn.disabled = false;
    }
  }

  logout() {
    setToken(null);
    this.setAdmin(false);
    this.toast('로그아웃했습니다.');
  }

  /** Called when the server rejects the saved token. */
  expired() {
    setToken(null);
    this.setAdmin(false);
  }
}
