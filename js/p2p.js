/* ============================================================
 * 点对点联机（P2P）：房主的浏览器就是服务器
 *
 * 与「服务器联机」的关系：
 *   · 服务器联机 —— 需要一台常开的 Node 服务器（server/server.js）做权威端；
 *   · 点对点联机 —— 两台设备用 WebRTC 数据通道直连，房主的浏览器就是权威端，
 *     对局数据不经过任何第三方，也不需要任何服务器。
 *
 * 为什么还需要「牵线」：
 *   两台设备要直连，得先互相告知「我在哪、怎么连我」（SDP / ICE 候选地址）。
 *   这个握手信息必须经一条双方都能到达的通道交换。本实现提供两种：
 *   ① 房间号模式（默认）：借助 PeerJS 公共信令服务牵线——房主创建房间得到
 *      6 位房间号，朋友输号即可，握手自动完成；
 *   ② 备用手动模式：房主生成邀请码 → 客人粘贴后生成回执码 → 房主粘贴回执码。
 *   两种方式握手之后，所有对局数据都走两台设备的点对点通道。
 *
 * 穿透能力：公共 STUN 穿透家用路由器；另附免费公共 TURN（Open Relay）中转，
 * 对称 NAT / 部分校园网·企业网下 STUN 失败时也能连上（速度略慢）。
 *
 * 对外接口与 GW.Net 保持一致（on / fire / sketch / chat / rematch / quit），
 * 因此 UI 层可以把两种联机方式当成同一个对象来用。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});

  /* 公共 STUN：只用于穿透 NAT、获取自己的公网候选地址，不中转任何对局数据。
   * 另附公共 TURN 中转（Open Relay 社区免费服务）：对称 NAT / 严格的校园网·企业网下
   * STUN 直连失败时，退而经 TURN 中转——速度略慢但能连上。 */
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
  /* PeerJS 房间号模式：公共信令只负责"牵线"（交换握手信息），对局数据仍点对点直连 */
  var PEER_PREFIX = 'hs-funcwar-';
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
    this._peer = null;    // PeerJS 实例（房间号模式）
    this._conn = null;    // PeerJS DataConnection（房间号模式）
    this._roomNum = null;
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
      if (self._acceptTimer) { clearTimeout(self._acceptTimer); self._acceptTimer = null; }
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
      alert('这串邀请码读不出来：请让房主把「邀请码」整段复制给你（首尾不要漏、别带多余空格或换行）。');
      this._emit('error', { msg: '这串邀请码读不出来，请让房主把码完整复制给你（首尾不要漏）。' });
      return;
    }
    if (!offer || (offer.type !== 'offer' || !offer.sdp)) {
      alert('这串不是有效的邀请码。应当贴的是房主点「① 我是房主：生成邀请码」后发来的那一串；不是「回执码」，也不是你自己生成的码。');
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
      alert('请先点「① 我是房主：生成邀请码」生成邀请码，再来贴回执码。');
      return;
    }
    /* 已经连上：无需再贴 */
    if (this.connected) {
      alert('直连已经建立、对战已在进行，不需要再贴回执码。');
      return;
    }
    /* 回执码只能应用一次：重复粘贴会报 "Called in wrong state" */
    var state = this.pc.signalingState;
    if (state === 'stable') {
      alert('这份回执码刚才已经贴过了，不能重复贴。\n现在正等待直连建立（最多 12 秒）：\n· 若随后自动进入对战，就是成功了；\n· 若一直没反应，请点「① 我是房主：重新生成邀请码」，双方从头再来一次。');
      return;
    }
    if (state !== 'have-local-offer') {
      alert('当前连接状态不对（' + state + '），无法贴回执码。\n请点「① 我是房主：重新生成邀请码」，把新的邀请码发给朋友重新走一遍。');
      return;
    }
    var answer;
    try {
      answer = decode((codeText || '').trim());
    } catch (e) {
      alert('这串回执码读不出来：请让朋友把「回执码」整段复制给你（首尾不要漏、别带多余空格或换行）。');
      return;
    }
    if (!answer || answer.type !== 'answer' || !answer.sdp) {
      alert('这里要贴的是朋友点「① 我加入」后生成的「回执码」，不是你或对方点「我是房主」生成的「邀请码」。\n请确认：对方点的是「我加入」按钮，不是「我是房主」。');
      return;
    }
    this._status('已收到回执码，正在建立直连…', 'info');
    this._acceptTimer = setTimeout(function () {
      if (self.connected) return;
      alert('连接超时：12 秒内未建立直连。常见原因：\n① 对方发来的不是「回执码」（而是邀请码）；\n② 回执码复制不完整；\n③ 双方都在校园网 / 企业网（对称 NAT），WebRTC 直连被挡。\n建议改用「服务器联机」。');
      self._emit('error', { msg: '连接超时：12 秒内未建立直连。常见原因：\n① 对方发来的不是「回执码」（而是邀请码）；\n② 回执码复制不完整；\n③ 双方都在校园网/企业网（对称 NAT），WebRTC 直连被挡。\n建议改用「服务器联机」。' });
    }, 12000);
    this.pc.setRemoteDescription(answer)['catch'](function (e) {
      if (self._acceptTimer) clearTimeout(self._acceptTimer);
      alert('建立连接失败：' + (e && e.message ? e.message : e));
      self._emit('error', { msg: '建立连接失败：' + (e && e.message ? e.message : e) });
    });
  };

  /* ---------------- 房间号模式（PeerJS 牵线，数据仍直连） ---------------- */

  /** 把 PeerJS DataConnection 适配成与原生 DataChannel 相同的事件 */
  P2P.prototype._bindConn = function (conn) {
    var self = this;
    this._conn = conn;
    conn.on('open', function () {
      self.connected = true;
      if (self._acceptTimer) { clearTimeout(self._acceptTimer); self._acceptTimer = null; }
      if (self._joinTimer) { clearTimeout(self._joinTimer); self._joinTimer = null; }
      self._status('直连已建立。', 'ok');
      self._emit('open');
      if (self.opts.onOpen) self.opts.onOpen();
    });
    conn.on('data', function (d) {
      var text = (typeof d === 'string') ? d : JSON.stringify(d);
      self._onRaw(text);
    });
    conn.on('close', function () {
      self.connected = false;
      self._emit('close');
      if (self.opts.onClose) self.opts.onClose();
    });
    conn.on('error', function (e) {
      var m = (e && e.message) ? e.message : '未知错误';
      self._emit('error', { msg: '数据通道出错：' + m });
    });
  };

  /** PeerJS 错误翻译成玩家能看懂的中文 */
  P2P.prototype._peerError = function (e) {
    var t = e && e.type;
    var msg;
    if (t === 'peer-unavailable') {
      msg = '找不到这个房间号：可能房主已退出房间，或号码输错了。\n请和房主核对 6 位房间号再试一次。';
    } else if (t === 'unavailable-id') {
      msg = '房间号撞号（极小概率），请再点一次「创建房间」。';
    } else if (t === 'network' || t === 'socket-error' || t === 'socket-closed' || t === 'server-error') {
      msg = '牵线服务器连不上（当前网络受限）。\n请展开下方「备用方式：手动复制连接码」，照样能玩。';
    } else if (t === 'browser-incompatible') {
      msg = '当前浏览器不支持点对点联机，请换 Chrome / Edge 等现代浏览器。';
    } else {
      msg = '点对点联机出错：' + ((e && e.message) ? e.message : t || '未知');
    }
    alert(msg);
    this._emit('error', { msg: msg });
  };

  /** 房主：创建房间 → 随机 6 位房间号；朋友输号即可加入 */
  P2P.prototype.hostRoom = function () {
    var self = this;
    if (typeof root.Peer === 'undefined') {
      this._emit('error', { msg: '房间号组件没加载出来（可能被网络拦截），请刷新页面重试，或展开「备用方式」手动换码。' });
      return;
    }
    if (GW.p2pSupported && !GW.p2pSupported()) {
      this._emit('error', { msg: '当前页面不支持点对点连接（需 https:// 或 localhost），请改用「服务器联机」' });
      return;
    }
    this._freePeer();
    this._status('正在创建房间…', 'info');
    var tried = 0;
    var self2 = this;
    function create() {
      tried++;
      var num = String(100000 + Math.floor(Math.random() * 900000));
      var peer;
      try { peer = new root.Peer(PEER_PREFIX + num, { debug: 0 }); }
      catch (e) { self2._peerError(e); return; }
      self2._peer = peer;
      self2._roomNum = num;
      peer.on('open', function () {
        self2._status('房间已创建！房间号 <b>' + num + '</b>：发给朋友，他输号即可加入，加入后自动开局。', 'ok');
        self2._emit('room', num);
      });
      peer.on('connection', function (conn) {
        /* 点对点只容 1 位客人：后来的直接婉拒 */
        if (self2._conn) { try { conn.close(); } catch (e2) { /* 忽略 */ } return; }
        self2._status('有玩家正在加入…', 'info');
        self2._bindConn(conn);
      });
      peer.on('disconnected', function () {
        if (!self2.connected) self2._status('与牵线服务器断开（已创建的房间不受影响），等待玩家加入中…', 'info');
      });
      peer.on('error', function (e) {
        if (e && e.type === 'unavailable-id' && tried < 3) { try { peer.destroy(); } catch (e2) {} create(); return; }
        self2._peerError(e);
      });
    }
    create();
  };

  /** 客人：输入 6 位房间号加入 */
  P2P.prototype.joinRoom = function (num) {
    var self = this;
    num = String(num || '').trim();
    if (!/^\d{6}$/.test(num)) {
      alert('房间号是 6 位数字，请检查后重新输入。');
      return;
    }
    if (typeof root.Peer === 'undefined') {
      this._emit('error', { msg: '房间号组件没加载出来（可能被网络拦截），请刷新页面重试，或展开「备用方式」手动换码。' });
      return;
    }
    if (GW.p2pSupported && !GW.p2pSupported()) {
      this._emit('error', { msg: '当前页面不支持点对点连接（需 https:// 或 localhost），请改用「服务器联机」' });
      return;
    }
    this._freePeer();
    this._status('正在加入房间 ' + num + ' …', 'info');
    var peer;
    try { peer = new root.Peer({ debug: 0 }); }
    catch (e) { this._peerError(e); return; }
    this._peer = peer;
    this._roomNum = num;
    this._joinTimer = setTimeout(function () {
      if (self.connected) return;
      alert('加入超时：房间 ' + num + ' 没有响应。\n常见原因：房间号输错、房主已退出、或当前网络连不上牵线服务器。\n可展开「备用方式：手动复制连接码」再试。');
    }, 15000);
    peer.on('open', function () {
      var conn = peer.connect(PEER_PREFIX + num, { reliable: true });
      self._bindConn(conn);
    });
    peer.on('error', function (e) {
      if (self._joinTimer) { clearTimeout(self._joinTimer); self._joinTimer = null; }
      self._peerError(e);
    });
  };

  /** 释放 PeerJS 牵线资源（不影响已建立的直连） */
  P2P.prototype._freePeer = function () {
    if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null; }
    if (this._peer) {
      try { this._peer.destroy(); } catch (e) { /* 忽略 */ }
      this._peer = null;
    }
    this._conn = null;
  };

  /* ---------------- 收发 ---------------- */
  /** 当前可用的发送通道：手动模式用 dc，房间号模式用 PeerJS conn */
  P2P.prototype._chan = function () {
    if (this.dc && this.dc.readyState === 'open') return this.dc;
    if (this._conn && this._conn.open) return this._conn;
    return null;
  };

  P2P.prototype.send = function (obj) {
    var chan = this._chan();
    if (!chan) return;
    var text;
    try { text = JSON.stringify(obj); } catch (e) { return; }
    try {
      if (text.length <= CHUNK) { chan.send(text); return; }
      /* 超长消息（长弹道）分片发送，避免超出数据通道单条上限 */
      var id = 'c' + Date.now() + Math.floor(Math.random() * 1000);
      var n = Math.ceil(text.length / CHUNK);
      for (var i = 0; i < n; i++) {
        chan.send(JSON.stringify({
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
    var dc = this.dc, pc = this.pc, conn = this._conn, peer = this._peer;
    setTimeout(function () {
      try { if (dc) dc.close(); } catch (e) { /* 忽略 */ }
      try { if (pc) pc.close(); } catch (e) { /* 忽略 */ }
      try { if (conn) conn.close(); } catch (e) { /* 忽略 */ }
      try { if (peer) peer.destroy(); } catch (e) { /* 忽略 */ }
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
