/**
 * A toast in the corner: the one implementation for the dashboard and editor.
 */

import { Toast } from 'bootstrap';
import { escapeHtml } from './html.js';

/**
 * Bootstrap's colour names, from whatever a caller passed. `error` is what
 * half the call sites say, and `text-bg-error` is not a class Bootstrap has.
 */
const VARIANTS = new Set(['primary', 'secondary', 'success', 'danger', 'warning', 'info', 'light', 'dark']);

function variantFor(type) {
  const aliases = { error: 'danger', warn: 'warning', notice: 'info' };
  const variant = aliases[type] || type;
  return VARIANTS.has(variant) ? variant : 'info';
}

/**
 * @param {string} message
 * @param {string} [type] a Bootstrap colour name, or `error`
 * @param {number} [delay] milliseconds; longer for anything telling somebody
 *        what to do next
 */
export function showToast(message, type = 'info', delay = 5000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container position-fixed top-0 end-0 p-3';
    document.body.appendChild(container);
  }

  const variant = variantFor(type);
  const urgent = variant === 'danger' || variant === 'warning';
  const wrapper = document.createElement('div');
  wrapper.className = `toast align-items-center text-bg-${variant} border-0`;
  wrapper.setAttribute('role', urgent ? 'alert' : 'status');
  wrapper.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
  wrapper.setAttribute('aria-atomic', 'true');
  wrapper.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${escapeHtml(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  container.appendChild(wrapper);

  const toast = new Toast(wrapper, { delay });
  toast.show();
  wrapper.addEventListener('hidden.bs.toast', () => wrapper.remove());
}
