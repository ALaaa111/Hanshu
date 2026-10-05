/* 启动 */
(function (root) {
  'use strict';
  function boot() {
    if (root.GW && root.GW.boot) root.GW.boot();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
