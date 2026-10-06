/* ============================================================
 * 函数战争 · 内网穿透中继服务器（零依赖，仅用 Node 内置模块）
 *
 * 设计目标（类比 Tailscale）：
 *   · 浏览器无法像 Tailscale 那样在系统层做内网穿透，但「房主浏览器即权威端」
 *     的架构下，我们只需要一条双方都能到达的通道来：
 *        ① 交换 WebRTC 握手（信令），让两台设备尝试【直连】（Tailscale 直连，低延迟）；
 *        ② 直连打不通（对称 NAT / 校园网 / 企业网）时，由本服务器【透明中转】数据
 *           （Tailscale 的 DERP 中继兜底）。
 *   · 本服务器【只转发字节，不跑任何对局逻辑】——权威对局仍在房主的浏览器里进行，
 *     与「服务器联机」（server/server.js 在服务器上跑权威）是两套独立方案。
 *
 * 适用：内网穿透联机（房主浏览器权威，2 人 1v1），最推荐给普通玩家——
 *       即使双方不在同一网络、甚至在严格 NAT 后也能连上。
 * 端口：默认 8081（避免与 server/server.js 的 8080 冲突），可用 PORT 环境变量改。
 * 启动： node server/relay.js
 * 游玩： 浏览器打开 http://<本机或局域网IP>:8081 → 联机对战 → 选「内网穿透联机」
 * ============================================================ */
'use strict';
var http = require('http');
var https = require('https');
var os = require('os');
var fs = require('fs');
var path = require('path');
var ws = require('./ws');

var ROOT = path.resolve(__dirname, '..');
var PORT = parseInt(process.env.PORT, 10) || 8081;

/* ---------------- 静态文件服务（同一进程顺带托管游戏页面，方便「一个进程搞定」） ---------------- */
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};
var BLOCKED = ['/server/', '/.workbuddy/', '/node_modules/'];

var httpServer = http.createServer(function (req, res) {
  var urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  for (var i = 0; i < BLOCKED.length; i++) {
    if (urlPath.indexOf(BLOCKED[i]) === 0) { res.writeHead(403); res.end('Forbidden'); return; }
  }
  var filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath.indexOf(ROOT) !== 0) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- 公网 / 局域网地址探测（用于生成一键分享链接，可选） ---------------- */
var publicIP = null;
function lanIPs() {
  var out = [];
  var ifaces = os.networkInterfaces();
  for (var name in ifaces) {
    var arr = ifaces[name] || [];
    for (var i = 0; i < arr.length; i++) {
      var a = arr[i];
      if (a && a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}
function fetchPublicIP(onDone) {
  if (publicIP) { if (onDone) onDone(true); return; }
  var providers = [
    { host: 'api.ipify.org', path: '/?format=json', parse: function (t) { try { return JSON.parse(t).ip; } catch (e) { return null; } } },
    { host: 'ipv4.icanhazip.com', path: '/', parse: function (t) { return (t || '').trim() || null; } },
    { host: 'ifconfig.me', path: '/ip', parse: function (t) { return (t || '').trim() || null; } }
  ];
  var i = 0;
  function tryNext() {
    if (i >= providers.length) { if (onDone) onDone(false); return; }
    var p = providers[i++];
    var req = https.get({
      host: p.host, path: p.path, timeout: 3500,
      headers: { 'User-Agent': 'graphwar-cn', 'Accept': 'application/json, text/plain' }
    }, function (r) {
      var body = '';
      r.on('data', function (c) { body += c; if (body.length > 256) r.destroy(); });
      r.on('end', function () {
        var ip = p.parse(body);
        if (ip && /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(ip)) { publicIP = ip; if (onDone) onDone(true); }
        else tryNext();
      });
    });
    req.on('timeout', function () { req.destroy(); tryNext(); });
    req.on('error', function () { tryNext(); });
  }
  tryNext();
}
fetchPublicIP();

/* ---------------- 中继核心：房间与连接路由 ---------------- */
/* clients: peerId -> conn（含 .room / .role）
 * rooms:   房间号 -> { host: peerId, guest: peerId|null } */
var clients = {};
var rooms = {};
var nextId = 1;

function genRoom() {
  var s, ok;
  do {
    s = String(100000 + Math.floor(Math.random() * 900000));
    ok = !rooms[s];
  } while (!ok);
  return s;
}

function send(conn, obj) {
  if (conn && conn.alive) {
    try { conn.send(obj); } catch (e) { /* 忽略 */ }
  }
}

/* 找出同房间的「另一端」连接（用于转发信令 / 中继数据） */
function otherConn(selfId, room) {
  if (!room) return null;
  var r = rooms[room];
  if (!r) return null;
  var otherId = (r.host === selfId) ? r.guest : (r.guest === selfId ? r.host : null);
  return otherId ? clients[otherId] : null;
}

function cleanupRoom(room) {
  if (room && rooms[room]) delete rooms[room];
}

ws.attach(httpServer, function (conn) {
  conn.alive = true;
  conn.peerId = 'p' + (nextId++);
  conn.room = null;
  conn.role = null;
  clients[conn.peerId] = conn;

  conn.on('message', function (text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    handle(conn, msg);
  });

  conn.on('close', function () {
    conn.alive = false;
    delete clients[conn.peerId];
    var room = conn.room;
    if (room && rooms[room]) {
      var r = rooms[room];
      var other = otherConn(conn.peerId, room);
      if (conn.role === 'host') {
        /* 房主离开 → 房间作废，通知客人 */
        cleanupRoom(room);
        if (other) { other.room = null; send(other, { type: 'peer-left' }); }
      } else if (conn.role === 'guest') {
        /* 客人离开 → 房间保留，房主可再等一位客人 */
        r.guest = null;
        if (other) send(other, { type: 'peer-left' });
      }
    }
  });
});

function handle(conn, msg) {
  if (msg.type === 'hello') {
    conn.send({ type: 'welcome', id: conn.peerId, publicIp: publicIP, lanIps: lanIPs(), port: PORT });
    return;
  }

  if (msg.type === 'create') {
    if (conn.room) { conn.send({ type: 'error', msg: '你已经在一个房间里了' }); return; }
    var num = genRoom();
    rooms[num] = { host: conn.peerId, guest: null };
    conn.room = num;
    conn.role = 'host';
    conn.send({ type: 'created', room: num });
    return;
  }

  if (msg.type === 'join') {
    var room = String(msg.room || '').trim();
    var r = rooms[room];
    if (!r) { conn.send({ type: 'error', msg: '房间不存在（房号有误或房主已退出）' }); return; }
    if (r.guest) { conn.send({ type: 'error', msg: '房间已满' }); return; }
    r.guest = conn.peerId;
    conn.room = room;
    conn.role = 'guest';
    conn.send({ type: 'joined', room: room });
    /* 通知房主：有客人进来了，可以开始 WebRTC 握手 */
    var host = clients[r.host];
    if (host) send(host, { type: 'peer-joined', room: room });
    return;
  }

  /* 信令：转发给另一端，用于 WebRTC 直连握手（SDP / ICE 候选） */
  if (msg.type === 'signal') {
    var o1 = otherConn(conn.peerId, conn.room);
    if (o1) send(o1, { type: 'signal', from: conn.peerId, data: msg.data });
    return;
  }

  /* 中继数据：直连未建立（或浏览器不支持 WebRTC）时，所有对局消息都走这里兜底转发 */
  if (msg.type === 'relay') {
    var o2 = otherConn(conn.peerId, conn.room);
    if (o2) send(o2, { type: 'relay', from: conn.peerId, data: msg.data });
    return;
  }

  if (msg.type === 'bye') {
    var other = otherConn(conn.peerId, conn.room);
    if (other) send(other, { type: 'peer-left' });
    return;
  }
}

httpServer.listen(PORT, function () {
  console.log('[函数战争] 内网穿透中继服务器已启动：');
  console.log('  本机：    http://localhost:' + PORT);
  console.log('  局域网：  http://<本机IP>:' + PORT + '  （同网段设备可加入）');
  console.log('  异地联机：把本服务器部署到任意云/内网穿透平台，朋友打开对应网址即可。');
  console.log('  大厅「连接方式」选「内网穿透联机（推荐）」，房主点创建房间拿到房间号发给朋友。');
});
