/* ============================================================
 * 联机客户端：WebSocket 封装
 * 负责连接服务器、创建 / 加入房间，并把本地开炮意图（写函数 / 画函数 / 角度）
 * 发往服务器；同时把服务器下发的对局事件（start / turn / shot / over …）转成回调。
 *
 * 服务器地址约定：由大厅界面传入（默认 ws://<当前主机> ，即本机 / 局域网 / 公网 IP）。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});

  /* 事件回调表：type -> [fn] */
  function Net(url) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.room = null;       // 房号
    this.team = null;       // 我方阵营下标：0 = 绿方（左军），1 = 青方（右军）
    this.closed = false;
    this.handlers = {};
    this._openCbs = [];
    this._connect();
  }

  Net.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
    return this;
  };

  Net.prototype._emit = function (type, data) {
    var list = this.handlers[type] || [];
    for (var i = 0; i < list.length; i++) list[i](data || {});
  };

  Net.prototype._connect = function () {
    var self = this;
    if (typeof WebSocket === 'undefined') {
      this._emit('error', { msg: '当前环境不支持 WebSocket' });
      return;
    }
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this._emit('error', { msg: '无法连接：' + (e && e.message ? e.message : e) });
      return;
    }
    this.ws.onopen = function () {
      self.connected = true;
      self._emit('open');
      for (var i = 0; i < self._openCbs.length; i++) self._openCbs[i]();
      self._openCbs = [];
    };
    this.ws.onclose = function () {
      self.connected = false;
      self._emit('close');
    };
    this.ws.onerror = function () {
      if (!self.connected) self._emit('error', { msg: '连接失败，请确认服务器已启动且地址正确' });
    };
    this.ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      self._onMessage(msg);
    };
  };

  /** 连接建立后再执行的动作（创建 / 加入房间依赖已连上） */
  Net.prototype.whenOpen = function (fn) {
    if (this.connected) fn();
    else this._openCbs.push(fn);
  };

  Net.prototype.send = function (obj) {
    if (this.ws && this.connected) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* 忽略发送失败 */ }
    }
  };

  /* ---------------- 大厅动作 ---------------- */
  Net.prototype.create = function (config) { this.send({ type: 'create', config: config }); };
  Net.prototype.join = function (code) { this.send({ type: 'join', code: String(code || '').toUpperCase() }); };

  /* ---------------- 对局内动作 ---------------- */
  Net.prototype.fire = function (expr, angle, weapon) { this.send({ type: 'fire', expr: expr, angle: angle || 0, weapon: weapon == null ? 1 : weapon }); };
  Net.prototype.sketch = function (norm, rot, scale, weapon) { this.send({ type: 'sketch', norm: norm, rot: rot, scale: scale, weapon: weapon == null ? 1 : weapon }); };
  Net.prototype.move = function (expr, dist) { this.send({ type: 'move', expr: expr, dist: dist }); };
  Net.prototype.sketchMove = function (norm, rot, scale, dist) { this.send({ type: 'move', norm: norm, rot: rot, scale: scale, dist: dist }); };
  Net.prototype.skill = function () { this.send({ type: 'skill' }); };
  /** 开局技能选择：把本席位的技能 id 交给服务器（服务器权威，校验后写入该席位） */
  Net.prototype.skillPick = function (id) { this.send({ type: 'skill_pick', skill: id }); };
  Net.prototype.angle = function (a) { this.send({ type: 'angle', angle: a }); };
  Net.prototype.rematch = function () { this.send({ type: 'rematch' }); };
  /* 快捷语：服务器只按 id 白名单转发给对手，text 仅作本地回显 */
  Net.prototype.chat = function (id, text) { this.send({ type: 'chat', id: id, text: text }); };
  Net.prototype.quit = function () {
    this.send({ type: 'quit' });
    this.closed = true;
    if (this.ws) { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
  };

  Net.prototype._onMessage = function (msg) {
    switch (msg.type) {
      case 'created': this.room = msg.code; this.team = msg.team; this._emit('created', msg); break;
      case 'joined': this.room = msg.code; this.team = msg.team; this._emit('joined', msg); break;
      case 'wait': this._emit('wait', msg); break;
      case 'share': this._emit('share', msg); break;
      case 'chat': this._emit('chat', msg); break;
      case 'start': this._emit('start', msg); break;
      case 'turn': this._emit('turn', msg); break;
      case 'shot': this._emit('shot', msg); break;
      case 'move': this._emit('move', msg); break;
      case 'skill_used': this._emit('skill_used', msg); break;
      case 'reward': this._emit('reward', msg); break;
      case 'pack': this._emit('pack', msg); break;
      case 'over': this._emit('over', msg); break;
      case 'fire_error': this._emit('fire_error', msg); break;
      case 'opponent_left': this._emit('opponent_left', msg); break;
      case 'error': this._emit('error', msg); break;
      default: break;
    }
  };

  GW.Net = Net;
})(typeof window !== 'undefined' ? window : globalThis);
