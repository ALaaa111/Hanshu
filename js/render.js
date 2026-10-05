/* ============================================================
 * Canvas 渲染层
 * 逻辑坐标系固定为 770×450（与原版一致），再按容器宽度做 DPR 缩放。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});
  var C = GW.C;

  var SKY_TOP = '#f7fdf8';
  var SKY_BOTTOM = '#e3f4e7';
  var GRID_SOFT = 'rgba(45, 122, 69, 0.10)';
  var GRID_MAIN = 'rgba(45, 122, 69, 0.22)';
  var AXIS = 'rgba(27, 94, 55, 0.55)';

  GW.Renderer = function Renderer(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.mouse = null;
    this.preview = null;      // 输入预览弹道
    this.explosions = [];
    this.puffs = [];
    this.sprite = null;       // 士兵贴图（assets/soldier_sprite.png），加载完成后替代矢量小人
    this._loadSprite();
    this.resize();
  };

  /** 加载士兵立绘（已抠掉背景）；加载失败则退回矢量绘制 */
  GW.Renderer.prototype._loadSprite = function () {
    if (typeof Image === 'undefined') return;
    var img = new Image();
    var self = this;
    img.onload = function () { self.sprite = img; };
    try { img.src = 'assets/soldier_sprite.png'; } catch (e) { /* 忽略 */ }
  };

  /**
   * 按容器可用空间精确缩放：逻辑坐标恒为 770×450，
   * 实际 CSS 尺寸取「容器宽」与「容器高 × 宽高比」的较小值，
   * 因此任何分辨率（含手机竖屏）都能完整看到整张战场，不需要滚动。
   */
  GW.Renderer.prototype.resize = function () {
    var canvas = this.canvas;
    var ratio = C.PLANE_LENGTH / C.PLANE_HEIGHT;
    var host = canvas.parentNode;
    var availW = (host && host.clientWidth) || canvas.clientWidth || C.PLANE_LENGTH;
    var availH = (host && host.clientHeight) || canvas.clientHeight || C.PLANE_HEIGHT;
    var cssW = Math.max(120, Math.floor(Math.min(availW, availH * ratio)));
    var cssH = Math.max(70, Math.round(cssW / ratio));
    if (cssH > availH) { cssH = Math.max(70, Math.floor(availH)); cssW = Math.round(cssH * ratio); }

    if (canvas.style.width !== cssW + 'px') canvas.style.width = cssW + 'px';
    if (canvas.style.height !== cssH + 'px') canvas.style.height = cssH + 'px';

    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    var w = Math.max(1, Math.round(cssW * dpr));
    var h = Math.round((w * C.PLANE_HEIGHT) / C.PLANE_LENGTH);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    this.scale = w / C.PLANE_LENGTH;
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    return { w: cssW, h: cssH };
  };

  GW.Renderer.prototype.setPreview = function (traj) { this.preview = traj; };
  GW.Renderer.prototype.setMouse = function (pt) { this.mouse = pt; };

  GW.Renderer.prototype.addExplosion = function (x, y, at) {
    this.explosions.push({ x: x, y: y, at: at });
  };

  GW.Renderer.prototype.draw = function (now) {
    now = now || GW.now();
    var ctx = this.ctx;
    var g = this.game;
    this.resize();

    /* 背景 */
    var grd = ctx.createLinearGradient(0, 0, 0, C.PLANE_HEIGHT);
    grd.addColorStop(0, SKY_TOP);
    grd.addColorStop(1, SKY_BOTTOM);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, C.PLANE_LENGTH, C.PLANE_HEIGHT);

    this._drawGrid(ctx);

    if (g.terrain) g.terrain.render(ctx);
    this._drawPacks(ctx, now);
    this._drawDeadMarks(ctx, now);
    this._drawSoldiers(ctx, now);
    this._drawAimLine(ctx, now);
    this._drawPreview(ctx);
    this._drawShot(ctx, now);
    this._drawExplosions(ctx, now);
    this._drawMouseHint(ctx);
  };

  /* ---------------- 网格（坐标轴与刻度已按要求隐藏） ---------------- */
  GW.Renderer.prototype._drawGrid = function (ctx) {
    var pxPerUnit = C.PLANE_LENGTH / C.PLANE_GAME_LENGTH;   // 15.4
    var cx = C.PLANE_LENGTH / 2, cy = C.PLANE_HEIGHT / 2;

    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID_SOFT;
    ctx.beginPath();
    for (var i = -25; i <= 25; i++) {
      var x = cx + i * pxPerUnit;
      if (i % 5 === 0) continue;
      ctx.moveTo(x, 0); ctx.lineTo(x, C.PLANE_HEIGHT);
    }
    for (var j = -15; j <= 15; j++) {
      var y = cy + j * pxPerUnit;
      if (y < 0 || y > C.PLANE_HEIGHT) continue;
      if (j % 5 === 0) continue;
      ctx.moveTo(0, y); ctx.lineTo(C.PLANE_LENGTH, y);
    }
    ctx.stroke();

    ctx.strokeStyle = GRID_MAIN;
    ctx.beginPath();
    for (var i2 = -25; i2 <= 25; i2 += 5) {
      var xa = cx + i2 * pxPerUnit;
      ctx.moveTo(xa, 0); ctx.lineTo(xa, C.PLANE_HEIGHT);
    }
    for (var j2 = -15; j2 <= 15; j2 += 5) {
      var ya = cy + j2 * pxPerUnit;
      if (ya < 0 || ya > C.PLANE_HEIGHT) continue;
      ctx.moveTo(0, ya); ctx.lineTo(C.PLANE_LENGTH, ya);
    }
    ctx.stroke();
    /* x 轴 / y 轴与数字刻度已隐藏：战场更干净，函数意象交给虚线网格承载 */
  };

  /* ---------------- 奖励包 ---------------- */
  GW.Renderer.prototype._drawPacks = function (ctx, now) {
    var g = this.game;
    if (!g.packs || !g.packs.length) return;
    for (var i = 0; i < g.packs.length; i++) {
      var p = g.packs[i];
      var def = GW.packById(p.kind) || C.PACKS[0];
      var bob = Math.sin(now / 400 + p.id) * 2.5;
      var x = p.x, y = p.y + bob;
      var pulse = 0.5 + 0.5 * Math.sin(now / 300 + p.id * 2);
      /* 光环 */
      ctx.strokeStyle = 'rgba(214, 158, 46, ' + (0.35 + 0.4 * pulse).toFixed(2) + ')';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y - 4, 10 + 2 * pulse, 0, Math.PI * 2);
      ctx.stroke();
      /* 礼盒 */
      ctx.fillStyle = '#f7b32b';
      ctx.fillRect(x - 7, y - 9, 14, 12);
      ctx.fillStyle = '#d98324';
      ctx.fillRect(x - 7, y - 4.5, 14, 2.6);
      ctx.fillStyle = '#fff5dd';
      ctx.fillRect(x - 1.4, y - 9, 2.8, 12);
      /* 字标 */
      ctx.fillStyle = '#7a4a06';
      ctx.font = 'bold 8px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.label, x, y - 9 - 8);
    }
  };

  /* ---------------- 士兵 ---------------- */
  GW.Renderer.prototype._drawSoldiers = function (ctx, now) {
    var g = this.game;
    for (var i = 0; i < g.players.length; i++) {
      var p = g.players[i];
      var color = (C.PLAYER_COLORS && C.PLAYER_COLORS[i]) || C.TEAM_COLOR[p.team];
      for (var k = 0; k < p.numSoldiers; k++) {
        var s = p.getSoldiers()[k];
        if (!s.alive) continue;
        var active = (i === g.currentTurn && k === p.currentSoldierIndex && g.state === 'aim');
        /* 位移动画：从起点滑到终点 */
        var dx = s.x, dy = s.y;
        if (g.moveAnim && g.moveAnim.playerIndex === i && g.moveAnim.soldierIndex === k) {
          var t = Math.min(1, (now - g.moveAnim.start) / C.MOVE_ANIM_TIME);
          var e = 1 - Math.pow(1 - t, 3);   // easeOutCubic
          dx = g.moveAnim.fx + (g.moveAnim.tx - g.moveAnim.fx) * e;
          dy = g.moveAnim.fy + (g.moveAnim.ty - g.moveAnim.fy) * e;
          if (t >= 1 && g.state === 'moving') g.moveAnim = null;
        }
        this._soldier(ctx, dx, dy, color, active, now, k, i, s, p);
      }
    }
  };

  GW.Renderer.prototype._soldier = function (ctx, x, y, color, active, now, index, playerIndex, s, p) {
    var r = C.SOLDIER_RADIUS;
    if (active) {
      var pulse = 0.5 + 0.5 * Math.sin(now / 260);
      ctx.strokeStyle = 'rgba(27, 94, 55, ' + (0.35 + 0.45 * pulse) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 6 + 2 * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
    /* 影子 */
    ctx.fillStyle = 'rgba(20, 70, 45, 0.14)';
    ctx.beginPath();
    ctx.ellipse(x, y + r + 3, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    /* 炮管：朝敌方方向（贴图模式下也保留，指示开火方向） */
    var dir = playerIndex % 2 === 0 ? 1 : -1;
    var facing = this.game.mode === C.SND_ODE ? (s ? s.angle : 0) : 0;
    ctx.strokeStyle = 'rgba(20, 70, 45, 0.85)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(x + dir * 3, y - 3);
    ctx.lineTo(x + dir * 3 + dir * 7 * Math.cos(facing), y - 3 - 7 * Math.sin(facing));
    ctx.stroke();

    if (this.sprite && this.sprite.complete && this.sprite.naturalWidth > 0) {
      /* 立绘贴图（已抠背景）：高约 3.4 倍士兵半径 */
      var h = r * 3.6, w = h * (this.sprite.naturalWidth / this.sprite.naturalHeight);
      ctx.drawImage(this.sprite, x - w / 2, y + r - h, w, h);
      /* 阵营色环脚标 */
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(x, y + r + 2, r * 1.15, r * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      /* 兜底：矢量小人 */
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 3.5, y + r * 0.9);
      ctx.lineTo(x - 3.5, y - 1);
      ctx.quadraticCurveTo(x - 3.5, y - 5, x, y - 5);
      ctx.quadraticCurveTo(x + 3.5, y - 5, x + 3.5, y - 1);
      ctx.lineTo(x + 3.5, y + r * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(x, y - 8, r * 0.72, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    /* 血条 */
    if (s && s.maxHp) {
      var bw = 18, ratio = Math.max(0, Math.min(1, s.hp / s.maxHp));
      var bx = x - bw / 2, by = y - r - 12;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(bx - 1, by - 1, bw + 2, 5);
      ctx.fillStyle = ratio > 0.5 ? '#2f9e5c' : (ratio > 0.25 ? '#d98324' : '#c0392b');
      ctx.fillRect(bx, by, bw * ratio, 3);
    }

    /* 编号 */
    ctx.fillStyle = 'rgba(27, 94, 55, 0.9)';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(index + 1), x, y - r - 14);
  };

  GW.Renderer.prototype._drawDeadMarks = function (ctx, now) {
    var g = this.game;
    for (var i = 0; i < g.players.length; i++) {
      var p = g.players[i];
      for (var k = 0; k < p.numSoldiers; k++) {
        var s = p.getSoldiers()[k];
        if (s.alive || s.killStep < 0) continue;
        var t = Math.min(1, (now - s.deathAt) / 1200);
        if (t >= 1) {
          /* 阵亡标记（小十字） */
          ctx.strokeStyle = 'rgba(120, 140, 128, 0.75)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(s.x - 4, s.y - 4); ctx.lineTo(s.x + 4, s.y + 4);
          ctx.moveTo(s.x + 4, s.y - 4); ctx.lineTo(s.x - 4, s.y + 4);
          ctx.stroke();
        } else {
          /* 阵亡爆炸动画 */
          var rr = 6 + 22 * t;
          var alpha = 1 - t;
          ctx.strokeStyle = 'rgba(192, 57, 43, ' + alpha.toFixed(2) + ')';
          ctx.fillStyle = 'rgba(250, 190, 90, ' + (alpha * 0.6).toFixed(2) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  };

  /* ---------------- 弹道 ---------------- */
  /** 画一段弹道。
   *  maxLen（可选）：沿曲线累计的像素长度上限——超出即截断，
   *  用于把「函数图像预览」限制在出膛后的一小段，避免整条曲线铺满战场。 */
  GW.Renderer.prototype._pathOf = function (ctx, traj, from, to, maxLen) {
    var inverted = traj.inverted;
    if (to <= from) return;
    var stride = Math.max(1, Math.floor((to - from) / 1400));
    ctx.beginPath();
    var prevX = 0, prevY = 0, acc = 0, started = false, cut = false;
    for (var i = from; i < to; i += stride) {
      var px = GW.toPlaneX(traj.xs[i]);
      if (inverted) px = C.PLANE_LENGTH - px;
      var py = GW.toPlaneY(traj.ys[i]);
      if (!started) { ctx.moveTo(px, py); started = true; }
      else {
        if (maxLen) {
          acc += Math.sqrt((px - prevX) * (px - prevX) + (py - prevY) * (py - prevY));
          if (acc > maxLen) { ctx.lineTo(px, py); cut = true; break; }
        }
        ctx.lineTo(px, py);
      }
      prevX = px; prevY = py;
    }
    if (cut) return;
    var last = to - 1;
    var lx = GW.toPlaneX(traj.xs[last]);
    if (inverted) lx = C.PLANE_LENGTH - lx;
    ctx.lineTo(lx, GW.toPlaneY(traj.ys[last]));
  };

  GW.Renderer.prototype._drawShot = function (ctx, now) {
    var g = this.game;
    /* 上一发的淡出残影 */
    if (g.lastShot) {
      var age = now - (g.lastShot.explodeAt || 0);
      if (age < C.FUNC_FADE_TIME + C.NEXT_TURN_DELAY) {
        var tr0 = g.lastShot.traj;
        var a = Math.max(0, 1 - age / (C.FUNC_FADE_TIME + C.NEXT_TURN_DELAY));
        ctx.save();
        ctx.globalAlpha = a * 0.5;
        ctx.strokeStyle = C.TEAM_COLOR[g.players[g.lastShot.playerIndex].team];
        ctx.lineWidth = 1.6;
        this._pathOf(ctx, tr0, 0, tr0.numSteps);
        ctx.stroke();
        ctx.restore();
      } else {
        g.lastShot = null;
      }
    }

    if (!g.shot) return;
    var shot = g.shot;
    var steps = Math.min(shot.traj.numSteps, Math.ceil(g.drawProgress(now)));
    var color = C.TEAM_COLOR[g.players[shot.playerIndex].team];
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(20, 70, 45, 0.35)';
    ctx.shadowBlur = 4;
    this._pathOf(ctx, shot.traj, 0, steps);
    ctx.stroke();
    ctx.restore();

    /* 炮弹头部 */
    var idx = Math.max(0, steps - 1);
    var hx = GW.toPlaneX(shot.traj.xs[idx]);
    if (shot.traj.inverted) hx = C.PLANE_LENGTH - hx;
    var hy = GW.toPlaneY(shot.traj.ys[idx]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(hx, hy, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
  };

  /* ---------------- 预瞄准线 ----------------
   * 从当前士兵脚下射出的一条带箭头的射线：
   * 有预览弹道时 = 该函数的出膛切线方向（改函数即改方向）；
   * 无输入时 = 默认水平朝向敌方（二阶模式取当前炮口角）。 */
  GW.Renderer.prototype._drawAimLine = function (ctx, now) {
    var g = this.game;
    if (!g) return;
    if (g.state !== 'aim') return;
    var idx = g.currentTurn;
    var p = g.players[idx];
    if (!p || p.isAI) return;
    var s = p.getCurrentTurnSoldier();
    if (!s || !s.isAlive()) return;

    var dx, dy;
    var traj = this.preview;
    if (traj && traj.numSteps >= 2) {
      var ax = GW.toPlaneX(traj.xs[0]);
      var ay = GW.toPlaneY(traj.ys[0]);
      var bx = GW.toPlaneX(traj.xs[1]);
      var by = GW.toPlaneY(traj.ys[1]);
      if (traj.inverted) {
        ax = C.PLANE_LENGTH - ax;
        bx = C.PLANE_LENGTH - bx;
      }
      dx = bx - ax; dy = by - ay;
    } else {
      var dir = p.team === C.TEAM1 ? 1 : -1;
      var ang = (g.mode === C.SND_ODE) ? (s.angle || 0) : 0;
      dx = dir * Math.cos(ang);
      dy = -Math.sin(ang);
    }
    var len = Math.sqrt(dx * dx + dy * dy);
    if (!isFinite(len) || len < 1e-9) { dx = (p.team === C.TEAM1 ? 1 : -1); dy = 0; len = 1; }
    dx /= len; dy /= len;

    var L = (C.AIM_LINE_LENGTH || 92) + (p.aimBonus || 0);   // 奖励包 / 技能可加长辅助瞄准线
    var pulse = 0.55 + 0.45 * Math.sin(now / 320);
    ctx.save();
    ctx.strokeStyle = 'rgba(27, 94, 55, ' + (0.35 + 0.35 * pulse).toFixed(2) + ')';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(s.x + dx * C.SOLDIER_RADIUS, s.y + dy * C.SOLDIER_RADIUS);
    ctx.lineTo(s.x + dx * L, s.y + dy * L);
    ctx.stroke();
    ctx.setLineDash([]);

    /* 箭头 */
    var hx = s.x + dx * L, hy = s.y + dy * L;
    var wing = 7;
    ctx.fillStyle = 'rgba(27, 94, 55, 0.85)';
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - dx * wing - dy * wing * 0.6, hy - dy * wing + dx * wing * 0.6);
    ctx.lineTo(hx - dx * wing + dy * wing * 0.6, hy - dy * wing - dx * wing * 0.6);
    ctx.closePath();
    ctx.fill();

    /* 角度读数 */
    var deg = Math.round(Math.atan2(-dy, dx) * 180 / Math.PI);
    ctx.font = 'bold 10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var label = (traj ? '出膛 ' : '瞄准 ') + (deg >= 0 ? '+' : '') + deg + '°';
    var tw = ctx.measureText(label).width + 10;
    var bx = Math.min(C.PLANE_LENGTH - tw - 2, Math.max(2, s.x + dx * (L + 6) - (dx < 0 ? tw : 0)));
    var by = Math.min(C.PLANE_HEIGHT - 14, Math.max(10, s.y + dy * (L + 6)));
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillRect(bx, by - 8, tw, 16);
    ctx.strokeStyle = 'rgba(27, 94, 55, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by - 8, tw, 16);
    ctx.fillStyle = 'rgba(20, 70, 45, 0.9)';
    ctx.fillText(label, bx + 5, by);
    ctx.restore();
  };

  GW.Renderer.prototype._drawPreview = function (ctx) {
    var traj = this.preview;
    if (!traj || this.game.state !== 'aim') return;
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(27, 94, 55, 0.55)';
    ctx.lineWidth = 1.8;
    /* 只画出膛后的一小段：既是方向参考，也不会整条铺满战场 */
    this._pathOf(ctx, traj, 0, traj.numSteps, C.PREVIEW_MAX_LENGTH || 0);
    ctx.stroke();
    ctx.restore();
  };

  GW.Renderer.prototype._drawExplosions = function (ctx, now) {
    for (var i = this.explosions.length - 1; i >= 0; i--) {
      var e = this.explosions[i];
      var t = (now - e.at) / 700;
      if (t >= 1) { this.explosions.splice(i, 1); continue; }
      var r = 4 + C.EXPLOSION_RADIUS * 1.6 * t;
      ctx.save();
      ctx.fillStyle = 'rgba(250, 180, 80, ' + (0.55 * (1 - t)).toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(192, 57, 43, ' + (0.8 * (1 - t)).toFixed(2) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r * 0.65, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  };

  GW.Renderer.prototype._drawMouseHint = function (ctx) {
    var m = this.mouse;
    if (!m) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(27, 94, 55, 0.45)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(m.x, 0); ctx.lineTo(m.x, C.PLANE_HEIGHT);
    ctx.moveTo(0, m.y); ctx.lineTo(C.PLANE_LENGTH, m.y);
    ctx.stroke();
    ctx.restore();

    var gx = GW.toGameX(m.x), gy = GW.toGameY(m.y);
    var text = 'x=' + gx.toFixed(1) + '  y=' + gy.toFixed(1);
    ctx.font = '11px ui-monospace, Consolas, monospace';
    var w = ctx.measureText(text).width + 10;
    var bx = Math.min(C.PLANE_LENGTH - w - 2, Math.max(2, m.x + 8));
    var by = Math.min(C.PLANE_HEIGHT - 20, Math.max(2, m.y + 8));
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeStyle = 'rgba(27, 94, 55, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(bx, by, w, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(20, 70, 45, 0.9)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 5, by + 8);
  };

})(typeof window !== 'undefined' ? window : globalThis);
