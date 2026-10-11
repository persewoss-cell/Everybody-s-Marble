// 서버 없이 방 만들기/참가를 처리하는 통신 계층.
// - 방장 기기가 "은행" 역할을 합니다. 방 상태와 규칙 계산은 방장 기기에서만 일어납니다.
// - 기기들 사이의 메시지는 무료 공개 MQTT 중계 서버(브로커)를 통해 주고받습니다.
// - 방 상태는 브로커에 retained 메시지로 남아서, 새로 들어온 사람도 바로 받아 봅니다.
(function (root) {
  'use strict';

  const G = root.MarbleGame;
  const PREFIX = 'everybodys-marble-bank/v1';
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const REQUEST_TIMEOUT = 10000;
  const HOST_PING_MS = 10000;
  const LISTING_EVERY = 3; // 방 목록 정보는 30초마다 갱신
  const LISTING_FRESH_MS = 90000; // 90초 넘게 소식이 없는 방은 목록에서 숨김

  function rand(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function topic(code, sub) {
    return `${PREFIX}/${code}/${sub}`;
  }
  function listingTopic(code) {
    return `${PREFIX}/rooms/${code}`;
  }
  function brokerList(hint) {
    const custom = new URLSearchParams(location.search).get('broker');
    if (custom) return [custom];
    if (hint && BROKERS.includes(hint)) return [hint, ...BROKERS.filter((b) => b !== hint)];
    return BROKERS.slice();
  }
  function friendlyError(message, extra) {
    const e = new Error(message);
    e.data = extra || {};
    return e;
  }

  // 브로커에 연결 (실패하면 reject)
  function connectBroker(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const client = root.mqtt.connect(url, {
        clientId: 'mb_' + rand(6),
        clean: true,
        keepalive: 30,
        reconnectPeriod: 2000,
        connectTimeout: timeoutMs || 8000,
      });
      const timer = setTimeout(() => {
        client.end(true);
        reject(new Error('timeout'));
      }, (timeoutMs || 8000) + 500);
      client.once('connect', () => {
        clearTimeout(timer);
        resolve(client);
      });
    });
  }

  // 방 상태(retained)가 있는지 잠깐 기다려 확인
  function peekRoom(client, code, waitMs) {
    return new Promise((resolve) => {
      const t = topic(code, 'state');
      let done = false;
      const onMsg = (tp, payload) => {
        if (tp !== t || done) return;
        finish(payload && payload.length ? safeParse(payload) : null);
      };
      const finish = (v) => {
        done = true;
        clearTimeout(timer);
        client.removeListener('message', onMsg);
        client.unsubscribe(t);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), waitMs);
      client.on('message', onMsg);
      client.subscribe(t, { qos: 1 });
    });
  }

  function safeParse(buf) {
    try {
      return JSON.parse(typeof buf === 'string' ? buf : new TextDecoder().decode(buf));
    } catch {
      return null;
    }
  }

  // ---- 방장 데이터(이 기기에만 저장) ----
  function hostKey(code) {
    return 'marble-host-' + code;
  }
  function loadHost(code) {
    try {
      return JSON.parse(localStorage.getItem(hostKey(code)));
    } catch {
      return null;
    }
  }
  function saveHost(code, data) {
    try {
      localStorage.setItem(hostKey(code), JSON.stringify(data));
    } catch {}
  }
  function dropHost(code) {
    try {
      localStorage.removeItem(hostKey(code));
    } catch {}
  }

  // ---- 연결 ----
  class Connection {
    constructor(session, handlers) {
      this.s = session;
      this.h = handlers;
      this.client = null;
      this.pending = new Map();
      this.lastHostAt = 0;
      this.rev = -1;
      this.connected = false;
      this.closed = false;
      this.host = null; // 방장일 때 { room, tokens, seen, rev }
    }

    async open(client) {
      const s = this.s;
      if (s.host) {
        this.host = loadHost(s.code);
        if (!this.host) throw friendlyError('이 기기에 방장 정보가 없습니다.', { code: 'NO_ROOM' });
        this.host.seen = this.host.seen || {};
        this.host.rev = this.host.rev || 0;
      }
      this.client = client || (await connectBroker(s.broker));
      const c = this.client;
      c.on('connect', () => {
        this.connected = true;
        if (this.host) this.publishState();
        this.status();
      });
      c.on('close', () => {
        this.connected = false;
        this.status();
      });
      c.on('offline', () => {
        this.connected = false;
        this.status();
      });
      c.on('message', (t, payload) => this.onMessage(t, payload));
      this.connected = c.connected;

      const subs = [topic(s.code, 'state'), topic(s.code, 'ping'), topic(s.code, 'res/' + s.cid)];
      if (this.host) subs.push(topic(s.code, 'req'));
      c.subscribe(subs, { qos: 1 });

      if (this.host) {
        this.publishState();
        this.pingTimer = setInterval(() => this.ping(), HOST_PING_MS);
      }
      this.watchTimer = setInterval(() => this.status(), 3000);
      this.status();
    }

    status() {
      if (!this.h.onStatus) return;
      const hostAlive = this.host ? true : Date.now() - this.lastHostAt < HOST_PING_MS * 3;
      this.h.onStatus({ connected: this.connected, hostAlive });
    }

    onMessage(t, payload) {
      const s = this.s;
      if (t === topic(s.code, 'state')) {
        if (!payload || !payload.length) {
          // 방장이 방을 닫음
          if (!this.host) this.h.onClosed && this.h.onClosed();
          return;
        }
        const msg = safeParse(payload);
        if (!msg || !msg.state) return;
        this.lastHostAt = Math.max(this.lastHostAt, Date.now());
        if (this.host) return; // 방장은 자기 상태를 직접 씀
        if (msg.rev < this.rev && msg.epoch === this.epoch) return;
        this.rev = msg.rev;
        this.epoch = msg.epoch;
        this.h.onState(msg.state);
        this.status();
        return;
      }
      if (t === topic(s.code, 'ping')) {
        this.lastHostAt = Date.now();
        this.status();
        return;
      }
      if (t === topic(s.code, 'res/' + s.cid)) {
        const msg = safeParse(payload);
        if (!msg) return;
        const p = this.pending.get(msg.reqId);
        if (!p) return;
        this.pending.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else p.reject(friendlyError(msg.error, msg.extra));
        return;
      }
      if (this.host && t === topic(s.code, 'req')) {
        const req = safeParse(payload);
        if (!req || !req.reqId || !req.cid) return;
        const res = this.handle(req);
        this.client.publish(topic(s.code, 'res/' + req.cid), JSON.stringify(res), { qos: 1 });
      }
    }

    // ---- 방장: 요청 처리 ----
    handle(req) {
      const H = this.host;
      if (H.seen[req.reqId]) return H.seen[req.reqId]; // 같은 요청이 두 번 와도 한 번만 처리
      let res;
      try {
        const room = H.room;
        if (req.kind === 'join') {
          // 같은 이름으로 다시 들어오면 그 사람으로 이어서 함 (튕겼을 때)
          const old = G.findByName(room, req.name);
          if (old && old.id === room.hostId) throw new G.GameError('방장 이름으로는 다른 기기에서 들어올 수 없어요. 방장 기기에서 다시 열어 주세요.');
          const id = old ? old.id : rand(6);
          if (!old) G.addPlayer(room, req.name, id);
          if (!H.tokens[id]) H.tokens[id] = rand(16);
          room.updatedAt = Date.now();
          res = { ok: true, playerId: id, token: H.tokens[id], rejoin: !!old };
        } else {
          const pid = Object.keys(H.tokens).find((k) => H.tokens[k] === req.token);
          if (!pid || !room.players.some((p) => p.id === pid)) {
            throw new G.GameError('이 방의 참가자가 아닙니다.', { code: 'NO_AUTH' });
          }
          if (req.kind === 'action') {
            G.applyAction(room, pid, req.action);
            if (req.action.type === 'kick') delete H.tokens[req.action.playerId];
          } else if (req.kind === 'leave') {
            if (room.status === 'lobby' && pid !== room.hostId) {
              room.players = room.players.filter((p) => p.id !== pid);
              delete H.tokens[pid];
            }
          } else {
            throw new G.GameError('알 수 없는 요청입니다.');
          }
          res = { ok: true };
        }
      } catch (e) {
        if (!(e instanceof G.GameError)) console.error(e);
        res = { ok: false, error: e.message || '오류가 발생했습니다.', extra: e.extra || {} };
      }
      res.reqId = req.reqId;
      H.seen[req.reqId] = res;
      const keys = Object.keys(H.seen);
      if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete H.seen[k];
      if (res.ok) {
        H.rev++;
        this.publishState();
      }
      saveHost(this.s.code, H);
      return res;
    }

    publishState() {
      const H = this.host;
      if (!H.epoch) H.epoch = rand(4);
      const state = G.publicState(H.room);
      this.h.onState(state);
      if (!this.client) return;
      this.client.publish(
        topic(this.s.code, 'state'),
        JSON.stringify({ rev: H.rev, epoch: H.epoch, at: Date.now(), state }),
        { qos: 1, retain: true },
      );
      this.publishListing();
    }

    // 처음 화면의 "열려 있는 방" 목록에 보일 정보
    publishListing() {
      const room = this.host.room;
      const host = room.players.find((p) => p.id === room.hostId);
      const info = {
        code: room.code,
        host: host ? host.name : '',
        players: room.players.map((p) => p.name),
        status: room.status,
        at: Date.now(),
      };
      this.client.publish(listingTopic(room.code), JSON.stringify(info), { qos: 1, retain: true });
    }

    ping() {
      if (this.client && this.client.connected) {
        this.client.publish(topic(this.s.code, 'ping'), String(Date.now()), { qos: 0 });
        this.pings = (this.pings || 0) + 1;
        if (this.pings % LISTING_EVERY === 0) this.publishListing();
      }
    }

    // ---- 요청 보내기 ----
    request(kind, payload) {
      const req = { ...payload, kind, reqId: rand(8), cid: this.s.cid, token: this.s.token };
      if (this.host) {
        const res = this.handle(req);
        return res.ok ? Promise.resolve(res) : Promise.reject(friendlyError(res.error, res.extra));
      }
      return sendRequest(this.client, this.s.code, req, this.pending);
    }

    act(action) {
      return this.request('action', { action });
    }

    // 방 닫기(방장) 또는 나가기
    async leave() {
      if (this.host) {
        this.client.publish(topic(this.s.code, 'state'), '', { qos: 1, retain: true });
        this.client.publish(listingTopic(this.s.code), '', { qos: 1, retain: true });
        dropHost(this.s.code);
        await new Promise((r) => setTimeout(r, 300));
      } else {
        try {
          await this.request('leave', {});
        } catch {}
      }
      this.close();
    }

    close() {
      this.closed = true;
      clearInterval(this.pingTimer);
      clearInterval(this.watchTimer);
      for (const p of this.pending.values()) clearTimeout(p.timer);
      this.pending.clear();
      if (this.client) this.client.end(true);
    }
  }

  function sendRequest(client, code, req, pending) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(req.reqId);
        reject(friendlyError('방장 기기가 응답하지 않아요. 방장 휴대폰에서 이 화면이 켜져 있는지 확인해 주세요.', { code: 'TIMEOUT' }));
      }, REQUEST_TIMEOUT);
      pending.set(req.reqId, { resolve, reject, timer });
      client.publish(topic(code, 'req'), JSON.stringify(req), { qos: 1 });
    });
  }

  // ---- 방 만들기 / 참가 ----
  async function createRoom(name) {
    let lastErr;
    for (const url of brokerList()) {
      let client;
      try {
        client = await connectBroker(url, 6000);
      } catch (e) {
        lastErr = e;
        continue;
      }
      for (let i = 0; i < 5; i++) {
        const code = String(1000 + Math.floor(Math.random() * 9000));
        const existing = await peekRoom(client, code, 1200);
        if (existing && existing.state) continue; // 이미 쓰는 번호
        const playerId = rand(6);
        const token = rand(16);
        const room = G.createRoom(code, name, playerId);
        saveHost(code, { room, tokens: { [playerId]: token }, seen: {}, rev: 0, epoch: rand(4) });
        const session = { code, broker: url, playerId, token, cid: rand(6), host: true, name };
        return { session, client };
      }
      client.end(true);
      throw new Error('방 번호를 만들지 못했습니다. 다시 시도해 주세요.');
    }
    throw friendlyError('중계 서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.' + (lastErr ? '' : ''));
  }

  async function joinRoom(code, name, brokerHint) {
    // 이 기기가 그 방의 방장이었다면 방장으로 다시 엶
    const H = loadHost(code);
    if (H && H.room && H.room.players.some((p) => p.id === H.room.hostId && p.name === String(name).trim())) {
      const url = brokerList(brokerHint)[0];
      const client = await connectBroker(url, 6000);
      const session = { code, broker: url, playerId: H.room.hostId, token: H.tokens[H.room.hostId], cid: rand(6), host: true, name };
      return { session, client };
    }
    let reachable = false;
    for (const url of brokerList(brokerHint)) {
      let client;
      try {
        client = await connectBroker(url, 6000);
      } catch {
        continue;
      }
      reachable = true;
      const existing = await peekRoom(client, code, 2500);
      if (!existing || !existing.state) {
        client.end(true);
        continue;
      }
      const cid = rand(6);
      const pending = new Map();
      const resTopic = topic(code, 'res/' + cid);
      const onMsg = (t, payload) => {
        if (t !== resTopic) return;
        const msg = safeParse(payload);
        const p = msg && pending.get(msg.reqId);
        if (!p) return;
        pending.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else p.reject(friendlyError(msg.error, msg.extra));
      };
      client.on('message', onMsg);
      await new Promise((r) => client.subscribe(resTopic, { qos: 1 }, r));
      try {
        const res = await sendRequest(client, code, { kind: 'join', name, reqId: rand(8), cid }, pending);
        client.removeListener('message', onMsg);
        const session = { code, broker: url, playerId: res.playerId, token: res.token, cid, host: false, name };
        return { session, client };
      } catch (e) {
        client.end(true);
        throw e;
      }
    }
    if (!reachable) throw friendlyError('중계 서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.');
    throw friendlyError('방을 찾을 수 없습니다. 방 번호를 확인해 주세요.', { code: 'NO_ROOM' });
  }

  // 열려 있는 방 목록 지켜보기. onList([{ code, host, players, status, at, broker }])
  function watchRooms(onList) {
    let stopped = false;
    let client = null;
    let timer = null;
    const rooms = new Map();
    const emit = () => {
      if (stopped) return;
      const now = Date.now();
      const list = [...rooms.values()]
        .filter((r) => now - r.at < LISTING_FRESH_MS && r.status !== 'ended')
        .sort((a, b) => (a.status === b.status ? b.at - a.at : a.status === 'lobby' ? -1 : 1));
      onList(list, true);
    };
    (async () => {
      for (const url of brokerList()) {
        if (stopped) return;
        try {
          client = await connectBroker(url, 6000);
        } catch {
          continue;
        }
        if (stopped) return client.end(true);
        client.on('message', (t, payload) => {
          const code = t.split('/').pop();
          const info = payload && payload.length ? safeParse(payload) : null;
          if (info && info.code === code) rooms.set(code, { ...info, broker: url });
          else rooms.delete(code);
          emit();
        });
        client.subscribe(`${PREFIX}/rooms/+`, { qos: 0 });
        timer = setInterval(emit, 10000);
        setTimeout(emit, 1500);
        return;
      }
      if (!stopped) onList([], false);
    })();
    return () => {
      stopped = true;
      clearInterval(timer);
      if (client) client.end(true);
    };
  }

  function shareUrl(session) {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', session.code);
    const idx = BROKERS.indexOf(session.broker);
    if (idx > 0) u.searchParams.set('b', String(idx));
    const custom = new URLSearchParams(location.search).get('broker');
    if (custom) u.searchParams.set('broker', custom);
    return u.toString();
  }

  function brokerFromIndex(i) {
    return BROKERS[Number(i)] || null;
  }

  root.MarbleNet = { Connection, createRoom, joinRoom, watchRooms, shareUrl, brokerFromIndex, hasHostData: (code) => !!loadHost(code) };
})(typeof self !== 'undefined' ? self : this);
