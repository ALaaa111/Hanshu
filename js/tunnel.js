/* ============================================================
 * 内网穿透联机（Tunnel）：房主浏览器 = 权威端，中继服务器做「打洞 + 兜底中转」
 *
 * 类比 Tailscale：
 *   · 房主浏览器就是权威服务器（跑 GW.Game，回合由自己推进）；
 *   · 中继服务器（server/relay.js）只做两件事：
 *       ① 转发 WebRTC 握手（信令），让两台设备尝试【直连】（Tailscale 直连，低延迟）；
 *       ② 直连打不通（对称 NAT / 校园网 / 企业网，或浏览器不支持 WebRTC）时，
 *          由中继服务器【透明中转】所有对局数据（Tailscale 的 DERP 中继兜底）。
 *   · 因此即使双方不在同一网络、甚至在严格 NAT 之后，也能连上；最坏情况只是走中继、
 *     速度稍慢，但游戏照常可玩（回合制对战，延迟无关紧要）。
 *
 * 与「点对点联机（p2p.js）」的关系：
 *   旧的 p2p.js 用 PeerJS 公共信令，但它【不中转数据】，所以对称 NAT 下经常连不上。
 *   本模块用自建中继服务器，信令 + 数据中继一体，连接成功率大幅提升，且接口保持一致：
 *   on / fire / sketch / move / skill / skillPick / angle / rematch / chat / quit / hostRoom / joinRoom。
 *   UI 层把两种联机当成同一个对象来用即可。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});

  /* 公共 STUN 用于穿透 NAT、获取公网候选地址（不中转数据）；TURN 作直连失败时的最后兜底。
   * 但即便 STUN/TURN 全都失败，本模块仍会自动降级为「中继服务器中转」，所以一定能连上。 */
  var ICE_SERVERS = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
        'stun:global.stun.twilio.com:3478'
      ]
    },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  /* 单条消息上限（数据通道 / 中继都按文本转发，留足余量） */
  var CHUNK = 60 * 1024;

  /* ---------------- 主体 ---------------- */
  function Tunnel(opts) {
    opts = opts || {};
    this.role = (opts.role === 'guest') ? 'guest' : 'host';
    this.team = (this.role === 'host') ? 0 : 1;
    this.room = null;            // 6 位房间号
    this.peerId = null;
    this.handlers = {};
    this.ws = null;              // 与中继服务器的 WebSocket
    this.pc = null;              // WebRTC 连接（用于直连尝试）
    this.dc = null;              // WebRTC 数据通道（直连通道）
    this.connected = false;      // 与对手是否可达（直连 或 中继 任一成立）
    this.relayMode = false;      // true = 当前走中继服务器中转（兜底路径）
    this._opened = false;        // 'open' 事件是否已触发（只触发一次）
    this._fb = null;             // 直连兜底定时器
    this._pending = null;        // 还没收到 welcome 时缓存的 create/join
    this.closed = false;
    this.opts = opts;
    this._relayUrl = (opts.relayUrl || '').trim();
    this._chunks = null;
  }

  Tunnel.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
    return this;
  };

  Tunnel.prototype._emit = function (type, data) {
    var list = this.handlers[type] || [];
    for (var i = 0; i < list.length; i++) list[i](data || {});
  };

  Tunnel.prototype._status = function (text, kind) {
    if (this.opts.onStatus) this.opts.onStatus(text, kind || 'info');
  };

  Tunnel.prototype._room = function (num) {
    if (this.opts.onRoom) this.opts.onRoom(num);
  };

  /* ---------------- 连接中继服务器 ---------------- */
  Tunnel.prototype._connect = function () {
    if (this.ws && this.ws.readyState === 1) return true;
    if (!this._relayUrl) {
      this._emit('error', { msg: '请先填写「中继服务器地址」（内网穿透服务器）。' });
      return false;
    }
    if (typeof WebSocket === 'undefined') {
      this._emit('error', { msg: '当前浏览器不支持 WebSocket，无法使用内网穿透联机。' });
      return false;
    }
    var self = this;
    try { this.ws = new WebSocket(this._relayUrl); }
    catch (e) {
      this._emit('error', { msg: '无法连接中继服务器：' + (e && e.message ? e.message : e) });
      return false;
    }
    this.ws.onopen = function () { self._send2({ type: 'hello' }); };
    this.ws.onmessage = function (ev) {
      try { self._onWs(JSON.parse(ev.data)); } catch (e) { /* 忽略坏帧 */ }
    };
    this.ws.onclose = function () {
      if (self.connected) self._emit('close');
    };
    this.ws.onerror = function () {
      if (!self.connected) self._emit('error', { msg: '连接中继服务器失败：请确认地址正确且服务器已启动。' });
    };
    return true;
  };

  Tunnel.prototype._send2 = function (obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* 忽略 */ }
    }
  };

  /* 房主创建房间 / 客人加入房间（房间号模式） */
  Tunnel.prototype.create = function () {
    if (!this._connect()) return;
    if (this.peerId) this._send2({ type: 'create' });
    else this._pending = { action: 'create' };
  };
  Tunnel.prototype.join = function (num) {
    num = String(num || '').trim();
    if (!/^\d{6}$/.test(num)) {
      alert('房间号是 6 位数字，请检查后重新输入。');
      return;
    }
    if (!this._connect()) return;
    if (this.peerId) this._send2({ type: 'join', room: num });
    else this._pending = { action: 'join', room: num };
  };
  Tunnel.prototype.hostRoom = function () { this.role = 'host'; this.create(); };
  Tunnel.prototype.joinRoom = function (num) { this.role = 'guest'; this.join(num); };

  /* ---------------- 中继信令处理 ---------------- */
  Tunnel.prototype._onWs = function (msg) {
    var self = this;
    switch (msg.type) {
      case 'welcome':
        this.peerId = msg.id;
        if (this._pending) {
          var p = this._pending; this._pending = null;
          if (p.action === 'create') this._send2({ type: 'create' });
          else if (p.action === 'join') this._send2({ type: 'join', room: p.room });
        }
        break;
      case 'created':
        this.room = msg.room;
        this._room(msg.room);
        this._status('房间已创建！房间号 <b>' + msg.room + '</b>：发给朋友，他加入后自动开局。', 'ok');
        break;
      case 'joined':
        this.room = msg.room;
        this._status('已加入房间 ' + msg.room + '，等待房主开局…', 'ok');
        /* 客人：支持 WebRTC 就等房主发来的握手（带兜底定时器）；不支持就直接走中继 */
        if (typeof RTCPeerConnection === 'undefined') this._goRelayOnly();
        else this._startFallback();
        break;
      case 'peer-joined':
        /* 房主：有客人进来了，开始 WebRTC 直连握手（不支持则直接中继） */
        if (this.role === 'host') this._hostNegotiate();
        break;
      case 'signal':
        this._onSignal(msg.data);
        break;
      case 'relay':
        this._onRaw(typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data));
        break;
      case 'peer-left':
        this._emit('opponent_left');
        break;
      case 'error':
        this._status('错误：' + (msg.msg || '未知'), 'error');
        this._emit('error', { msg: msg.msg || '未知错误' });
        break;
      default:
        break;
    }
  };

  /* ---------------- WebRTC 直连尝试（Tailscale 直连） ---------------- */
  Tunnel.prototype._mkPc = function () {
    if (typeof RTCPeerConnection === 'undefined') return null;
    var self = this;
    var pc;
    try { pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); }
    catch (e) { return null; }
    this.pc = pc;
    pc.oniceconnectionstatechange = function () { /* failed 时由兜底定时器切到中继 */ };
    return pc;
  };

  Tunnel.prototype._hostNegotiate = function () {
    var self = this;
    if (typeof RTCPeerConnection === 'undefined') { this._goRelayOnly(); return; }
    var pc = this._mkPc();
    if (!pc) { this._goRelayOnly(); return; }
    var dc;
    try { dc = pc.createDataChannel('gw', { ordered: true }); }
    catch (e) { this._goRelayOnly(); return; }
    this._bindChannel(dc);
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () {
      self._send2({ type: 'signal', data: pc.localDescription });
      self._startFallback();
    })['catch'](function () { self._goRelayOnly(); });
  };

  Tunnel.prototype._guestNegotiate = function (desc) {
    var self = this;
    if (typeof RTCPeerConnection === 'undefined') { this._goRelayOnly(); return; }
    var pc = this._mkPc();
    if (!pc) { this._goRelayOnly(); return; }
    pc.ondatachannel = function (ev) { self._bindChannel(ev.channel); };
    pc.setRemoteDescription(desc).then(function () { return pc.createAnswer(); }).then(function (a) {
      return pc.setLocalDescription(a);
    }).then(function () {
      self._send2({ type: 'signal', data: pc.localDescription });
      self._startFallback();
    })['catch'](function () { self._goRelayOnly(); });
  };

  Tunnel.prototype._onSignal = function (desc) {
    if (!desc) return;
    if (desc.type === 'offer') { this._guestNegotiate(desc); }
    else if (desc.type === 'answer') { if (this.pc) { try { this.pc.setRemoteDescription(desc); } catch (e) {} } }
    else if (desc.candidate) { if (this.pc) { try { this.pc.addIceCandidate(desc); } catch (e) {} } }
  };

  Tunnel.prototype._bindChannel = function (dc) {
    var self = this;
    this.dc = dc;
    dc.onopen = function () {
      self.connected = true;
      self.relayMode = false;
      if (self._fb) { clearTimeout(self._fb); self._fb = null; }
      self._maybeOpen('direct');
    };
    dc.onclose = function () {
      /* 直连断开：自动降级为中继中转，并探一下对手是否仍在 */
      if (self.connected) { self.relayMode = true; self._rawSend(JSON.stringify({ type: '__ping' })); }
    };
    dc.onerror = function () { /* 忽略，由兜底定时器处理 */ };
    dc.onmessage = function (ev) {
      self._onRaw(typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data));
    };
  };

  /* 10 秒内没建立直连 → 自动走中继服务器中转（Tailscale DERP 兜底） */
  Tunnel.prototype._startFallback = function () {
    var self = this;
    if (this._fb) clearTimeout(this._fb);
    this._fb = setTimeout(function () {
      if (self.connected) return;
      self.relayMode = true;
      self._rawSend(JSON.stringify({ type: '__ping' }));
    }, 10000);
  };

  /* 完全没有 WebRTC 支持（或握手失败）→ 直接走中继 */
  Tunnel.prototype._goRelayOnly = function () {
    this.relayMode = true;
    if (this.ws && this.ws.readyState === 1) this._rawSend(JSON.stringify({ type: '__ping' }));
  };

  /* ---------------- 收发 ---------------- */
  /* 当前可用通道：直连通道优先；否则经中继服务器（__ping 之类控制帧也走这里） */
  Tunnel.prototype._rawSend = function (text) {
    if (this.dc && this.dc.readyState === 'open' && !this.relayMode) {
      try { this.dc.send(text); return; } catch (e) { /* 落到中继 */ }
    }
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify({ type: 'relay', data: text })); return; } catch (e) { /* 忽略 */ }
    }
  };

  Tunnel.prototype.send = function (obj) {
    var text;
    try { text = JSON.stringify(obj); } catch (e) { return; }
    if (text.length <= CHUNK) { this._rawSend(text); return; }
    var id = 'c' + Date.now() + Math.floor(Math.random() * 1000);
    var n = Math.ceil(text.length / CHUNK);
    for (var i = 0; i < n; i++) {
      this._rawSend(JSON.stringify({
        __chunk: { id: id, i: i, n: n, data: text.substr(i * CHUNK, CHUNK) }
      }));
    }
  };

  Tunnel.prototype._onRaw = function (text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    /* 任何来自对手的字节都说明「可达」 */
    if (!this.connected) { this.connected = true; this._maybeOpen('relay'); }
    if (msg && msg.__chunk) {
      var c = msg.__chunk;
      if (!this._chunks || this._chunks.id !== c.id) this._chunks = { id: c.id, n: c.n, parts: [] };
      this._chunks.parts[c.i] = c.data;
      var got = 0;
      for (var i = 0; i < this._chunks.parts.length; i++) if (this._chunks.parts[i] != null) got++;
      if (got < this._chunks.n) return;
      var full = this._chunks.parts.join('');
      this._chunks = null;
      try { msg = JSON.parse(full); } catch (e2) { return; }
    }
    if (msg && msg.type === '__ping') return;   // 纯握手探活帧，不进游戏逻辑
    this._onMessage(msg);
  };

  Tunnel.prototype._maybeOpen = function (kind) {
    if (this._opened) return;
    this._opened = true;
    if (kind === 'relay') {
      this._status('已通过中继服务器连接（打洞未成功，走中转，速度稍慢但能玩）。', 'ok');
    } else {
      this._status('直连已建立（内网穿透成功）。', 'ok');
    }
    this._emit('open');
    if (this.opts.onOpen) this.opts.onOpen();
  };

  Tunnel.prototype._onMessage = function (msg) {
    switch (msg.type) {
      case 'start': this._emit('start', msg); break;
      case 'turn': this._emit('turn', msg); break;
      case 'shot': this._emit('shot', msg); break;
      case 'move': this._emit('move', msg); break;
      case 'skill_used': this._emit('skill_used', msg); break;
      case 'reward': this._emit('reward', msg); break;
      case 'pack': this._emit('pack', msg); break;
      case 'over': this._emit('over', msg); break;
      case 'chat': this._emit('chat', msg); break;
      case 'fire_error': this._emit('fire_error', msg); break;
      case 'opponent_left': this._emit('opponent_left', msg); break;
      case 'bot_tookover': this._emit('bot_tookover', msg); break;
      case 'error': this._emit('error', msg); break;
      /* 下面这些只有房主端会收到（客人把开炮意图发给权威端） */
      case 'fire': this._emit('fire', msg); break;
      case 'sketch': this._emit('sketch', msg); break;
      case 'move_intent': this._emit('move_intent', msg); break;
      case 'skill': this._emit('skill', msg); break;
      case 'skill_pick': this._emit('skill_pick', msg); break;
      case 'angle': this._emit('angle', msg); break;
      case 'rematch': this._emit('rematch', msg); break;
      default: break;
    }
  };

  /* ---------------- 对局内动作（与旧 P2P / 服务器 Net 接口一致） ---------------- */
  Tunnel.prototype.fire = function (expr, angle, weapon) { this.send({ type: 'fire', expr: expr, angle: angle || 0, weapon: weapon == null ? 1 : weapon }); };
  Tunnel.prototype.sketch = function (norm, rot, scale, weapon) { this.send({ type: 'sketch', norm: norm, rot: rot, scale: scale, weapon: weapon == null ? 1 : weapon }); };
  Tunnel.prototype.move = function (expr, dist) { this.send({ type: 'move_intent', expr: expr, dist: dist }); };
  Tunnel.prototype.sketchMove = function (norm, rot, scale, dist) { this.send({ type: 'move_intent', norm: norm, rot: rot, scale: scale, dist: dist }); };
  Tunnel.prototype.skill = function () { this.send({ type: 'skill' }); };
  /** 开局技能选择：客人把技能 id 交给房主（房主即权威端） */
  Tunnel.prototype.skillPick = function (id) { this.send({ type: 'skill_pick', skill: id, seat: this.team }); };
  Tunnel.prototype.angle = function (a) { this.send({ type: 'angle', angle: a }); };
  Tunnel.prototype.rematch = function () { this.send({ type: 'rematch' }); };
  Tunnel.prototype.chat = function (id, text) {
    this.send({ type: 'chat', id: id, text: text, from: this.team });
  };

  Tunnel.prototype.quit = function () {
    this.closed = true;
    try { this._send2({ type: 'bye' }); } catch (e) { /* 忽略 */ }
    var ws = this.ws, pc = this.pc, dc = this.dc;
    setTimeout(function () {
      try { if (dc) dc.close(); } catch (e) { /* 忽略 */ }
      try { if (pc) pc.close(); } catch (e) { /* 忽略 */ }
      try { if (ws) ws.close(); } catch (e) { /* 忽略 */ }
    }, 150);
    this.connected = false;
  };

  GW.Tunnel = Tunnel;

  /** 当前环境能否用内网穿透联机：只需要浏览器支持 WebSocket（中继兜底让它在无 WebRTC 时也能用） */
  GW.tunnelSupported = function () { return typeof WebSocket !== 'undefined'; };
  /* 兼容旧调用：UI 里个别地方仍可能用到 p2pSupported，这里指向同一判断 */
  if (!GW.p2pSupported) GW.p2pSupported = GW.tunnelSupported;

})(typeof window !== 'undefined' ? window : globalThis);
