/* ============================================================
 * 常量与坐标换算
 * 数值全部对齐参考项目 catabriga/graphwar（Java 版）Constants.java，
 * 保证手感、地图尺度、回合节奏与原作一致。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});

  var C = {
    /* 画布/坐标：平面为 770×450 像素，对应游戏坐标 x∈[-25,25]、y∈[-14.6,14.6] */
    PLANE_LENGTH: 770,
    PLANE_HEIGHT: 450,
    PLANE_GAME_LENGTH: 50,

    /* 地形圆（山体） */
    CIRCLE_MEAN_RADIUS: 40,
    CIRCLE_STANDARD_DEVIATION: 25,
    NUM_CIRCLES_MEAN_VALUE: 15,
    NUM_CIRCLES_STANDARD_DEVIATION: 7,

    /* 士兵 */
    SOLDIER_RADIUS: 7,
    SOLDIER_SELECTION_RADIUS: 15,
    SOLDIER_MAX_DEATH_TIME: 6000,
    MAX_SOLDIERS_PER_PLAYER: 4,
    MAX_PLAYERS: 8,               // 多人模式最多席位（2v2=4 人 / 3v3=6 人 / 4v4=8 人）
    MAX_TEAMS: 4,                 // 队伍总数上限（2 队对抗 / 3 队 / 4 队混战）
    MAX_PER_TEAM: 4,              // 每队人数上限（队伍总数 × 每队人数 ≤ MAX_PLAYERS）
    SOLDIER_MAX_HP: 100,          // 士兵血量（较原版「一击必杀」大幅提高）
    PLAYER_COLORS: [              // 各玩家（席位）颜色，最多 8 席
      '#2f9e5c', '#0f8f8f', '#7cb342', '#00897b',
      '#f59e0b', '#8b5cf6', '#ec4899', '#eab308'
    ],
    PLAYER_NAMES: [ '绿方·1号', '青方·1号', '绿方·2号', '青方·2号',
                    '绿方·3号', '青方·3号', '绿方·4号', '青方·4号' ],

    /* 武器：每次发射前可三选一。
     * dmg=路径命中伤害；radius=落点爆炸半径；falloff=边缘伤害系数；
     * scatter=落点分裂出的子爆炸数量（散弹） */
    WEAPONS: [
      { id: 'heavy',    name: '重炮弹', hint: '单发高伤：路径命中 70，落点大爆炸', dmg: 70, radius: 16, falloff: 0.5, scatter: 0 },
      { id: 'standard', name: '标准弹', hint: '均衡：路径命中 40，落点爆炸',       dmg: 40, radius: 11, falloff: 0.5, scatter: 0 },
      { id: 'scatter',  name: '散弹',   hint: '落点炸开 5 团弹片，每团 22 伤害',    dmg: 15, radius: 9,  falloff: 0.4, scatter: 5 }
    ],

    /* 位移（把本回合行动改为沿函数曲线移动） */
    MAX_MOVE_DIST: 5,             // 位移上限（游戏坐标单位，全场宽 50）
    MOVE_PICKUP_RADIUS: 16,       // 位移途中拾取奖励包的半径（像素）
    MOVE_ANIM_TIME: 700,          // 位移动画时长（毫秒）

    /* 奖励包：每回合结束后概率刷新，炮弹击中或位移碰到即归当前玩家 */
    PACK_SPAWN_CHANCE: 0.4,
    PACK_MAX_ON_FIELD: 3,
    PACK_PICKUP_RADIUS: 18,
    PACKS: [
      { id: 'heal',  label: '补', name: '维修包',   hint: '生命 +35' },
      { id: 'aim',   label: '瞄', name: '瞄准镜',   hint: '辅助瞄准线 +50px（本局）' },
      { id: 'power', label: '力', name: '强化弹头', hint: '下一发伤害 ×1.6' },
      { id: 'move',  label: '疾', name: '疾行靴',   hint: '位移上限 +3（本局）' }
    ],

    /* 开局技能：开局前每人选一个，对局中可用一次，使用后消耗本回合行动 */
    SKILLS: [
      { id: 'heal',      name: '应急修理', hint: '立即回复自己 45 生命' },
      { id: 'groupheal', name: '群体维修', hint: '己方全体回复 30 生命' },
      { id: 'power',     name: '火力强化', hint: '下一发伤害 ×1.6' },
      { id: 'range',     name: '侦察卫星', hint: '辅助瞄准线 +80px（本局）' }
    ],

    /* 爆炸 */
    EXPLOSION_RADIUS: 12,

    /* 瞄准辅助的显示长度（像素）
     * 只画出膛后的一小段：既能指示方向，又不会把整条弹道提前摊在战场上挡视线。
     * AIM_LINE_LENGTH：脚下射出的预瞄准射线长度；
     * PREVIEW_MAX_LENGTH：函数图像（虚线预览）沿曲线的最大绘制长度。 */
    AIM_LINE_LENGTH: 46,
    PREVIEW_MAX_LENGTH: 240,

    /* 弹道绘制节奏 */
    FUNCTION_VELOCITY: 1500,      // 每秒绘制的步数
    FUNC_FADE_TIME: 1000,
    NEXT_TURN_DELAY: 3000,        // 命中/落地后切换回合的等待时间
    TURN_TIME: 120000,            // 每回合思考时间（2 分钟）

    /* 数值积分参数 */
    FUNC_MAX_STEPS: 20000,
    FUNC_MAX_STEP_DISTANCE_SQUARED: 0.001,
    FUNC_MIN_X_STEP_DISTANCE: 0.00001,
    STEP_SIZE: 0.01,

    /* 发射角 */
    ANGLE_ERROR: Math.PI / 360,
    MAX_ANGLE_LOOPS: 100,
    ANGLE_ACCELERATION: 0.000003,

    /* 阵营与模式 */
    TEAM1: 1,
    TEAM2: 2,
    NORMAL_FUNC: 0,
    FST_ODE: 1,
    SND_ODE: 2,

    MODE_NAME: ['普通函数模式', '一阶微分方程模式', '二阶微分方程模式'],
    MODE_HINT: [
      '最经典的模式：弹道 = 你写的函数图像本身。系统会自动加上一个常数项，把曲线平移到士兵脚下，所以表达式里写任何常数都不影响结果。',
      '输入 y\' = f(x, y)：以士兵的位置作为初值，用四阶龙格—库塔法求解微分方程，解曲线就是弹道（不再平移）。',
      '输入 y\'\' = f(x, y, y\')：需要两个初值——士兵位置与发射角。用键盘 ↑ / ↓ 或左侧滑条调整炮口角度，这是唯一受角度影响的模式。'
    ],

    TEAM_NAME: { 1: '左军·绿方', 2: '右军·青方', 3: '橙　方', 4: '紫　方',
                 5: '棕　方', 6: '粉　方', 7: '灰　方', 8: '金　方' },
    TEAM_COLOR: { 1: '#2f9e5c', 2: '#0f8f8f', 3: '#f59e0b', 4: '#8b5cf6',
                  5: '#b45309', 6: '#ec4899', 7: '#64748b', 8: '#eab308' },

    /* 手绘弹道（画函数）
     * 笔画只用来确定方向与走向：先拟合成一条多项式曲线，再当作普通函数发射，
     * 因此它会像写出来的函数一样一直飞到撞上东西为止（无限延长）。
     * SKETCH_SPAN：画板与战场同比例（770:450），故笔迹按画板宽度 1:1 映射到战场像素 */
    SKETCH_SPAN: 770,
    SKETCH_DEGREE: 2,         // 拟合次数（二次=抛物线，能表达绝大多数手绘走向）

    /* AI 参数 */
    AI: {
      1: { generations: 6, population: 24, elite: 4, budgetMs: 500 },
      2: { generations: 12, population: 40, elite: 6, budgetMs: 1100 },
      3: { generations: 24, population: 64, elite: 8, budgetMs: 2000 }
    },
    AI_MAX_STEPS: 6000,           // AI 试算时的最大步数（截断以提速）

    /* 联机快捷语 / 互动：对局中一键发给对手的预设语句。
     * 服务器只按 id 白名单转发（见 server.js），因此无法发送任意内容，杜绝骚扰。 */
    QUICK_PHRASES: [
      { id: 'hurry', label: '催一催', text: '快点啦，就等你这发啦～' },
      { id: 'go', label: '开始吧', text: '开始吧，我已经准备好啦！' },
      { id: 'good', label: '打得好', text: '这发打得漂亮！' },
      { id: 'lucky', label: '运气不错', text: '运气不错嘛，再来一发？' },
      { id: 'close', label: '就差一点', text: '就差一点点，稳住！' },
      { id: 'oops', label: '手滑了', text: '手滑了…这发不算！' },
      { id: 'gg', label: 'GG', text: 'GG，打得不错！' }
    ]
  };

  GW.C = C;

  /* 快捷语 id → 语句 查找（客户端与服务器共用） */
  GW.quickPhrase = function (id) {
    var list = C.QUICK_PHRASES;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };

  /* 按 id 查武器 / 奖励包 / 技能 */
  GW.weaponById = function (i) { return C.WEAPONS[i] || C.WEAPONS[1]; };
  GW.packById = function (id) {
    var list = C.PACKS;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };
  GW.skillById = function (id) {
  var list = C.SKILLS;
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
};

/* ---------------- 多人席位规则（本地 / 服务器 / 点对点共用） ---------------- */
GW.clampPlayerCount = function (n) {
  var v = parseInt(n, 10);
  if (isNaN(v)) return 2;
  return Math.max(2, Math.min(C.MAX_PLAYERS, v));
};

/** 队伍总数 → 合法值（2..MAX_TEAMS） */
GW.clampTeamCount = function (n) {
  var v = parseInt(n, 10);
  if (isNaN(v)) return 2;
  return Math.max(2, Math.min(C.MAX_TEAMS, v));
};

/** 每队人数 → 合法值（1..MAX_PER_TEAM，且不能让 队伍总数 × 每队人数 超出 MAX_PLAYERS） */
GW.clampPerTeam = function (n, teams) {
  var v = parseInt(n, 10);
  if (isNaN(v)) v = 1;
  v = Math.max(1, Math.min(C.MAX_PER_TEAM, v));
  var t = GW.clampTeamCount(teams);
  while (t * v > C.MAX_PLAYERS && v > 1) v--;          // 超上限就自动往下收
  return v;
};

/** 赛制 → 总人数：这是「多人模式」唯一的人口——先选队伍总数，再选每队人数 */
GW.seatsFromRoster = function (teams, perTeam) {
  var t = GW.clampTeamCount(teams);
  var p = GW.clampPerTeam(perTeam, t);
  return { teams: t, perTeam: p, count: t * p };
};

/** 总人数 → 赛制（历史接口的反推：偶数人数两队各半，奇数人人一队混战） */
GW.rosterFromSeats = function (playerCount) {
  var n = GW.clampPlayerCount(playerCount);
  if (n % 2 === 0) return { teams: 2, perTeam: n / 2, count: n };
  return { teams: n, perTeam: 1, count: n };
};

/** 席位 i（从 0 起）属于哪一队：按「队伍总数」轮流分配，人人一队时每队就 1 人 */
GW.seatTeamIn = function (teams, i) {
  var t = GW.clampTeamCount(teams);
  return ((parseInt(i, 10) || 0) % t) + 1;
};

/** 兼容旧签名：GW.seatTeam(playerCount, i) */
GW.seatTeam = function (playerCount, i) {
  return GW.seatTeamIn(GW.rosterFromSeats(playerCount).teams, i);
};

/** 席位名：第几队 · 队内第几号（3 队 2 人时是「第 2 队 · 2 号」） */
GW.seatName = function (teams, i) {
  var t = GW.clampTeamCount(teams);
  var idx = parseInt(i, 10) || 0;
  return '第 ' + GW.seatTeamIn(t, idx) + ' 队 · ' + (Math.floor(idx / t) + 1) + ' 号';
};

/** 赛制 → 标签：teamLabel(2,2) = 2v2、teamLabel(3,2) = 2v2v2、teamLabel(3,1) = 1v1v1；
 *  只传一个参数时按人数反推赛制（4 = 2v2、6 = 3v3、3 = 1v1v1）。 */
GW.teamLabel = function (a, b) {
  var t, p;
  if (b == null) { var r = GW.rosterFromSeats(a); t = r.teams; p = r.perTeam; }
  else { t = GW.clampTeamCount(a); p = GW.clampPerTeam(b, t); }
  var parts = [];
  for (var i = 0; i < t; i++) parts.push(p);
  return parts.join('v');
};

/** 赛制 + 每人士兵数 → 每队需要几个落座位 */
GW.teamQuota = function (teams, perTeam, soldiersPerPlayer) {
  var r = GW.seatsFromRoster(teams, perTeam);
  var per = r.count > 2 ? 1 : Math.max(1, Math.min(C.MAX_SOLDIERS_PER_PLAYER, parseInt(soldiersPerPlayer, 10) || 2));
  var quota = [];
  for (var i = 0; i < r.teams; i++) quota.push(r.perTeam * per);
  return quota;
};

  /* 像素坐标 → 游戏坐标 */
  GW.toGameX = function (px) {
    return (C.PLANE_GAME_LENGTH * (px - C.PLANE_LENGTH / 2)) / C.PLANE_LENGTH;
  };
  GW.toGameY = function (py) {
    return (C.PLANE_GAME_LENGTH * (-py + C.PLANE_HEIGHT / 2)) / C.PLANE_LENGTH;
  };
  /* 游戏坐标 → 像素坐标 */
  GW.toPlaneX = function (gx) {
    return (C.PLANE_LENGTH * gx) / C.PLANE_GAME_LENGTH + C.PLANE_LENGTH / 2;
  };
  GW.toPlaneY = function (gy) {
    return (-C.PLANE_LENGTH * gy) / C.PLANE_GAME_LENGTH + C.PLANE_HEIGHT / 2;
  };

  /* 标准正态分布随机量（Box-Muller） */
  GW.gaussRandom = function () {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  GW.randInt = function (n) { return Math.floor(Math.random() * n); };

})(typeof window !== 'undefined' ? window : globalThis);
