/** Tiny DOM helpers — enough structure to build views without a framework. */

/**
 * @param {string} tag  optionally with classes: 'div.card.card--tight'
 * @param {object} [props] attributes; `class`, `text`, `html`, `on*` handlers, dataset
 * @param {Array<Node|string|null|false>} [children]
 */
export function el(tag, props = {}, children = []) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.classList.add(...classes);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') {
      node.classList.add(...String(value).split(/\s+/).filter(Boolean));
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastTimer = null;
export function toast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2400);
}

/** Card with an optional uppercase label. */
export function card(label, children, className = '') {
  return el(`section.card${className ? '.' + className.split(' ').join('.') : ''}`, {}, [
    label && el('h2.card__label', { text: label }),
    ...[].concat(children).filter(Boolean),
  ]);
}

export function switchToggle(checked, onChange, ariaLabel) {
  return el('span.switch', {}, [
    el('input', {
      type: 'checkbox',
      checked: checked || null,
      'aria-label': ariaLabel,
      onChange: (e) => onChange(e.target.checked),
    }),
    el('span.switch__track', { 'aria-hidden': 'true' }),
  ]);
}

export function settingRow(title, sub, control) {
  return el('div.row', {}, [
    el('div.row__text', {}, [
      el('div.row__title', { text: title }),
      sub && el('div.row__sub', { text: sub }),
    ]),
    control,
  ]);
}

/** Number field that reports `null` when emptied. */
export function numberField(label, value, onInput, { placeholder = '0', unit = '', hint = '' } = {}) {
  const input = el('input', {
    type: 'number',
    inputmode: 'decimal',
    min: '0',
    step: 'any',
    placeholder,
    value: value === null || value === undefined ? '' : String(value),
    onInput: (e) => {
      const raw = e.target.value.trim();
      onInput(raw === '' ? null : Number(raw));
    },
  });

  return el('div.field', {}, [
    el('label', { text: label }),
    el('div.input-row', {}, [input, unit && el('span.unit', { text: unit })]),
    hint && el('div.field__hint', { text: hint }),
  ]);
}
