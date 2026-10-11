'use strict';

(() => {
  const MAN = 10000;
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal-root');
  const $toasts = document.getElementById('toasts');

  // ---------- 상태 ----------
  let session = loadSession(); // { code, playerId, token, name }
  let state = null; // 서버에서 받은 방 상태
  let es = null;
  let connected = false;
  let lastSeenTx = 0;
  let firstState = true;

  function loadSession() {
    try { return JSON.parse(localStorage.getItem('marble-session')) || null; } catch { return null; }
  }
  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem('marble-session', JSON.stringify(s));
      else localStorage.removeItem('marble-session');
    } catch {}
  }
  function lastName() {
    try { return localStorage.getItem('marble-name') || ''; } catch { return ''; }
  }

  // ---------- 유틸 ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmt(n) {
    const sign = n < 0 ? '-' : '';
    n = Math.abs(n);
    const eok = Math.floor(n / 1e8);
    const man = (n % 1e8) / MAN;
    const manStr = man.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
    if (eok && man) return `${sign}${eok}억 ${manStr}만`;
    if (eok) return `${sign}${eok}억`;
    if (n === 0) return '0';
    if (n < MAN) return `${sign}${n.toLocaleString('ko-KR')}`;
    return `${sign}${manStr}만`;
  }
  function parseMan(v) {
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? Math.round(n * MAN) : NaN;
  }
  function me() {
    return state && state.players.find((p) => p.id === session.playerId);
  }
  function isHost() {
    return state && session && state.hostId === session.playerId;
  }
  function others(includeBankrupt) {
    return state.players.filter((p) => p.id !== session.playerId && (includeBankrupt || !p.bankrupt));
  }
  function pname(id) {
    const p = state.players.find((x) => x.id === id);
    return p ? p.name : '?';
  }
  function toast(msg, cls) {
    const el = document.createElement('div');
    el.className = 'toast ' + (cls || '');
    el.textContent = msg;
    $toasts.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
  function vibrate(ms) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch {}
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || '네트워크 오류가 발생했습니다.');
      err.data = data;
      throw err;
    }
    return data;
  }

  async function act(action) {
    return api(`/api/rooms/${session.code}/action`, { token: session.token, action });
  }

  // ---------- 연결 ----------
  function connect() {
    if (es) es.close();
    state = null;
    firstState = true;
    render();
    es = new EventSource(`/api/rooms/${session.code}/events?token=${encodeURIComponent(session.token)}`);
    es.onopen = () => { connected = true; renderConn(); };
    es.onmessage = (ev) => {
      connected = true;
      const s = JSON.parse(ev.data);
      onState(s);
    };
    es.onerror = async () => {
      connected = false;
      renderConn();
      // 방이 없어졌거나 내보내진 경우 확인
      try {
        await api(`/api/rooms/${session.code}`);
      } catch (e) {
        if (e.data && e.data.code === 'NO_ROOM') {
          es.close();
          saveSession(null);
          toast('방이 없어졌습니다.', 'err');
          render();
        }
      }
    };
  }

  function onState(s) {
    const prevStatus = state && state.status;
    state = s;
    if (!me()) {
      // 내보내짐
      es && es.close();
      saveSession(null);
      state = null;
      toast('방에서 나가게 되었습니다.', 'err');
      render();
      return;
    }
    // 새 거래 알림 (내 돈이 바뀐 거래)
    const newest = s.log.length ? s.log[s.log.length - 1].id : 0;
    if (!firstState) {
      for (const tx of s.log) {
        if (tx.id <= lastSeenTx) continue;
        const d = tx.deltas[session.playerId];
        if (d && tx.actorId !== session.playerId && tx.kind !== 'start') {
          toast(`${d > 0 ? '+' : ''}${fmt(d)} · ${tx.text}`, d > 0 ? 'plus' : 'minus');
          vibrate(d > 0 ? [60, 40, 60] : 200);
        }
      }
      if (prevStatus === 'playing' && s.status === 'ended') vibrate([100, 50, 100, 50, 200]);
    }
    lastSeenTx = newest;
    firstState = false;
    render();
  }

  // ---------- 화면 ----------
  function render() {
    if (!session) return renderHome();
    if (!state) {
      $app.innerHTML = `${topbar()}<div class="wrap"><div class="card center">연결 중...</div>
        <button class="btn secondary" id="bk">처음으로</button></div>`;
      $app.querySelector('#bk').onclick = () => { es && es.close(); saveSession(null); render(); };
      return;
    }
    if (state.status === 'lobby') return renderLobby();
    if (state.status === 'playing') return renderGame();
    return renderEnded();
  }

  function topbar() {
    const code = session ? session.code : '';
    return `<div class="topbar"><h1>🎲 모두의 마블 은행</h1>
      <div class="row" style="flex:none;align-items:center;gap:6px">
        <span id="conn">${session && !connected && state ? '<span class="conn">재연결 중</span>' : ''}</span>
        ${code ? `<button class="code" id="share">${esc(code)}</button>` : ''}
      </div></div>`;
  }
  function renderConn() {
    const el = document.getElementById('conn');
    if (el) el.innerHTML = !connected && state ? '<span class="conn">재연결 중</span>' : '';
  }
  function bindShare() {
    const b = document.getElementById('share');
    if (b) b.onclick = share;
  }
  async function share() {
    const url = `${location.origin}/?room=${session.code}`;
    const text = `모두의 마블 은행 방 번호: ${session.code}\n${url}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: '모두의 마블 은행', text, url });
        return;
      }
    } catch { return; }
    try {
      await navigator.clipboard.writeText(url);
      toast('참가 링크를 복사했습니다.');
    } catch {
      prompt('이 링크를 보내세요', url);
    }
  }

  // 처음 화면: 방 만들기 / 참가
  function renderHome() {
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room') || '';
    $app.innerHTML = `${topbar()}<div class="wrap">
      <div class="hero"><div class="logo">🎲💰</div><h1>모두의 마블 은행</h1>
        <p>보드게임 돈 계산을 각자 휴대폰으로!</p></div>
      <div class="card">
        <label class="field"><span>내 이름</span><input type="text" id="name" maxlength="12" placeholder="예: 엄마" value="${esc(lastName())}"></label>
      </div>
      <div class="card">
        <h2>방 참가하기</h2>
        <label class="field"><span>방 번호 (4자리)</span><input type="tel" id="code" inputmode="numeric" maxlength="4" placeholder="1234" value="${esc(roomParam)}"></label>
        <button class="btn" id="join">참가하기</button>
      </div>
      <div class="card">
        <h2>새 방 만들기 <small>· 방장이 됩니다</small></h2>
        <button class="btn accent" id="create">방 만들기</button>
      </div>
      <div class="err center" id="err"></div>
      <button class="btn secondary" id="rules">규칙 보기</button>
    </div>`;
    const $name = $app.querySelector('#name');
    const $err = $app.querySelector('#err');
    const getName = () => {
      const n = $name.value.trim();
      if (!n) { $err.textContent = '이름을 입력해 주세요.'; $name.focus(); return null; }
      try { localStorage.setItem('marble-name', n); } catch {}
      return n;
    };
    $app.querySelector('#create').onclick = async () => {
      const name = getName(); if (!name) return;
      try {
        const r = await api('/api/rooms', { name });
        saveSession({ ...r, name });
        history.replaceState(null, '', `/?room=${r.code}`);
        connect();
      } catch (e) { $err.textContent = e.message; }
    };
    $app.querySelector('#join').onclick = async () => {
      const name = getName(); if (!name) return;
      const code = $app.querySelector('#code').value.trim();
      if (!/^\d{4}$/.test(code)) { $err.textContent = '방 번호 4자리를 입력해 주세요.'; return; }
      try {
        const r = await api(`/api/rooms/${code}/join`, { name });
        saveSession({ ...r, name });
        history.replaceState(null, '', `/?room=${r.code}`);
        connect();
      } catch (e) { $err.textContent = e.message; }
    };
    $app.querySelector('#rules').onclick = showRules;
  }

  function settingsRows(s) {
    return [
      ['시작 자금', fmt(s.startMoney) + ' 마블'],
      ['월급 (출발지 통과)', fmt(s.salary) + ' 마블'],
      ['무인도 보석금', fmt(s.bail) + ' 마블'],
      ['컬러 독점 통행료', '×' + s.monopolyMultiplier],
      ['올림픽 통행료', '×' + s.olympicMultiplier + ' (개최할 때마다)'],
      ['인수 가격', '건설가 ×' + s.takeoverMultiplier],
      ['은행 매각', s.sellRate + '%'],
    ];
  }

  // 대기실
  function renderLobby() {
    const host = isHost();
    $app.innerHTML = `${topbar()}<div class="wrap">
      <div class="card center">
        <div class="muted">방 번호</div>
        <div class="bigcode">${esc(state.code)}</div>
        <div class="muted">다른 사람은 이 번호로 참가하세요</div>
        <button class="btn secondary mt" id="share2">📤 참가 링크 보내기</button>
      </div>
      <div class="card">
        <h2>참가자 ${state.players.length}/4</h2>
        <ul class="plist">${state.players.map((p) => `<li>
          <span class="dot" style="background:${p.color}"></span>
          <span class="name">${esc(p.name)}${p.id === state.hostId ? '<span class="tag">방장</span>' : ''}${p.id === session.playerId ? '<span class="tag">나</span>' : ''}</span>
          ${host && p.id !== state.hostId ? `<button class="link" data-kick="${p.id}">내보내기</button>` : ''}
        </li>`).join('')}</ul>
      </div>
      <div class="card">
        <h2>게임 설정 ${host ? '<small>· 방장만 변경 가능</small>' : ''}</h2>
        <ul class="plist">${settingsRows(state.settings).map(([k, v]) => `<li><span class="name">${k}</span><span>${v}</span></li>`).join('')}</ul>
        ${host ? '<button class="btn secondary mt" id="edit">설정 바꾸기</button>' : ''}
      </div>
      ${host
        ? `<button class="btn accent" id="start" ${state.players.length < 2 ? 'disabled' : ''}>게임 시작 (모두 ${fmt(state.settings.startMoney)} 지급)</button>`
        : '<div class="card center muted">방장이 게임을 시작하기를 기다리는 중...</div>'}
      <button class="btn secondary mt" id="leave">나가기</button>
    </div>`;
    bindShare();
    $app.querySelector('#share2').onclick = share;
    $app.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = () => confirmBox(`${pname(b.dataset.kick)}님을 내보낼까요?`, () => act({ type: 'kick', playerId: b.dataset.kick }));
    });
    if (host) {
      $app.querySelector('#edit').onclick = editSettings;
      $app.querySelector('#start').onclick = () => run(() => act({ type: 'start' }));
    }
    $app.querySelector('#leave').onclick = () => confirmBox('방에서 나갈까요?', async () => {
      await api(`/api/rooms/${session.code}/leave`, { token: session.token });
      es && es.close();
      saveSession(null);
      state = null;
      history.replaceState(null, '', '/');
      render();
    });
  }

  // 게임 화면
  function renderGame() {
    const m = me();
    const s = state.settings;
    const host = isHost();
    const sorted = [...state.players];
    $app.innerHTML = `${topbar()}<div class="wrap">
      <div class="me ${m.bankrupt ? 'bankrupt' : ''}" style="background:${m.color}">
        <div class="who">${esc(m.name)}${host ? ' · 방장' : ''}${m.bankrupt ? ' · 파산' : ''}</div>
        <div class="bal">${fmt(m.money)} <small>마블</small></div>
      </div>
      ${m.bankrupt ? '<div class="card center muted">파산했습니다. 다른 사람들의 게임을 지켜보세요.</div>' : `
      <div class="actions">
        <button class="act" data-a="salary"><span class="ic">🏁</span>월급<small>+${fmt(s.salary)}</small></button>
        <button class="act" data-a="toll"><span class="ic">🧾</span>통행료<small>내기</small></button>
        <button class="act" data-a="takeover"><span class="ic">🤝</span>인수<small>건설가×${s.takeoverMultiplier}</small></button>
        <button class="act" data-a="buy"><span class="ic">🏠</span>구매·건설<small>은행에 내기</small></button>
        <button class="act" data-a="bail"><span class="ic">🏝️</span>보석금<small>-${fmt(s.bail)}</small></button>
        <button class="act" data-a="payBank"><span class="ic">🏦</span>은행에<small>내기</small></button>
        <button class="act" data-a="receiveBank"><span class="ic">🎁</span>은행에서<small>받기</small></button>
        <button class="act" data-a="transfer"><span class="ic">💸</span>송금<small>플레이어에게</small></button>
        <button class="act" data-a="sell"><span class="ic">🏚️</span>매각<small>${s.sellRate}% 받기</small></button>
      </div>`}
      <div class="card">
        <h2>모든 플레이어</h2>
        <ul class="plist">${sorted.map((p) => `<li>
          <span class="dot" style="background:${p.color}"></span>
          <span class="name ${p.bankrupt ? 'out' : ''}">${esc(p.name)}${p.id === state.hostId ? '<span class="tag">방장</span>' : ''}${p.id === session.playerId ? '<span class="tag">나</span>' : ''}${p.bankrupt ? '<span class="tag">파산</span>' : ''}</span>
          <span class="money">${fmt(p.money)}</span>
        </li>`).join('')}</ul>
      </div>
      <div class="card">
        <h2>거래 기록</h2>
        ${logHtml()}
      </div>
      ${host ? `<div class="card"><h2>방장 메뉴</h2>
        <button class="btn secondary" id="adjust">잔액 직접 수정</button>
        <button class="btn secondary mt" id="hbk">다른 플레이어 파산 처리</button>
        <button class="btn mt" id="end">🏆 승리 선언 / 게임 종료</button>
      </div>` : ''}
      ${m.bankrupt ? '' : '<button class="btn danger" id="bankrupt">파산하기</button>'}
      <button class="btn secondary mt" id="rules">규칙 보기</button>
      <div style="height:24px"></div>
    </div>`;
    bindShare();
    bindLog();
    $app.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => ACTIONS[b.dataset.a]()));
    const q = (id) => $app.querySelector(id);
    q('#rules').onclick = showRules;
    if (q('#bankrupt')) q('#bankrupt').onclick = () => bankruptDialog();
    if (host) {
      q('#adjust').onclick = adjustDialog;
      q('#hbk').onclick = hostBankruptDialog;
      q('#end').onclick = endDialog;
    }
  }

  function logHtml() {
    const items = [...state.log].reverse().slice(0, 60);
    if (!items.length) return '<div class="muted">아직 거래가 없습니다.</div>';
    const host = isHost();
    return `<ul class="log">${items.map((tx) => {
      const d = tx.deltas[session.playerId];
      const canUndo = state.status === 'playing' && !tx.undone && !tx.noUndo && (tx.actorId === session.playerId || host);
      const time = new Date(tx.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      return `<li class="${tx.undone ? 'undone' : ''}">
        <span class="t ${d ? 'mine' : ''}">${esc(tx.text)}${d && !tx.undone ? ` <span style="color:var(--${d > 0 ? 'plus' : 'minus'})">(${d > 0 ? '+' : ''}${fmt(d)})</span>` : ''}</span>
        <span class="time">${time}</span>
        ${canUndo ? `<button class="undo" data-undo="${tx.id}">취소</button>` : ''}
      </li>`;
    }).join('')}</ul>`;
  }
  function bindLog() {
    $app.querySelectorAll('[data-undo]').forEach((b) => {
      const tx = state.log.find((t) => t.id === Number(b.dataset.undo));
      b.onclick = () => confirmBox(`이 거래를 취소할까요?\n\n${tx ? tx.text : ''}`, () => act({ type: 'undo', txId: Number(b.dataset.undo) }));
    });
  }

  function renderEnded() {
    const r = state.result || {};
    const ranking = [...state.players].sort((a, b) => (a.id === r.winnerId ? -1 : b.id === r.winnerId ? 1 : (a.bankrupt - b.bankrupt) || b.money - a.money));
    $app.innerHTML = `${topbar()}<div class="wrap">
      <div class="card winner"><div class="trophy">🏆</div>
        <h2>${esc(pname(r.winnerId))} 승리!</h2><div class="muted">${esc(r.reason || '')}</div></div>
      <div class="card"><h2>최종 결과</h2>
        <ul class="plist">${ranking.map((p, i) => `<li><b>${i + 1}</b><span class="dot" style="background:${p.color}"></span>
          <span class="name ${p.bankrupt ? 'out' : ''}">${esc(p.name)}</span><span class="money">${p.bankrupt ? '파산' : fmt(p.money)}</span></li>`).join('')}</ul>
      </div>
      <div class="card"><h2>거래 기록</h2>${logHtml()}</div>
      ${isHost() ? '<button class="btn accent" id="again">같은 사람들과 다시 하기</button>' : ''}
      <button class="btn secondary mt" id="home">처음으로</button>
    </div>`;
    bindShare();
    if (isHost()) $app.querySelector('#again').onclick = () => confirmBox('새 게임을 준비할까요? (기록이 지워집니다)', () => act({ type: 'reset' }));
    $app.querySelector('#home').onclick = () => {
      es && es.close();
      saveSession(null);
      state = null;
      history.replaceState(null, '', '/');
      render();
    };
  }

  // ---------- 모달 ----------
  function openModal(html, onMount) {
    $modal.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
    const bg = $modal.firstElementChild;
    bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });
    const root = bg.firstElementChild;
    root.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
    onMount && onMount(root);
    return root;
  }
  function closeModal() { $modal.innerHTML = ''; }

  function confirmBox(msg, onYes, yesLabel) {
    openModal(`<h3 style="white-space:pre-line;font-size:18px">${esc(msg)}</h3>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>아니요</button><button class="btn" id="yes">${esc(yesLabel || '네')}</button></div>`,
    (root) => {
      root.querySelector('#yes').onclick = async () => {
        try { await onYes(); closeModal(); } catch (e) { handleError(e, root); }
      };
    });
  }

  // 잔액 부족 시: 매각하거나 파산
  function handleError(e, root, creditorId) {
    if (e.data && e.data.code === 'INSUFFICIENT') {
      openModal(`<h3>잔액이 부족해요 😥</h3>
        <p>${fmt(e.data.shortfall)} 마블이 부족합니다.<br>땅이나 건물을 은행에 팔아 돈을 마련하거나, 파산해야 합니다.</p>
        <button class="btn accent" id="s">🏚️ 매각해서 돈 마련하기</button>
        <button class="btn danger mt" id="b">파산하기</button>
        <button class="btn secondary mt" data-close>취소</button>`,
      (r) => {
        r.querySelector('#s').onclick = () => ACTIONS.sell();
        r.querySelector('#b').onclick = () => bankruptDialog(creditorId);
      });
      return;
    }
    const el = root && root.querySelector('#err');
    if (el) el.textContent = e.message; else toast(e.message, 'err');
  }

  async function run(fn, root, creditorId) {
    try {
      await fn();
      closeModal();
      return true;
    } catch (e) {
      handleError(e, root, creditorId);
      return false;
    }
  }

  function amountInput(id, label, chips) {
    const c = chips || [1, 5, 10, 50, 100];
    return `<div class="sub">${label}</div>
      <div class="amount"><input type="number" inputmode="decimal" min="0" step="any" id="${id}" placeholder="0"><span class="unit">만 마블</span></div>
      <div class="chips mt">${c.map((v) => `<button class="chip" data-add="${id}" data-v="${v}">+${v}만</button>`).join('')}<button class="chip" data-clear="${id}">지우기</button></div>`;
  }
  function bindAmount(root, onChange) {
    root.querySelectorAll('[data-add]').forEach((b) => {
      b.onclick = () => {
        const inp = root.querySelector('#' + b.dataset.add);
        const cur = Number(inp.value) || 0;
        inp.value = Math.round((cur + Number(b.dataset.v)) * 10) / 10;
        onChange && onChange();
      };
    });
    root.querySelectorAll('[data-clear]').forEach((b) => {
      b.onclick = () => { root.querySelector('#' + b.dataset.clear).value = ''; onChange && onChange(); };
    });
    root.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => onChange && onChange()));
  }
  function playerChips(name, list, selected) {
    return `<div class="chips">${list.map((p) => `<button class="chip pchip ${p.id === selected ? 'on' : ''}" data-${name}="${p.id}">
      <span class="dot" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('')}</div>`;
  }
  function bindChoice(root, name, onPick) {
    const btns = root.querySelectorAll(`[data-${name}]`);
    btns.forEach((b) => {
      b.onclick = () => {
        btns.forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onPick(b.dataset[name]);
      };
    });
  }

  const ACTIONS = {
    salary() {
      confirmBox(`출발지를 지나 월급 ${fmt(state.settings.salary)} 마블을 받을까요?`, () => act({ type: 'salary' }), '받기');
    },

    bail() {
      confirmBox(`무인도 보석금 ${fmt(state.settings.bail)} 마블을 내고 탈출할까요?`, () => act({ type: 'bail' }), '내기');
    },

    toll() {
      const list = others();
      if (!list.length) return toast('다른 플레이어가 없습니다.', 'err');
      let to = list.length === 1 ? list[0].id : null;
      let olympics = 0;
      const s = state.settings;
      openModal(`<h3>🧾 통행료 내기</h3>
        <div class="sub">누구의 땅인가요?</div>
        ${playerChips('to', list, to)}
        ${amountInput('base', '땅 카드에 적힌 통행료 (지어진 건물 기준 합계)')}
        <label class="check"><input type="checkbox" id="mono"> 컬러 독점 도시 (×${s.monopolyMultiplier})</label>
        <div class="check" style="justify-content:space-between"><span>올림픽 개최 횟수 (×${s.olympicMultiplier}씩)</span>
          <span class="stepper"><button id="om">−</button><b id="ov">0</b><button id="op">+</button></span></div>
        <div class="preview"><span>낼 금액</span><b id="pv">0</b></div>
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">내기</button></div>`,
      (root) => {
        const calc = () => {
          const base = parseMan(root.querySelector('#base').value) || 0;
          let mult = 1;
          if (root.querySelector('#mono').checked) mult *= s.monopolyMultiplier;
          mult *= Math.pow(s.olympicMultiplier, olympics);
          root.querySelector('#pv').textContent = fmt(Math.round(base * mult));
          root.querySelector('#ov').textContent = olympics;
        };
        bindAmount(root, calc);
        bindChoice(root, 'to', (v) => (to = v));
        root.querySelector('#mono').onchange = calc;
        root.querySelector('#om').onclick = () => { olympics = Math.max(0, olympics - 1); calc(); };
        root.querySelector('#op').onclick = () => { olympics = Math.min(5, olympics + 1); calc(); };
        root.querySelector('#ok').onclick = () => {
          if (!to) return (root.querySelector('#err').textContent = '땅 주인을 골라 주세요.');
          run(() => act({ type: 'toll', to, base: parseMan(root.querySelector('#base').value), monopoly: root.querySelector('#mono').checked, olympics }), root, to);
        };
      });
    },

    takeover() {
      const list = others();
      if (!list.length) return toast('다른 플레이어가 없습니다.', 'err');
      let to = list.length === 1 ? list[0].id : null;
      const k = state.settings.takeoverMultiplier;
      openModal(`<h3>🤝 인수하기</h3>
        <div class="sub">통행료를 낸 뒤, 원하면 그 땅을 인수할 수 있어요. 랜드마크가 있는 도시는 인수할 수 없어요.</div>
        <div class="sub mt">누구의 땅인가요?</div>
        ${playerChips('to', list, to)}
        ${amountInput('val', '현재 건설가 (땅 + 지어진 건물 가격의 합)')}
        <div class="preview"><span>인수 금액 (×${k})</span><b id="pv">0</b></div>
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">인수하기</button></div>`,
      (root) => {
        const calc = () => {
          root.querySelector('#pv').textContent = fmt(Math.round((parseMan(root.querySelector('#val').value) || 0) * k));
        };
        bindAmount(root, calc);
        bindChoice(root, 'to', (v) => (to = v));
        root.querySelector('#ok').onclick = () => {
          if (!to) return (root.querySelector('#err').textContent = '땅 주인을 골라 주세요.');
          run(() => act({ type: 'takeover', to, value: parseMan(root.querySelector('#val').value) }), root, to);
        };
      });
    },

    buy() {
      bankDialog('🏠 구매·건설', ['땅 구매', '별장 건설', '빌딩 건설', '호텔 건설', '랜드마크 건설', '관광지 구매'], 'payBank');
    },
    payBank() {
      bankDialog('🏦 은행에 내기', ['세금(국세청)', '찬스카드', '올림픽 개최', '세계여행', '기타'], 'payBank');
    },
    receiveBank() {
      bankDialog('🎁 은행에서 받기', ['찬스카드', '기타'], 'receiveBank');
    },

    transfer() {
      const list = others();
      if (!list.length) return toast('다른 플레이어가 없습니다.', 'err');
      let to = list.length === 1 ? list[0].id : null;
      openModal(`<h3>💸 송금하기</h3>
        <div class="sub">받는 사람</div>
        ${playerChips('to', list, to)}
        ${amountInput('amt', '금액')}
        <label class="field mt"><span>메모 (선택)</span><input type="text" id="memo" maxlength="30" placeholder="예: 찬스카드"></label>
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">보내기</button></div>`,
      (root) => {
        bindAmount(root);
        bindChoice(root, 'to', (v) => (to = v));
        root.querySelector('#ok').onclick = () => {
          if (!to) return (root.querySelector('#err').textContent = '받는 사람을 골라 주세요.');
          run(() => act({ type: 'transfer', to, amount: parseMan(root.querySelector('#amt').value), reason: root.querySelector('#memo').value }), root, to);
        };
      });
    },

    sell() {
      const rate = state.settings.sellRate;
      openModal(`<h3>🏚️ 은행에 매각</h3>
        <div class="sub">돈이 부족할 때 내 땅·건물을 은행에 팔아요. 팔린 땅은 보드에서 내 표시를 치워 주세요.</div>
        <label class="field mt"><span>도시 이름 (선택)</span><input type="text" id="city" maxlength="12"></label>
        ${amountInput('val', '매각할 땅·건물의 건설가 합계')}
        <div class="preview"><span>받을 금액 (${rate}%)</span><b id="pv">0</b></div>
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">매각하기</button></div>`,
      (root) => {
        const calc = () => {
          root.querySelector('#pv').textContent = fmt(Math.floor(((parseMan(root.querySelector('#val').value) || 0) * rate) / 100));
        };
        bindAmount(root, calc);
        root.querySelector('#ok').onclick = () =>
          run(() => act({ type: 'sell', value: parseMan(root.querySelector('#val').value), city: root.querySelector('#city').value }), root);
      });
    },
  };

  function bankDialog(title, reasons, type) {
    let reason = reasons[0];
    openModal(`<h3>${title}</h3>
      <div class="sub">항목</div>
      <div class="chips">${reasons.map((r, i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>
      ${amountInput('amt', '금액 (카드에 적힌 가격)')}
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">${type === 'payBank' ? '내기' : '받기'}</button></div>`,
    (root) => {
      bindAmount(root);
      bindChoice(root, 'r', (v) => (reason = v));
      root.querySelector('#ok').onclick = () =>
        run(() => act({ type, amount: parseMan(root.querySelector('#amt').value), reason }), root);
    });
  }

  function bankruptDialog(creditorId) {
    const list = others();
    let to = creditorId || '';
    const m = me();
    openModal(`<h3>☠️ 파산하기</h3>
      <p>파산하면 게임에서 빠집니다. 남은 돈 ${fmt(m.money)}은(는) 빚진 상대에게 넘어가고, 부족한 금액은 내지 않습니다.
      가지고 있던 땅과 건물은 보드에서 치워 주세요.</p>
      <div class="sub">누구에게 빚을 졌나요?</div>
      <div class="chips"><button class="chip ${to ? '' : 'on'}" data-to="">🏦 은행</button>
      ${list.map((p) => `<button class="chip pchip ${p.id === to ? 'on' : ''}" data-to="${p.id}"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('')}</div>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn danger" id="ok">파산</button></div>`,
    (root) => {
      bindChoice(root, 'to', (v) => (to = v));
      root.querySelector('#ok').onclick = () => run(() => act({ type: 'bankrupt', to: to || undefined }), root);
    });
  }

  function hostBankruptDialog() {
    const list = others();
    if (!list.length) return;
    let who = null;
    let to = '';
    openModal(`<h3>다른 플레이어 파산 처리</h3>
      <div class="sub">파산할 사람</div>
      ${playerChips('who', list, null)}
      <div class="sub">남은 돈을 받을 사람</div>
      <div class="chips"><button class="chip on" data-to="">🏦 은행</button>
      ${state.players.filter((p) => !p.bankrupt).map((p) => `<button class="chip pchip" data-to="${p.id}"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('')}</div>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn danger" id="ok">파산 처리</button></div>`,
    (root) => {
      bindChoice(root, 'who', (v) => (who = v));
      bindChoice(root, 'to', (v) => (to = v));
      root.querySelector('#ok').onclick = () => {
        if (!who) return (root.querySelector('#err').textContent = '파산할 사람을 골라 주세요.');
        if (to === who) return (root.querySelector('#err').textContent = '같은 사람을 고를 수 없습니다.');
        run(() => act({ type: 'bankrupt', playerId: who, to: to || undefined }), root);
      };
    });
  }

  function adjustDialog() {
    let who = null;
    openModal(`<h3>잔액 직접 수정</h3>
      <div class="sub">실수를 바로잡을 때만 쓰세요. 기록에 남습니다.</div>
      ${playerChips('who', state.players, null)}
      ${amountInput('amt', '새 잔액', [10, 50, 100])}
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">수정</button></div>`,
    (root) => {
      bindAmount(root);
      bindChoice(root, 'who', (v) => {
        who = v;
        root.querySelector('#amt').value = state.players.find((p) => p.id === v).money / MAN;
      });
      root.querySelector('#ok').onclick = () => {
        if (!who) return (root.querySelector('#err').textContent = '사람을 골라 주세요.');
        run(() => act({ type: 'adjust', playerId: who, money: parseMan(root.querySelector('#amt').value) }), root);
      };
    });
  }

  function endDialog() {
    let who = null;
    let reason = 'triple';
    openModal(`<h3>🏆 승리 선언</h3>
      <div class="sub">승리 조건</div>
      <div class="chips">
        <button class="chip on" data-r="triple">트리플 독점</button>
        <button class="chip" data-r="line">라인 독점</button>
        <button class="chip" data-r="tour">관광지 독점</button>
        <button class="chip" data-r="other">기타 종료</button>
      </div>
      <div class="sub">승리한 사람</div>
      ${playerChips('who', state.players.filter((p) => !p.bankrupt), null)}
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn accent" id="ok">게임 종료</button></div>`,
    (root) => {
      bindChoice(root, 'r', (v) => (reason = v));
      bindChoice(root, 'who', (v) => (who = v));
      root.querySelector('#ok').onclick = () => {
        if (!who) return (root.querySelector('#err').textContent = '승리한 사람을 골라 주세요.');
        run(() => act({ type: 'end', winnerId: who, reason }), root);
      };
    });
  }

  function editSettings() {
    const s = state.settings;
    const f = (id, label, val, unit) => `<label class="field"><span>${label}</span>
      <div class="amount"><input type="number" inputmode="decimal" step="any" id="${id}" value="${val}"><span class="unit">${unit}</span></div></label>`;
    openModal(`<h3>게임 설정</h3>
      <div class="sub">기본값은 모두의 마블 보드게임 규칙 기준이에요. 가진 게임 설명서와 다르면 바꿔 주세요.</div>
      ${f('startMoney', '시작 자금', s.startMoney / MAN, '만')}
      ${f('salary', '월급 (출발지 통과)', s.salary / MAN, '만')}
      ${f('bail', '무인도 보석금', s.bail / MAN, '만')}
      ${f('monopolyMultiplier', '컬러 독점 통행료 배수', s.monopolyMultiplier, '배')}
      ${f('olympicMultiplier', '올림픽 통행료 배수', s.olympicMultiplier, '배')}
      ${f('takeoverMultiplier', '인수 가격 배수', s.takeoverMultiplier, '배')}
      ${f('sellRate', '은행 매각 시 받는 비율', s.sellRate, '%')}
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" id="def">기본값</button><button class="btn" id="ok">저장</button></div>`,
    (root) => {
      const v = (id) => Number(root.querySelector('#' + id).value);
      root.querySelector('#def').onclick = () =>
        run(() => act({ type: 'updateSettings', settings: { startMoney: 200 * MAN, salary: 30 * MAN, bail: 20 * MAN, monopolyMultiplier: 2, olympicMultiplier: 2, takeoverMultiplier: 2, sellRate: 50 } }), root);
      root.querySelector('#ok').onclick = () =>
        run(() => act({ type: 'updateSettings', settings: {
          startMoney: Math.round(v('startMoney') * MAN),
          salary: Math.round(v('salary') * MAN),
          bail: Math.round(v('bail') * MAN),
          monopolyMultiplier: v('monopolyMultiplier'),
          olympicMultiplier: v('olympicMultiplier'),
          takeoverMultiplier: v('takeoverMultiplier'),
          sellRate: v('sellRate'),
        } }), root);
    });
  }

  function showRules() {
    openModal(`<h3>📖 돈 관련 규칙</h3>
      <div class="rules">
        <b>준비</b><ul><li>2~4명. 모두 <b>200만 마블</b>씩 받고 시작합니다.</li><li>보드·말·주사위·카드는 실물로, 돈만 이 앱으로 주고받습니다.</li></ul>
        <b>월급</b><ul><li>출발지를 <b>지나갈 때마다 30만 마블</b> (세계여행으로 출발지를 지나도 받음).</li>
          <li>순간이동 카드로 출발지를 거치지 않으면 받지 않습니다.</li></ul>
        <b>땅·건물</b><ul><li>빈 땅에 도착하면 카드에 적힌 가격으로 구매하고 별장·빌딩·호텔을 지을 수 있습니다 → <b>구매·건설</b>.</li>
          <li>별장·빌딩·호텔이 모두 지어진 내 도시에 다시 오면 랜드마크를 지을 수 있습니다.</li></ul>
        <b>통행료</b><ul><li>다른 사람 땅에 도착하면 카드의 통행료(지어진 건물 기준)를 땅 주인에게 냅니다.</li>
          <li>같은 색 도시를 모두 가지면(컬러 독점) <b>통행료 2배</b>, 올림픽이 열린 도시는 <b>배수가 추가</b>되고 효과는 겹칩니다.</li></ul>
        <b>인수</b><ul><li>통행료를 낸 뒤 그 땅을 <b>현재 건설가의 2배</b>를 주인에게 주고 인수할 수 있습니다.</li>
          <li><b>랜드마크가 있는 도시는 인수할 수 없습니다.</b> 인수한 뒤에는 추가로 건물을 지을 수 있습니다.</li></ul>
        <b>무인도</b><ul><li>3턴 동안 갇힙니다. 더블이 나오거나, <b>보석금</b>을 내거나, 탈출 카드를 쓰면 나옵니다.</li></ul>
        <b>파산</b><ul><li>돈이 모자라면 땅·건물을 은행에 팔아 마련합니다. 그래도 모자라면 파산하고, 부족한 금액은 내지 않습니다.</li></ul>
        <b>승리</b><ul><li><b>트리플 독점</b>: 컬러 독점 3곳 (관광지는 포함 안 됨)</li>
          <li><b>라인 독점</b>: 보드 한 줄의 도시·관광지를 모두 소유</li>
          <li><b>관광지 독점</b>: 모든 관광지 소유</li><li>또는 나머지 모두 파산</li></ul>
        <div class="muted">판본(베이직·이코노미·메가디럭스)에 따라 금액이 다를 수 있어요. 방장이 방을 만든 뒤 설정에서 바꿀 수 있습니다.</div>
      </div>
      <button class="btn mt" data-close>닫기</button>`);
  }

  // ---------- 시작 ----------
  if (session) {
    const roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam && roomParam !== session.code) saveSession(null);
  }
  if (session) connect(); else render();
})();
