/* ============================================================
 * 回合制核心：兵力布置、回合推进、误伤判定、计分与胜负结算
 * 流程对照原版 GameData.java（举手 uses firewall: 开炮 → 逐点绘制 → 爆炸 →
 * 延迟 3 秒 → 轮转到下一名存活士兵；单回合思考时限 60 秒）
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});
  var C = GW.C;

  GW.now = function () { return Date.now(); };

  /* ---------------- 士兵 ---------------- */
  GW.Soldier = function Soldier(x, y) {
    this.x = x || 0;
    this.y = y || 0;
    this.alive = false;
    this.angle = 0;
    this.exploding = false;
    this.deathAt = 0;
    this.killStep = -1;
    this.functionUsed = '';
    this.hp = C.SOLDIER_MAX_HP;      // 血量：不再一击必杀，扣到 0 才阵亡
    this.maxHp = C.SOLDIER_MAX_HP;
  };
  GW.Soldier.prototype.isAlive = function () { return this.alive; };
  GW.Soldier.prototype.setAlive = function (v) { this.alive = !!v; };
  GW.Soldier.prototype.isExploding = function () { return this.exploding; };
  GW.Soldier.prototype.setExploding = function (v) {
    this.exploding = !!v;
    if (this.exploding) this.deathAt = GW.now();
  };
  GW.Soldier.prototype.getFunction = function () { return this.functionUsed; };
  GW.Soldier.prototype.setFunction = function (s) { this.functionUsed = s; };

  /* ---------------- 玩家（席位） ----------------
   * 2 人模式：席位 0/1，阵营 TEAM1/TEAM2；
   * 4 人模式：席位 0/1/2/3，阵营 [1,2,1,2]（2v2），每人 1 名士兵独立行动。 */
  GW.Player = function Player(opts) {
    this.name = opts.name;
    this.id = opts.id;
    this.team = opts.team;
    this.isAI = !!opts.isAI;
    this.numSoldiers = opts.numSoldiers;
    this.soldiers = [];
    for (var i = 0; i < C.MAX_SOLDIERS_PER_PLAYER; i++) this.soldiers.push(new GW.Soldier());
    this.currentSoldierIndex = 0;
    this.kills = 0;          // 命中敌方
    this.friendly = 0;       // 误伤己方
    this.skill = null;       // 开局选择的技能 id
    this.skillUsed = false;  // 技能每局限一次
    this.aimBonus = 0;       // 辅助瞄准线加成（像素，本局有效）
    this.moveBonus = 0;      // 位移上限加成（游戏坐标单位，本局有效）
    this.powerShot = false;  // 下一发伤害强化
  };
  GW.Player.prototype.getSoldiers = function () { return this.soldiers; };
  GW.Player.prototype.getCurrentTurnSoldier = function () { return this.soldiers[this.currentSoldierIndex]; };
  GW.Player.prototype.getCurrentTurnSoldierIndex = function () { return this.currentSoldierIndex; };
  GW.Player.prototype.restartTurn = function () { this.currentSoldierIndex = 0; };
  GW.Player.prototype.startSoldier = function (i, x, y) {
    this.soldiers[i] = new GW.Soldier(x, y);
    this.soldiers[i].setAlive(true);
  };
  /** 轮转到下一名存活士兵；返回 false 表示全灭 */
  GW.Player.prototype.nextTurn = function () {
    for (var i = 0; i < this.numSoldiers; i++) {
      this.currentSoldierIndex = (this.currentSoldierIndex + 1) % this.numSoldiers;
      if (this.soldiers[this.currentSoldierIndex].isAlive()) return true;
    }
    return false;
  };
  GW.Player.prototype.aliveCount = function () {
    var n = 0;
    for (var i = 0; i < this.numSoldiers; i++) if (this.soldiers[i].isAlive()) n++;
    return n;
  };
  GW.Player.prototype.score = function () { return this.kills * 100 - this.friendly * 50; };

  /* ---------------- 对局 ---------------- */
  GW.Game = function Game(opts) {
    opts = opts || {};
    this.mode = opts.mode == null ? C.NORMAL_FUNC : opts.mode;
    this.soldiersPerPlayer = Math.max(1, Math.min(C.MAX_SOLDIERS_PER_PLAYER, opts.soldiersPerPlayer || 2));
    this.opponent = opts.opponent || 'human';
    this.aiLevel = opts.aiLevel || 2;
    /* 多人模式由「队伍总数 × 每队人数」决定，总人数 = 队伍总数 × 每队人数；
     * 只给 playerCount 的历史调用（服务器 / 测试）会自动反推出等价赛制。 */
    var roster = (opts.playerCount != null)
      ? GW.rosterFromSeats(opts.playerCount)
      : GW.seatsFromRoster(opts.teams, opts.perTeam);
    this.teams = roster.teams;            // 队伍总数
    this.perTeam = roster.perTeam;        // 每队人数
    this.playerCount = roster.count;
    if (this.playerCount > 2) this.soldiersPerPlayer = 1;   // 每人只控一名士兵
    if (opts.soldiersPerPlayer === 1 && this.playerCount > 2) this.soldiersPerPlayer = 1;

    this.players = [];
    for (var pi = 0; pi < this.playerCount; pi++) {
      this.players.push(new GW.Player({
        name: (this.playerCount > 2) ? GW.seatName(this.teams, pi)
                                     : (C.PLAYER_NAMES[pi] || ('玩家' + (pi + 1))),
        id: pi,
        team: GW.seatTeamIn(this.teams, pi),
        numSoldiers: this.soldiersPerPlayer,
        isAI: this.opponent === 'ai' && pi !== 0    // 人机模式：除先手外全部交给电脑
      }));
    }

    this.listeners = [];
    this.state = 'aim';        // aim | drawing | exploding | moving | over
    this.remoteDriven = false; // 联机镜像模式：本地不推进回合，仅播放服务器下发的弹道动画
    this.shot = null;
    this.lastShot = null;
    this.moveAnim = null;      // 位移动画 {playerIndex,soldierIndex,fx,fy,tx,ty,start}
    this.packs = [];           // 场上奖励包 [{id,x,y,kind}]
    this.packSeq = 0;
    this.round = 0;
    this.turnStartTime = GW.now();
    this.ai = null;
    this.newBattle();
  };

  GW.Game.prototype.on = function (fn) { this.listeners.push(fn); };
  GW.Game.prototype.emit = function (type, data) {
    for (var i = 0; i < this.listeners.length; i++) this.listeners[i](type, data || {});
  };
  GW.Game.prototype.log = function (text, kind, who) {
    this.emit('log', { text: text, kind: kind || '', who: who || '' });
  };

  /* ---------------- 生成战场 ---------------- */
  GW.Game.prototype.newBattle = function () {
    var teamCount = this.teams;
    var quota = GW.teamQuota(this.teams, this.perTeam, this.soldiersPerPlayer);
    var placed = null;
    for (var attempt = 0; attempt < 24 && !placed; attempt++) {
      var circles = GW.generateCircles();
      var positions = GW.placeSoldiers(circles, quota);
      this.terrain = new GW.Terrain(circles);
      var ok = true;
      for (var i = 0; i < positions.length; i++) {
        if (this.terrain.soldierCollides(positions[i].x, positions[i].y, C.SOLDIER_RADIUS)) { ok = false; break; }
      }
      if (ok) placed = positions;
    }
    if (!placed) placed = GW.placeSoldiers([[100, 100, 5]], quota);
    this._deploy(placed);

    this.state = 'aim';
    this.shot = null;
    this.lastShot = null;
    this.moveAnim = null;
    this.packs = [];
    this.ai = null;
    this.round = 0;
    this.currentTurn = GW.randInt(this.playerCount);
    this.turnStartTime = GW.now();
    this.emit('newbattle', { game: this });
    this.emit('turn', { playerIndex: this.currentTurn });
    this.log('战场已生成：' + this.teams + ' 队 × ' + this.perTeam + ' 人（共 ' + this.playerCount +
      ' 人 · ' + GW.teamLabel(this.teams, this.perTeam) + '），每人 ' + this.soldiersPerPlayer + ' 名士兵，' + C.MODE_NAME[this.mode] + '。', 'sys');
  };

  /** 把落座位置分配给各玩家（loadBattle 与 newBattle 共用） */
  GW.Game.prototype._deploy = function (positions) {
    for (var t = 0; t < this.players.length; t++) {
      var teamSide = this.players[t].team;
      var list = [];
      for (var k = 0; k < positions.length; k++) if (positions[k].team === teamSide) list.push(positions[k]);
      /* 4 人模式：同阵营两名玩家各拿一个落座位 */
      var sameTeamBefore = 0;
      for (var b = 0; b < t; b++) if (this.players[b].team === teamSide) sameTeamBefore++;
      for (var j = 0; j < this.soldiersPerPlayer; j++) {
        var idx = sameTeamBefore * this.soldiersPerPlayer + j;
        var pos = list[idx] || list[j] || { x: t % 2 === 0 ? 100 : 600, y: 225 };
        this.players[t].startSoldier(j, pos.x, pos.y);
      }
      this.players[t].kills = 0;
      this.players[t].friendly = 0;
      this.players[t].restartTurn();
      /* 重置本局增益与技能（loadBattle 重新开局时也一样） */
      this.players[t].aimBonus = 0;
      this.players[t].moveBonus = 0;
      this.players[t].powerShot = false;
      this.players[t].skillUsed = false;
      /* 技能兜底：没选过技能的席位随机配一个（AI、未选择的人选、掉线接管席位都走这条路），
       * 保证 useSkill 永远可用，且权威端与镜像端不会卡在「本局没有选择技能」。 */
      if (!this.players[t].skill) this.players[t].skill = C.SKILLS[GW.randInt(C.SKILLS.length)].id;
      for (var s = 0; s < this.players[t].numSoldiers; s++) {
        this.players[t].getSoldiers()[s].hp = C.SOLDIER_MAX_HP;
        this.players[t].getSoldiers()[s].maxHp = C.SOLDIER_MAX_HP;
      }
    }
  };

  /* 供冒烟测试/教学固定场景使用：清空地形 */
  GW.Game.prototype.setEmptyTerrain = function () {
    this.terrain = new GW.Terrain([]);
  };

  /** 新手教程专用固定场景：地形不挡住演示弹道，便于讲解每一步机制 */
  GW.Game.prototype.setupTutorial = function () {
    this.mode = C.NORMAL_FUNC;
    this.opponent = 'human';
    this.soldiersPerPlayer = 2;
    this.players[1].isAI = false;
    for (var i = 0; i < 2; i++) {
      this.players[i].numSoldiers = 2;
      this.players[i].kills = 0;
      this.players[i].friendly = 0;
      this.players[i].restartTurn();
    }
    this.terrain = new GW.Terrain([[300, 430, 50], [425, 442, 36], [360, 235, 32]]);
    this.players[0].startSoldier(0, 140, 330);
    this.players[0].startSoldier(1, 178, 330);
    this.players[1].startSoldier(0, 600, 330);
    this.players[1].startSoldier(1, 645, 272);
    this.state = 'aim';
    this.shot = null;
    this.lastShot = null;
    this.ai = null;
    this.round = 0;
    this.currentTurn = 0;
    this.turnStartTime = GW.now();
    this.emit('newbattle', { game: this });
    this.emit('turn', { playerIndex: this.currentTurn });
  };

  /**
   * 联机镜像：用服务器权威下发的地形圆与士兵落座重建一局。
   * @param {number[][]} circles  地形圆 [x,y,r]
   * @param {{team:number,x:number,y:number}[]} positions  已落座的士兵（按阵营归并）
   * @param {number} currentTurn  首发方（玩家下标）
   * @param {boolean} remote  true=客户端镜像（本地不推进回合）；false=服务器权威对局
   */
  GW.Game.prototype.loadBattle = function (circles, positions, currentTurn, remote) {
    this.terrain = new GW.Terrain(circles);
    this._deploy(positions);
    this.state = 'aim';
    this.shot = null;
    this.lastShot = null;
    this.moveAnim = null;
    this.packs = [];
    this.ai = null;
    this.round = 0;
    this.currentTurn = currentTurn || 0;
    this.turnStartTime = GW.now();
    this.remoteDriven = !!remote;
    this.emit('newbattle', { game: this });
    this.emit('turn', { playerIndex: this.currentTurn });
  };

  GW.Game.prototype.currentPlayer = function () { return this.players[this.currentTurn]; };

  GW.Game.prototype.remainingTime = function (now) {
    now = now || GW.now();
    if (this.state !== 'aim') {
      var frozenAt = this.turnStartTimeFrozen || this.turnStartTime;
      return Math.max(0, C.TURN_TIME - (frozenAt - this.turnStartTime));
    }
    return Math.max(0, C.TURN_TIME - (now - this.turnStartTime));
  };

  /** 试算：不改变任何游戏状态，用于输入预览与 AI 搜索 */
  GW.Game.prototype.simulate = function (input, angle, forPlayerIndex) {
    var compiled;
    try {
      compiled = (typeof input === 'string')
        ? GW.compileString(input)
        : { eval: GW.compileTree(input.tree || input), tree: input.tree || input, source: null };
    } catch (e) {
      return null;
    }
    return this._run(compiled, angle, forPlayerIndex, C.FUNC_MAX_STEPS);
  };

  GW.Game.prototype.simulateTree = function (tree, angle, forPlayerIndex) {
    try {
      return this._run({ eval: GW.compileTree(tree), tree: tree, source: GW.treeToString(tree) }, angle, forPlayerIndex, C.FUNC_MAX_STEPS);
    } catch (e) { return null; }
  };

  GW.Game.prototype._run = function (compiled, angle, forPlayerIndex, maxSteps) {
    var idx = forPlayerIndex == null ? this.currentTurn : forPlayerIndex;
    var player = this.players[idx];
    var soldier = player.getCurrentTurnSoldier();
    if (!soldier.isAlive()) return null;
    try {
      return GW.computeTrajectory({
        f: compiled.eval,
        mode: this.mode,
        shooter: soldier,
        angle: angle != null ? angle : soldier.angle,
        players: this.players,
        currentTurn: idx,
        inverted: player.team === C.TEAM2,
        terrain: this.terrain,
        maxSteps: maxSteps || C.FUNC_MAX_STEPS
      });
    } catch (e) {
      return null;
    }
  };

  /* ---------------- 手绘弹道 ---------------- */

  /**
   * 把画板上的一笔变成一条完整弹道。
   *
   * 规则：笔画只决定「方向」——系统对它做最小二乘拟合，得到一条多项式曲线，
   * 然后把这条曲线当作普通函数 y = f(x) 发射出去：它会被平移到士兵脚下，
   * 并<b>无限延长</b>，直到撞到地形、击中士兵或飞出战场为止。
   *
   * @param norm  归一化笔迹 [{x,y}]，以起点为原点、画板宽度为单位、y 向下为正
   * @param rotDeg 方向（绕起点旋转的角度）
   * @param scale  大小（1 = 原尺寸）
   */
  GW.Game.prototype.buildSketchTrajectory = function (norm, rotDeg, scale) {
    var idx = this.currentTurn;
    var player = this.players[idx];
    var soldier = player.getCurrentTurnSoldier();
    if (!soldier || !soldier.isAlive() || !norm || norm.length < 2) return null;
    if (!GW.fitPolynomial) return null;

    var inverted = player.team === C.TEAM2;
    var rad = (rotDeg || 0) * Math.PI / 180;
    var sc = (scale == null ? 1 : scale);
    var cos = Math.cos(rad), sin = Math.sin(rad);

    /* 1) 归一化笔迹 → 战场像素偏移（缩放 + 旋转）。
     *    u = 朝敌方方向的水平偏移，v = 垂直偏移（向下为正）。 */
    var offs = [], i;
    for (i = 0; i < norm.length; i++) {
      var ox = norm[i].x * C.SKETCH_SPAN * sc;
      var oy = norm[i].y * C.SKETCH_SPAN * sc;
      offs.push({ x: ox * cos - oy * sin, y: ox * sin + oy * cos });
    }

    /* 2) 拟合成多项式：这一笔的形状 → 一条可以无限延长的曲线 */
    var degree = Math.min(C.SKETCH_DEGREE, Math.max(1, offs.length - 1));
    var fit = GW.fitPolynomial(offs, degree);
    if (!fit) return null;
    var anchorY0 = fit.eval(0);        // 让 P(0)=0：曲线从士兵脚下出发

    var baseX = inverted ? C.PLANE_LENGTH - soldier.x : soldier.x;   // 镜像坐标里的炮口 x
    var baseY = soldier.y;

    function P(u) { return fit.eval(u) - anchorY0; }

    /* 3) 像素空间的多项式 → 游戏坐标下的 f(x) */
    var A1 = C.PLANE_LENGTH / C.PLANE_GAME_LENGTH;
    var A0 = C.PLANE_LENGTH / 2 - baseX;
    var K = C.PLANE_GAME_LENGTH / C.PLANE_LENGTH;
    /* Q(u) = R(u) - anchorY0（保证 Q(0)=0）→ 先搬到 game x 上 */
    var cUp = GW.polyCoefs(fit);
    cUp = cUp.slice(0);
    cUp[0] -= anchorY0;
    var qGame = composePoly(cUp, A1, A0);
    var polyG = new Array(qGame.length);
    for (i = 0; i < qGame.length; i++) polyG[i] = -K * qGame[i];
    polyG[0] += K * (C.PLANE_HEIGHT / 2 - baseY);

    function fpert(xGame) {
      var u = A1 * xGame + A0;
      return GW.toGameY(baseY + P(u));
    }

    /* 4) 交给与普通函数完全相同的弹道引擎：碰撞、命中、地形判定全部一致 */
    var traj = GW.computeTrajectory({
      f: fpert,
      mode: C.NORMAL_FUNC,
      shooter: soldier,
      angle: soldier.angle,
      players: this.players,
      currentTurn: idx,
      inverted: inverted,
      terrain: this.terrain,
      maxSteps: C.FUNC_MAX_STEPS
    });
    if (!traj || traj.numSteps < 2) return null;

    traj.sketch = true;
    traj.expr = this._sketchExpression(polyG, traj);
    return traj;
  };

  /** 把真正的出膛点代回去，得到实际生效的函数解析式（供顶部显示） */
  GW.Game.prototype._sketchExpression = function (polyG, traj) {
    try {
      var x0 = traj.xs[0], y0 = traj.ys[0];
      var higher = 0;
      for (var k = 1; k < polyG.length; k++) higher += polyG[k] * Math.pow(x0, k);
      var coefs = polyG.slice(0);
      coefs[0] = y0 - higher;
      var text = GW.formatPolynomial(coefs, 3);
      return text ? 'y = ' + text : null;
    } catch (e) {
      return null;
    }
  };

  /** 多项式复合：c(x) 与线性函数 (a·x + b) */
  function composePoly(c, a, b) {
    var n = c.length;
    var out = new Array(n);
    var k, j;
    for (k = 0; k < n; k++) out[k] = 0;
    var powB = [1];
    for (j = 1; j < n; j++) powB[j] = powB[j - 1] * b;
    var powA = [1];
    for (j = 1; j < n; j++) powA[j] = powA[j - 1] * a;
    var binomRow = buildBinom(n);
    /* (a·x + b)^i = Σ_j C(i,j)·a^j·b^(i-j)·x^j */
    for (var i = 0; i < n; i++) {
      for (j = 0; j <= i; j++) {
        out[j] += c[i] * binomRow[i][j] * powA[j] * powB[i - j];
      }
    }
    return out;
  }

  function buildBinom(n) {
    var row = [], i, j;
    for (i = 0; i < n; i++) {
      row[i] = [];
      for (j = 0; j < n; j++) row[i][j] = 0;
    }
    row[0][0] = 1;
    for (i = 1; i < n; i++) {
      row[i][0] = 1;
      for (j = 1; j <= i; j++) row[i][j] = row[i - 1][j - 1] + row[i - 1][j];
    }
    return row;
  }

  /**
   * 开炮。input 可为字符串（人类输入）或 {tree}（电脑 AI）
   * @param weaponIdx 武器下标（0 重炮弹 / 1 标准弹 / 2 散弹），缺省标准弹
   * @returns {{ok:boolean, reason?:string}}
   */
  GW.Game.prototype.fire = function (input, isAI, weaponIdx) {
    if (this.state !== 'aim') return { ok: false, reason: '炮弹还在飞，请稍候' };
    var compiled;
    try {
      if (typeof input === 'string') {
        compiled = GW.compileString(input);
        compiled.source = GW.treeToString(compiled.tree);
      } else {
        var tree = input.tree || input;
        compiled = { eval: GW.compileTree(tree), tree: tree, source: GW.treeToString(tree), input: '' };
      }
    } catch (e) {
      return { ok: false, reason: e.message };
    }

    var player = this.players[this.currentTurn];
    var soldier = player.getCurrentTurnSoldier();
    var angle = soldier.angle;

    var traj = this._run(compiled, angle, this.currentTurn, C.FUNC_MAX_STEPS);
    if (!traj) return { ok: false, reason: '无法生成弹道，请换一个表达式' };

    soldier.setFunction(compiled.source);
    if (this.mode === C.SND_ODE) soldier.angle = traj.fireAngle;

    return this._launch(traj, compiled.source, !!isAI, C.FUNCTION_VELOCITY, weaponIdx);
  };

  /**
   * 发射一条已经算好的弹道（手绘弹道走这里）。
   * source 缺省时使用拟合出来的解析式，顶部显示的就是真实函数值而非「手绘函数」。
   */
  GW.Game.prototype.fireTrajectory = function (traj, source, velocity, weaponIdx) {
    if (this.state !== 'aim') return { ok: false, reason: '炮弹还在飞，请稍候' };
    if (!traj || traj.numSteps < 2) return { ok: false, reason: '这一笔形成不了有效弹道，请重画或调整大小' };
    var expr = source || traj.expr || '拟合弹道';
    this.players[this.currentTurn].getCurrentTurnSoldier().setFunction(expr);
    return this._launch(traj, expr, false, velocity || C.FUNCTION_VELOCITY, weaponIdx);
  };

  GW.Game.prototype._launch = function (traj, source, isAI, velocity, weaponIdx) {
    var player = this.players[this.currentTurn];
    var weapon = GW.weaponById(weaponIdx == null ? 1 : weaponIdx);
    var wi = C.WEAPONS.indexOf(weapon);

    /* 记下每名目标被弹道穿越的步号，绘制到该步时才结算伤害（与原版节奏一致） */
    for (var h = 0; h < traj.hits.length; h++) {
      this.players[traj.hits[h].playerIndex].getSoldiers()[traj.hits[h].soldierIndex].killStep = traj.hits[h].step;
    }

    this.shot = {
      traj: traj,
      source: source,
      start: GW.now(),
      playerIndex: this.currentTurn,
      soldierIndex: player.currentSoldierIndex,
      velocity: velocity,
      weapon: wi,
      killed: [],
      exploded: false,
      isAI: !!isAI
    };
    this.state = 'drawing';
    this.turnStartTimeFrozen = this.shot.start;
    this.round++;

    this.log((isAI ? '电脑' : C.TEAM_NAME[player.team]) + ' 发射' + weapon.name + '：' + source, isAI ? 'ai' : 'shoot', player.name);
    this.emit('shot', { shot: this.shot });
    return { ok: true, traj: traj };
  };

  /** 当前应绘制到第几步（动画进度） */
  GW.Game.prototype.drawProgress = function (now) {
    if (this.state === 'aim' || !this.shot) return 0;
    if (this.state === 'exploding') return this.shot.traj.numSteps;
    var vel = this.shot.velocity || C.FUNCTION_VELOCITY;
    var steps = ((now - this.shot.start) * vel) / 1000;
    if (steps > this.shot.traj.numSteps) steps = this.shot.traj.numSteps;
    return steps;
  };

  /* ---------------- 每帧推进 ---------------- */
  GW.Game.prototype.update = function (now) {
    now = now || GW.now();

    if (this.state === 'drawing' || this.state === 'exploding') {
      this._advanceShot(now);
      return;
    }

    if (this.state === 'moving') {
      if (this.remoteDriven) return;   // 镜像端等服务器下发 'turn'
      if (now - (this._moveStart || 0) >= C.MOVE_ANIM_TIME) this.nextTurn(now);
      return;
    }

    /* 联机镜像：本地不跑 AI、不因超时自作主张轮转，回合由服务器下发的 'turn' 决定 */
    if (this.remoteDriven) return;

    if (this.state === 'aim') {
      if (this.players[this.currentTurn].isAI) {
        this._tickAI(now);
        return;
      }
      if (C.TURN_TIME - (now - this.turnStartTime) <= 0) {
        var name = C.TEAM_NAME[this.players[this.currentTurn].team];
        this.log(name + ' 思考超时，本回合作废。', 'sys');
        this.emit('timeout', { playerIndex: this.currentTurn });
        this.nextTurn(now);
      }
    }
  };

  /* ---------------- 伤害 / 治疗 ---------------- */

  /** 扣血。血量归 0 才阵亡；shooterIndex 用于战功归属（radial 时来自 this.shot） */
  GW.Game.prototype._applyDamage = function (playerIndex, soldierIndex, dmg) {
    var victim = this.players[playerIndex].getSoldiers()[soldierIndex];
    if (!victim.alive || !(dmg > 0)) return;
    victim.hp = Math.max(0, victim.hp - Math.round(dmg));
    if (victim.hp <= 0) {
      victim.setExploding(true);
      victim.setAlive(false);
      if (this.shot) this._attribute({ playerIndex: playerIndex, soldierIndex: soldierIndex });
    } else {
      this.emit('damaged', { playerIndex: playerIndex, soldierIndex: soldierIndex, hp: victim.hp, dmg: Math.round(dmg) });
    }
  };

  /** 落点（半径）伤害：中心全额，边缘按 falloff 衰减；对双方都生效（会误伤） */
  GW.Game.prototype._radialDamage = function (px, py, radius, dmg, falloff) {
    for (var i = 0; i < this.players.length; i++) {
      for (var k = 0; k < this.players[i].numSoldiers; k++) {
        var s = this.players[i].getSoldiers()[k];
        if (!s.alive) continue;
        var d = Math.sqrt((s.x - px) * (s.x - px) + (s.y - py) * (s.y - py));
        if (d > radius) continue;
        var f = 1 - (d / radius) * (1 - (falloff == null ? 0.5 : falloff));
        this._applyDamage(i, k, dmg * f);
      }
    }
  };

  /** 奖励包效果结算 */
  GW.Game.prototype._collectPack = function (pack) {
    var idx = this.packs.indexOf(pack);
    if (idx < 0) return;
    this.packs.splice(idx, 1);
    var p = this.shot ? this.players[this.shot.playerIndex]
      : (this.moveAnim ? this.players[this.moveAnim.playerIndex] : this.players[this.currentTurn]);
    var holder = p.getCurrentTurnSoldier();
    if (pack.kind === 'heal') {
      holder.hp = Math.min(holder.maxHp, holder.hp + 35);
      this.log(C.TEAM_NAME[p.team] + ' 拾取「维修包」：生命 +35。', 'hit', p.name);
    } else if (pack.kind === 'aim') {
      p.aimBonus += 50;
      this.log(C.TEAM_NAME[p.team] + ' 拾取「瞄准镜」：辅助瞄准线 +50px（本局）。', 'hit', p.name);
    } else if (pack.kind === 'power') {
      p.powerShot = true;
      this.log(C.TEAM_NAME[p.team] + ' 拾取「强化弹头」：下一发伤害 ×1.6。', 'hit', p.name);
    } else if (pack.kind === 'move') {
      p.moveBonus += 3;
      this.log(C.TEAM_NAME[p.team] + ' 拾取「疾行靴」：位移上限 +3（本局）。', 'hit', p.name);
    }
    this.emit('reward', { playerIndex: this.players.indexOf(p), kind: pack.kind, x: pack.x, y: pack.y });
  };

  /** 每回合结束后概率刷新一个奖励包 */
  GW.Game.prototype._maybeSpawnPack = function () {
    if (this.packs.length >= C.PACK_MAX_ON_FIELD) return;
    if (Math.random() > C.PACK_SPAWN_CHANCE) return;
    var px = 40 + Math.random() * (C.PLANE_LENGTH - 80);
    var def = C.PACKS[GW.randInt(C.PACKS.length)];
    this.packs.push({ id: ++this.packSeq, x: Math.round(px), y: 0, kind: def.id });
    var pack = this.packs[this.packs.length - 1];
    /* 落到地形表面：从上往下找到第一个碰撞点 */
    var y = 6;
    while (y < C.PLANE_HEIGHT - 4 && !this.terrain.soldierCollides(px, y + 4, 3)) y += 3;
    pack.y = Math.round(y);
    this.emit('pack', { pack: pack });
    this.log('空投「' + def.name + '」出现在战场（' + def.hint + '）。', 'sys');
  };

  GW.Game.prototype._advanceShot = function (now) {
    var shot = this.shot;
    if (!shot) return;
    var traj = shot.traj;
    var steps = this.drawProgress(now);
    var weapon = GW.weaponById(shot.weapon);

    /* 炮弹当前位置的奖励包拾取（击中奖励包即归射击方） */
    if (traj.numSteps > 0) {
      var ci = Math.min(traj.numSteps - 1, Math.max(0, Math.floor(steps) - 1));
      var cx = GW.toPlaneX(traj.xs[ci]);
      if (traj.inverted) cx = C.PLANE_LENGTH - cx;
      var cy = GW.toPlaneY(traj.ys[ci]);
      for (var pi = this.packs.length - 1; pi >= 0; pi--) {
        var pk = this.packs[pi];
        var d = Math.sqrt((pk.x - cx) * (pk.x - cx) + (pk.y - cy) * (pk.y - cy));
        if (d <= C.PACK_PICKUP_RADIUS) this._collectPack(pk);
      }
    }

    /* 绘制过程中，被弹道穿过的士兵依次结算路径伤害 */
    for (var i = 0; i < traj.hits.length; i++) {
      var h = traj.hits[i];
      if (shot.killed.indexOf(h) >= 0) continue;
      if (steps >= h.step) {
        shot.killed.push(h);
        var mult = this.players[shot.playerIndex].powerShot ? 1.6 : 1;
        this._applyDamage(h.playerIndex, h.soldierIndex, weapon.dmg * mult);
      }
    }

    /* 炮弹抵达终点 → 炸出一个坑 + 范围伤害（散弹再炸出多团弹片） */
    if (this.state === 'drawing' && steps >= traj.numSteps) {
      if (!shot.exploded) {
        shot.exploded = true;
        shot.explodeAt = now;
        var mult2 = this.players[shot.playerIndex].powerShot ? 1.6 : 1;
        this.players[shot.playerIndex].powerShot = false;   // 强化只持续一发
        var ex = traj.lastX, ey = traj.lastY;
        if (traj.inverted) ex = C.PLANE_LENGTH - ex;
        if (isFinite(ex) && isFinite(ey)) {
          this.terrain.explode(ex, ey, C.EXPLOSION_RADIUS);
          this._radialDamage(ex, ey, weapon.radius, weapon.dmg * 0.8 * mult2, weapon.falloff);
          for (var sc = 0; sc < weapon.scatter; sc++) {
            var ang = Math.PI * 2 * sc / weapon.scatter + Math.random() * 0.6;
            var rr = weapon.radius * (1.1 + Math.random() * 0.5);
            var sx = ex + Math.cos(ang) * rr, sy = ey + Math.sin(ang) * rr * 0.8;
            this.emit('explosion', { x: sx, y: sy, at: now + 120 * sc, small: true });
            this._radialDamage(sx, sy, weapon.radius * 0.8, 22 * mult2, weapon.falloff);
          }
        }
        this.emit('explosion', { x: ex, y: ey, at: now });
      }
      this.state = 'exploding';
      return;
    }

    if (this.state === 'exploding' && now - shot.explodeAt >= C.NEXT_TURN_DELAY) {
      this.lastShot = shot;
      this.shot = null;
      if (this.remoteDriven) { return; }   // 保持 exploding，等待服务器下发 'turn' 再切换
      this.nextTurn(now);
    }
  };

  GW.Game.prototype._attribute = function (hit) {
    var shooter = this.players[this.shot.playerIndex];
    var victimPlayer = this.players[hit.playerIndex];
    var own = shooter.team === victimPlayer.team;
    if (own) {
      shooter.friendly++;
      this.log('误伤！' + C.TEAM_NAME[shooter.team] + ' 的炮弹打中了自己人。', 'bad', shooter.name);
    } else {
      shooter.kills++;
      this.log('命中！' + C.TEAM_NAME[victimPlayer.team] + ' 损失 1 名士兵。', 'hit', shooter.name);
    }
    this.emit('casualty', { shooter: shooter, victim: victimPlayer, own: own });
  };

  /** 轮转到下一名存活士兵；无人可动则结算 */
  GW.Game.prototype.nextTurn = function (now) {
    now = now || GW.now();
    if (this.checkGameFinished()) {
      this._finish(now);
      return;
    }
    for (var i = 0; i < this.players.length; i++) {
      this.currentTurn = (this.currentTurn + 1) % this.players.length;
      if (this.players[this.currentTurn].nextTurn()) break;
    }
    this.state = 'aim';
    this.turnStartTime = now;
    this.ai = null;
    this._maybeSpawnPack();   // 每回合结束后概率空投奖励包
    this.emit('turn', { playerIndex: this.currentTurn });
  };

  GW.Game.prototype.checkGameFinished = function () {
    /* 按阵营判定：任一阵营全灭即结束（兼容 2 人与 4 人 2v2） */
    var teamAlive = {};
    for (var i = 0; i < this.players.length; i++) {
      if (this.players[i].aliveCount() > 0) teamAlive[this.players[i].team] = true;
    }
    return !(teamAlive[C.TEAM1] && teamAlive[C.TEAM2]);
  };

  GW.Game.prototype._finish = function (now) {
    this.state = 'over';
    var winners = [], losers = [];
    for (var i = 0; i < this.players.length; i++) {
      if (this.players[i].aliveCount() > 0) winners.push(this.players[i]);
      else losers.push(this.players[i]);
    }
    var winner = winners.length === 1 ? winners[0] : null;
    this.result = {
      winner: winner,
      reason: winner
        ? (C.TEAM_NAME[winner.team] + ' 全歼敌军，赢得胜利！')
        : '双方同归于尽，平局。',
      at: now
    };
    this.log(this.result.reason, 'hit');
    this.emit('over', this.result);
  };

  /* ---------------- AI 驱动 ---------------- */
  GW.Game.prototype._tickAI = function (now) {
    if (!this.ai) {
      if (!GW.AI) return;
      this.ai = new GW.AI(this, this.aiLevel);
      this.emit('aithink', { playerIndex: this.currentTurn });
    }
    var result = this.ai.tick();
    if (result) {
      var shot = { tree: result.tree, angle: result.angle };
      this._applyAIShot(shot);
    }
  };

  GW.Game.prototype._applyAIShot = function (shot) {
    if (shot.angle != null && this.mode === C.SND_ODE) {
      var soldier = this.players[this.currentTurn].getCurrentTurnSoldier();
      soldier.angle = shot.angle;
    }
    var res = this.fire(shot, true);
    if (!res.ok) {
      // 兜底：随便开一炮，避免电脑卡住流程
      this.fire({ tree: GW.randomTree(this.mode, 2) }, true);
    }
  };

  GW.Game.prototype.setAngle = function (angle) {
    var p = this.players[this.currentTurn];
    if (!p || p.isAI) return;
    var s = p.getCurrentTurnSoldier();
    s.angle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, angle));
  };

  /* ---------------- 位移：把本回合行动改为沿函数曲线移动 ----------------
   * input 与开炮相同（表达式 / {tree}），dist 为想移动的距离（游戏坐标单位），
   * 实际位移会被钳制在「本回合上限」内，且不能钻进山体或别的士兵身体里。
   * 位移途中碰到奖励包同样拾取。位移消耗整个回合。 */
  GW.Game.prototype.move = function (input, dist, isAI) {
    if (this.state !== 'aim') return { ok: false, reason: '请等当前炮弹飞完' };
    var player = this.players[this.currentTurn];
    var soldier = player.getCurrentTurnSoldier();
    if (!soldier || !soldier.isAlive()) return { ok: false, reason: '这名士兵已阵亡' };

    var compiled = null;
    try {
      if (typeof input === 'string' && input.trim()) {
        compiled = GW.compileString(input);
      } else if (input && input.tree) {
        compiled = { eval: GW.compileTree(input.tree) };
      }
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    if (!compiled) return { ok: false, reason: '请先输入位移函数（曲线方向即移动方向）' };

    var traj = this._run(compiled, soldier.angle, this.currentTurn, C.FUNC_MAX_STEPS);
    if (!traj || traj.numSteps < 2) return { ok: false, reason: '这条曲线无法作为位移路径' };

    var pxPerUnit = C.PLANE_LENGTH / C.PLANE_GAME_LENGTH;
    var maxDist = C.MAX_MOVE_DIST + (player.moveBonus || 0);
    var wantPx = Math.max(0.5, Math.min(maxDist, dist == null ? maxDist : dist)) * pxPerUnit;

    /* 沿弹道逐段累计像素距离，找到目标点 */
    var acc = 0, tx = 0, ty = 0, i, px, py, prevX, prevY, first = true;
    var inverted = traj.inverted;
    var picked = [];
    for (i = 0; i < traj.numSteps; i++) {
      px = GW.toPlaneX(traj.xs[i]);
      if (inverted) px = C.PLANE_LENGTH - px;
      py = GW.toPlaneY(traj.ys[i]);
      if (!first) {
        acc += Math.sqrt((px - prevX) * (px - prevX) + (py - prevY) * (py - prevY));
      }
      prevX = px; prevY = py; first = false;
      /* 途中拾取奖励包 */
      for (var pi = this.packs.length - 1; pi >= 0; pi--) {
        var pk = this.packs[pi];
        if (picked.indexOf(pk) < 0 &&
            Math.sqrt((pk.x - px) * (pk.x - px) + (pk.y - py) * (pk.y - py)) <= C.MOVE_PICKUP_RADIUS) {
          picked.push(pk);
        }
      }
      if (acc >= wantPx) break;
    }
    tx = prevX; ty = prevY;

    /* 终点不能卡进山体 / 其他士兵：往回退到最后一个合法点 */
    var others = [];
    for (var p2 = 0; p2 < this.players.length; p2++) {
      for (var s2 = 0; s2 < this.players[p2].numSoldiers; s2++) {
        var os = this.players[p2].getSoldiers()[s2];
        if (os.alive && os !== soldier) others.push(os);
      }
    }
    function legal(x, y) {
      if (x < 4 || x > C.PLANE_LENGTH - 4 || y < 4 || y > C.PLANE_HEIGHT - 4) return false;
      if (this.terrain.soldierCollides(x, y, C.SOLDIER_RADIUS)) return false;
      for (var o = 0; o < others.length; o++) {
        var dx = others[o].x - x, dy = others[o].y - y;
        if (dx * dx + dy * dy < (C.SOLDIER_RADIUS * 2.2) * (C.SOLDIER_RADIUS * 2.2)) return false;
      }
      return true;
    }
    var fx = soldier.x, fy = soldier.y;
    if (!legal.call(this, tx, ty)) {
      var step = Math.max(1, Math.floor(traj.numSteps / 200));
      var j = i;
      while (j > 0) {
        j = Math.max(0, j - step);
        var qx = GW.toPlaneX(traj.xs[j]);
        if (inverted) qx = C.PLANE_LENGTH - qx;
        var qy = GW.toPlaneY(traj.ys[j]);
        if (legal.call(this, qx, qy)) { tx = qx; ty = qy; break; }
        if (j === 0) break;
      }
      if (!legal.call(this, tx, ty)) { tx = fx; ty = fy; }
    }

    /* 提交位移 + 拾取 */
    soldier.x = Math.round(tx * 10) / 10;
    soldier.y = Math.round(ty * 10) / 10;
    var savedShot = this.shot;
    this.moveAnim = { playerIndex: this.currentTurn, soldierIndex: player.currentSoldierIndex, fx: fx, fy: fy, tx: soldier.x, ty: soldier.y, start: GW.now() };
    for (var m = 0; m < picked.length; m++) this._collectPack(picked[m]);
    this.state = 'moving';
    this._moveStart = GW.now();
    this.round++;
    var movedDist = Math.sqrt((soldier.x - fx) * (soldier.x - fx) + (soldier.y - fy) * (soldier.y - fy)) / pxPerUnit;
    this.log((isAI ? '电脑' : C.TEAM_NAME[player.team]) + ' 位移 ' + movedDist.toFixed(1) + ' 格（上限 ' + maxDist + ' 格）。', 'sys', player.name);
    this.emit('move', { playerIndex: this.currentTurn, soldierIndex: player.currentSoldierIndex, fx: fx, fy: fy, tx: soldier.x, ty: soldier.y });
    return { ok: true, dist: movedDist };
  };

  /* ---------------- 技能：开局各选一个，对局中可用一次，消耗本回合 ---------------- */

  /** 权威端专用：给某个席位指定开局技能（联机由 skill_pick 消息驱动，校验后才生效） */
  GW.Game.prototype.pickSkill = function (playerIndex, skillId) {
    var p = this.players[playerIndex];
    if (!p) return { ok: false, reason: '席位不存在' };
    if (!GW.skillById(skillId)) return { ok: false, reason: '没有「' + skillId + '」这个技能' };
    if (p.skillUsed) return { ok: false, reason: '本局技能已经用过了，不能再改' };
    p.skill = skillId;
    return { ok: true };
  };

  GW.Game.prototype.useSkill = function () {
    if (this.state !== 'aim') return { ok: false, reason: '请等当前行动结束' };
    var p = this.players[this.currentTurn];
    if (!p.skill) return { ok: false, reason: '本局没有选择技能' };
    if (p.skillUsed) return { ok: false, reason: '技能已经用过了（每局一次）' };
    var soldier = p.getCurrentTurnSoldier();
    p.skillUsed = true;
    if (p.skill === 'heal') {
      var amt = Math.min(45, soldier.maxHp - soldier.hp);
      soldier.hp += amt;
      this.log(C.TEAM_NAME[p.team] + ' 发动「应急修理」：生命 +' + amt + '。', 'hit', p.name);
    } else if (p.skill === 'groupheal') {
      for (var k = 0; k < p.numSoldiers; k++) {
        var s = p.getSoldiers()[k];
        if (s.alive) s.hp = Math.min(s.maxHp, s.hp + 30);
      }
      this.log(C.TEAM_NAME[p.team] + ' 发动「群体维修」：己方全体生命 +30。', 'hit', p.name);
    } else if (p.skill === 'power') {
      p.powerShot = true;
      this.log(C.TEAM_NAME[p.team] + ' 发动「火力强化」：下一发伤害 ×1.6。', 'hit', p.name);
    } else if (p.skill === 'range') {
      p.aimBonus += 80;
      this.log(C.TEAM_NAME[p.team] + ' 发动「侦察卫星」：辅助瞄准线 +80px（本局）。', 'hit', p.name);
    }
    this.emit('skill', { playerIndex: this.currentTurn, skill: p.skill });
    this.nextTurn();
    return { ok: true };
  };

  /* ---------------- 联机共用：消息打包 ----------------
   * 服务器（server.js）与点对点房主（浏览器）都用这两个函数生成下行消息，
   * 保证「服务器联机」和「点对点联机」两种模式下，客人收到的数据完全一致。 */

  /** 弹道 → 可 JSON 化的数据（坐标保留 3 位小数，体积约为原始的 1/2，误差 < 0.02 像素） */
  GW.packShot = function (shot) {
    var t = shot.traj;
    var r3 = function (v) { return Math.round(v * 1000) / 1000; };
    var xs = new Array(t.numSteps), ys = new Array(t.numSteps);
    for (var i = 0; i < t.numSteps; i++) { xs[i] = r3(t.xs[i]); ys[i] = r3(t.ys[i]); }
    return {
      traj: {
        xs: xs, ys: ys,
        numSteps: t.numSteps,
        hits: t.hits,
        fireAngle: t.fireAngle,
        lastX: t.lastX,
        lastY: t.lastY,
        inverted: t.inverted,
        sketch: t.sketch,
        expr: t.expr
      },
      source: shot.source,
      playerIndex: shot.playerIndex,
      soldierIndex: shot.soldierIndex,
      velocity: shot.velocity,
      weapon: shot.weapon
    };
  };

  /** 全体玩家战况快照（回合切换时同步，避免客户端与权威端状态漂移） */
  GW.snapshotPlayers = function (g) {
    return g.players.map(function (p) {
      return {
        currentSoldierIndex: p.currentSoldierIndex,
        kills: p.kills,
        friendly: p.friendly,
        aimBonus: p.aimBonus || 0,
        moveBonus: p.moveBonus || 0,
        powerShot: !!p.powerShot,
        skill: p.skill || null,
        skillUsed: !!p.skillUsed,
        soldiers: p.getSoldiers().slice(0, p.numSoldiers).map(function (s) {
          return { alive: s.alive, hp: s.hp, x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10 };
        })
      };
    });
  };

  /** 场上奖励包快照（随 turn 一起同步） */
  GW.snapshotPacks = function (g) {
    return (g.packs || []).map(function (p) { return { id: p.id, x: p.x, y: p.y, kind: p.kind }; });
  };

})(typeof window !== 'undefined' ? window : globalThis);
