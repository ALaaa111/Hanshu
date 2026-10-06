/* ============================================================
 * 联机房间（Room）：房主浏览器 = 权威端，PeerJS 公共云信令做「牵线」
 *
 * 设计目标：玩家和房主都不用懂「服务器」、不用开任何东西。
 *   · 房主点「创建房间」→ 浏览器向 PeerJS 公共云信令注册一个房间号 → 生成邀请链接；
 *   · 朋友点开链接 → 浏览器自动连上房主 → 两人【点对点直连】对战。
 *   · 全程零配置：信令服务器由开发者部署一次并写死（PeerJS 公共云，免费用），
 *     玩家永远看不到、不用管。这正是 Othello / Dots&Boxes 等同类网页游戏的标准做法。
 *
 * 房主浏览器就是权威服务器（跑 GW.Game，回合由自己推进）；
 * 对局数据走 WebRTC 数据通道【直连】，不经过任何中间服务器。
 *
 * 接口与 GW.Net（自建服务器链路）完全一致，UI 层把两种联机当成同一个对象用即可：
 *   on / fire / sketch / move / skill / skillPick / angle / rematch / chat / quit
 *   hostRoom() / joinRoom(num) ，以及回调 onRoom(num) / onOpen() / onStatus()。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});

  /* 房间号前缀：避免和公共信令服务器上的其它应用撞 ID。
   * 玩家看到的房间号是 6 位短码；真正注册到信令的是 'hs-funcwar-' + 短码。 */
  var ROOM_PREFIX = 'hs-funcwar-';

  /* 打洞用的 ICE 服务器（玩家无需配置，浏览器自动选用）：
   *   · STUN 帮双方发现自己的公网地址 —— 家用路由器场景绝大多数靠它就够；
   *   · TURN 是打洞彻底失败（对称 NAT / 公司网 / 校园网）时的兜底中转，用公共免费节点。
   * 对局数据始终端到端加密；能直连就直连，只有直连失败才用到 TURN。 */
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

  /* 生成 6 位易读短码（去掉易混字符 0/O/1/I/L） */
  function randRoom() {
    var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var s = '';
    for (var i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  }

  /* 把玩家输入的短码规整成信令 ID（兼容大小写、容错空格） */
  function toPeerId(code) {
    var c = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.indexOf(ROOM_PREFIX) === 0) return c;
    return ROOM_PREFIX + c;
  }

  /* ---------------- 主体 ---------------- */
  function Room(opts) {
    opts = opts || {};
    this.role = (opts.role === 'guest') ? 'guest' : 'host';
    this.team = (this.role === 'host') ? 0 : 1;
    this.room = null;          // 6 位房间短码
    this.peerId = null;
    this.peer = null;          // PeerJS 实例
    this.conn = null;          // 与对手的 DataConnection（直连通道）
    this.handlers = {};
    this.connected = false;
    this._opened = false;      // 'open' 事件只触发一次
    this.closed = false;
    this.opts = opts;
  }

  Room.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
    return this;
  };

  Room.prototype._emit = function (type, data) {
    var list = this.handlers[type] || [];
    for (var i = 0; i < list.length; i++) list[i](data || {});
  };

  Room.prototype._status = function (text, kind) {
    if (this.opts.onStatus) this.opts.onStatus(text, kind || 'info');
  };

  Room.prototype._room = function (num) {
    if (this.opts.onRoom) this.opts.onRoom(num);
  };

  /* ---------------- 房主：注册房间 ---------------- */
  Room.prototype.hostRoom = function () {
    this.role = 'host';
    this._createPeer(randRoom(), true);
  };

  /* ---------------- 客人：连接房间 ---------------- */
  Room.prototype.joinRoom = function (num) {
    num = String(num || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{4,}$/.test(num)) {
      alert('房间号格式不对，请检查后重新输入（通常是 6 位字母数字）。');
      return;
    }
    this.role = 'guest';
    this.room = num;
    this._createPeer(num, false);   // 必须把房间号传下去，否则会连到不存在的 'hs-funcwar-null'
  };

  Room.prototype._createPeer = function (roomCode, isHost) {
    if (typeof Peer === 'undefined') {
      this._status('当前环境无法联机：页面需要 https 或 localhost，且浏览器需支持 WebRTC。请改用 Chrome / Edge 等现代浏览器，并确保通过线上网址打开。', 'error');
      return;
    }
    var self = this;
    /* 房主用固定 ID 注册（短码带前缀），客人用随机 ID。
     * 信令走 PeerJS 公共云（开发者免部署、玩家免配置）；数据走 WebRTC 直连。
     * iceServers 里带 STUN + 公共 TURN，跨网络打洞成功率更高（玩家全程无感）。 */
    var peerOpts = { config: { iceServers: ICE_SERVERS } };
    var peer;
    try {
      peer = isHost ? new Peer(ROOM_PREFIX + roomCode, peerOpts) : new Peer(peerOpts);
    } catch (e) {
      this._status('信令连接失败：' + (e && e.message ? e.message : e), 'error');
      return;
    }
    this.peer = peer;

    peer.on('open', function (id) {
      self.peerId = id;
      if (isHost) {
        self.room = roomCode;
        self._room(roomCode);   // 通知 UI 显示邀请链接
      }
    });

    if (isHost) {
      peer.on('connection', function (conn) {
        if (self.conn) { try { conn.close(); } catch (e) {} return; }  // 只接受第一位客人
        self._bind(conn);
      });
    } else {
      var conn = peer.connect(ROOM_PREFIX + roomCode, { reliable: true });
      this._bind(conn);
    }

    peer.on('error', function (err) {
      var t = (err && err.type) || '';
      if (t === 'unavailable-id' && isHost) {
        /* 极小概率房间号撞车：换一个重试 */
        try { peer.destroy(); } catch (e) {}
        self.hostRoom();
        return;
      }
      if (t === 'peer-unavailable') {
        self._status('房间不存在或房主已离开，请确认房间号正确、且房主仍在线。', 'error');
        self._emit('error', { msg: '房间不存在或房主已离开' });
        return;
      }
      if (t === 'network' || t === 'server-error' || t === 'socket-error') {
        self._status('连接信令服务器失败，请检查网络后重试。', 'error');
        self._emit('error', { msg: '信令服务器连接失败' });
        return;
      }
      self._status('联机出错：' + (err && err.message ? err.message : t || '未知'), 'error');
      self._emit('error', { msg: err && err.message ? err.message : t || '未知' });
    });

    peer.on('disconnected', function () {
      /* 信令短暂掉线：PeerJS 会自动重连，无需处理 */
    });
  };

  /* ---------------- 绑定直连数据通道 ---------------- */
  Room.prototype._bind = function (conn) {
    var self = this;
    this.conn = conn;
    conn.on('open', function () {
      self.connected = true;
      self._maybeOpen();
    });
    conn.on('data', function (data) {
      /* PeerJS 已自动反序列化为对象 */
      self._onMessage(data);
    });
    conn.on('close', function () {
      if (self.connected) {
        self.connected = false;
        self._emit('opponent_left', {});
        self._emit('close');
      }
    });
    conn.on('error', function () {
      if (!self.connected) self._status('与对手的连接断开了，请重新创建房间。', 'error');
    });
  };

  Room.prototype._maybeOpen = function () {
    if (this._opened) return;
    this._opened = true;
    if (this.role === 'guest') this._emit('joined', { team: 1, code: this.room });
    this._status(this.role === 'host' ? '朋友已连接，正在生成战场…' : '已连接，等待房主开局…', 'ok');
    this._emit('open');
    if (this.opts.onOpen) this.opts.onOpen();
  };

  /* ---------------- 收发 ---------------- */
  Room.prototype.send = function (obj) {
    if (this.conn && this.conn.open) {
      try { this.conn.send(obj); return; } catch (e) { /* 落到错误提示 */ }
    }
    this._status('连接尚未建立，请稍候或重新创建房间。', 'error');
  };

  Room.prototype._onMessage = function (msg) {
    if (!msg || !msg.type) return;
    /* 任何来自对手的字节都说明「可达」 */
    if (!this.connected) { this.connected = true; this._maybeOpen(); }
    this._emit(msg.type, msg);
  };

  /* ---------------- 对局内动作（与 GW.Net 一致） ---------------- */
  Room.prototype.fire = function (expr, angle, weapon) { this.send({ type: 'fire', expr: expr, angle: angle || 0, weapon: weapon == null ? 1 : weapon }); };
  Room.prototype.sketch = function (norm, rot, scale, weapon) { this.send({ type: 'sketch', norm: norm, rot: rot, scale: scale, weapon: weapon == null ? 1 : weapon }); };
  Room.prototype.move = function (expr, dist) { this.send({ type: 'move_intent', expr: expr, dist: dist }); };
  Room.prototype.sketchMove = function (norm, rot, scale, dist) { this.send({ type: 'move_intent', norm: norm, rot: rot, scale: scale, dist: dist }); };
  Room.prototype.skill = function () { this.send({ type: 'skill' }); };
  /** 开局技能选择：客人把技能 id 交给房主（房主即权威端） */
  Room.prototype.skillPick = function (id) { this.send({ type: 'skill_pick', skill: id, seat: this.team }); };
  Room.prototype.angle = function (a) { this.send({ type: 'angle', angle: a }); };
  Room.prototype.rematch = function () { this.send({ type: 'rematch' }); };
  Room.prototype.chat = function (id, text) {
    this.send({ type: 'chat', id: id, text: text, from: this.team });
  };

  Room.prototype.quit = function () {
    this.closed = true;
    var conn = this.conn, peer = this.peer;
    try { if (conn) conn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    this.connected = false;
  };

  GW.Room = Room;

  /** 当前环境能否用房间联机：需要浏览器支持 WebRTC，且 PeerJS 已加载 */
  GW.roomSupported = function () {
    return typeof RTCPeerConnection !== 'undefined' && typeof Peer !== 'undefined';
  };
  /* 兼容旧调用名 */
  if (!GW.p2pSupported) GW.p2pSupported = GW.roomSupported;

})(typeof window !== 'undefined' ? window : globalThis);
