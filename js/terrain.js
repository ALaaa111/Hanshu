/* ============================================================
 * 地形：随机圆形山体 + 像素级碰撞 + 炮弹爆炸挖掘
 * 生成与判定规则参考原版 Obstacle.java / GraphServer.java
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});
  var C = GW.C;

  GW.Terrain = function Terrain(circles) {
    var L = C.PLANE_LENGTH, H = C.PLANE_HEIGHT;
    this.width = L;
    this.height = H;
    this.circles = [];
    this.mask = new Uint8Array(L * H);       // 1 = 实体山体，0 = 可通行的天空

    if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = L;
      this.canvas.height = H;
      this.ctx = this.canvas.getContext('2d');
    } else {
      this.canvas = null;
      this.ctx = null;
    }

    if (circles) {
      for (var i = 0; i < circles.length; i++) {
        this.addSolid(circles[i][0], circles[i][1], circles[i][2]);
      }
    }
  };

  GW.Terrain.prototype.addSolid = function (cx, cy, r) {
    if (!(r > 0)) return;
    this.circles.push([cx, cy, r]);
    this._paintMask(cx, cy, r, 1);
    if (this.ctx) {
      this.ctx.fillStyle = '#256d43';
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
      this.ctx.fill();
    }
  };

  /* 爆炸挖掘：把山体挖掉一块（原版用白色填充 doAttack + collidePoint 判白色为通行） */
  GW.Terrain.prototype.explode = function (cx, cy, r) {
    if (!(r > 0)) return;
    this._paintMask(cx, cy, r, 0);
    if (this.ctx) {
      this.ctx.save();
      this.ctx.globalCompositeOperation = 'destination-out';
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }
  };

  GW.Terrain.prototype._paintMask = function (cx, cy, r, value) {
    var L = this.width, H = this.height;
    var r2 = r * r;
    var x0 = Math.max(0, Math.floor(cx - r));
    var x1 = Math.min(L - 1, Math.ceil(cx + r));
    var y0 = Math.max(0, Math.floor(cy - r));
    var y1 = Math.min(H - 1, Math.ceil(cy + r));
    for (var y = y0; y <= y1; y++) {
      var dy = y - cy;
      var dy2 = dy * dy;
      var row = y * L;
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx;
        if (dx * dx + dy2 <= r2) this.mask[row + x] = value;
      }
    }
  };

  /* 与像素是否相撞（越界同样视为撞山） */
  GW.Terrain.prototype.collidePoint = function (x, y) {
    if (x < 0 || x >= this.width) return true;
    if (y < 0 || y >= this.height) return true;
    return this.mask[(y | 0) * this.width + (x | 0)] === 1;
  };

  /* 圆是否可以在此处落座（用于布置士兵） */
  GW.Terrain.prototype.soldierCollides = function (x, y, radius) {
    if (x + radius >= this.width) return true;
    if (x - radius < 0) return true;
    if (y + radius >= this.height) return true;
    if (y - radius < 0) return true;
    return this.collidePoint(x, y) || this.collidePoint(x + radius, y) ||
      this.collidePoint(x - radius, y) || this.collidePoint(x, y + radius) ||
      this.collidePoint(x, y - radius);
  };

  GW.Terrain.prototype.render = function (ctx) {
    if (!this.canvas) return;
    ctx.drawImage(this.canvas, 0, 0);
  };

  /* ---------- 随机地图生成（参数与原版 GraphServer.generateCircles 一致） ---------- */
  GW.generateCircles = function () {
    var n = Math.round(GW.gaussRandom() * C.NUM_CIRCLES_STANDARD_DEVIATION + C.NUM_CIRCLES_MEAN_VALUE);
    if (n < 1) n = 1;
    var circles = [];
    for (var i = 0; i < n; i++) {
      var x = GW.randInt(C.PLANE_LENGTH);
      var y = GW.randInt(C.PLANE_HEIGHT);
      var r = Math.round(GW.gaussRandom() * C.CIRCLE_STANDARD_DEVIATION + C.CIRCLE_MEAN_RADIUS);
      var guard = 0;
      while (r <= 2 && guard++ < 20) {
        r = Math.round(GW.gaussRandom() * C.CIRCLE_STANDARD_DEVIATION + C.CIRCLE_MEAN_RADIUS);
      }
      if (r <= 2) r = 3;
      circles.push([x, y, r]);
    }
    return circles;
  };

  /** 按原版服务端规则在各自半场随机落座：彼此保持距离，也不能与山体重叠 */
  GW.placeSoldiers = function (circles, teams) {
    var half = C.PLANE_LENGTH / 2;
    var span = half - 2 * C.SOLDIER_RADIUS;
    var placed = [];
    var radiusQs = C.SOLDIER_SELECTION_RADIUS;

    function tooClose(x, y) {
      for (var i = 0; i < placed.length; i++) {
        var ddx = placed[i][0] - x, ddy = placed[i][1] - y;
        if (Math.sqrt(ddx * ddx + ddy * ddy) < 20) return true;   // 人数越多越容易挤，用真实圆形间距
      }
      for (var j = 0; j < circles.length; j++) {
        var c = circles[j];
        var dx = x - c[0], dy = y - c[1];
        if (Math.sqrt(dx * dx + dy * dy) < c[2] + radiusQs) return true;
      }
      return false;
    }

    var zones = teams.length;                       // 阵营数：2 队时左右分兵，N 队时均分场地
    var band = span / zones;                        // 每个阵营的横向落座带宽
    var out = [];
    for (var t = 0; t < zones; t++) {
      var center = (t + 0.5) * (C.PLANE_LENGTH / zones);
      for (var k = 0; k < teams[t]; k++) {
        var pos = null;
        for (var attempt = 0; attempt < 3000; attempt++) {
          var x = center + (GW.randInt(band) - band / 2);
          var y = GW.randInt(C.PLANE_HEIGHT - 2 * C.SOLDIER_RADIUS) + C.SOLDIER_RADIUS;
          if (!tooClose(x, y)) { pos = [x, y]; break; }
        }
        if (!pos) pos = [center + (k - (teams[t] - 1) / 2) * 14, GW.randInt(C.PLANE_HEIGHT)];
        placed.push(pos);
        out.push({ team: t + 1, x: pos[0], y: pos[1] });
      }
    }
    return out;
  };

  /** 生成一局可开打的战场：山体 + 各席位落座点。
   *  服务器（server.js）与点对点房主（浏览器）共用同一份实现，
   *  保证两种联机方式下的地图规则完全一致。
   *  perSeat：每名玩家带几名士兵；playerCount 影响队伍数（2 队 / 人人一队）。 */
  /** 按「队伍总数 × 每队人数」生成战场；只给 playerCount 时按人数反推等价赛制。
   *  @param soldiers 每人士兵数（多人模式下固定每人 1 名）
   *  @param teams 队伍总数，给了就以它为准（否则由 playerCount 反推） */
  GW.generateBattle = function (soldiers, playerCount, teams, perTeam) {
    var roster = (teams != null)
      ? GW.seatsFromRoster(teams, (perTeam != null ? perTeam : (playerCount != null ? Math.round(playerCount / teams) : 1)))
      : GW.rosterFromSeats(playerCount);
    var teamCount = roster.teams;
    var quota = GW.teamQuota(roster.teams, roster.perTeam, soldiers);
    var teams = quota;
    var placed = null, circles = null, terrain = null;
    for (var attempt = 0; attempt < 24 && !placed; attempt++) {
      circles = GW.generateCircles();
      var positions = GW.placeSoldiers(circles, teams);
      terrain = new GW.Terrain(circles);
      var ok = true;
      for (var i = 0; i < positions.length; i++) {
        if (terrain.soldierCollides(positions[i].x, positions[i].y, C.SOLDIER_RADIUS)) { ok = false; break; }
      }
      if (ok) placed = positions;
    }
    if (!placed) placed = GW.placeSoldiers(circles || GW.generateCircles(), teams);
    return { circles: circles, positions: placed };
  };

})(typeof window !== 'undefined' ? window : globalThis);
