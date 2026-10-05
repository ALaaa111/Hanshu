/* ============================================================
 * 点对点联机（P2P）：房主的浏览器就是服务器
 *
 * 与「服务器联机」的关系：
 *   · 服务器联机 —— 需要一台常开的 Node 服务器（server/server.js）做权威端；
 *   · 点对点联机 —— 两台设备用 WebRTC 数据通道直连，房主的浏览器就是权威端，
 *     对局数据不经过任何第三方，也不需要任何服务器。
 *
 * 为什么还需要「复制连接码」：
 *   两台设备要直连，得先互相告知「我在哪、怎么连我」（SDP / ICE 候选地址）。
 *   这个「握手信息」必须经一条双方都能到达的通道交换——本实现采用**手动复制**：
 *   房主生成邀请码 → 客人粘贴后生成回执码 → 房主粘贴回执码 → 直连建立。
 *   只复制这一次，之后所有对局数据都走点对点通道。
 *
 * 穿透能力：借助公共 STUN 服务器穿透家用路由器。少数网络（对称 NAT、
 * 部分校园网 / 企业网）必须靠 TURN 中转才能连通，本实现不含 TURN，
 * 连不上时会明确提示改用「服务器联机」。
 *
 * 对外接口与 GW.Net 保持一致（on / fire / sketch / chat / rematch / quit），
 * 因此 UI 层可以把两种联机方式当成同一个对象来用。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});

  /* 公共 STUN：只用于穿透 NAT、获取自己的公网候选地址，不中转任何对局数据 */
  var ICE_SERVERS = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
        'stun:global.stun.twilio.com:3478'
      ]
    }
  ];
  /* 数据通道单条消息上限（各家浏览器约 256KB，留足余量） */
  var CHUNK = 60 * 1024;

  /* ---------------- 连接码编解码（JSON → base64，便于整段复制） ---------------- */
  function encode(obj) {
    var json = JSON.stringify(obj);
    var s;
    if (typeof TextEncoder !== 'undefined') {
      var bytes = new TextEncoder().encode(json);
      var out = '';
      for (var i = 0; i < bytes.length; i += 4096) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
      }
      s = out;
    } else {
      s = unescape(encodeURIComponent(json));
    }
    return btoa(s);
  }

  function decode(str) {
    var bin = atob(String(str).replace(/\s+/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var json = (typeof TextDecoder !== 'undefined')
      ? new TextDecoder().decode(bytes)
      : decodeURIComponent(escape(bin));
    return JSON.parse(json);
  }

  /* ---------------- 主体 ---------------- */
  function P2P(opts) {
    opts = opts || {};
    this.role = (opts.role === 'guest') ? 'guest' : 'host';
    this.team = (this.role === 'host') ? 0 : 1;
    this.room = 'P2P';
    this.handlers = {};
    this.pc = null;
    this.dc = null;
    this.connected = false;
    this.closed = false;
    this.opts = opts;
    this._chunks = null;
  }

  /* 暴露编解码便于测试：连接码 = base64(JSON(SDP))，可整段复制 / 粘贴 */
  P2P.encode = encode;
  P2P.decode = decode;

  P2P.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
    return this;
  };

  P2P.prototype._emit = function (type, data) {
    var list = this.handlers[type] || [];
    for (var i = 0; i < list.length; i++) list[i](data || {});
  };

  P2P.prototype._status = function (text, kind) {
    if (this.opts.onStatus) this.opts.onStatus(text, kind || 'info');
  };

  P2P.prototype._code = function (text, tag) {
    if (this.opts.onCode) this.opts.onCode(text, tag);
  };

  P2P.prototype._mkPc = function () {
    var self = this;
    if (typeof RTCPeerConnection === 'undefined') {
      this._emit('error', { msg: '当前浏览器不支持点对点连接（WebRTC），请改用「服务器联机」' });
      return null;
    }
    var pc;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (e) {
      this._emit('error', { msg: '无法创建点对点连接：' + (e && e.message ? e.message : e) });
      return null;
    }
    this.pc = pc;
    pc.oniceconnectionstatechange = function () {
      if (pc.iceConnectionState === 'failed') {
        self._emit('error', {
          msg: '点对点连接失败：双方网络可能都在对称 NAT 之后（常见于校园网 / 企业网）。' +
            '请改用「服务器联机」，或由房主运行 server/server.js。'
        });
      }
    };
    return pc;
  };

  /** 等 ICE 收集完毕（非 trickle 模式：候选地址必须已经写进 SDP 才能整段复制） */
  P2P.prototype._whenReady = function (cb) {
    var pc = this.pc, done = false;
    function finish() { if (done) return; done = true; clearTimeout(timer); cb(); }
    var timer = setTimeout(finish, 5000);
    pc.onicegatheringstatechange = function () {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.onicecandidate = function (e) {
      if (!e || !e.candidate) setTimeout(finish, 300);
    };
  };

  P2P.prototype._bindChannel = function (dc) {
    var self = this;
    this.dc = dc;
    dc.onopen = function () {
      self.connected = true;
      self._status('直连已建立。', 'ok');
      self._emit('open');
      if (self.opts.onOpen) self.opts.onOpen();
    };
    dc.onclose = function () {
      self.connected = false;
      self._emit('close');
      if (self.opts.onClose) self.opts.onClose();
    };
    dc.onerror = function (e) {
      var m = (e && e.error && e.error.message) ? e.error.message : '未知错误';
      self._emit('error', { msg: '数据通道出错：' + m });
    };
    dc.onmessage = function (ev) { self._onRaw(ev.data); };
  };

  /* ---------------- 三步握手 ---------------- */

  /** ① 房主：生成邀请码 */
  P2P.prototype.hostStart = function () {
    var self = this;
    if (GW.p2pSupported && !GW.p2pSupported()) {
      this._emit('error', { msg: '当前页面不支持点对点连接（需 https:// 或 localhost），请改用「服务器联机」' });
      return;
    }
    var pc = this._mkPc();
    if (!pc) return;
    this._status('正在收集网络候选地址，生成邀请码…', 'info');
    var dc;
    try {
      dc = pc.createDataChannel('gw', { ordered: true });
    } catch (e) {
      this._emit('error', { msg: '创建数据通道失败：' + (e && e.message ? e.message : e) });
      return;
    }
    this._bindChannel(dc);
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      self._whenReady(function () {
        try {
          self._code(encode(pc.localDescription), 'offer');
        } catch (e) {
          self._emit('error', { msg: '生成邀请码失败：' + (e && e.message ? e.message : e) });
          return;
        }
        self._status('邀请码已生成：复制发给朋友，让他粘贴后生成「回执码」发回给你。', 'ok');
      });
    })['catch'](function (e) {
      self._emit('error', { msg: '生成邀请码失败：' + (e && e.message ? e.message : e) });
    });
  };

  /** ② 客人：粘贴邀请码 → 生成回执码 */
  P2P.prototype.guestAnswer = function (codeText) {
    var self = this;
    if (GW.p2pSupported && !GW.p2pSupported()) {
      this._emit('error', { msg: '当前页面不支持点对点连接（需 https:// 或 localhost），请改用「服务器联机」' });
      return;
    }
    var offer;
    try {
      offer = decode((codeText || '').trim());
    } catch (e) {
      this._emit('error', { msg: '这串邀请码读不出来，请让房主把码完整复制给你（首尾不要漏）。' });
      return;
    }
    if (!offer || (offer.type !== 'offer' || !offer.sdp)) {
      this._emit('error', { msg: '这串不是有效的邀请码（应当贴的是房主生成的那一串）。' });
      return;
    }
    var pc = this._mkPc();
    if (!pc) return;
    this._status('正在生成回执码…', 'info');
    pc.ondatachannel = function (ev) { self._bindChannel(ev.channel); };
    pc.setRemoteDescription(offer).then(function () {
      return pc.createAnswer();
    }).then(function (answer) {
      return pc.setLocalDescription(answer);
    }).then(function () {
      self._whenReady(function () {
        try {
          self._code(encode(pc.localDescription), 'answer');
        } catch (e) {
          self._emit('error', { msg: '生成回执码失败：' + (e && e.message ? e.message : e) });
          return;
        }
        self._status('回执码已生成：把它发回给房主，房主粘贴后对战立即开始。', 'ok');
      });
    })['catch'](function (e) {
      self._emit('error', { msg: '处理邀请码失败：' + (e && e.message ? e.message : e) });
    });
  };

  /** ③ 房主：粘贴回执码 → 直连建立 */
  P2P.prototype.hostAccept = function (codeText) {
    var self = this;
    if (!this.pc) {
      this._emit('error', { msg: '请先点「① 我是房主：生成邀请码」。' });
      return;
    }
    var answer;
    try {
      answer = decode((codeText || '').trim());
    } catch (e) {
      this._emit('error', { msg: '这串回执码读不出来，请让朋友把码完整复制给你。' });
      return;
    }
    if (!answer || answer.type !== 'answer' || !answer.sdp) {
      this._emit('error', { msg: '这里要贴的是朋友生成的「回执码」，不是你自己那串邀请码。' });
      return;
    }
    this._status('已收到回执码，正在建立直连…', 'info');
    this.pc.setRemoteDescription(answer)['catch'](function (e) {
      self._emit('error', { msg: '建立连接失败：' + (e && e.message ? e.message : e) });
    });
  };

  /* ---------------- 收发 ---------------- */
  P2P.prototype.send = function (obj) {
    if (!this.dc || this.dc.readyState !== 'open') return;
    var text;
    try { text = JSON.stringify(obj); } catch (e) { return; }
    try {
      if (text.length <= CHUNK) { this.dc.send(text); return; }
      /* 超长消息（长弹道）分片发送，避免超出数据通道单条上限 */
      var id = 'c' + Date.now() + Math.floor(Math.random() * 1000);
      var n = Math.ceil(text.length / CHUNK);
      for (var i = 0; i < n; i++) {
        this.dc.send(JSON.stringify({
          __chunk: { id: id, i: i, n: n, data: text.substr(i * CHUNK, CHUNK) }
        }));
      }
    } catch (e) { /* 忽略发送失败 */ }
  };

  P2P.prototype._onRaw = function (text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
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
    this._onMessage(msg);
  };

  P2P.prototype._onMessage = function (msg) {
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

  /* ---------------- 对局内动作 ---------------- */
  P2P.prototype.fire = function (expr, angle, weapon) { this.send({ type: 'fire', expr: expr, angle: angle || 0, weapon: weapon == null ? 1 : weapon }); };
  P2P.prototype.sketch = function (norm, rot, scale, weapon) { this.send({ type: 'sketch', norm: norm, rot: rot, scale: scale, weapon: weapon == null ? 1 : weapon }); };
  P2P.prototype.move = function (expr, dist) { this.send({ type: 'move_intent', expr: expr, dist: dist }); };
  P2P.prototype.sketchMove = function (norm, rot, scale, dist) { this.send({ type: 'move_intent', norm: norm, rot: rot, scale: scale, dist: dist }); };
  P2P.prototype.skill = function () { this.send({ type: 'skill' }); };
  /** 开局技能选择：客人把技能 id 交给房主（房主即权威端） */
  P2P.prototype.skillPick = function (id) { this.send({ type: 'skill_pick', skill: id, seat: this.team }); };
  P2P.prototype.angle = function (a) { this.send({ type: 'angle', angle: a }); };
  P2P.prototype.rematch = function () { this.send({ type: 'rematch' }); };
  P2P.prototype.chat = function (id, text) {
    this.send({ type: 'chat', id: id, text: text, from: this.team });
  };

  P2P.prototype.quit = function () {
    this.closed = true;
    try { this.send({ type: 'opponent_left' }); } catch (e) { /* 忽略 */ }
    var dc = this.dc, pc = this.pc;
    setTimeout(function () {
      try { if (dc) dc.close(); } catch (e) { /* 忽略 */ }
      try { if (pc) pc.close(); } catch (e) { /* 忽略 */ }
    }, 150);
    this.connected = false;
  };

  GW.P2P = P2P;

  /** 当前环境能否跑点对点：需要浏览器支持 WebRTC，且页面处于安全上下文
   *  （https:// 或 localhost——用局域网 IP 打开的 http:// 页面会被浏览器禁用 WebRTC）。 */
  GW.p2pSupported = function () {
    if (typeof RTCPeerConnection === 'undefined') return false;
    var secure = root.isSecureContext;
    return (typeof secure === 'undefined') ? true : !!secure;
  };

})(typeof window !== 'undefined' ? window : globalThis);
