'use strict';
const sprite = document.getElementById('sprite');
const toggle = document.getElementById('toggle');
const description = document.getElementById('description');
const stage = document.querySelector('.stage');
const loadStatus = document.getElementById('load-status');
const retry = document.getElementById('retry');
const buttons = [...document.querySelectorAll('[data-activity]')];
const activities = {
  rest: ['休息', '闭上眼睛，慢慢放松。'],
  walk: ['散步', '迈开小小的步子，一起走走。'],
  observe: ['观察', '左看看，右看看，世界里有什么新鲜事？'],
};
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let paused = reducedMotion.matches;
let selectedActivity = 'rest';
let loadVersion = 0;
let cancelLoad = () => {};
function reflectPlayback() {
  sprite.classList.toggle('paused', paused);
  toggle.textContent = paused ? '播放动作' : '暂停播放';
  toggle.setAttribute('aria-pressed', String(paused));
}
function loadActivity(activity) {
  if (!Object.hasOwn(activities, activity)) return;
  cancelLoad();
  selectedActivity = activity;
  const version = ++loadVersion;
  const name = activities[activity][0];
  stage.setAttribute('aria-busy', 'true');
  sprite.classList.add('loading');
  sprite.setAttribute('aria-label', `蔓蔓${name}动作加载中`);
  loadStatus.textContent = `正在加载${name}动作…`;
  retry.hidden = true;
  toggle.disabled = true;
  description.textContent = activities[activity][1];
  for (const item of buttons) item.setAttribute('aria-pressed', String(item.dataset.activity === activity));

  const image = new Image();
  let finished = false;
  const timeout = window.setTimeout(() => finish(false), 15000);
  const cleanup = () => {
    window.clearTimeout(timeout);
    image.onload = null;
    image.onerror = null;
  };
  cancelLoad = () => { finished = true; cleanup(); };
  function finish(ready) {
    if (finished || version !== loadVersion) return;
    finished = true;
    cleanup();
    stage.setAttribute('aria-busy', 'false');
    if (!ready) {
      loadStatus.textContent = `${name}动作暂时没加载出来，请重新加载。`;
      sprite.setAttribute('aria-label', `蔓蔓${name}动作加载失败`);
      retry.hidden = false;
      return;
    }
    sprite.classList.remove(...Object.keys(activities));
    sprite.classList.add(activity);
    sprite.classList.remove('loading');
    sprite.setAttribute('aria-label', `蔓蔓正在${name}`);
    loadStatus.textContent = '';
    toggle.disabled = false;
    reflectPlayback();
  }
  image.onload = () => image.decode().then(() => finish(true), () => finish(false));
  image.onerror = () => finish(false);
  image.src = `assets/${activity}.png`;
}
for (const button of buttons) {
  button.addEventListener('click', () => loadActivity(button.dataset.activity));
}
retry.addEventListener('click', () => loadActivity(selectedActivity));
toggle.addEventListener('click', () => {
  paused = !paused;
  sprite.classList.toggle('motion-enabled', !paused);
  reflectPlayback();
});
reducedMotion.addEventListener('change', event => {
  paused = event.matches;
  sprite.classList.remove('motion-enabled');
  reflectPlayback();
});
reflectPlayback();
loadActivity(selectedActivity);
