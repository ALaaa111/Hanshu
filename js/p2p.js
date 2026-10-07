/* ============================================================
 * 函数战争 · 联机核心（纯 WebRTC 点对点，零第三方 SDK）
 *
 * 设计原则：玩家与房主都不需要「服务器」这个概念。
 *
 * 牵线（信令）有两条路，任选其一，都不需要玩家部署任何东西：
 *   ① cloud  一键房间号：浏览器连公共 MQTT 信令（EMQX，国内可达）交换连接信息；
 *   ② manual 连接码：把连接信息编码成一段文字，两人互发一下即可 —— 不依赖任何服务器，
 *              任何信令服务被墙时都能用，是永远可用的兜底。
 * 连上之后，对局数据全部走 WebRTC 数据通道，不经过任何中间服务器。
 *
 * 拓扑：星型。房主的浏览器是唯一的「权威端」（跑 GW.Game、推进回合），
 *       每位客人只与房主建一条通道；客人之间不直连。
 *       这样 2~8 人都能玩，且必然只有一份权威状态，不会出现不同步。
 *
 * 对外接口（UI 层只认识这一个对象）：
 *   on(type, fn) / send(obj) / sendTo(seat, obj) / quit()
 *   hostRoom() / joinRoom(code)                  —— 一键房间号（MQTT 信令）
 *   manualCreate() / manualAccept(code) / manualFinish(code)  —— 连接码
 *   fire / sketch / move / sketchMove / skill / skillPick / rematch / chat
 * 事件：
 *   room(code) / offer_code(code) / answer_code(code)   房主/客人拿到可分享的凭据
 *   lobby(state) / joined(msg) / open()
 *   peer_join / peer_leave / close / opponent_left / error
 *   start / turn / shot / move / skill_used / skills / reward / pack / over /
 *   fire_error / chat
 *   fire / sketch / move_intent / skill / skill_pick / rematch      （客人 → 房主的意图）
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});

  /* ---------------- 常量 ---------------- */

  /* 房间号：6 位，去掉 0/O/1/I/L 等易混字符（32 个字符，32^6 ≈ 10.7 亿种） */
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 6;

  /* 公共 MQTT 信令前缀：只作「牵线」，对局数据不经它 */
  var TOPIC_PREFIX = 'hanshu-gw/';

  /* 公共 MQTT 信令服务器（按顺序尝试；均为免费公共经纪，无需注册部署）。
   * EMQX 是国产开源项目，其公共经纪在国内网络实测可达、稳定。 */
  var BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker-cn.emqx.io:8084/mqtt'
  ];

  /* ICE 服务器（玩家全程无感，浏览器自动选用）。
   * 选型依据是「国内网络实测可达」——这是联机能否打通的关键：
   *   · STUN 帮双方发现自己的公网地址，家用宽带绝大多数靠它即可直连；
   *   · TURN 是打洞彻底失败（对称 NAT / 4G 5G / 公司校园网）时的兜底中转，走 TCP 443
   *     以便穿过只放行 80/443 的严格防火墙。
   * 注意：Google / Twilio / OpenRelay 的 UDP:3478 在国内实测被墙，故不再使用。 */
  var ICE_SERVERS = [
    {
      urls: [
        'stun:stun.miwifi.com:3478',
        'stun:stun.chat.bilibili.com:3478',
        'stun:stun.cloudflare.com:3478'
      ]
    },
    {
      urls: [
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turn:openrelay.metered.ca:80?transport=tcp',
        'turns:openrelay.metered.ca:443'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  var SIGNAL_TIMEOUT = 6000;      // 单次连接信令服务器的时间上限
  var SIGNAL_ROUNDS = 2;          // 所有信令服务器都试过一遍算一轮，失败可再整轮重试
  var CONNECT_TIMEOUT = 25000;    // 客人从「加入」到「打通通道」的时间上限
  var GATHER_CAP = 2500;          // 连接码模式：收集本端地址的最长时间（越短出码越快）
  var RETRY_EVERY = 1200;         // 信令是「发出去就不管」（QoS0），关键消息要周期重发

  /* ---------------- 小工具 ---------------- */

  function randCode() {
    var s = '';
    for (var i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    return s;
  }

  function randId() {
    return Math.random().toString(36).slice(2, 10);
  }

  /** 规整玩家输入的房间号：去空格、转大写、去掉非法字符 */
  function normalizeCode(v) {
    return String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /* ---- UTF-8 编解码（不依赖 TextEncoder，兼容老浏览器） ---- */
  function toUtf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xD800 || c >= 0xE000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else {
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (str.charCodeAt(++i) & 0x3FF));
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return out;
  }

  function fromUtf8(bytes, start, end) {
    var s = '';
    for (var i = start; i < end;) {
      var b = bytes[i++];
      if (b < 0x80) s += String.fromCharCode(b);
      else if (b < 0xE0) s += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
      else if (b < 0xF0) {
        var b2 = bytes[i++], b3 = bytes[i++];
        s += String.fromCharCode(((b & 15) << 12) | ((b2 & 63) << 6) | (b3 & 63));
      } else {
        var c2 = bytes[i++], c3 = bytes[i++], c4 = bytes[i++];
        var cp = ((b & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63);
        cp -= 0x10000;
        s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return s;
  }

  /* ---------------- 迷你 MQTT 3.1.1 客户端（只实现信令所需部分）
   * MQTT 控制包走标准 WebSocket 子协议 'mqtt'，无需任何第三方库。
   * 支持：CONNECT / CONNACK / PUBLISH(QoS0) / SUBSCRIBE / SUBACK / PINGREQ
   * ---------------- */
  function mqttRemainLen(n) {
    var b = [];
    do { var d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; b.push(d); } while (n > 0);
    return b;
  }

  function mqttUtf8(str) {
    var u = toUtf8(str);
    return [u.length >> 8, u.length & 0xFF].concat(u);
  }

  function mqttPacket(type, flags, body) {
    return new Uint8Array([(type << 4) | flags].concat(mqttRemainLen(body.length), body));
  }

  function MqttClient(url, clientId) {
    this.url = url;
    this.clientId = clientId;
    this.ws = null;
    this.ready = false;
    this.onMessage = null;
    this.onClose = null;
    this._subs = [];
    this._pid = 1;
    this._ping = null;
    this._destroyed = false;
  }

  MqttClient.prototype.connect = function (timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(self.url, ['mqtt']); }
      catch (e) { return reject(new Error('浏览器不支持 WebSocket')); }
      self.ws = ws;
      ws.binaryType = 'arraybuffer';

      var settled = false;
      var timer = setTimeout(function () { fail('连接信令服务器超时'); }, timeoutMs || SIGNAL_TIMEOUT);

      function fail(msg) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch (e) { /* 忽略 */ }
        reject(new Error(msg));
      }

      ws.onopen = function () {
        /* CONNECT：协议名 MQTT / 级别 4 / CleanSession / keepalive 60s */
        ws.send(mqttPacket(1, 0, mqttUtf8('MQTT').concat([4, 0x02, 0x00, 0x3C], mqttUtf8(self.clientId))));
      };
      ws.onerror = function () { fail('信令服务器连不上'); };
      ws.onclose = function () {
        clearTimeout(timer);
        var wasReady = self.ready;
        self.ready = false;
        if (!settled) { settled = true; reject(new Error('信令连接被关闭')); }
        else if (wasReady && !self._destroyed && self.onClose) self.onClose();
      };
      ws.onmessage = function (ev) {
        var u;
        try { u = new Uint8Array(ev.data); } catch (e) { return; }
        if (!u.length) return;
        var type = u[0] >> 4;
        if (type === 2) {                       /* CONNACK */
          if (u[3] !== 0) return fail('信令服务器拒绝连接（' + u[3] + '）');
          settled = true;
          clearTimeout(timer);
          self.ready = true;
          for (var i = 0; i < self._subs.length; i++) self._rawSub(self._subs[i]);
          self._startPing();
          resolve();
        } else if (type === 3) {                /* PUBLISH */
          var m = parsePublish(u);
          if (m && self.onMessage) self.onMessage(m.topic, m.payload);
        }
      };
    });
  };

  MqttClient.prototype._startPing = function () {
    var self = this;
    clearInterval(this._ping);
    /* keepalive：每 30 秒一个 PINGREQ，防止链路上空闲被回收 */
    this._ping = setInterval(function () {
      if (self.ready && self.ws) { try { self.ws.send(new Uint8Array([0xC0, 0x00])); } catch (e) { /* 忽略 */ } }
    }, 30000);
  };

  MqttClient.prototype.subscribe = function (topic) {
    if (this._subs.indexOf(topic) < 0) this._subs.push(topic);
    if (this.ready) this._rawSub(topic);
  };

  MqttClient.prototype._rawSub = function (topic) {
    var id = (this._pid++) & 0xFFFF;
    try { this.ws.send(mqttPacket(8, 2, [id >> 8, id & 0xFF].concat(mqttUtf8(topic), [0]))); }
    catch (e) { /* 忽略 */ }
  };

  MqttClient.prototype.publish = function (topic, payload) {
    if (!this.ready || !this.ws) return false;
    var body = mqttUtf8(topic).concat(toUtf8(payload));
    if (body.length > 200000) return false;    /* 保险：拒绝超大报文 */
    try { this.ws.send(mqttPacket(3, 0, body)); return true; }
    catch (e) { return false; }
  };

  MqttClient.prototype.close = function () {
    this._destroyed = true;
    this.ready = false;
    clearInterval(this._ping);
    try { if (this.ws) this.ws.close(); } catch (e) { /* 忽略 */ }
  };

  function parsePublish(u) {
    var idx = 1, mult = 1, len = 0, d;
    do { d = u[idx++]; len += (d & 127) * mult; mult *= 128; } while (d & 128);
    var bodyStart = idx, bodyEnd = bodyStart + len;
    if (bodyEnd > u.length) return null;
    var tl = (u[bodyStart] << 8) | u[bodyStart + 1];
    var ts = bodyStart + 2;
    if (ts + tl > bodyEnd) return null;
    return { topic: fromUtf8(u, ts, ts + tl), payload: fromUtf8(u, ts + tl, bodyEnd) };
  }

  /* ---------------- 连接码编解码（连接码模式：不依赖任何信令服务器） ---------------- */
  function packCode(json) {
    return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function unpackCode(str) {
    try {
      var t = String(str || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      while (t.length % 4) t += '=';
      var obj = JSON.parse(atob(t));
      if (!obj || !obj.sdp) return null;
      return obj;
    } catch (e) { return null; }
  }

  /* 连接码：把一段 SDP 压成尽量短的文本。
   * 做法：不依赖 trickle，而是等本端地址收集完（或到点），
   * 再把候选地址自己重排进 SDP —— 顺带丢掉 TCP / 回环等无用候选，
   * 于是连接码通常只有一千多字符。 */
  var CAND_SKIP_TCP = true;

  function pickCandidates(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length && out.length < 10; i++) {
      var s = (list[i] && list[i].c) || '';
      if (!s) continue;
      if (CAND_SKIP_TCP && s.indexOf(' tcp ') >= 0) continue;                 /* TCP 候选对公网直连帮助很小 */
      if (s.indexOf(' ::1 ') >= 0 || s.indexOf(' 127.0.0.1 ') >= 0) continue; /* 回环地址 */
      var key = s.replace(/\d+ typ/, 'typ');                                   /* 忽略端口做去重 */
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(s);
    }
    return out;
  }

  function buildManualPayload(rec, kind) {
    var desc = rec.pc.localDescription;
    var sdp = (desc && desc.sdp) || '';
    var type = (desc && desc.type) || (kind === 'o' ? 'offer' : 'answer');
    var lines = sdp.split(/\r\n|\n/);
    var cands = pickCandidates(rec.gathered);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln) continue;
      if (/^a=candidate:/.test(ln)) continue;            /* 原候选一律丢弃，统一在下面重排 */
      if (ln === 'a=ice-options:trickle') continue;      /* 非 trickle，无需声明 */
      if (ln === 'a=extmap-allow-mixed' || /^a=msid-semantic/.test(ln)) continue;
      if (/^a=ice-ufrag:/.test(ln)) {                    /* 候选必须排在 ice-ufrag 之前 */
        /* candidate.candidate 自带 "candidate:" 前缀，补个 "a=" 即为标准 SDP 行 */
        for (var j = 0; j < cands.length; j++) out.push('a=' + cands[j].replace(/^a=/, ''));
      }
      out.push(ln);
    }
    /* 末尾必须保留 CRLF —— 少了它部分浏览器的 SDP 解析会直接报错 */
    return JSON.stringify({ v: 1, t: kind, sdp: { type: type, sdp: out.join('\r\n') + '\r\n' } });
  }

  /* 等本端地址收集完毕（连接码模式需要一次性打包全部候选地址） */
  function waitIceComplete(pc, cb, capMs) {
    if (pc.iceGatheringState === 'complete') return cb();
    var done = false, timer = null;
    function fin() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { pc.removeEventListener('icegatheringstatechange', on); } catch (e) { /* 忽略 */ }
      cb();
    }
    function on() { if (pc.iceGatheringState === 'complete') fin(); }
    try { pc.addEventListener('icegatheringstatechange', on); } catch (e) { pc.onicegatheringstatechange = on; }
    timer = setTimeout(fin, capMs || GATHER_CAP);
  }

  /* ---------------- 主体 ---------------- */
  function P2P(opts) {
    opts = opts || {};
    this.opts = opts;
    this.role = (opts.role === 'guest') ? 'guest' : 'host';
    this.transport = (opts.transport === 'manual') ? 'manual' : 'cloud';
    this.roster = opts.roster || { teams: 2, perTeam: 1, count: 2 };
    this.code = null;          /* 房间号（6 位） */
    this.room = null;          /* 兼容旧字段：同 code */
    this.seat = 0;             /* 我方席位（房主恒为 0；客人由房主下发） */
    this.links = [];           /* [{ pc, dc, id, seat, name, open, isHost }] */
    this.handlers = {};
    this.closed = false;
    this.connected = false;    /* 是否已与至少一位对手建立数据通道 */
    this.sig = null;           /* MqttClient */
    this.myId = randId();      /* 本端在信令中的随机身份 */
    this.topic = null;
    this._opened = false;
    this._timer = null;
    this._joinTimer = null;
    this._manualRec = null;
    this._guestRec = null;
    this._myAnswer = null;
    this._joinedCount = null;
  }

  P2P.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
    return this;
  };

  P2P.prototype._emit = function (type, data) {
    var list = this.handlers[type];
    if (list) for (var i = 0; i < list.length; i++) list[i](data || {});
    var hook = this.opts['on' + type.replace(/(^|_)(\w)/g, function (m, a, b) { return b.toUpperCase(); })];
    if (typeof hook === 'function') hook(data || {});
  };

  P2P.prototype._status = function (text, kind) {
    if (this.opts.onStatus) this.opts.onStatus(text, kind || 'info');
  };

  P2P.prototype._fail = function (msg) {
    this._status(msg, 'error');
    this._emit('error', { msg: msg });
  };

  /* ================= 一键房间号（MQTT 信令） ================= */

  P2P.prototype.hostRoom = function () {
    var self = this;
    this.transport = 'cloud';
    this.role = 'host';
    this.seat = 0;
    this.code = randCode();
    this.room = this.code;
    /* 立刻给出房间号 —— UI 马上就有内容可显示，不必等信令连上 */
    this._emit('room', { code: this.code });
    this._status('房间号 <b>' + this.code + '</b> 已生成，正在连接信令服务器…', 'info');
    this._openSignal(function (err) {
      if (self.closed) return;
      if (err) {
        self._fail('公共信令服务器连不上（' + err.message + '）。' +
          '请直接用下面的 <b>「连接码」</b> 直连 —— 那条路不需要任何服务器，一定能连。');
        return;
      }
      self._status('房间 <b>' + self.code + '</b> 已就绪，把邀请链接 / 房间号发给朋友，正在等待他加入…', 'ok');
      self._emit('ready', { role: 'host' });
      self._emitLobby();
    });
  };

  P2P.prototype.joinRoom = function (code) {
    var self = this;
    code = normalizeCode(code);
    if (code.length < 4) { this._fail('房间号不对，请检查后重新输入（通常是 6 位字母数字）。'); return; }
    this.transport = 'cloud';
    this.role = 'guest';
    this.code = code;
    this.room = code;
    this._status('正在连接信令服务器…', 'info');
    this._openSignal(function (err) {
      if (self.closed) return;
      if (err) {
        self._fail('公共信令服务器连不上（' + err.message + '）。' +
          '请改用下面的 <b>「连接码」</b>：让房主生成邀请码发给你，粘贴进来即可，不需要任何服务器。');
        return;
      }
      self._status('正在通知房主「我来了」…', 'info');
      self._emit('ready', { role: 'guest' });
      self._sigSend('*', { t: 'join' });
      self._startConnectTimer();
      /* 信令是 QoS0：房主可能还没订阅好，join 会丢。周期重发直到连上。 */
      clearInterval(self._joinTimer);
      self._joinTimer = setInterval(function () {
        if (self.closed || self.connected) { clearInterval(self._joinTimer); return; }
        self._sigSend('*', { t: 'join' });
      }, RETRY_EVERY);
    });
  };

  /* 依次尝试各公共信令服务器；全部失败后再整轮重试一次，尽力避免偶发抖动 */
  P2P.prototype._openSignal = function (cb) {
    var self = this;
    this.topic = TOPIC_PREFIX + this.code;
    var idx = 0, round = 0, lastErr = null;

    function attempt() {
      if (self.closed) return;
      if (idx >= BROKERS.length) {
        idx = 0;
        round++;
        if (round >= SIGNAL_ROUNDS) return cb(lastErr || new Error('信令服务器不可达'));
        self._status('信令服务器没有响应，正在重试…', 'info');
        return setTimeout(attempt, 1200);
      }
      var i = idx++;
      var client = new MqttClient(BROKERS[i], 'hgw-' + self.myId);
      client.connect(SIGNAL_TIMEOUT).then(function () {
        if (self.closed) { client.close(); return; }
        self.sig = client;
        client.onMessage = function (topic, payload) { self._onSignal(topic, payload); };
        client.onClose = function () { self._onSignalLost(); };
        client.subscribe(self.topic + '/#');
        /* 订阅生效后再回调（留一点时间等 SUBACK） */
        setTimeout(function () { if (!self.closed) cb(null); }, 250);
      })['catch'](function (e) {
        lastErr = e;
        attempt();
      });
    }
    attempt();
  };

  P2P.prototype._sigSend = function (to, obj) {
    if (!this.sig || !this.sig.ready) return false;
    obj.from = this.myId;
    obj.to = to;
    return this.sig.publish(this.topic + '/' + this.myId, JSON.stringify(obj));
  };

  P2P.prototype._onSignal = function (topic, payload) {
    if (this.closed) return;
    var msg;
    try { msg = JSON.parse(payload); } catch (e) { return; }
    if (!msg || !msg.t || msg.from === this.myId) return;
    var mine = (msg.to === '*' || msg.to === this.myId || (msg.to === 'host' && this.role === 'host'));
    if (!mine) return;
    switch (msg.t) {
      case 'join':   if (this.role === 'host') this._onJoin(msg); break;
      case 'offer':  if (this.role === 'guest') this._onOffer(msg); break;
      case 'answer': if (this.role === 'host') this._onAnswer(msg); break;
      case 'ice':    this._onIce(msg); break;
      case 'busy':   if (this.role === 'guest') this._fail('这间房已经满员了，请让房主新建一个房间。'); break;
    }
  };

  P2P.prototype._onJoin = function (msg) {
    var maxGuests = Math.max(1, (this.roster.count || 2) - 1);
    var exist = this._findLink(msg.from);
    if (exist) {
      /* 客人重发 join：说明它还没收到我们的应答，重发一次 offer（或已有 offer 就重发） */
      if (!exist.answered && exist.pc.localDescription) this._sigSend(msg.from, { t: 'offer', sdp: exist.pc.localDescription });
      return;
    }
    if (this.links.length >= maxGuests) { this._sigSend(msg.from, { t: 'busy' }); return; }
    this._createLink(msg.from, true, '');
  };

  P2P.prototype._onOffer = function (msg) {
    var self = this;
    if (this._guestRec) {
      /* 房主重发了 offer（说明我们的应答半路丢了）：把上次的应答再发一次 */
      if (this._myAnswer) this._sigSend('host', { t: 'answer', sdp: this._myAnswer });
      return;
    }
    var rec = this._createLink('host', false, '房主');
    if (!rec) return;
    this._guestRec = rec;
    rec.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).then(function () {
      return rec.pc.createAnswer();
    }).then(function (ans) {
      return rec.pc.setLocalDescription(ans);
    }).then(function () {
      self._myAnswer = rec.pc.localDescription;
      self._sigSend('host', { t: 'answer', sdp: self._myAnswer });
    })['catch'](function (e) {
      self._fail('与房主协商失败：' + (e && e.message ? e.message : e));
    });
  };

  P2P.prototype._onAnswer = function (msg) {
    var rec = this._findLink(msg.from);
    if (!rec) return;
    rec.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).then(function () {
      rec.answered = true;
    })['catch'](function () {
      this._dropLink(rec, '协商失败');
    }.bind(this));
  };

  P2P.prototype._onIce = function (msg) {
    var rec = this._findLink(msg.from);
    if (!rec || !msg.cand) return;
    try { rec.pc.addIceCandidate(new RTCIceCandidate(msg.cand))['catch'](function () { /* 忽略 */ }); }
    catch (e) { /* 忽略 */ }
  };

  /* ================= 连接码（零信令服务器） ================= */

  /** 房主：生成「邀请码」 */
  P2P.prototype.manualCreate = function () {
    var self = this;
    this.transport = 'manual';
    this.role = 'host';
    this.seat = 0;
    this._status('正在生成邀请码…', 'info');
    var rec = this._createLink('manual', true, '');
    if (!rec) return;
    this._manualRec = rec;
    waitIceComplete(rec.pc, function () {
      self._emit('offer_code', { code: packCode(buildManualPayload(rec, 'o')) });
    }, GATHER_CAP);
  };

  /** 客人：粘贴「邀请码」→ 生成「应答码」 */
  P2P.prototype.manualAccept = function (codeStr) {
    var self = this;
    var data = unpackCode(codeStr);
    if (!data || data.t !== 'o') { this._fail('邀请码不对，请确认完整复制了房主发来的那一段。'); return; }
    this.transport = 'manual';
    this.role = 'guest';
    this.seat = 1;
    this._status('正在生成应答码…', 'info');
    var rec = this._createLink('manual', false, '房主');
    if (!rec) return;
    this._guestRec = rec;

    rec.pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(function () {
      return rec.pc.createAnswer();
    }).then(function (ans) {
      return rec.pc.setLocalDescription(ans);
    }).then(function () {
      waitIceComplete(rec.pc, function () {
        self._emit('answer_code', { code: packCode(buildManualPayload(rec, 'a')) });
      }, GATHER_CAP);
    })['catch'](function (e) {
      self._fail('生成应答码失败：' + (e && e.message ? e.message : e));
    });
  };

  /** 房主：粘贴朋友发回的「应答码」→ 完成直连 */
  P2P.prototype.manualFinish = function (codeStr) {
    var rec = this._manualRec;
    if (!rec) { this._fail('请先点「生成邀请码」。'); return; }
    var data = unpackCode(codeStr);
    if (!data || data.t !== 'a') { this._fail('应答码不对，请确认完整复制了朋友发回的那一段。'); return; }
    this._status('正在与朋友直连…', 'info');
    rec.pc.setRemoteDescription(new RTCSessionDescription(data.sdp))['catch'](function (e) {
      this._fail('完成连接失败：' + (e && e.message ? e.message : e));
    }.bind(this));
  };

  /* ================= 底层：建一条 RTCPeerConnection ================= */

  P2P.prototype._createLink = function (remoteId, isHost, name) {
    var self = this;
    var pc;
    try { pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); }
    catch (e) { this._fail('浏览器无法建立 WebRTC 连接：' + (e && e.message ? e.message : e)); return null; }

    var rec = { id: remoteId, name: name || '', seat: null, open: false, isHost: isHost, pc: pc, dc: null, gathered: [] };
    this.links.push(rec);

    pc.onicecandidate = function (ev) {
      if (!ev.candidate) return;
      if (self.transport === 'manual') {
        /* 只留连接码必需的三个字段，避免整段连接码过长 */
        rec.gathered.push({ c: ev.candidate.candidate, m: ev.candidate.sdpMid, i: ev.candidate.sdpMLineIndex });
      } else {
        self._sigSend(remoteId, { t: 'ice', cand: ev.candidate });
      }
    };

    pc.onconnectionstatechange = function () {
      var st = pc.connectionState;
      if (st === 'failed') self._dropLink(rec, '连接失败（可能被防火墙拦了）');
      else if (st === 'closed') self._dropLink(rec);
      else if (st === 'disconnected') self._status('与对手的连接不稳定，正在尝试恢复…', 'info');
    };

    if (isHost) {
      var dc = pc.createDataChannel('gw', { ordered: true });
      rec.dc = dc;
      this._bindChannel(rec, dc);
      pc.createOffer()
        .then(function (offer) { return pc.setLocalDescription(offer); })
        .then(function () { if (self.transport !== 'manual') self._sigSend(remoteId, { t: 'offer', sdp: pc.localDescription }); })
        ['catch'](function () { self._dropLink(rec, '生成连接信息失败'); });
    } else {
      pc.ondatachannel = function (ev) { rec.dc = ev.channel; self._bindChannel(rec, ev.channel); };
    }
    return rec;
  };

  P2P.prototype._findLink = function (id) {
    for (var i = 0; i < this.links.length; i++) if (this.links[i].id === id) return this.links[i];
    return null;
  };

  P2P.prototype._bindChannel = function (rec, dc) {
    var self = this;
    dc.onopen = function () {
      rec.open = true;
      self.connected = true;
      if (self.role === 'host') {
        rec.seat = self._freeSeat();
        self._sendOn(rec, {
          type: 'welcome', team: rec.seat, seat: rec.seat, code: self.code,
          count: self.roster.count, teams: self.roster.teams, perTeam: self.roster.perTeam
        });
        self._emit('peer_join', { seat: rec.seat, name: rec.name });
        self._emitLobby();
        self._status('有朋友连上了（' + self._openLinks().length + '/' + Math.max(1, self.roster.count - 1) + ' 位客人）。', 'ok');
      } else {
        self._cancelConnectTimer();
      }
      self._maybeOpen();
    };
    dc.onmessage = function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      self._onLinkData(rec, data);
    };
    dc.onclose = function () { self._dropLink(rec); };
    dc.onerror = function () { if (!rec.open) self._dropLink(rec, '数据通道出错'); };
  };

  P2P.prototype._onLinkData = function (rec, data) {
    if (!data || typeof data !== 'object' || !data.type) return;
    if (!rec.isHost && data.type === 'welcome') {
      this.seat = (typeof data.seat === 'number') ? data.seat : 1;
      this._emit('joined', { team: this.seat, seat: this.seat, count: data.count, code: data.code });
    }
    if (rec.isHost && rec.seat != null) {
      if (data.seat == null) data.seat = rec.seat;
      if (data.from == null) data.from = rec.seat;
    }
    this._emit(data.type, data);
  };

  P2P.prototype._sendOn = function (rec, obj) {
    try { if (rec.dc && rec.dc.readyState === 'open') { rec.dc.send(JSON.stringify(obj)); return true; } }
    catch (e) { /* 忽略 */ }
    return false;
  };

  P2P.prototype._freeSeat = function () {
    var used = {};
    for (var i = 0; i < this.links.length; i++) if (this.links[i].seat != null) used[this.links[i].seat] = true;
    var s = 1;
    while (used[s]) s++;
    return s;
  };

  P2P.prototype._openLinks = function () {
    return this.links.filter(function (c) { return c.open; });
  };

  P2P.prototype._dropLink = function (rec, why) {
    var idx = this.links.indexOf(rec);
    if (idx < 0) return;
    this.links.splice(idx, 1);
    try { if (rec.dc) rec.dc.close(); } catch (e) { /* 忽略 */ }
    try { if (rec.pc) rec.pc.close(); } catch (e) { /* 忽略 */ }
    if (rec === this._guestRec) { this._guestRec = null; this._myAnswer = null; }
    if (this.role === 'host') {
      if (rec.seat != null) this._emit('peer_leave', { seat: rec.seat, name: rec.name });
      this._emitLobby();
      if (!this.links.length) this.connected = false;
    } else {
      this.connected = false;
      this._emit('opponent_left', {});
      this._emit('close', {});
    }
    if (why) this._status(why, 'error');
  };

  P2P.prototype._maybeOpen = function () {
    if (this._opened) return;
    this._opened = true;
    this._status(this.role === 'host' ? '朋友已连上。' : '已连上房主。', 'ok');
    this._emit('open', {});
  };

  /* 客人：从「加入」到「打通」的超时保护，避免一直卡着没反馈 */
  P2P.prototype._startConnectTimer = function () {
    var self = this;
    clearTimeout(this._timer);
    this._timer = setTimeout(function () {
      if (!self.connected && !self.closed) {
        self._fail('连不上房主（' + Math.round(CONNECT_TIMEOUT / 1000) + ' 秒超时）。' +
          '请确认房间号正确、房主还在房间里；若仍不行，改用下面的 <b>「连接码」</b> 直连（不依赖任何服务器）。');
      }
    }, CONNECT_TIMEOUT);
  };

  P2P.prototype._cancelConnectTimer = function () { clearTimeout(this._timer); };

  P2P.prototype._onSignalLost = function () {
    if (this.closed) return;
    /* 信令断了不影响已建立的直连；只在还没连上时提示 */
    if (!this.connected) {
      this._fail('与公共信令服务器的连接断了。请重试，或改用 <b>「连接码」</b> 直连（不依赖任何服务器）。');
    } else {
      this._status('公共信令连接已断开（已建立的对局不受影响）。', 'info');
    }
  };

  /* ================= 大厅状态 ================= */

  P2P.prototype.joinedCount = function () {
    if (this.role === 'guest') return this.connected ? 2 : 1;
    return 1 + this._openLinks().length;
  };

  P2P.prototype._emitLobby = function () {
    var state = {
      joined: this.joinedCount(),
      count: this.roster.count || 2,
      seats: this._openLinks().map(function (c) { return { seat: c.seat, name: c.name }; })
    };
    this._emit('lobby', state);
    if (this.role === 'host' && this.links.length) {
      this.send({ type: 'lobby', joined: state.joined, count: state.count });
    }
  };

  /* ================= 发送 ================= */

  /** 房主 → 所有客人；客人 → 房主 */
  P2P.prototype.send = function (obj) {
    var sent = false;
    for (var i = 0; i < this.links.length; i++) if (this._sendOn(this.links[i], obj)) sent = true;
    if (!sent && this.role === 'guest' && this.connected) {
      this._status('与房主的连接已断开，请重新加入房间。', 'error');
    }
    return sent;
  };

  /** 只发给某个席位（房主专用） */
  P2P.prototype.sendTo = function (seat, obj) {
    for (var i = 0; i < this.links.length; i++) {
      if (this.links[i].seat === seat) return this._sendOn(this.links[i], obj);
    }
    return false;
  };

  /** 已连上的客人席位列表（房主专用） */
  P2P.prototype.peerSeats = function () {
    return this.links.map(function (c) { return c.seat; }).filter(function (s) { return s != null; });
  };

  /* ================= 对局内动作（客人 → 房主的上报接口） ================= */

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
    clearInterval(this._joinTimer);
    /* 先摘掉引用再逐个关闭：close() 会回调 _dropLink 去 splice 这个数组，
     * 边遍历边删除会漏关后面的连接（多人房尤其明显）。 */
    var links = this.links.slice();
    this.links = [];
    for (var i = 0; i < links.length; i++) {
      try { if (links[i].dc) links[i].dc.close(); } catch (e) { /* 忽略 */ }
      try { if (links[i].pc) links[i].pc.close(); } catch (e) { /* 忽略 */ }
    }
    if (this.sig) { try { this.sig.close(); } catch (e) { /* 忽略 */ } this.sig = null; }
    this.connected = false;
  };

  GW.P2P = P2P;
  GW.P2P.ICE_SERVERS = ICE_SERVERS;
  GW.P2P.BROKERS = BROKERS;
  GW.P2P.randCode = randCode;
  GW.P2P.normalizeCode = normalizeCode;

  /** 当前环境能否联机：需要 WebRTC（页面须为 https 或 localhost） */
  GW.p2pSupported = function () {
    return typeof RTCPeerConnection !== 'undefined';
  };
  /** 一键房间号还需要 WebSocket（连接码模式不需要） */
  GW.p2pCloudSupported = function () {
    return typeof RTCPeerConnection !== 'undefined' && typeof WebSocket !== 'undefined';
  };

})(typeof window !== 'undefined' ? window : globalThis);
