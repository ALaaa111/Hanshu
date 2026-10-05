/* ============================================================
 * 零依赖 WebSocket 服务端（RFC 6455 最小实现）
 * 仅支持文本帧（本游戏的消息均为 JSON 文本）。
 * 负责：握手升级、解帧（客户端须掩码）、封帧（服务端不掩码）、
 *       ping→pong、close。
 * ============================================================ */
'use strict';
var crypto = require('crypto');

var GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function WSConnection(socket) {
  this.socket = socket;
  this.buf = Buffer.alloc(0);
  this.fragOp = 0;
  this.frag = '';
  this.alive = true;
  this.handlers = { message: [], close: [] };
  var self = this;
  socket.on('data', function (chunk) { self._onData(chunk); });
  socket.on('close', function () { self.alive = false; self._fire('close'); });
  socket.on('error', function () { self.alive = false; self._fire('close'); });
}

WSConnection.prototype.on = function (type, fn) {
  (this.handlers[type] = this.handlers[type] || []).push(fn);
  return this;
};

WSConnection.prototype._fire = function (type, arg) {
  var list = this.handlers[type] || [];
  for (var i = 0; i < list.length; i++) list[i](arg);
};

WSConnection.prototype._onData = function (chunk) {
  this.buf = Buffer.concat([this.buf, chunk]);
  this._parse();
};

WSConnection.prototype._parse = function () {
  var buf = this.buf;
  while (buf.length >= 2) {
    var b0 = buf[0], b1 = buf[1];
    var fin = (b0 & 0x80) !== 0;
    var opcode = b0 & 0x0f;
    var masked = (b1 & 0x80) !== 0;
    var len = b1 & 0x7f;
    var offset = 2;

    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      var hi = buf.readUInt32BE(2);
      var lo = buf.readUInt32BE(6);
      len = hi * 4294967296 + lo;
      offset = 10;
    }

    var maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return;

    var payload = Buffer.from(buf.slice(offset, offset + len));
    if (masked) {
      for (var i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    buf = buf.slice(offset + len);
    this.buf = buf;

    if (opcode === 0x8) { this.close(); return; }
    if (opcode === 0x9) { this._sendFrame(0xA, payload); continue; }   // ping → pong
    if (opcode === 0xA) { continue; }                                  // pong

    var text = payload.toString('utf8');
    if (opcode === 0x0) {            // 续帧（分片文本）
      this.frag += text;
      if (fin) { var full = this.frag; this.frag = ''; this.fragOp = 0; this._fire('message', full); }
      continue;
    }
    if (!fin) { this.fragOp = opcode; this.frag = text; continue; }
    this._fire('message', text);
  }
};

WSConnection.prototype._sendFrame = function (opcode, payload) {
  if (!this.socket || !this.alive) return;
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode;   // FIN + opcode（服务端发送不掩码）
  try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { /* 忽略 */ }
};

WSConnection.prototype.send = function (obj) {
  if (typeof obj !== 'string') obj = JSON.stringify(obj);
  this._sendFrame(0x1, Buffer.from(obj, 'utf8'));
};

WSConnection.prototype.close = function () {
  if (!this.alive) return;
  try { this._sendFrame(0x8, Buffer.alloc(0)); } catch (e) { /* 忽略 */ }
  try { this.socket.end(); } catch (e) { /* 忽略 */ }
  this.alive = false;
  this._fire('close');
};

/** 在 http.Server 上升级 WebSocket */
function attach(server, onConnection) {
  server.on('upgrade', function (req, socket, head) {
    var key = req.headers['sec-websocket-key'];
    var upgrade = (req.headers['upgrade'] || '').toLowerCase();
    if (!key || upgrade !== 'websocket') { socket.destroy(); return; }
    var accept = acceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    if (head && head.length) socket.unshift(head);
    var conn = new WSConnection(socket);
    onConnection(conn, req);
  });
}

module.exports = { attach: attach, WSConnection: WSConnection };
