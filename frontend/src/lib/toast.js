// Tiny global toast — dispatch an event from anywhere; <Toast/> (mounted in App) renders it.
export function toast(msg, kind = '') {
  window.dispatchEvent(new CustomEvent('rx-toast', { detail: { msg, kind } }));
}
