require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(__dirname + '/public'));

const PORT = process.env.PORT || 4790;
const APP_ID = process.env.INTERCOM_APP_ID || 'your-workspace-id';
const INTERCOM_VERSION = '2.14';
const API_BASE = 'https://api.intercom.io';

const sseClients = new Set();
const log = [];

function redactAuth(headers) {
  const copy = { ...headers };
  if (copy.Authorization) {
    const token = copy.Authorization.replace(/^Bearer /, '');
    copy.Authorization = `Bearer ****${token.slice(-4)}`;
  }
  return copy;
}

function emit(entry) {
  const full = { id: crypto.randomUUID(), ts: Date.now(), ...entry };
  log.push(full);
  if (log.length > 300) log.shift();
  const payload = `data: ${JSON.stringify(full)}\n\n`;
  for (const res of sseClients) res.write(payload);
  return full;
}

app.get('/api/config', (req, res) => {
  res.json({ appId: APP_ID });
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  sseClients.add(res);
  for (const entry of log.slice(-50)) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  req.on('close', () => sseClients.delete(res));
});

async function callIntercom({ method, path, token, body, quiet, label }) {
  const url = `${API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Intercom-Version': INTERCOM_VERSION,
  };
  if (!quiet) {
    emit({ kind: 'request', method, url, headers: redactAuth(headers), body: body || null });
  }
  const started = Date.now();
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const durationMs = Date.now() - started;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const result = { ok: res.ok, status: res.status, durationMs, data, url, headers };
  if (!quiet) {
    emit({ kind: 'response', method, url, status: res.status, durationMs, body: data, label });
  }
  return result;
}

function findFinReply(conversation, afterMs) {
  const parts = conversation?.conversation_parts?.conversation_parts || [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const createdMs = (part.created_at || 0) * 1000;
    const authorType = part.author?.type;
    if (createdMs >= afterMs && part.body && (authorType === 'bot' || authorType === 'admin')) {
      return part.body.trim();
    }
  }
  return null;
}

app.post('/api/ask', async (req, res) => {
  const { question, user } = req.body || {};
  const key = (process.env.FIN_AGENT_API_KEY || '').trim();
  if (!question) return res.status(400).json({ error: 'question is required' });
  if (!key) {
    emit({ kind: 'error', label: 'No FIN_AGENT_API_KEY set in .env — add the real key and restart the server.' });
    return res.status(412).json({ error: 'FIN_AGENT_API_KEY is not set. Add it to .env and restart.' });
  }

  const conversationId = `demo-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const startedMs = Date.now();

  const askResult = await callIntercom({
    method: 'POST',
    path: '/fin/ask',
    token: key,
    body: {
      conversation_id: conversationId,
      message: { author: 'user', body: question, timestamp_ms: String(startedMs) },
      user: {
        id: user?.id || 'demo-user',
        name: user?.name || undefined,
        email: user?.email || undefined,
      },
    },
  });

  if (!askResult.ok) {
    return res.status(502).json({ error: 'fin/ask failed', details: askResult.data });
  }

  emit({ kind: 'status', label: 'Fin is thinking…' });

  const intercomConversationId = askResult.data?.intercom_conversation_id;
  let answer = null;
  let readToken = key;
  let lastPoll = null;

  if (intercomConversationId) {
    for (let attempt = 0; attempt < 20 && !answer; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await callIntercom({
        method: 'GET',
        path: `/conversations/${intercomConversationId}`,
        token: readToken,
        quiet: true,
      });
      lastPoll = poll;
      if (!poll.ok && (poll.status === 401 || poll.status === 403) && process.env.FALLBACK_READ_TOKEN) {
        readToken = process.env.FALLBACK_READ_TOKEN.trim();
        continue;
      }
      if (poll.ok) {
        answer = findFinReply(poll.data, startedMs);
      }
    }
  }

  // Only the poll that actually resolved (or the last attempt, on timeout) gets logged — not every intermediate poll.
  if (lastPoll) {
    emit({ kind: 'request', method: 'GET', url: lastPoll.url, headers: redactAuth(lastPoll.headers) });
    emit({ kind: 'response', method: 'GET', url: lastPoll.url, status: lastPoll.status, durationMs: lastPoll.durationMs, body: lastPoll.data });
  }

  const webhookPayload = {
    topic: answer ? 'fin_replied' : 'fin_status_updated',
    data: {
      conversation_id: conversationId,
      intercom_conversation_id: intercomConversationId || null,
      status: answer ? 'complete' : 'thinking',
      message: answer ? { author: 'fin', body: answer, timestamp_ms: String(Date.now()) } : null,
    },
  };

  emit({ kind: 'webhook', simulated: true, body: webhookPayload });

  res.json({
    conversationId,
    intercomConversationId,
    answer,
    timedOut: !answer,
  });
});

// Real receiver for when a public tunnel is pointed here — logs unmarked as simulated.
app.post('/api/webhook/fin-agent', (req, res) => {
  emit({ kind: 'webhook', simulated: false, label: 'Real inbound webhook', body: req.body });
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Fin-over-API demo running at http://localhost:${PORT} (workspace ${APP_ID})`);
});
