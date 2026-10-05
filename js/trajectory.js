/* ============================================================
 * 弹道引擎
 * 三种模式的数值算法严格对照原版 Function.java：
 *   NORMAL_FUNC : processFunctionRange —— y = f(x)，加常数平移到士兵脚下
 *   FST_ODE     : processRK4Range      —— 四阶龙格-库塔解 y' = f(x, y)
 *   SND_ODE     : processRK42Range     —— 四阶龙格-库塔解 y'' = f(x, y, y')，需发射角
 * 逐点检测：己方/友军士兵误伤、地形碰撞、数值发散（NaN/Infinity）。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});
  var C = GW.C;

  var MAX_SUBDIVIDE = 200;   // 步长细分的防御上限（原版理论可退出，此处防止病态函数卡死）

  function distSquared(xs, ys, i) {
    var dx = xs[i] - xs[i - 1], dy = ys[i] - ys[i - 1];
    return dx * dx + dy * dy;
  }

  function alreadyHit(hits, p, s) {
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].playerIndex === p && hits[i].soldierIndex === s) return true;
    }
    return false;
  }

  function makeHitDetector(players, currentTurn) {
    /* 导出：手绘弹道需要在 game 层做同样的命中判定 */
    var R2 = C.SOLDIER_RADIUS * C.SOLDIER_RADIUS;
    /**
     * @param xP,yP 该点的 Canvas 像素坐标（已按阵营做镜像还原）
     * @param hits 累计命中列表
     * @param step 当前步号
     */
    return function detect(xP, yP, hits, step) {
      for (var j = 0; j < players.length; j++) {
        var p = players[j];
        for (var k = 0; k < p.numSoldiers; k++) {
          // 正在开炮的这名士兵不会被自己的第一发判定到
          if (j === currentTurn && k === p.currentSoldierIndex) continue;
          var s = p.getSoldiers()[k];
          if (!s.isAlive()) continue;
          var dx = s.x - xP, dy = s.y - yP;
          if (dx * dx + dy * dy < R2) {
            if (!alreadyHit(hits, j, k)) hits.push({ playerIndex: j, soldierIndex: k, step: step });
          }
        }
      }
    };
  }

  GW.makeHitDetector = makeHitDetector;

  /**
   * 计算一条弹道。
   * @param opts.f           已编译的表达式 f(x, y, y')
   * @param opts.mode        游戏模式
   * @param opts.shooter     开炮士兵（含 x, y, angle）
   * @param opts.players     全部玩家
   * @param opts.currentTurn 当前行动的玩家下标
   * @param opts.inverted    true 表示该阵营在右半场，坐标系需镜像
   * @param opts.terrain     地形（可为 null）
   * @param opts.maxSteps    最大步数
   */
  GW.computeTrajectory = function (opts) {
    var f = opts.f;
    var mode = opts.mode;
    var invert = !!opts.inverted;
    var maxSteps = opts.maxSteps || C.FUNC_MAX_STEPS;
    var players = opts.players;
    var currentTurn = opts.currentTurn;
    var terrain = opts.terrain;
    var detect = makeHitDetector(players, currentTurn);

    var xs = new Float64Array(maxSteps);
    var ys = new Float64Array(maxSteps);
    var hits = [];
    var numSteps = maxSteps;
    var fireAngle = 0;
    var i, guard;

    /* 起点：士兵位置 →（镜像）→ 游戏坐标 */
    var startX = opts.shooter.x;
    var startY = opts.shooter.y;
    if (invert) startX = C.PLANE_LENGTH - startX;

    var x0 = GW.toGameX(startX);
    var y0 = GW.toGameY(startY);

    /* 士兵半径换算到游戏坐标（光线 advances 一步才开始离开士兵） */
    var gcRadius = (C.PLANE_GAME_LENGTH * C.SOLDIER_RADIUS) / C.PLANE_LENGTH;

    if (mode === C.NORMAL_FUNC) {
      /* ---------- 普通函数：反解出发射角（让炮弹出膛方向贴合曲线切线） ---------- */
      fireAngle = startAngleOfSlope(f, x0, gcRadius);
      if (isFinite(fireAngle)) {
        x0 += gcRadius * Math.cos(fireAngle);
        y0 += gcRadius * Math.sin(fireAngle);
      }
      /* 平移常数：使曲线恰好经过士兵脚下的出膛点 */
      var offSet = -f(x0, 0, 0) + y0;
      xs[0] = x0; ys[0] = y0;

      for (i = 1; i < maxSteps; i++) {
        var ts = C.STEP_SIZE;
        xs[i] = xs[i - 1] + ts;
        ys[i] = f(xs[i], 0, 0) + offSet;

        var endFunc = false;
        guard = 0;
        while (distSquared(xs, ys, i) > C.FUNC_MAX_STEP_DISTANCE_SQUARED) {
          if (xs[i] - xs[i - 1] > C.FUNC_MIN_X_STEP_DISTANCE && guard++ < MAX_SUBDIVIDE) {
            ts = ts / 2;
            xs[i] = xs[i - 1] + ts;
            ys[i] = f(xs[i], 0, 0) + offSet;
          } else {
            endFunc = true;
            break;
          }
        }
        if (endFunc) { numSteps = i; break; }

        var px = GW.toPlaneX(xs[i]);
        var py = GW.toPlaneY(ys[i]);
        if (invert) px = C.PLANE_LENGTH - px;
        detect(px, py, hits, i);
        if (terrain && terrain.collidePoint(px, py)) { numSteps = i; break; }
        if (!isFinite(py) || !isFinite(px)) { numSteps = i; break; }
      }

    } else if (mode === C.FST_ODE) {
      /* ---------- 一阶微分方程：士兵位置即初值，RK4 求解，不做平移 ---------- */
      fireAngle = startAngleRK4(f, x0, y0, gcRadius);
      x0 += gcRadius * Math.cos(fireAngle);
      y0 += gcRadius * Math.sin(fireAngle);
      xs[0] = x0; ys[0] = y0;

      for (i = 1; i < maxSteps; i++) {
        var ts2 = C.STEP_SIZE;
        advanceRK1(f, xs, ys, i, ts2);
        var endFunc2 = false;
        guard = 0;
        while (distSquared(xs, ys, i) > C.FUNC_MAX_STEP_DISTANCE_SQUARED) {
          if (xs[i] - xs[i - 1] > C.FUNC_MIN_X_STEP_DISTANCE && guard++ < MAX_SUBDIVIDE) {
            ts2 = ts2 / 2;
            advanceRK1(f, xs, ys, i, ts2);
          } else {
            endFunc2 = true;
            break;
          }
        }
        if (endFunc2) { numSteps = i; break; }

        var px2 = GW.toPlaneX(xs[i]);
        var py2 = GW.toPlaneY(ys[i]);
        if (invert) px2 = C.PLANE_LENGTH - px2;
        detect(px2, py2, hits, i);
        if (terrain && terrain.collidePoint(px2, py2)) { numSteps = i; break; }
        if (!isFinite(py2) || !isFinite(px2)) { numSteps = i; break; }
      }

    } else {
      /* ---------- 二阶微分方程：初值 = 士兵位置 + 发射角 ---------- */
      var dys = new Float64Array(maxSteps);
      var angle = opts.angle || 0;
      var sx = startX + C.SOLDIER_RADIUS * Math.cos(angle);
      var sy = startY - C.SOLDIER_RADIUS * Math.sin(angle);   // 像素 y 轴向下，故取负
      xs[0] = GW.toGameX(sx);
      ys[0] = GW.toGameY(sy);
      dys[0] = Math.tan(angle);
      fireAngle = angle;

      for (i = 1; i < maxSteps; i++) {
        var ts3 = C.STEP_SIZE;
        advanceRK2(f, xs, ys, dys, i, ts3);
        var endFunc3 = false;
        guard = 0;
        while (distSquared(xs, ys, i) > C.FUNC_MAX_STEP_DISTANCE_SQUARED &&
          xs[i] - xs[i - 1] > C.FUNC_MIN_X_STEP_DISTANCE) {
          if (guard++ >= MAX_SUBDIVIDE) { endFunc3 = true; break; }
          ts3 = ts3 / 2;
          advanceRK2(f, xs, ys, dys, i, ts3);
        }
        if (endFunc3) { numSteps = i; break; }

        var px3 = GW.toPlaneX(xs[i]);
        var py3 = GW.toPlaneY(ys[i]);
        if (invert) px3 = C.PLANE_LENGTH - px3;
        detect(px3, py3, hits, i);
        if (terrain && terrain.collidePoint(px3, py3)) { numSteps = i; break; }
        if (!isFinite(py3) || !isFinite(px3)) { numSteps = i; break; }
      }
    }

    if (numSteps < 1) numSteps = 1;
    if (numSteps > maxSteps) numSteps = maxSteps;

    var lastGX = xs[numSteps - 1];
    var lastGY = ys[numSteps - 1];
    var lastX = GW.toPlaneX(lastGX);
    var lastY = GW.toPlaneY(lastGY);

    return {
      xs: xs, ys: ys, numSteps: numSteps, hits: hits,
      fireAngle: fireAngle, lastX: lastX, lastY: lastY, inverted: invert
    };
  };

  /* ---------- RK4：一阶 y' = f(x, y) ---------- */
  function advanceRK1(f, xs, ys, i, h) {
    var x = xs[i - 1], y = ys[i - 1];
    var k1 = f(x, y, 0);
    var k2 = f(x + 0.5 * h, y + 0.5 * h * k1, 0);
    var k3 = f(x + 0.5 * h, y + 0.5 * h * k2, 0);
    var k4 = f(x + h, y + h * k3, 0);
    xs[i] = x + h;
    ys[i] = y + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
  }

  /* ---------- RK4：二阶系统 { y'=dy, dy'=f(x, y, y') } ---------- */
  function advanceRK2(f, xs, ys, dys, i, h) {
    var x = xs[i - 1], y = ys[i - 1], d = dys[i - 1];
    var k11 = d;
    var k12 = f(x, y, d);
    var k21 = d + (h / 2) * k12;
    var k22 = f(x + h / 2, y + (h / 2) * k11, k21);
    var k31 = d + (h / 2) * k22;
    var k32 = f(x + h / 2, y + (h / 2) * k21, k31);
    var k41 = d + h * k32;
    var k42 = f(x + h, y + h * k31, k41);
    xs[i] = x + h;
    ys[i] = y + (h / 6) * (k11 + 2 * k21 + 2 * k31 + k41);
    dys[i] = d + (h / 6) * (k12 + 2 * k22 + 2 * k32 + k42);
  }

  /* ---------- 出膛角迭代（普通函数）：与 getStartAngle 一致 ---------- */
  function startAngleOfSlope(f, x, radius) {
    var h = C.STEP_SIZE;
    var slope = (f(x + h, 0, 0) - f(x, 0, 0)) / h;
    var angle = Math.atan(slope);
    var error = 10000;
    for (var i = 0; error > C.ANGLE_ERROR && i < C.MAX_ANGLE_LOOPS; i++) {
      var fx = x + radius * Math.cos(angle);
      slope = (f(fx + h, 0, 0) - f(fx, 0, 0)) / h;
      var newAngle = Math.atan(slope);
      error = Math.abs(newAngle - angle);
      angle = newAngle;
    }
    return angle;
  }

  /* ---------- 出膛角迭代（一阶方程）：与 getRK4StartAngle 一致 ---------- */
  function startAngleRK4(f, x, y, radius) {
    var angle = 0;
    var error = 10000;
    var h = C.STEP_SIZE;
    for (var i = 0; error > C.ANGLE_ERROR && i < C.MAX_ANGLE_LOOPS; i++) {
      var fx = x + radius * Math.cos(angle);
      var fy = y + radius * Math.sin(angle);
      var k1 = f(fx, fy, 0);
      var k2 = f(fx + 0.5 * h, fy + 0.5 * h * k1, 0);
      var k3 = f(fx + 0.5 * h, fy + 0.5 * h * k2, 0);
      var k4 = f(fx + h, fy + h * k3, 0);
      var nextY = fy + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      var nextX = fx + h;
      var newAngle = Math.atan((nextY - fy) / (nextX - fx));
      error = Math.abs(newAngle - angle);
      angle = newAngle;
    }
    return angle;
  }

})(typeof window !== 'undefined' ? window : globalThis);
