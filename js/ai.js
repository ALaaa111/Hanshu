/* ============================================================
 * 电脑 AI：遗传算法搜索「能打到敌人、又不炸到自己」的曲面
 * 适应度算法对照原版 ComputerPlayer.evaluateFunction：
 *   命中敌方 +2000000 / 误伤己方 -2000000 / 其余用「最近距离」逼近目标
 * 这里用增量式执行（每帧只算几毫秒），避免卡住界面。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});
  var C = GW.C;

  GW.AI = function AI(game, level) {
    this.game = game;
    this.cfg = C.AI[level] || C.AI[2];
    this.playerIndex = game.currentTurn;
    this.player = game.players[this.playerIndex];
    this.mode = game.mode;
    this.generation = 0;
    this.evalIndex = 0;
    this.phase = 'evaluating';
    this.startedAt = GW.now();
    this.population = [];
    this.best_ = null;

    for (var i = 0; i < this.cfg.population; i++) this.population.push(this.randomCandidate());
    this.best_ = this.population[0];
  };

  GW.AI.prototype.randomCandidate = function () {
    return {
      tree: GW.randomTree(this.mode, 3),
      angle: this.mode === C.SND_ODE ? (Math.random() - 0.5) * Math.PI * 0.9 : 0,
      fitness: -Infinity,
      evaluated: false
    };
  };

  /* ---------- 适应度：原版 evaluateFunction 的移植 ---------- */
  GW.AI.prototype.evaluate = function (cand) {
    cand.evaluated = true;
    var f;
    try {
      f = GW.compileTree(cand.tree);
    } catch (e) {
      cand.fitness = -1e18;
      return;
    }
    var game = this.game;
    var soldier = this.player.getCurrentTurnSoldier();
    var traj;
    try {
      traj = GW.computeTrajectory({
        f: f,
        mode: this.mode,
        shooter: soldier,
        angle: cand.angle,
        players: game.players,
        currentTurn: this.playerIndex,
        inverted: this.player.team === C.TEAM2,
        terrain: game.terrain,
        maxSteps: C.AI_MAX_STEPS
      });
    } catch (e) {
      cand.fitness = -1e18;
      return;
    }
    if (!traj || traj.numSteps <= 1) { cand.fitness = -1e18; return; }

    var L = C.PLANE_LENGTH, H = C.PLANE_HEIGHT, G = C.PLANE_GAME_LENGTH;
    var total = 0;
    var minDistSquared = 1000000;
    var aiTeam = this.player.team;

    for (var i = 0; i < game.players.length; i++) {
      var p = game.players[i];
      for (var j = 0; j < p.numSoldiers; j++) {
        var s = p.getSoldiers()[j];
        if (!s.isAlive()) continue;
        if (i === this.playerIndex && j === p.currentSoldierIndex) continue;

        /* 是否被这条弹道击中 */
        var hit = false;
        for (var k = 0; k < traj.hits.length; k++) {
          if (traj.hits[k].playerIndex === i && traj.hits[k].soldierIndex === j) { hit = true; break; }
        }
        if (hit) {
          total += (p.team !== aiTeam) ? 2000000 : -2000000;
          continue;
        }
        if (p.team === aiTeam) continue;

        /* 未被命中：统计弹道与该敌人的最近距离，用于逐步逼近 */
        var soldierMin = Number.MAX_VALUE;
        for (var step = 0; step < traj.numSteps; step++) {
          var distY = (-L * traj.ys[step] / G + H / 2) - s.y;
          var distX;
          if (aiTeam === C.TEAM2) {
            distX = L - (L * traj.xs[step] / G + L / 2) - s.x;
            if (distX < 0) continue;
          } else {
            distX = (L * traj.xs[step] / G + L / 2) - s.x;
            if (distX > 0) continue;
          }
          var d = distX * distX + distY * distY;
          if (d < soldierMin) soldierMin = d;
        }
        if (soldierMin < minDistSquared) minDistSquared = soldierMin;
      }
    }
    if (minDistSquared === Number.MAX_VALUE) minDistSquared = 1000000;
    total += 1000000 - minDistSquared;
    cand.fitness = total;
  };

  GW.AI.prototype.updateBest = function () {
    for (var i = 0; i < this.population.length; i++) {
      if (!this.best_ || this.population[i].fitness > this.best_.fitness) this.best_ = this.population[i];
    }
  };

  GW.AI.prototype.tournament = function () {
    var best = null;
    for (var i = 0; i < 3; i++) {
      var c = this.population[GW.randInt(this.population.length)];
      if (!best || c.fitness > best.fitness) best = c;
    }
    return best;
  };

  GW.AI.prototype.breed = function () {
    var cfg = this.cfg;
    var sorted = this.population.slice().sort(function (a, b) { return b.fitness - a.fitness; });
    var next = [];
    for (var i = 0; i < Math.min(cfg.elite, sorted.length); i++) {
      next.push({ tree: GW.cloneTree(sorted[i].tree), angle: sorted[i].angle, fitness: -Infinity, evaluated: false });
    }
    while (next.length < cfg.population) {
      var a = this.tournament(), b = this.tournament();
      var child = GW.crossover(a.tree, b.tree);
      child = GW.mutate(child, this.mode);
      var angle = Math.random() < 0.5 ? a.angle : b.angle;
      if (Math.random() < 0.25) angle += GW.gaussRandom() * 0.25;
      if (angle > Math.PI / 2) angle = Math.PI / 2;
      if (angle < -Math.PI / 2) angle = -Math.PI / 2;
      next.push({ tree: child, angle: angle, fitness: -Infinity, evaluated: false });
    }
    this.population = next;
    this.generation++;
  };

  /** 每帧调用一次；返回非 null 表示搜索结束，可以开炮 */
  GW.AI.prototype.tick = function () {
    var deadline = GW.now() + 12;      // 单帧最多占用 12ms，保证画面不卡
    while (GW.now() < deadline) {
      if (this.phase === 'evaluating') {
        if (this.evalIndex >= this.population.length) {
          this.updateBest();
          this.phase = 'ready';
          continue;
        }
        this.evaluate(this.population[this.evalIndex++]);
        continue;
      }
      // phase === 'ready'
      if (this.generation >= this.cfg.generations || GW.now() - this.startedAt > this.cfg.budgetMs) {
        return this.best();
      }
      this.breed();
      this.evalIndex = 0;
      this.phase = 'evaluating';
    }
    return null;
  };

  GW.AI.prototype.best = function () {
    this.updateBest();
    return { tree: this.best_ ? this.best_.tree : GW.randomTree(this.mode, 2), angle: this.best_ ? this.best_.angle : 0 };
  };

})(typeof window !== 'undefined' ? window : globalThis);
