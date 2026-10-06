/* ============================================================
 * 函数战争 · 联机服务器（零依赖，仅用 Node 内置模块）
 *
 * 职责：
 *   1. 用 HTTP 把整个项目作为静态站点托管（默认 8080 端口）；
 *   2. 在同一端口上提供 WebSocket（房间 / 权威对局循环）；
 *   3. 加载浏览器同款 GW 核心模块，在服务器上跑「权威模拟」，
 *      把 shot / turn / over 事件广播给双方；
 *   4. 校验「是否轮到该玩家」「炮弹是否在飞」等合法性。
 *
 * 启动： node server/server.js   （可选 PORT 环境变量改端口）
 * 游玩： 浏览器打开 http://<本机或局域网IP>:8080 → 联机对战
 * ============================================================ */
'use strict';
var http = require('http');
var https = require('https');
var os = require('os');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var ws = require('./ws');

var ROOT = path.resolve(__dirname, '..');
var PORT = parseInt(process.env.PORT, 10) || 8080;

/* ---------------- 加载浏览器同款 GW 核心（纯逻辑，无 DOM） ---------------- */
['constants', 'expression', 'terrain', 'trajectory', 'sketch', 'game', 'ai'].forEach(function (name) {
  var code = fs.readFileSync(path.join(ROOT, 'js', name + '.js'), 'utf8');
  vm.runInThisContext(code, { filename: name + '.js' });
});
var GW = globalThis.GW;
var C = GW.C;

/* ---------------- 地址探测：创建房间时自动生成「一键加入」分享链接 ----------------
 * 玩家往往不知道自己的公网 / 局域网 IP，因此由服务器代为探测：
 *   · 公网 IP：向公共 IP 服务发起一次 HTTPS 请求（零依赖，仅用 Node 内置 https）；
 *   · 局域网 IP：从 os.networkInterfaces() 取非内网的 IPv4；
 * 结果随 created 消息一起下发给房主，房主即可直接复制链接发给朋友。 */
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
    }, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; if (body.length > 256) res.destroy(); });
      res.on('end', function () {
        var ip = p.parse(body);
        if (ip && /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(ip)) {
          publicIP = ip;
          console.log('[函数战争] 已探测公网 IP：' + ip);
          if (onDone) onDone(true);
        } else { tryNext(); }
      });
    });
    req.on('timeout', function () { req.destroy(); tryNext(); });
    req.on('error', function () { tryNext(); });
  }
  tryNext();
}

function shareInfo() {
  return { port: PORT, publicIp: publicIP, lanIps: lanIPs() };
}

/* 启动即预热一次，玩家点「创建房间」时通常已拿到公网 IP */
fetchPublicIP();

/* ---------------- 静态文件服务 ---------------- */
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

/* ---------------- 房间管理 ---------------- */
var rooms = {};

/** 无实体的「AI 玩家」连接占位：不接收消息，仅作为 room.players 中的一项，
 *  让 sendBoth 对其 skip（alive:false），同时真正的对局由 room.game 的 AI 驱动。 */
function makeBot(teamIndex) {
  return { teamIndex: teamIndex, isBot: true, alive: false, send: function () {} };
}

function randomCode(n) {
  var s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var r = '';
  for (var i = 0; i < n; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
}
function genCode() {
  var code;
  do { code = randomCode(4); } while (rooms[code]);
  return code;
}
function sendAll(room, msg) {
  for (var i = 0; i < room.players.length; i++) {
    var p = room.players[i];
    if (p && p.alive) p.send(msg);
  }
}

/** 席位由「多人赛制」决定：队伍总数 × 每队人数 = 总人数（上限 8）；
 *  只给 playerCount 的历史房间按人数反推等价赛制。 */
function seatRoster(room) {
  var cfg = room.config || {};
  if (cfg.teams != null) {
    return GW.seatsFromRoster(GW.clampTeamCount(cfg.teams), cfg.perTeam);
  }
  return GW.rosterFromSeats(cfg.playerCount);
}

function seatCount(room) {
  return seatRoster(room).count;
}

function startMatch(room) {
  var mode = room.config.mode || 0;
  var roster = seatRoster(room);
  var nSeats = roster.count;
  /* 多人模式（2v2 / 3v3 / 4v4 / 多队混战）：每人 1 名士兵，同阵营玩家共用落座位 */
  var soldiers = nSeats > 2 ? 1 : Math.max(1, Math.min(C.MAX_SOLDIERS_PER_PLAYER, room.config.soldiers || 2));
  var turnTime = (room.config.turnTime == null) ? 120 : room.config.turnTime;   // 每秒；0 = 不限时
  var battle = nSeats > 2
    ? GW.generateBattle(soldiers, nSeats, roster.teams, roster.perTeam)   // 与浏览器端（点对点房主）共用同一份实现
    : GW.generateBattle(soldiers);
  var currentTurn = GW.randInt(nSeats);

  var g = new GW.Game({
    mode: mode, soldiersPerPlayer: soldiers,
    teams: roster.teams, perTeam: roster.perTeam, playerCount: nSeats,
    opponent: 'human', aiLevel: 2, turnTimeSec: turnTime
  });
  room.game = g;                  // 必须在 loadBattle 之前赋值，否则初始 'turn' 广播时 snapshotPlayers 会取空
  g.on(broadcastFactory(room));   // 也须在 loadBattle 之前：后者会 emit 初始 'turn'，须被广播
  g.loadBattle(battle.circles, battle.positions, currentTurn, false);   // 服务器权威：remoteDriven=false

  /* 人机补齐：只补「空位」，绝不顶替已连接的真人席位 */
  var fillAI = !!room.config.fillAI;
  if (fillAI) {
    for (var fi = 0; fi < nSeats; fi++) {
      if (!room.players[fi]) {
        room.players[fi] = makeBot(fi);
        g.players[fi].isAI = true;
        if (room.botTeam == null) room.botTeam = fi;
      }
    }
  }
  /* 掉线接管后重开：离场席位在 onDisconnect 里已换成 bot，这里只需保持 AI 执子 */
  if (room.botTeam != null && g.players[room.botTeam] && room.players[room.botTeam] && room.players[room.botTeam].isBot) {
    g.players[room.botTeam].isAI = true;
  }

  var base = {
    type: 'start',
    config: {
      mode: mode, soldiers: soldiers, playerCount: nSeats,
      teams: roster.teams, perTeam: roster.perTeam, turnTime: turnTime
    },
    terrain: { circles: battle.circles, positions: battle.positions },
    currentTurn: currentTurn,
    botTeam: (room.botTeam != null) ? room.botTeam : -1
  };
  for (var si = 0; si < nSeats; si++) {
    if (room.players[si] && room.players[si].alive) {
      room.players[si].send(Object.assign({}, base, { team: si }));
    }
  }
}

function broadcastFactory(room) {
  return function (type, data) {
    if (type === 'shot') {
      sendAll(room, { type: 'shot', round: room.game.round, shot: packShot(data.shot) });
    } else if (type === 'turn') {
      sendAll(room, {
        type: 'turn', currentTurn: room.game.currentTurn,
        players: snapshotPlayers(room.game), packs: GW.snapshotPacks(room.game)
      });
    } else if (type === 'move') {
      sendAll(room, {
        type: 'move', round: room.game.round, playerIndex: data.playerIndex,
        soldierIndex: data.soldierIndex, fx: data.fx, fy: data.fy, tx: data.tx, ty: data.ty
      });
    } else if (type === 'skill') {
      sendAll(room, { type: 'skill_used', playerIndex: data.playerIndex, skill: data.skill });
    } else if (type === 'skills') {
      sendAll(room, { type: 'skills', players: data.players });
    } else if (type === 'reward') {
      sendAll(room, { type: 'reward', playerIndex: data.playerIndex, kind: data.kind, x: data.x, y: data.y });
    } else if (type === 'pack') {
      sendAll(room, { type: 'pack', pack: data.pack });
    } else if (type === 'over') {
      sendAll(room, {
        type: 'over',
        result: { winner: data.winner ? { team: data.winner.team } : null, reason: data.reason }
      });
    }
    /* 忽略 newbattle / log / explosion / casualty / damaged / aithink / timeout */
  };
}

/* 消息打包统一走 GW.packShot / GW.snapshotPlayers（js/game.js），
 * 与浏览器端的点对点房主共用，避免两份实现漂移。 */
function packShot(shot) { return GW.packShot(shot); }
function snapshotPlayers(g) { return GW.snapshotPlayers(g); }

/* ---------------- 玩家动作 ---------------- */
function turnCheck(room, conn) {
  var g = room.game;
  if (!g) { conn.send({ type: 'fire_error', msg: '对局尚未开始' }); return null; }
  if (g.state !== 'aim') { conn.send({ type: 'fire_error', msg: '请等当前行动结束' }); return null; }
  if (g.currentTurn !== conn.teamIndex) { conn.send({ type: 'fire_error', msg: '还没轮到你' }); return null; }
  return g;
}

function applyFire(room, conn, expr, angle, weapon) {
  var g = turnCheck(room, conn);
  if (!g) return;
  if (g.mode === C.SND_ODE) g.setAngle(angle || 0);
  var res = g.fire(expr, false, weapon);
  if (!res.ok) { conn.send({ type: 'fire_error', msg: res.reason }); return; }
  /* game.fire 内部 emit('shot') → 广播 */
}

function applySketch(room, conn, norm, rot, scale, weapon) {
  var g = turnCheck(room, conn);
  if (!g) return;
  if (!norm || !norm.length) { conn.send({ type: 'fire_error', msg: '请先在画板上拖出一笔' }); return; }
  var traj = g.buildSketchTrajectory(norm, rot || 0, scale == null ? 1 : scale);
  if (!traj || traj.numSteps < 2) { conn.send({ type: 'fire_error', msg: '这一笔无法形成有效弹道，请重画或调小尺寸' }); return; }
  var res = g.fireTrajectory(traj, traj.expr, C.FUNCTION_VELOCITY, weapon);
  if (!res.ok) { conn.send({ type: 'fire_error', msg: res.reason }); return; }
}

/* 位移：写函数或手绘曲线均可；距离可自控但受上限钳制（game.move 内部处理） */
function applyMove(room, conn, msg) {
  var g = turnCheck(room, conn);
  if (!g) return;
  var res;
  if (msg.norm && msg.norm.length) {
    var traj = g.buildSketchTrajectory(msg.norm, msg.rot || 0, msg.scale == null ? 1 : msg.scale);
    if (!traj || traj.numSteps < 2) { conn.send({ type: 'fire_error', msg: '这一笔无法作为位移路径' }); return; }
    /* 用共享的「沿弹道前段移动」实现：先存后在 game 内复用同一套规则 */
    res = moveAlongTrajectory(g, traj, msg.dist);
  } else {
    res = g.move(msg.expr, msg.dist, false);
  }
  if (!res.ok) { conn.send({ type: 'fire_error', msg: res.reason }); return; }
}

/** 与 ui.js 的 _moveAlongTrajectory 同一套规则（手绘曲线位移），服务器权威执行 */
function moveAlongTrajectory(g, traj, dist) {
  var player = g.players[g.currentTurn];
  var soldier = player.getCurrentTurnSoldier();
  if (!soldier || !soldier.isAlive()) return { ok: false, reason: '这名士兵已阵亡' };
  var maxDist = C.MAX_MOVE_DIST + (player.moveBonus || 0);
  var pxPerUnit = C.PLANE_LENGTH / C.PLANE_GAME_LENGTH;
  var wantPx = Math.max(0.5, Math.min(maxDist, dist == null ? maxDist : dist)) * pxPerUnit;
  var acc = 0, tx = traj.xs[0], ty = traj.ys[0], i;
  var fx = soldier.x, fy = soldier.y;
  var picked = [];
  for (i = 1; i < traj.numSteps; i++) {
    var px = GW.toPlaneX(traj.xs[i]);
    if (traj.inverted) px = C.PLANE_LENGTH - px;
    var py = GW.toPlaneY(traj.ys[i]);
    acc += Math.sqrt((px - GW.toPlaneX(traj.xs[i - 1])) * (px - GW.toPlaneX(traj.xs[i - 1])) +
      (py - GW.toPlaneY(traj.ys[i - 1])) * (py - GW.toPlaneY(traj.ys[i - 1])));
    for (var pi = g.packs.length - 1; pi >= 0; pi--) {
      var pk = g.packs[pi];
      if (picked.indexOf(pk) < 0 &&
          Math.sqrt((pk.x - px) * (pk.x - px) + (pk.y - py) * (pk.y - py)) <= C.MOVE_PICKUP_RADIUS) picked.push(pk);
    }
    tx = traj.xs[i]; ty = traj.ys[i];
    if (acc >= wantPx) break;
  }
  var gx = traj.inverted ? C.PLANE_LENGTH - GW.toPlaneX(tx) : GW.toPlaneX(tx);
  var gy = GW.toPlaneY(ty);
  if (g.terrain.soldierCollides(gx, gy, C.SOLDIER_RADIUS) || gx < 4 || gx > C.PLANE_LENGTH - 4) {
    return { ok: false, reason: '位移终点被地形挡住，请缩短距离或换曲线' };
  }
  soldier.x = Math.round(gx * 10) / 10;
  soldier.y = Math.round(gy * 10) / 10;
  g.moveAnim = { playerIndex: g.currentTurn, soldierIndex: player.currentSoldierIndex, fx: fx, fy: fy, tx: soldier.x, ty: soldier.y, start: GW.now() };
  for (var m = 0; m < picked.length; m++) g._collectPack(picked[m]);
  g.state = 'moving';
  g._moveStart = GW.now();
  g.round++;
  g.log(C.TEAM_NAME[player.team] + ' 手绘位移。', 'sys');
  g.emit('move', { playerIndex: g.currentTurn, soldierIndex: player.currentSoldierIndex, fx: fx, fy: fy, tx: soldier.x, ty: soldier.y });
  return { ok: true };
}

/* 开局技能选择：客户端在「进入战场」后立刻上报，服务器写进该席位的 authoritative 玩家，
 * 随后由 turn 快照（snapshotPlayers 含 skill / skillUsed）同步给所有人。 */
function applySkillPick(room, conn, skillId) {
  var g = room.game;
  if (!g) { conn.send({ type: 'fire_error', msg: '对局尚未开始' }); return; }
  var res = g.pickSkill(conn.teamIndex, skillId);
  if (!res.ok) { conn.send({ type: 'fire_error', msg: res.reason }); return; }
  sendAll(room, {
    type: 'skills',
    players: snapshotPlayers(g).map(function (p) { return { skill: p.skill, skillUsed: p.skillUsed }; })
  });
}

function applySkill(room, conn) {
  var g = turnCheck(room, conn);
  if (!g) return;
  var res = g.useSkill();
  if (!res.ok) { conn.send({ type: 'fire_error', msg: res.reason }); return; }
}

/* ---------------- 连接处理 ---------------- */
ws.attach(httpServer, function (conn) {
  conn.on('message', function (text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    handle(conn, msg);
  });
  conn.on('close', function () { onDisconnect(conn); });
});

function handle(conn, msg) {
  if (msg.type === 'create') {
    if (conn.room) return;
    var code = genCode();
    var cfg = msg.config || { mode: 0, soldiers: 2, fillAI: false };
    var nSeats = seatRoster({ config: cfg }).count;   // 队伍总数 × 每队人数
    var seats = [conn];
    for (var si = 1; si < nSeats; si++) seats.push(null);
    var room = { code: code, players: seats, config: cfg, game: null, botTeam: null };
    conn.teamIndex = 0;
    conn.room = room;
    rooms[code] = room;
    conn.send({ type: 'created', code: code, team: 0, share: shareInfo() });
    /* 若启动时还未探测到公网 IP，这里补探一次并回推给房主（拿到后刷新分享链接） */
    if (!publicIP) {
      fetchPublicIP(function (ok) {
        if (!ok) return;
        try { conn.send({ type: 'share', share: shareInfo() }); } catch (e) { /* 连接可能已关闭 */ }
      });
    }
    /* 人机补齐：无人可等时直接以 AI 补满空位开局（空位识别在 startMatch 内完成） */
    if (cfg.fillAI) startMatch(room);
    return;
  }
  if (msg.type === 'join') {
    var room = rooms[msg.code];
    if (!room) { conn.send({ type: 'error', msg: '房间不存在' }); return; }
    var seat = -1;
    for (var i = 0; i < room.players.length; i++) {
      if (!room.players[i] || room.players[i].isBot) { seat = i; break; }
    }
    if (seat < 0) { conn.send({ type: 'error', msg: '房间已满' }); return; }
    /* 若该座位原本由 AI 顶替（人机补齐），真人加入则 AI 让位 */
    if (room.players[seat] && room.players[seat].isBot && room.game) {
      room.game.players[seat].isAI = false;
      if (room.botTeam === seat) room.botTeam = null;
    }
    room.players[seat] = conn;
    conn.teamIndex = seat;
    conn.room = room;
    conn.send({ type: 'joined', code: room.code, team: seat });
    /* 人满即开局 */
    var needBot = !!(room.config && room.config.fillAI);
    var full = true;
    for (var j = 0; j < room.players.length; j++) {
      if (!room.players[j] && !(needBot && j > 0)) { full = false; break; }
    }
    if (full && !room.game) startMatch(room);
    return;
  }
  if (!conn.room) return;
  var r = conn.room;
  if (msg.type === 'chat') {
    /* 快捷语：只按 id 从白名单取文，转发给其他真人玩家；无法发送任意内容 */
    var phrase = GW.quickPhrase ? GW.quickPhrase(msg.id) : null;
    if (phrase) {
      for (var pi = 0; pi < r.players.length; pi++) {
        var peer = r.players[pi];
        if (peer && peer !== conn && peer.alive && !peer.isBot) {
          peer.send({ type: 'chat', id: phrase.id, text: phrase.text, from: conn.teamIndex });
        }
      }
    }
    return;
  }
  if (msg.type === 'fire') applyFire(r, conn, msg.expr, msg.angle, msg.weapon);
  else if (msg.type === 'sketch') applySketch(r, conn, msg.norm, msg.rot, msg.scale, msg.weapon);
  else if (msg.type === 'move') applyMove(r, conn, msg);
  else if (msg.type === 'skill') applySkill(r, conn);
  else if (msg.type === 'skill_pick') applySkillPick(r, conn, msg.skill);
  else if (msg.type === 'rematch') {
    var ready = true;
    for (var ri = 0; ri < r.players.length; ri++) {
      if (!r.players[ri] && !(r.config && r.config.fillAI && ri > 0)) { ready = false; break; }
    }
    if (ready) startMatch(r);
  }
  /* 'angle' / 'quit' 由开炮消息携带 angle，或断开时由 close 处理 */
}

function onDisconnect(conn) {
  var room = conn.room;
  if (!room) return;
  /* 人机补齐：对局进行中 → 用 AI 接管离场席位，对局继续 */
  if (room.game) {
    var leaverSeat = conn.teamIndex;
    room.game.players[leaverSeat].isAI = true;
    if (room.botTeam == null) room.botTeam = leaverSeat;
    room.players[leaverSeat] = makeBot(leaverSeat);
    for (var i = 0; i < room.players.length; i++) {
      var other = room.players[i];
      if (other && other !== conn && other.alive && !other.isBot) {
        other.send({ type: 'bot_tookover', team: leaverSeat });
      }
    }
    return;
  }
  for (var k = 0; k < room.players.length; k++) {
    var rest = room.players[k];
    if (rest && rest !== conn && rest.alive) rest.send({ type: 'opponent_left' });
  }
  delete rooms[room.code];
}

/* ---------------- 权威对局循环 ---------------- */
setInterval(function () {
  for (var code in rooms) {
    var room = rooms[code];
    if (room.game) room.game.update(Date.now());
  }
}, 16);

httpServer.listen(PORT, function () {
  console.log('[函数战争] 联机服务器已启动：');
  console.log('  本机：  http://localhost:' + PORT);
  console.log('  局域网：http://<本机IP>:' + PORT + '  （同网段设备可加入）');
  console.log('  联机大厅填的服务器地址默认就是当前打开地址。');
});
