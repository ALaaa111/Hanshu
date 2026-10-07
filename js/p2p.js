/* ============================================================
 * 函数战争 · 联机核心（P2P / WebRTC）
 *
 * 设计原则：玩家与房主都不需要「服务器」这个概念。
 *   · 房主点「创建房间」：浏览器向公共信令云（PeerJS Cloud）登记一个房间号；
 *   · 朋友点开邀请链接 / 输入房间号：浏览器与房主【点对点直连】；
 *   · 对局数据全程走 WebRTC 数据通道，不经过任何中间服务器。
 *
 * 拓扑：星型。房主的浏览器是唯一的「权威端」（跑 GW.Game、推进回合），
 *       每位客人只与房主建立一条数据通道；客人之间不直连。
 *       这样 2~8 人都能玩，且必然只有一份权威状态，不会出现不同步。
 *
 * 接口（UI 层只需认识这一个对象）：
 *   on(type, fn) / send(obj) / sendTo(seat, obj) / quit()
 *   hostRoom() / joinRoom(code)
 *   fire / sketch / move / sketchMove / skill / skillPick / angle / rematch / chat
 * 事件：
 *   room(code)        房主拿到房间号
 *   lobby(state)      大厅人数变化（房主与客人都收得到）
 *   joined(msg)       客人被房主接纳，msg.team = 自己的席位
 *   open()            第一条数据通道打通
 *   peer_join/peer_leave
 *   start / turn / shot / move / skill_used / skills / reward / pack / over /
 *   fire_error / chat / opponent_left / close
 *   fire / sketch / move_intent / skill / skill_pick / rematch   （这些是客人发给房主的意图）
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});

  /* 信令 ID 前缀：避免与公共信令云上其它应用撞车。
   * 玩家看到的是 5 位房间号，真正注册到信令云的是 'hanshu-gw-' + 房间号。 */
  var ID_PREFIX = 'hanshu-gw-';
  var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 去掉 0/O/1/I/L 等易混字符
  var CODE_LEN = 5;

  /* ICE 服务器（玩家全程无感，浏览器自动选用）。
   * 下面这些节点均已实测在本机网络可用：
   *   · STUN 帮双方发现自己的公网地址 —— 家用宽带绝大多数靠它即可直连；
   *   · TURN 是打洞彻底失败（对称 NAT / 4G 5G / 公司校园网）时的兜底中转。
   * WebRTC 自带端到端加密，能直连就直连，只有直连失败才用 TURN。 */
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
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  /* 客人连上房主后，多久还没打通就报错（毫秒） */
  var CONNECT_TIMEOUT = 20000;

  function randCode() {
    var s = '';
    for (var i = 0; i < CODE_LEN; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    return s;
  }

  /* 把玩家输入的房间号规整：去空格、转大写、去掉非法字符 */
  function normalizeCode(v) {
    return String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /* PeerJS 尚未加载时（CDN 还在切源）最多等一会儿再报错 */
  function waitForPeer(cb, tries) {
    if (typeof Peer !== 'undefined') return cb(true);
    if ((tries || 0) >= 25) return cb(false);
    setTimeout(function () { waitForPeer(cb, (tries || 0) + 1); }, 400);
  }

  /* ---------------- 主体 ---------------- */
  function P2P(opts) {
    opts = opts || {};
    this.opts = opts;
    this.role = (opts.role === 'guest') ? 'guest' : 'host';
    this.roster = opts.roster || { teams: 2, perTeam: 1, count: 2 };
    this.code = null;          // 房间号（5 位）
    this.room = null;          // 兼容旧字段：同 code
    this.seat = 0;             // 我方席位（房主恒为 0；客人由房主下发）
    this.peer = null;          // PeerJS 实例
    this.peerId = null;
    this.conns = [];           // [{ conn, id, seat, name, open }]
    this.handlers = {};
    this.closed = false;
    this.connected = false;    // 我方是否已与对手建立数据通道
    this._opened = false;
    this._timer = null;
    this._lobbyJoined = null;  // 客人侧：由房主同步过来的已加入人数
  }

  P2P.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
    return this;
  };

  P2P.prototype._emit = function (type, data) {
    var list = this.handlers[type];
    if (list) for (var i = 0; i < list.length; i++) list[i](data || {});
    /* 事件同时回调给构造参数里的同名钩子，方便轻量接入 */
    var hook = this.opts['on' + type.replace(/(^|_)(\w)/g, function (m, a, b) { return b.toUpperCase(); })];
    if (typeof hook === 'function') hook(data || {});
  };

  P2P.prototype._status = function (text, kind) {
    if (this.opts.onStatus) this.opts.onStatus(text, kind || 'info');
  };

  /* ---------------- 房主：注册房间 ---------------- */
  P2P.prototype.hostRoom = function () {
    var self = this;
    this.role = 'host';
    this.seat = 0;
    waitForPeer(function (ok) {
      if (!ok) { self._fail('联机组件没能加载（PeerJS CDN 不可达）。请检查网络后刷新页面重试。'); return; }
      self._createPeer(randCode(), true);
    });
  };

  /* ---------------- 客人：加入房间 ---------------- */
  P2P.prototype.joinRoom = function (code) {
    var self = this;
    code = normalizeCode(code);
    if (code.length < 4) {
      this._fail('房间号不对，请检查后重新输入（通常是 5 位字母数字）。');
      return;
    }
    this.role = 'guest';
    this.code = code;
    this.room = code;
    waitForPeer(function (ok) {
      if (!ok) { self._fail('联机组件没能加载（PeerJS CDN 不可达）。请检查网络后刷新页面重试。'); return; }
      self._createPeer(code, false);
    });
  };

  P2P.prototype._fail = function (msg) {
    this._status(msg, 'error');
    this._emit('error', { msg: msg });
  };

  P2P.prototype._createPeer = function (code, isHost) {
    var self = this;
    var peer;
    try {
      var peerOpts = { debug: 0, config: { iceServers: ICE_SERVERS } };
      peer = isHost ? new Peer(ID_PREFIX + code, peerOpts) : new Peer(peerOpts);
    } catch (e) {
      this._fail('无法启动联机：' + (e && e.message ? e.message : e));
      return;
    }
    this.peer = peer;

    peer.on('open', function () {
      self.peerId = peer.id;
      if (isHost) {
        self.code = code;
        self.room = code;
        self._status('房间已创建，正在等待朋友加入…', 'ok');
        self._emit('room', { code: code });
        self._emitLobby();
      } else {
        self._status('正在连接房主…', 'info');
        self._connectToHost(code);
      }
    });

    if (isHost) {
      peer.on('connection', function (conn) { self._acceptConn(conn); });
    }

    peer.on('error', function (err) { self._onPeerError(err, isHost); });

    /* 信令短暂掉线：PeerJS 会自动重连；这里显式再拉一把 */
    peer.on('disconnected', function () {
      if (!self.closed) { try { peer.reconnect(); } catch (e) { /* 忽略 */ } }
    });
  };

  P2P.prototype._connectToHost = function (code) {
    var self = this;
    var conn;
    try {
      conn = this.peer.connect(ID_PREFIX + code, {
        reliable: true,
        metadata: { name: this.opts.name || '' }
      });
    } catch (e) {
      this._fail('连接房主失败：' + (e && e.message ? e.message : e));
      return;
    }
    this._bindConn(conn, true);
  };

  P2P.prototype._onPeerError = function (err, isHost) {
    var t = (err && err.type) || '';
    if (t === 'unavailable-id' && isHost) {
      /* 极小概率房间号撞车：换个号重来 */
      try { this.peer.destroy(); } catch (e) { /* 忽略 */ }
      this.conns = [];
      this._createPeer(randCode(), true);
      return;
    }
    if (t === 'peer-unavailable') {
      this._fail('房间 <b>' + (this.code || '') + '</b> 不存在，或房主已经离开。请确认房间号是否正确、房主是否还在房间内。');
      return;
    }
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') {
      this._fail('连不上联机信令服务器（公共信令云）。请检查网络后重试。');
      return;
    }
    if (t === 'browser-incompatible') {
      this._fail('当前浏览器不支持 WebRTC，请换用 Chrome / Edge / Safari 等现代浏览器。');
      return;
    }
    if (t === 'webrtc') {
      this._fail('网络协商失败（可能是防火墙 / 专网限制）。请换一个网络（例如手机热点）再试。');
      return;
    }
    this._fail('联机出错：' + (err && err.message ? err.message : (t || '未知错误')));
  };

  /* ---------------- 房主：接受客人连接 ---------------- */
  P2P.prototype._acceptConn = function (conn) {
    /* 房间满员：礼貌拒绝多出来的连接 */
    var maxGuests = Math.max(1, (this.roster.count || 2) - 1);
    if (this.conns.length >= maxGuests) {
      try { conn.close(); } catch (e) { /* 忽略 */ }
      this._status('已有 ' + maxGuests + ' 位玩家在房间里了，新连接被拒绝。', 'info');
      return;
    }
    this._bindConn(conn, false);
  };

  /* ---------------- 绑定一条数据通道 ---------------- */
  P2P.prototype._bindConn = function (conn, isGuestSide) {
    var self = this;
    var rec = { conn: conn, id: conn.peer, seat: null, name: '', open: false };
    this.conns.push(rec);

    conn.on('open', function () {
      rec.open = true;
      rec.name = (conn.metadata && conn.metadata.name) || '';
      if (isGuestSide) {
        /* 客人：通道即战力，先报上名字 */
        self.connected = true;
        self._maybeOpen();
        self._sendRaw(conn, { type: 'hello', name: self.opts.name || '' });
      } else {
        /* 房主：给这位客人分配一个空席位（0 号是房主自己） */
        rec.seat = self._freeSeat();
        self._sendRaw(conn, {
          type: 'welcome',
          team: rec.seat,
          seat: rec.seat,
          code: self.code,
          count: self.roster.count,
          teams: self.roster.teams,
          perTeam: self.roster.perTeam
        });
        self.connected = true;
        self._maybeOpen();
        self._emit('peer_join', { seat: rec.seat, name: rec.name });
        self._emitLobby();
      }
    });

    conn.on('data', function (data) {
      self._onData(rec, data, isGuestSide);
    });

    conn.on('close', function () {
      self._dropConn(rec);
    });

    conn.on('error', function () {
      if (!rec.open) {
        if (isGuestSide) self._fail('与房主的连接失败了，请重新加入房间。');
        else self._status('与玩家的连接建立失败。', 'error');
      }
      self._dropConn(rec);
    });

    if (isGuestSide) {
      /* 客人侧：加超时，避免一直卡在「正在连接房主…」 */
      clearTimeout(this._timer);
      this._timer = setTimeout(function () {
        if (!rec.open && !self.closed) {
          self._fail('连接超时：没能连上房主。请确认房间号正确、房主仍在房间内，然后重试；' +
            '若公司 / 校园网限制较严，可换手机热点再试。');
        }
      }, CONNECT_TIMEOUT);
    }
  };

  P2P.prototype._freeSeat = function () {
    var used = {};
    for (var i = 0; i < this.conns.length; i++) if (this.conns[i].seat != null) used[this.conns[i].seat] = true;
    var s = 1;
    while (used[s]) s++;
    return s;
  };

  P2P.prototype._dropConn = function (rec) {
    var idx = this.conns.indexOf(rec);
    if (idx < 0) return;
    this.conns.splice(idx, 1);
    if (this.role === 'host') {
      this._emit('peer_leave', { seat: rec.seat, name: rec.name });
      this._emitLobby();
      if (!this.conns.length) this.connected = false;
    } else {
      this.connected = false;
      this._emit('opponent_left', {});
      this._emit('close', {});
    }
  };

  /* ---------------- 收到数据 ---------------- */
  P2P.prototype._onData = function (rec, data, isGuestSide) {
    if (!data || typeof data !== 'object') return;
    if (isGuestSide && data.type === 'welcome') {
      this.seat = (typeof data.seat === 'number') ? data.seat : 1;
      /* 房主接纳了我：对外发一个 joined 事件（UI 层据此显示「你是 X 队」） */
      this._emit('joined', { team: this.seat, seat: this.seat, count: data.count, code: data.code });
    }
    if (isGuestSide && data.type === 'lobby' && typeof data.joined === 'number') {
      this._lobbyJoined = data.joined;
    }
    /* 房主侧：把「这条消息是谁发的」补进消息里，供权威端做席位校验 */
    if (!isGuestSide && rec.seat != null) {
      if (data.seat == null) data.seat = rec.seat;
      if (data.from == null) data.from = rec.seat;
    }
    if (!this.connected) { this.connected = true; this._maybeOpen(); }
    this._emit(data.type, data);
  };

  P2P.prototype._maybeOpen = function () {
    if (this._opened) return;
    this._opened = true;
    this._status(this.role === 'host' ? '朋友已连接。' : '已连上房主。', 'ok');
    this._emit('open', {});
  };

  /* ------------------- 大厅状态 ------------------- */
  P2P.prototype._openConns = function () {
    return this.conns.filter(function (c) { return c.open; });
  };

  P2P.prototype.joinedCount = function () {
    if (this.role === 'guest') return (this._lobbyJoined != null) ? this._lobbyJoined : (this.connected ? 2 : 1);
    return 1 + this._openConns().length;
  };

  P2P.prototype._emitLobby = function () {
    var state = {
      joined: this.joinedCount(),
      count: this.roster.count || 2,
      seats: this._openConns().map(function (c) { return { seat: c.seat, name: c.name }; })
    };
    this._emit('lobby', state);
    /* 房主把人数变化同步给已在房间里的客人们 */
    if (this.role === 'host' && this.conns.length) {
      this.send({ type: 'lobby', joined: state.joined, count: state.count });
    }
  };

  /* ---------------- 发送 ---------------- */
  P2P.prototype._sendRaw = function (conn, obj) {
    try { if (conn && conn.open) conn.send(obj); return true; } catch (e) { return false; }
  };

  /** 广播：房主 → 所有客人；客人 → 房主 */
  P2P.prototype.send = function (obj) {
    var sent = false;
    for (var i = 0; i < this.conns.length; i++) {
      if (this._sendRaw(this.conns[i].conn, obj)) sent = true;
    }
    /* 客人已经连上、却又发不出去，说明通道断了，明确提示一下 */
    if (!sent && this.role === 'guest' && this.connected) {
      this._status('与房主的连接已断开，请重新加入房间。', 'error');
    }
    return sent;
  };

  /** 只发给某个席位（房主专用） */
  P2P.prototype.sendTo = function (seat, obj) {
    for (var i = 0; i < this.conns.length; i++) {
      if (this.conns[i].seat === seat) return this._sendRaw(this.conns[i].conn, obj);
    }
    return false;
  };

  /** 已连接的客人席位列表（房主专用） */
  P2P.prototype.peerSeats = function () {
    return this.conns.map(function (c) { return c.seat; }).filter(function (s) { return s != null; });
  };

  /* ---------------- 对局内动作（客人 → 房主的上报接口） ---------------- */
  P2P.prototype.fire = function (expr, angle, weapon) { this.send({ type: 'fire', expr: expr, angle: angle || 0, weapon: weapon == null ? 1 : weapon }); };
  P2P.prototype.sketch = function (norm, rot, scale, weapon) { this.send({ type: 'sketch', norm: norm, rot: rot, scale: scale, weapon: weapon == null ? 1 : weapon }); };
  P2P.prototype.move = function (expr, dist) { this.send({ type: 'move_intent', expr: expr, dist: dist }); };
  P2P.prototype.sketchMove = function (norm, rot, scale, dist) { this.send({ type: 'move_intent', norm: norm, rot: rot, scale: scale, dist: dist }); };
  P2P.prototype.skill = function () { this.send({ type: 'skill' }); };
  P2P.prototype.skillPick = function (id) { this.send({ type: 'skill_pick', skill: id, seat: this.seat }); };
  P2P.prototype.angle = function (a) { this.send({ type: 'angle', angle: a }); };
  P2P.prototype.rematch = function () { this.send({ type: 'rematch' }); };
  P2P.prototype.chat = function (id, text) { this.send({ type: 'chat', id: id, text: text, from: this.seat }); };

  P2P.prototype.quit = function () {
    this.closed = true;
    clearTimeout(this._timer);
    /* 先摘掉引用再逐个关闭：close() 会回调 _dropConn 去 splice 这个数组，
     * 边遍历边删除会漏关后面的连接（多人房尤其明显）。 */
    var conns = this.conns.slice();
    this.conns = [];
    for (var i = 0; i < conns.length; i++) { try { conns[i].conn.close(); } catch (e) { /* 忽略 */ } }
    try { if (this.peer) this.peer.destroy(); } catch (e) { /* 忽略 */ }
    this.connected = false;
  };

  GW.P2P = P2P;

  /** 当前环境能否用联机：需要 WebRTC（页面须为 https 或 localhost） */
  GW.p2pSupported = function () {
    return typeof RTCPeerConnection !== 'undefined';
  };
  /* 兼容旧调用名 */
  GW.roomSupported = GW.p2pSupported;

})(typeof window !== 'undefined' ? window : globalThis);
