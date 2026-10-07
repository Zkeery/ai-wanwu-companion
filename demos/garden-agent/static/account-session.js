// Presentation-only identity for the offline demo. Never an authentication boundary.
'use strict';
const demoAccount = {
  key: 'garden-demo-identity-v1',
  read() {
    try { const value = JSON.parse(sessionStorage.getItem(this.key));
      return value?.demo === true && typeof value.nickname === 'string' && value.nickname.length <= 20 ? value : null;
    } catch { return null; }
  },
  save(nickname) { sessionStorage.setItem(this.key, JSON.stringify({demo:true,nickname:nickname || '花园访客'})); },
  clear() { sessionStorage.removeItem(this.key); }
};
