// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized: the
// e-mail and password of the inexogy customer account and the pace. The
// password never leaves this object but for the Authorization header of the
// requests to inexogy.
// -----------------------------------------------------------------------------

import { POLL_DEFAULT_MIN, POLL_MAX_MIN, POLL_MIN_MIN } from './constants.js';

/** Whether a text holds a control character (never in a header). */
const hasControl = (text) =>
  [...text].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

/** The minutes between two reads: POLL_MIN_MIN to POLL_MAX_MIN, POLL_DEFAULT_MIN otherwise. */
export function pollOf(raw) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (value === '' || value === null || value === undefined) {
    return POLL_DEFAULT_MIN;
  }
  if (typeof value === 'string' && !/^\d{1,4}$/.test(value)) {
    return POLL_DEFAULT_MIN;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return POLL_DEFAULT_MIN;
  }
  return Math.min(POLL_MAX_MIN, Math.max(POLL_MIN_MIN, Math.round(number)));
}

/**
 * The e-mail: trimmed, at most 254 characters, never a colon (HTTP Basic
 * would cut it there) nor a control character; else ''.
 */
function emailOf(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text.length <= 254 && !text.includes(':') && !hasControl(text) ? text : '';
}

/** The password as typed (spaces may belong to it), at most 256 characters, no control character. */
function passwordOf(raw) {
  return typeof raw === 'string' && raw.length <= 256 && !hasControl(raw) ? raw : '';
}

export function normalizeConfig(raw = {}) {
  return {
    email: emailOf(raw?.email),
    password: passwordOf(raw?.password),
    pollMinutes: pollOf(raw?.poll_minutes),
  };
}

/** Whether the form is complete enough to read the account. */
export const isComplete = (config) => Boolean(config.email && config.password);
