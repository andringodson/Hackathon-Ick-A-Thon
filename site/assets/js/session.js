// Live Session: multi-device sync for demos and shared use.
// A host screen (e.g. the projector) opens a room and shows a QR code; phones that
// scan it join. Crowd reports, simulated rushes and (optionally) navigation sync
// across every device in real time, with presence ("N devices live").
//
// Transport: Supabase Realtime broadcast when the app is connected to Supabase,
// otherwise the free public ntfy.sh relay (no account, no setup). Messages carry
// only room events — no personal data.

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RELAY = 'https://ntfy.sh';
const HEARTBEAT_MS = 25000;
const STALE_MS = 70000;
const RUSH_MS = 3 * 60000;

const rid = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHABET[b % ALPHABET.length]).join('');
const deviceKind = () => (matchMedia('(pointer: coarse)').matches ? 'phone' : 'laptop');

// ---------- transports ----------
function ntfyTransport(code, onMessage, onStatus) {
  const topic = `rushcast-room-${code.toLowerCase()}`;
  let es = null;
  let closed = false;
  function connect() {
    es = new EventSource(`${RELAY}/${topic}/sse`);
    es.onopen = () => onStatus('online');
    es.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data);
        if (env.event === 'message' && env.message) onMessage(JSON.parse(env.message));
      } catch {}
    };
    es.onerror = () => {
      onStatus('reconnecting');
      if (es.readyState === EventSource.CLOSED && !closed) setTimeout(connect, 3000);
    };
  }
  connect();
  return {
    kind: 'relay',
    send: (msg) => fetch(`${RELAY}/${topic}`, { method: 'POST', body: JSON.stringify(msg), keepalive: true }).catch(() => onStatus('offline')),
    close: () => { closed = true; es?.close(); },
  };
}

function supabaseTransport(client, code, onMessage, onStatus) {
  const ch = client.channel(`rushcast-room-${code}`, { config: { broadcast: { self: false } } });
  ch.on('broadcast', { event: 'room' }, ({ payload }) => onMessage(payload));
  ch.subscribe((status) => onStatus(status === 'SUBSCRIBED' ? 'online' : 'reconnecting'));
  return {
    kind: 'realtime',
    send: (msg) => ch.send({ type: 'broadcast', event: 'room', payload: msg }),
    close: () => client.removeChannel(ch),
  };
}

export function createSession({ engine, store, onEvent, clockOffset = () => 0 }) {
  const me = { id: rid(8), kind: deviceKind() };
  const state = {
    code: null,
    role: null, // 'host' | 'guest'
    follow: true,
    status: 'idle',
    peers: new Map(), // id -> { kind, seen }
    reports: [],
    activity: [],
  };
  let transport = null;
  let beat = 0;

  // Remote reports feed the live estimate exactly like local ones.
  const baseReportsFor = engine.reportsFor;
  engine.reportsFor = (id) => [...baseReportsFor(id), ...state.reports.filter((r) => r.facility_id === id)].sort((a, b) => b.at - a.at);

  // Our own reports go to the room too.
  const baseSubmit = store.submit.bind(store);
  store.submit = async (facilityId, level) => {
    await baseSubmit(facilityId, level);
    if (state.code) send({ t: 'report', fac: facilityId, level });
  };

  const peerLabel = (id, kind) => `${kind === 'phone' ? '📱' : '💻'} ${id.slice(-3)}`;
  function log(item) {
    state.activity.unshift({ ...item, at: Date.now() });
    state.activity.length = Math.min(state.activity.length, 12);
  }
  function prune() {
    const now = Date.now();
    for (const [id, p] of state.peers) if (now - p.seen > STALE_MS) state.peers.delete(id);
  }
  function send(msg) {
    transport?.send({ ...msg, from: me.id, kind: me.kind, role: state.role, ts: Date.now() });
  }

  function receive(msg) {
    if (!msg || msg.from === me.id) return;
    const known = state.peers.has(msg.from);
    state.peers.set(msg.from, { kind: msg.kind, role: msg.role, seen: Date.now() });
    const who = peerLabel(msg.from, msg.kind);
    switch (msg.t) {
      case 'hello':
        if (!known) {
          log({ type: 'join', who });
          onEvent('join', { who, kind: msg.kind });
          send({ t: 'here' }); // let the newcomer count us
        }
        if (state.role === 'host' && state.follow) {
          send({ t: 'nav', hash: location.hash || '#/' });
          send({ t: 'clock', offset: clockOffset() });
        }
        break;
      case 'here':
        break;
      case 'bye':
        state.peers.delete(msg.from);
        break;
      case 'report': {
        const r = { id: `room-${msg.from}-${msg.ts}`, facility_id: msg.fac, level: msg.level, at: new Date(msg.ts), room: true };
        if (!state.reports.some((x) => x.id === r.id)) state.reports.push(r);
        state.reports = state.reports.filter((x) => Date.now() - x.at < 6 * 3600000);
        log({ type: 'report', who, fac: msg.fac, level: msg.level });
        onEvent('report', { who, fac: msg.fac, level: msg.level });
        break;
      }
      case 'rush':
        engine.overrides.set(msg.fac, { pct: 96, until: msg.until });
        log({ type: 'rush', who, fac: msg.fac });
        onEvent('rush', { fac: msg.fac });
        break;
      case 'nav':
        if (state.role === 'guest' && state.follow && msg.role === 'host' && msg.hash && msg.hash !== location.hash) {
          onEvent('nav', { hash: msg.hash });
        }
        break;
      case 'clock':
        if (state.role === 'guest' && state.follow && msg.role === 'host') onEvent('clock', { offset: msg.offset });
        break;
      case 'end':
        if (msg.role === 'host' && state.role === 'guest') {
          onEvent('ended', {});
          leave(false);
        }
        break;
      default:
        break;
    }
    prune();
    onEvent('change', {});
  }

  function open(code, role) {
    leave(false);
    state.code = code;
    state.role = role;
    state.peers.clear();
    state.activity = [];
    const onStatus = (s) => { state.status = s; onEvent('change', {}); };
    transport = store.client ? supabaseTransport(store.client, code, receive, onStatus) : ntfyTransport(code, receive, onStatus);
    // Let the subscription settle before announcing ourselves.
    setTimeout(() => send({ t: 'hello' }), 900);
    beat = setInterval(() => { send({ t: 'here' }); prune(); onEvent('change', {}); }, HEARTBEAT_MS);
    try { sessionStorage.setItem('rc.session', JSON.stringify({ code, role })); } catch {}
    onEvent('change', {});
  }

  function leave(announce = true) {
    if (!state.code) return;
    if (announce) send({ t: state.role === 'host' ? 'end' : 'bye' });
    clearInterval(beat);
    transport?.close();
    transport = null;
    state.code = null;
    state.role = null;
    state.status = 'idle';
    state.peers.clear();
    try { sessionStorage.removeItem('rc.session'); } catch {}
    onEvent('change', {});
  }

  addEventListener('pagehide', () => { if (state.code) send({ t: 'bye' }); });

  return {
    state,
    me,
    host: () => open(rid(6), 'host'),
    join: (code) => open(code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6), 'guest'),
    leave,
    resume() {
      try {
        const s = JSON.parse(sessionStorage.getItem('rc.session') || 'null');
        if (s?.code) open(s.code, s.role);
      } catch {}
    },
    setFollow(on) { state.follow = on; if (on && state.role === 'host') send({ t: 'nav', hash: location.hash || '#/' }); onEvent('change', {}); },
    navigated(hash) { if (state.role === 'host' && state.follow) send({ t: 'nav', hash }); },
    clockChanged(offset) { if (state.role === 'host') send({ t: 'clock', offset }); },
    rush(fac) {
      const until = Date.now() + RUSH_MS;
      engine.overrides.set(fac, { pct: 96, until });
      send({ t: 'rush', fac, until });
      log({ type: 'rush', who: 'you', fac });
      onEvent('rush', { fac, self: true });
      onEvent('change', {});
    },
    joinUrl: () => `${location.origin}${location.pathname}#/join/${state.code}`,
    count: () => (state.code ? state.peers.size + 1 : 0),
    transportKind: () => transport?.kind ?? null,
    peerLabel,
  };
}
