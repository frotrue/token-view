// Cache only the application shell. Private records stay in the account-scoped data cache.
if (import.meta.env.PROD && 'serviceWorker' in navigator && !('__TAURI_INTERNALS__' in window)) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // The app remains usable when service workers are unavailable (e.g. private browsing).
    });
  });
}
