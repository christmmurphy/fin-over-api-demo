const logList = document.getElementById('log-list');
const form = document.getElementById('ask-form');
const sendBtn = document.getElementById('send-btn');
const answerBox = document.getElementById('answer-box');
const answerText = document.getElementById('answer-text');

function methodBadge(entry) {
  if (entry.kind === 'webhook') return entry.simulated ? 'WEBHOOK sim' : 'WEBHOOK';
  if (entry.kind === 'error') return 'ERROR';
  return entry.method;
}

function renderEntry(entry) {
  const li = document.createElement('li');

  if (entry.kind === 'status') {
    li.className = 'status-entry';
    li.innerHTML = '<span class="pulse"></span>';
    li.append(entry.label);
    logList.appendChild(li);
    logList.scrollTop = logList.scrollHeight;
    return;
  }

  li.className = 'log-entry';

  const details = document.createElement('details');
  const summary = document.createElement('summary');

  const badge = document.createElement('span');
  const badgeClasses = methodBadge(entry).split(' ');
  badge.className = `badge ${badgeClasses[0]}${badgeClasses[1] ? ' ' + badgeClasses[1] : ''}`;
  badge.textContent = entry.kind === 'webhook'
    ? (entry.simulated ? 'WEBHOOK (sim)' : 'WEBHOOK')
    : (entry.method || 'ERR');
  summary.appendChild(badge);

  const urlEl = document.createElement('span');
  urlEl.className = 'log-url';
  urlEl.textContent = entry.url ? entry.url.replace('https://api.intercom.io', '') : (entry.label || '');
  summary.appendChild(urlEl);

  if (entry.status) {
    const status = document.createElement('span');
    status.className = 'log-meta';
    status.textContent = `${entry.status} · ${entry.durationMs ?? 0}ms`;
    summary.appendChild(status);
  } else {
    const time = document.createElement('span');
    time.className = 'log-meta';
    time.textContent = new Date(entry.ts).toLocaleTimeString();
    summary.appendChild(time);
  }

  details.appendChild(summary);

  if (entry.label) {
    const label = document.createElement('div');
    label.className = 'log-label';
    label.textContent = entry.label;
    details.appendChild(label);
  }

  const payload = entry.body ?? entry.headers;
  if (payload) {
    const body = document.createElement('div');
    body.className = 'log-body';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(payload, null, 2);
    body.appendChild(pre);
    details.appendChild(body);
  }

  li.appendChild(details);
  logList.appendChild(li);
  logList.scrollTop = logList.scrollHeight;
}

function renderAnswer(html) {
  answerText.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  answerText.querySelectorAll('a').forEach((a) => {
    if (!a.textContent.trim()) {
      a.remove();
      return;
    }
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

const es = new EventSource('/api/events');
es.onmessage = (e) => renderEntry(JSON.parse(e.data));

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    document.getElementById('workspace-id').textContent = cfg.appId;
  })
  .catch(() => {});

document.getElementById('clear-log').addEventListener('click', () => {
  logList.innerHTML = '';
});

const loader = document.getElementById('loader');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  sendBtn.disabled = true;
  sendBtn.textContent = 'Asking Fin…';
  answerBox.hidden = true;
  loader.hidden = false;

  const payload = {
    question: document.getElementById('question').value,
    user: {
      id: document.getElementById('user-id').value,
      name: document.getElementById('user-name').value,
      email: document.getElementById('user-email').value,
    },
  };

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    answerBox.hidden = false;
    if (!res.ok) {
      answerText.textContent = `Error: ${data.error || 'request failed'}`;
    } else if (data.timedOut) {
      answerText.textContent = 'Fin did not reply before the poll timeout — check the log for details.';
    } else {
      renderAnswer(data.answer);
    }
  } catch (err) {
    answerBox.hidden = false;
    answerText.textContent = `Error: ${err.message}`;
  } finally {
    loader.hidden = true;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Ask Fin';
  }
});
