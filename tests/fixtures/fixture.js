const parameters = new URLSearchParams(location.search);
const video = document.querySelector('#primary');
video.src = `/sample.mp4?video=${encodeURIComponent(parameters.get('video') || 'one')}`;

function addVideo(label = 'Secondary demo video') {
  const wrapper = document.createElement('div');
  wrapper.className = 'player';
  const extra = document.createElement('video');
  extra.setAttribute('aria-label', label);
  extra.controls = true;
  extra.muted = true;
  extra.preload = 'auto';
  extra.src = `/sample.mp4?video=${encodeURIComponent(label)}`;
  wrapper.append(extra);
  document.querySelector('#extras').append(wrapper);
}

document.querySelector('#fullscreen').addEventListener('click', () => document.querySelector('#player').requestFullscreen());
document.querySelector('#add-video').addEventListener('click', () => addVideo('Late demo video'));
if (parameters.has('multi')) addVideo();
if (parameters.has('frame')) {
  const frame = document.createElement('iframe');
  const frameUrl = new URL('/index.html?video=embedded', location.href);
  frameUrl.hostname = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  frame.src = frameUrl.href;
  frame.title = 'Cross-origin embedded video';
  document.querySelector('#extras').append(frame);
}
