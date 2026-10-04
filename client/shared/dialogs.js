/**
 * Confirmation and input dialogs that look like the rest of the product.
 *
 * `confirm()` and `prompt()` block every other script on the page - the
 * socket included, so an operator reading "End this chat?" stopped receiving
 * messages until they answered - they cannot say which button is the
 * dangerous one, and they cannot offer two different ways of doing a thing.
 */

import { Modal } from 'bootstrap';
import { escapeHtml } from './html.js';

let sequence = 0;

/**
 * Open a modal with the given body and buttons, and resolve with the value of
 * whichever button was pressed, or `null` if it was dismissed.
 */
function openDialog({ title, bodyHtml, buttons, focusSelector }) {
  sequence += 1;
  const id = `app-dialog-${sequence}`;
  const element = document.createElement('div');
  element.className = 'modal fade app-dialog';
  element.id = id;
  element.tabIndex = -1;
  element.setAttribute('aria-labelledby', `${id}-title`);
  element.setAttribute('aria-hidden', 'true');
  element.innerHTML = `
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title" id="${id}-title">${escapeHtml(title)}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer">
          ${buttons.map((button, index) => `
            <button type="button" class="btn ${button.className || 'btn-secondary'}" data-dialog-index="${index}">
              ${escapeHtml(button.label)}
            </button>`).join('')}
        </div>
      </div>
    </div>`;
  document.body.appendChild(element);

  const modal = new Modal(element);

  return new Promise(resolve => {
    let result = null;

    element.addEventListener('click', event => {
      const target = event.target.closest('[data-dialog-index]');
      if (!target) {
        return;
      }
      const button = buttons[Number(target.dataset.dialogIndex)];
      result = typeof button.value === 'function' ? button.value(element) : button.value;
      modal.hide();
    });

    // Enter in a text field means the primary button.
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target.matches('input')) {
        event.preventDefault();
        const primary = buttons.findIndex(button => button.primary);
        if (primary >= 0) {
          element.querySelector(`[data-dialog-index="${primary}"]`).click();
        }
      }
    });

    element.addEventListener('shown.bs.modal', () => {
      const focus = element.querySelector(focusSelector || '[data-dialog-index].btn-primary, [data-dialog-index].btn-danger');
      if (focus) {
        focus.focus();
        // A prefilled name is usually replaced, not appended to.
        if (focus.select) {
          focus.select();
        }
      }
    });

    element.addEventListener('hidden.bs.modal', () => {
      modal.dispose();
      element.remove();
      resolve(result);
    });

    modal.show();
  });
}

/**
 * Ask for a yes or no.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.message] plain text
 * @param {string} [options.confirmLabel] says what will happen: "Delete", not "OK"
 * @param {boolean} [options.danger] for anything that cannot be undone
 * @returns {Promise<boolean>}
 */
export async function confirmDialog({ title, message = '', confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false }) {
  const result = await openDialog({
    title,
    bodyHtml: `<p class="mb-0">${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
    buttons: [
      { label: cancelLabel, value: false, className: 'btn-outline-secondary' },
      { label: confirmLabel, value: true, className: danger ? 'btn-danger' : 'btn-primary', primary: true }
    ]
  });
  return result === true;
}

/**
 * Ask for one line of text.
 *
 * @returns {Promise<string|null>} the trimmed text, or null when cancelled
 */
export async function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save', required = true }) {
  const inputId = `app-dialog-input-${sequence + 1}`;
  const result = await openDialog({
    title,
    bodyHtml: `
      <label class="form-label" for="${inputId}">${escapeHtml(label)}</label>
      <input type="text" class="form-control" id="${inputId}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">`,
    focusSelector: 'input',
    buttons: [
      { label: 'Cancel', value: null, className: 'btn-outline-secondary' },
      {
        label: confirmLabel,
        className: 'btn-primary',
        primary: true,
        value: element => element.querySelector('input').value.trim()
      }
    ]
  });

  if (result === null || (required && !result)) {
    return null;
  }
  return result;
}
