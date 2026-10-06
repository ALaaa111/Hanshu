/* ============================================================
 * 界面控制层：画面切换、输入交互、手绘弹道、顶部函数数值显示、计时、结算、教程接线
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});
  var C = GW.C;

  function $(id) { return document.getElementById(id); }
  /* 在无 location 的环境（如测试用的 DOM 桩）下安全取址 */
  function loc() { return (typeof location !== 'undefined' && location) ? location : {}; }

  var HELP_HTML = [
    '<h4>一、怎么玩</h4>',
    '<ul><li>双方各有若干名士兵，<b>轮流</b>输入一条函数（一次只能一名士兵开炮）；</li>',
    '<li>这条函数会经过平移/积分，变成从该士兵脚下飞出的<b>弹道</b>；</li>',
    '<li>弹道撞到山体即停止并炸出缺口，经过敌方士兵即将其消灭；</li>',
    '<li>某一方士兵<b>全部阵亡</b>即判负，同时全灭为平局。</li></ul>',
    '<h4>二、两种给出弹道的方式</h4>',
    '<ul><li><b>写函数</b>（底部）：直接输入表达式，例如 <code>-((x+16)*(x-14))/20</code>；</li>',
    '<li><b>画函数</b>（战场左侧）：在画板上按住拖出一笔，它<b>只决定方向</b>——' +
    '系统会自动拟合成一条函数式（显示在屏幕最上方），然后把它<b>无限延长</b>飞出去，' +
    '直到撞上东西为止。松手后还能用「方向 / 大小」继续微调。</li></ul>',
    '<h4>三、计分</h4>',
    '<ul><li>命中敌方士兵：<b>+100 分</b>；</li>',
    '<li>误伤己方士兵（含自己队友）：<b>−50 分</b>；</li>',
    '<li>胜负仍以「全歼对方」为准，积分只是过程评价。</li></ul>',
    '<h4>四、三种弹道模式</h4>',
    '<ul><li><b>普通函数</b>：写 <code>y = f(x)</code>，系统会加常数把曲线平移到士兵脚下，所以常数项无意义；</li>',
    '<li><b>一阶微分方程</b>：写 <code>y\' = f(x, y)</code>，以士兵位置为初值做 RK4 数值解；</li>',
    '<li><b>二阶微分方程</b>：写 <code>y\'\' = f(x, y, y\')</code>，初值为士兵位置 + <b>发射角</b>（用 ↑ / ↓ 调整）。</li></ul>',
    '<h4>五、函数书写规则</h4>',
    '<table class="syntax-grid">',
    '<tr><th>类别</th><th>可写内容</th></tr>',
    '<tr><td>变量</td><td><code>x</code>、<code>y</code>、<code>y\'</code></td></tr>',
    '<tr><td>运算符</td><td><code>+</code> <code>-</code> <code>*</code> <code>/</code> <code>^</code></td></tr>',
    '<tr><td>函数</td><td><code>sqrt()</code> <code>log()</code>（底10）<code>ln()</code> <code>abs()</code> <code>sin()</code> <code>cos()</code> <code>tan()</code></td></tr>',
    '<tr><td>常量 / 简写</td><td><code>e</code>、<code>pi</code>、<code>exp(x)</code>、省略乘号 <code>2x</code>、全角括号与中文符号自动识别</td></tr>',
    '</table>',
    '<h4>六、三个最常踩的坑</h4>',
    '<ul><li><b>常数无效</b>：<code>2*x+3</code> 与 <code>2*x-8</code> 射出的是同一条轨迹；</li>',
    '<li><b>坐标只有 ±25</b>：<code>x^2</code> 会瞬间冲上天，请缩放为 <code>(x^2)/50</code> 这类写法；</li>',
    '<li><b>定义域爆炸</b>：己方总在左半场（x 为负），所以 <code>sqrt(x)</code> 会当场炸掉，应写 <code>sqrt(abs(x))</code>。</li></ul>',
    '<h4>七、操作</h4>',
    '<ul><li>输入表达式后回车 = 发射；会出现虚线预览与<b>预瞄准线</b>（随函数实时改变方向）；</li>',
    '<li>二阶模式下 <b>↑ / ↓</b> 调整发射角；</li>',
    '<li>每回合思考限时 <b>2 分钟</b>，超时自动跳过；</li>',
    '<li>屏幕<b>最上方</b>始终显示刚刚操作的那条函数：写函数显示原式，画函数显示拟合出来的解析式。</li></ul>'
  ].join('');

  GW.UI = function UI() {
    /* 赛制：队伍总数 teams × 每队人数 perTeam = 总人数（本地 / 联机 / 点对点共用） */
    this.settings = {
      opponent: 'human', mode: C.NORMAL_FUNC,
      soldiers: 2, difficulty: 2, players: 2,
      teams: 2, perTeam: 1,
      turnTime: 120          // 每回合思考时间（秒），0 = 不限时
    };
    this.game = null;
    this.renderer = null;
    this.tutorial = new GW.Tutorial(this);
    this.previewTimer = null;
    this.isTutorial = false;
    this._toastTimer = null;
    /* 行动设置：攻击 / 位移 + 武器三选一 + 位移距离 */
    this.action = 'fire';       // fire | move
    this.weapon = 1;            // 0 重炮弹 / 1 标准弹 / 2 散弹
    this.moveDist = 3;          // 位移距离（格）
    /* 联机状态 */
    this.net = null;
    this.isRemote = false;
    this.myTeam = 0;
    this.botTeam = -1;          // 联机中由 AI 顶替的阵营下标（−1 表示无）
    this.isHost = false;        // 点对点联机中：本机就是权威端（房主的浏览器当服务器）
    this._mirrorExpr = '';      // 手绘拟合式镜像到函数输入框的当前值（用于避免覆盖手动修改）
    this._mpLink = 'room';      // 联机方式：room = 房间联机（PeerJS 公共云信令 + WebRTC 直连，零服务器）
    /* 战场缩放（手机端看全边框 / 桌面端看细节） */
    this.zoom = 1; this.panX = 0; this.panY = 0; this._zoomBound = false;
    this.mpTurnTime = 120;      // 联机创建房间时的每回合时间（秒），0 = 不限
    this._bindStaticUI();
    this._bindSketch();
    this._bindWindows();
    this._bindLobby();
    this._bindZoom();
  };

  /* ---------------- 战场缩放：按钮 + 双指捏合 + 滚轮 ---------------- */
  GW.UI.prototype._bindZoom = function () {
    var self = this;
    if (this._zoomBound) return;
    this._zoomBound = true;
    var stage = $('stage');
    if (!stage) return;

    function apply() {
      var z = self.zoom, px = self.panX, py = self.panY;
      stage.style.transform = 'translate(' + px + 'px,' + py + 'px) scale(' + z + ')';
      var lbl = $('zoom-label');
      if (lbl) lbl.textContent = Math.round(z * 100) + '%';
    }
    this._applyStageZoom = apply;

    function setZoom(z) {
      self.zoom = Math.max(0.4, Math.min(4, z));
      apply();
    }
    this.setZoom = function (z) { setZoom(z); };

    // 按钮
    var bOut = $('zoom-out'), bIn = $('zoom-in'), bReset = $('zoom-reset');
    if (bOut) bOut.onclick = function () { setZoom(self.zoom / 1.3); };
    if (bIn) bIn.onclick = function () { setZoom(self.zoom * 1.3); };
    if (bReset) bReset.onclick = function () { self.zoom = 1; self.panX = 0; self.panY = 0; apply(); };

    // 滚轮（桌面）
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      setZoom(self.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });

    // 双指捏合 + 双指拖动平移
    var pinch = null;
    function tdist(t) {
      var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function tmid(t) {
      return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
    }
    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        pinch = { d: tdist(e.touches), z: self.zoom, mid: tmid(e.touches) };
        e.preventDefault();
      }
    }, { passive: false });
    stage.addEventListener('touchmove', function (e) {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        var d = tdist(e.touches);
        var m = tmid(e.touches);
        setZoom(pinch.z * d / pinch.d);
        self.panX += m.x - pinch.mid.x;
        self.panY += m.y - pinch.mid.y;
        pinch.mid = m;
        apply();
      }
    }, { passive: false });
    stage.addEventListener('touchend', function (e) {
      if (e.touches.length < 2) pinch = null;
    });
  };

  /* ---------------- 浮动次级窗口：拖动 + 最小化 ---------------- */
  GW.UI.prototype._bindWindows = function () {
    var self = this;
    function bindMin(btnId, winId) {
      var btn = $(btnId), win = $(winId);
      if (!btn || !win) return;
      btn.onclick = function (e) {
        e.stopPropagation();
        win.classList.toggle('min');
        btn.textContent = win.classList.contains('min') ? '□' : '—';
        if (self.renderer) self.renderer.resize();
        if (self.sketch) self.sketch.resize();
      };
    }
    bindMin('win-min-draw', 'panel-draw');
    bindMin('win-min-console', 'input-block');

    function bindDrag(handleId, winId) {
      var handle = $(handleId), win = $(winId);
      /* 手机端面板是贴底抽屉，拖着跑反而挡战场 */
      if (!handle || !win) return;
      if (self._isSheetMode && self._isSheetMode()) return;
      var sx = 0, sy = 0, ol = 0, ot = 0, dragging = false;
      function down(e) {
        if (e.target && e.target.tagName === 'BUTTON') return;   // 不拦截按钮点击
        dragging = true;
        var pt = e.touches ? e.touches[0] : e;
        sx = pt.clientX; sy = pt.clientY;
        var r = win.getBoundingClientRect();
        win.style.left = r.left + 'px';
        win.style.top = r.top + 'px';
        win.style.right = 'auto';
        win.style.bottom = 'auto';
        ol = r.left; ot = r.top;
        e.preventDefault();
      }
      function move(e) {
        if (!dragging) return;
        var pt = e.touches ? e.touches[0] : e;
        var nl = ol + (pt.clientX - sx);
        var nt = ot + (pt.clientY - sy);
        var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
        var r = win.getBoundingClientRect();
        nl = Math.max(4, Math.min(vw - r.width - 4, nl));
        nt = Math.max(4, Math.min(vh - 36, nt));
        win.style.left = nl + 'px';
        win.style.top = nt + 'px';
        e.preventDefault();
      }
      function up() { dragging = false; }
      handle.addEventListener('mousedown', down);
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      handle.addEventListener('touchstart', down, { passive: false });
      document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('touchend', up);
    }
    bindDrag('drag-draw', 'panel-draw');
    bindDrag('drag-console', 'input-block');
    this._bindSheetTabs();
  };

  /** 手机端（宽度 ≤ 760px）：两块面板改为贴底抽屉，由底部标签条切换 */
  GW.UI.prototype._bindSheetTabs = function () {
    var self = this;
    ['draw', 'console', 'none'].forEach(function (id) {
      var btn = $('win-tab-' + id);
      if (!btn) return;
      btn.onclick = function () { self._setSheet(id); };
    });
    this._syncSheetMode();
    if (window.addEventListener) {
      window.addEventListener('resize', function () { self._syncSheetMode(); });
      window.addEventListener('orientationchange', function () {
        setTimeout(function () { self._syncSheetMode(); }, 120);
      });
    }
  };

  GW.UI.prototype._isSheetMode = function () {
    var w = (window && window.innerWidth) || 1200;
    return w <= 760;
  };

  /** id: draw | console | none */
  GW.UI.prototype._setSheet = function (id) {
    var el = $('screen-game');
    if (!el) return;
    ['sheet-draw', 'sheet-console', 'sheet-none'].forEach(function (c) { el.classList.remove(c); });
    el.classList.add('sheet-' + id);
    var tabs = document.querySelectorAll ? document.querySelectorAll('.win-tab') : [];
    Array.prototype.forEach.call(tabs, function (b) {
      b.classList.toggle('active', b.getAttribute('data-sheet') === id);
    });
    if (this.renderer) this.renderer.resize();
    if (this.sketch) this.sketch.resize();
  };

  GW.UI.prototype._syncSheetMode = function () {
    var el = $('screen-game');
    if (!el) return;
    if (!this._isSheetMode()) {
      ['sheet-draw', 'sheet-console', 'sheet-none'].forEach(function (c) { el.classList.remove(c); });
      return;
    }
    var has = false;
    ['sheet-draw', 'sheet-console', 'sheet-none'].forEach(function (c) { has = has || el.classList.contains(c); });
    if (!has) this._setSheet('none');
  };

  /* ---------------- 静态按钮 ---------------- */
  GW.UI.prototype._bindStaticUI = function () {
    var self = this;

    /* 菜单 */
    $('btn-menu-start').onclick = function () { self.showScreen('screen-setup'); };
    $('btn-menu-tutorial').onclick = function () { self.startTutorial(); };
    $('btn-menu-help').onclick = function () { self.openHelp(); };
    $('btn-menu-online').onclick = function () { self.enterLobby(); };

    /* 设置页 */
    this._bindSeg('seg-opponent', function (v) {
      self.settings.opponent = v;
      self._syncOpponentUI();
    });
    this._bindSeg('seg-mode', function (v) {
      self.settings.mode = parseInt(v, 10);
      $('mode-hint').textContent = C.MODE_HINT[self.settings.mode];
    });
    this._bindSeg('seg-soldiers', function (v) { self.settings.soldiers = parseInt(v, 10); });
    this._bindSeg('seg-players', function (v) { self.settings.players = parseInt(v, 10); });
    this._bindSeg('seg-difficulty', function (v) { self.settings.difficulty = parseInt(v, 10); });
    /* 每回合时间（秒） */
    this._bindSeg('seg-turntime', function (v) { self.settings.turnTime = parseInt(v, 10); });
    /* 多人模式：队伍总数 / 每队人数 */
    this._bindSeg('seg-teams', function (v) {
      self.settings.teams = parseInt(v, 10);
      if (self.settings.teams * self.settings.perTeam > C.MAX_PLAYERS) {
        self.settings.perTeam = C.MAX_PER_TEAM;
        self._switchSegValue('seg-perteam', String(self.settings.perTeam));
      }
      self._syncRosterNote();
    });
    this._bindSeg('seg-perteam', function (v) {
      self.settings.perTeam = parseInt(v, 10);
      if (self.settings.teams * self.settings.perTeam > C.MAX_PLAYERS) {
        self.settings.perTeam = GW.clampPerTeam(self.settings.perTeam, self.settings.teams);
        self._switchSegValue('seg-perteam', String(self.settings.perTeam));
      }
      self._syncRosterNote();
    });
    this._bindSeg('seg-difficulty', function (v) { self.settings.difficulty = parseInt(v, 10); });
    $('mode-hint').textContent = C.MODE_HINT[this.settings.mode];
    this._syncOpponentUI();

    $('btn-setup-back').onclick = function () { self.showScreen('screen-menu'); };
    $('btn-setup-start').onclick = function () { self.startLocalGame(); };

    /* 对战页 */
    $('btn-fire').onclick = function () { self.fire(); };
    $('key-fire-go').onclick = function () { self.fire(); };
    $('btn-help').onclick = function () { self.openHelp(); };
    $('btn-restart').onclick = function () { self.restart(); };
    $('btn-quit').onclick = function () { self.quitToMenu(); };

    /* 行动 / 炮弹 / 技能：正式对局在「回合准备」弹窗里选（回合开始前），
     * 教程模式下这三组控件直接显示在指令台里（#legacy-order），用于逐步讲解。 */
    this._bindSeg('seg-action', function (v) { self._applyAction(v); });
    var weapons = document.querySelectorAll('#weapon-row .weapon');
    Array.prototype.forEach.call(weapons, function (btn) {
      btn.onclick = function () { self._setWeapon(parseInt(btn.getAttribute('data-w'), 10) || 0); };
    });
    var moveRange = $('move-dist');
    if (moveRange) moveRange.addEventListener('input', function () {
      self.moveDist = parseInt(moveRange.value, 10) || 3;
      $('move-dist-val').textContent = self.moveDist + ' 格';
    });
    var skillBtn = $('btn-skill');
    if (skillBtn) skillBtn.onclick = function () { self.useSkill(); };
    var orderChange = $('btn-order-change');
    if (orderChange) orderChange.onclick = function () { self.openTurnPrep(); };
    var fab0 = $('skill-fab');
    if (fab0) fab0.onclick = function () { self.openTurnPrep(); };
    this._bindTurnPrep();

    /* 快捷语（联机互动）：点「快捷语」弹出预设语句，点空白处收起 */
    $('btn-quick').onclick = function (e) { e.stopPropagation(); self.toggleQuick(); };
    var quickPop = $('quick-pop');
    if (quickPop) quickPop.addEventListener('click', function (e) { e.stopPropagation(); });
    this._buildQuickList();
    document.addEventListener('click', function () { self.hideQuick(); });

    $('expr-input').addEventListener('input', function () { self.schedulePreview(); });
    $('expr-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); self.fire(); }
    });

    /* 符号键盘 */
    var keys = document.querySelectorAll('#keypad .key');
    Array.prototype.forEach.call(keys, function (btn) {
      btn.onclick = function () { self.insertToken(btn.getAttribute('data-ins')); };
    });
    /* 示例函数 */
    var chips = document.querySelectorAll('.chip[data-func]');
    Array.prototype.forEach.call(chips, function (btn) {
      btn.onclick = function () {
        $('expr-input').value = btn.getAttribute('data-func');
        self.schedulePreview();
        $('expr-input').focus();
      };
    });

    /* 角度 */
    $('btn-angle-up').onclick = function () { self.adjustAngle(+1); };
    $('btn-angle-down').onclick = function () { self.adjustAngle(-1); };
    document.addEventListener('keydown', function (e) {
      if (self.game && self.game.mode === C.SND_ODE && $('screen-game').classList.contains('active')) {
        if (e.key === 'ArrowUp') { e.preventDefault(); self.adjustAngle(+1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); self.adjustAngle(-1); }
      }
    });

    /* 弹窗 */
    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (el) {
      el.onclick = function () { $(el.getAttribute('data-close')).classList.add('hidden'); };
    });
    $('btn-result-menu').onclick = function () {
      $('result-modal').classList.add('hidden');
      self.quitToMenu();
    };
    $('btn-result-again').onclick = function () {
      $('result-modal').classList.add('hidden');
      self.restart();
    };

    /* 教程按钮 */
    $('tut-next').onclick = function () { self.tutorial.next(); };
    $('tut-prev').onclick = function () { self.tutorial.prev(); };
    $('tut-exit').onclick = function () { self.tutorial.stop(); };
    $('tut-min').onclick = function () { self.tutorial.toggleMin(); };

    /* 画布：坐标提示 */
    var canvas = $('stage');
    canvas.addEventListener('mousemove', function (e) {
      if (!self.renderer) return;
      var rect = canvas.getBoundingClientRect();
      self.renderer.setMouse({
        x: ((e.clientX - rect.left) / rect.width) * C.PLANE_LENGTH,
        y: ((e.clientY - rect.top) / rect.height) * C.PLANE_HEIGHT
      });
    });
    canvas.addEventListener('mouseleave', function () {
      if (self.renderer) self.renderer.setMouse(null);
    });

    $('help-body').innerHTML = HELP_HTML;
    window.addEventListener('resize', function () { self.onResize(); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { self.onResize(); });
    }
  };

  GW.UI.prototype.onResize = function () {
    if (this.renderer) this.renderer.resize();
    if (this.sketch) this.sketch.resize();
    if (this.tutorial) this.tutorial.refresh();
  };

  /* ---------------- 顶部：函数数值显示 ---------------- */
  /**
   * @param text  函数解析式（写函数=原式，画函数=拟合式）
   * @param opts  {mode:'idle'|'preview'|'fired', team:1|2}
   */
  GW.UI.prototype.setFuncDisplay = function (text, opts) {
    var el = $('func-display');
    if (!el) return;
    opts = opts || {};
    var label = $('func-label');
    var mode = opts.mode || 'idle';
    el.classList.remove('idle', 'preview', 't1', 't2');
    if (!text) {
      el.textContent = '等待第一条指令…';
      el.classList.add('idle');
      label.textContent = '当前弹道指令';
      return;
    }
    el.textContent = text;
    if (mode === 'preview') el.classList.add('preview');
    if (opts.team) el.classList.add('t' + opts.team);
    label.textContent =
      mode === 'preview' ? '预览（尚未发射）· ' + (C.TEAM_NAME[opts.team] || '') :
        mode === 'fired' ? '已发射 · ' + (C.TEAM_NAME[opts.team] || '') :
          '当前弹道指令';
  };

  /** 事件浮层：替代原来的战斗日志，只在战场上短暂停留 */
  GW.UI.prototype.toast = function (text, kind) {
    var el = $('stage-toast');
    if (!el) return;
    if (this._toastId && typeof clearTimeout === 'function') clearTimeout(this._toastId);
    el.className = 'stage-toast ' + (kind || '');
    el.textContent = text;
    el.classList.remove('hidden');
    this._toastId = setTimeout(function () {
      try { el.classList.add('hidden'); } catch (e) { /* 忽略 */ }
    }, 2600);
  };

  GW.UI.prototype.addLog = function (text, kind) {
    /* 战斗日志已取消：改为在战场上短暂停留的事件浮层 */
    this.toast(text, kind);
  };

  /* ---------------- 快捷语（联机互动） ---------------- */
  GW.UI.prototype._buildQuickList = function () {
    var self = this;
    var list = $('quick-pop-list');
    if (!list) return;
    list.innerHTML = '';
    (C.QUICK_PHRASES || []).forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'quick-item';
      b.textContent = p.label;
      b.title = p.text;
      b.onclick = function (e) { e.stopPropagation(); self.sendQuick(p); };
      list.appendChild(b);
    });
  };

  GW.UI.prototype.toggleQuick = function () {
    var pop = $('quick-pop');
    if (pop) pop.classList.toggle('hidden');
  };

  GW.UI.prototype.hideQuick = function () {
    var pop = $('quick-pop');
    if (pop) pop.classList.add('hidden');
  };

  /** 快捷语入口只在联机对局中出现 */
  GW.UI.prototype.setQuickVisible = function (v) {
    var btn = $('btn-quick');
    if (btn) btn.classList.toggle('hidden', !v);
    if (!v) this.hideQuick();
  };

  GW.UI.prototype.sendQuick = function (p) {
    if (!p) return;
    if (this.isRemote && this.net) {
      this.net.chat(p.id, p.text);
      this.toast('我：' + p.text, 'me');   // 本地回显；对手端由其 chat 事件展示
    } else {
      this.toast('快捷语用于联机对战：催一催、夸一夸对手。', 'sys');
    }
    this.hideQuick();
  };

  /* ---------------- 手绘画板 ---------------- */
  GW.UI.prototype._bindSketch = function () {
    var self = this;
    this.sketch = new GW.SketchPad($('sketch'), {
      onChange: function () { self.onSketchChanged(); }
    });

    $('btn-sketch-clear').onclick = function () { self.sketch.clear(); };

    function bindRange(id, apply) {
      var el = $(id);
      el.addEventListener('input', function () { apply(parseFloat(el.value)); });
      return el;
    }
    this.rotRange = bindRange('sketch-rot', function (v) { self.setSketchRot(v); });
    this.scaleRange = bindRange('sketch-scale', function (v) { self.setSketchScale(v / 100); });

    $('btn-rot-down').onclick = function () { self.setSketchRot(self.sketch.rot - 15); };
    $('btn-rot-up').onclick = function () { self.setSketchRot(self.sketch.rot + 15); };
    $('btn-rot-reset').onclick = function () { self.setSketchRot(0); };
    $('btn-scale-down').onclick = function () { self.setSketchScale(self.sketch.scale - 0.15); };
    $('btn-scale-up').onclick = function () { self.setSketchScale(self.sketch.scale + 0.15); };

    $('btn-sketch-fire').onclick = function () { self.fireSketch(); };
  };

  GW.UI.prototype.setSketchRot = function (deg) {
    while (deg > 180) deg -= 360;
    while (deg < -180) deg += 360;
    deg = Math.round(deg);
    this.sketch.setTransform(deg, this.sketch.scale);
    $('sketch-rot').value = deg;
    $('sketch-rot-val').textContent = (deg > 0 ? '+' : '') + deg + '°';
    this.onSketchChanged();
  };

  GW.UI.prototype.setSketchScale = function (s) {
    s = Math.max(0.3, Math.min(2.2, Math.round(s * 100) / 100));
    this.sketch.setTransform(this.sketch.rot, s);
    $('sketch-scale').value = Math.round(s * 100);
    $('sketch-scale-val').textContent = s.toFixed(2) + '×';
    this.onSketchChanged();
  };

  GW.UI.prototype.sketchTraj = function () {
    var g = this.game;
    if (!g || !this.sketch || this.sketch.isEmpty()) return null;
    return g.buildSketchTrajectory(this.sketch.stroke(), this.sketch.rot, this.sketch.scale);
  };

  GW.UI.prototype.onSketchChanged = function () {
    var g = this.game;
    if (!g || !this.renderer || g.state !== 'aim') { return; }
    var status = $('sketch-status');
    if (g.players[g.currentTurn].isAI) { return; }
    if (this.sketch.isEmpty()) {
      status.textContent = '按住拖动即可定方向，松手后可继续微调';
      status.className = 'expr-status';
      this.renderer.setPreview(null);
      if (this._mirrorExpr && $('expr-input').value === this._mirrorExpr) $('expr-input').value = '';
      this._mirrorExpr = '';
      this.setFuncDisplay(this.lastFired || '', { mode: 'idle', team: this.lastFiredTeam });
      return;
    }
    var traj = this.sketchTraj();
    if (!traj || traj.numSteps < 2) {
      status.textContent = '✗ 这一笔飞不远（多半角度太陡），请重画或调小尺寸';
      status.className = 'expr-status error';
      this.renderer.setPreview(null);
      return;
    }
    status.innerHTML = '✓ 可发射 · 拟合函数 <b>' + escapeHtml(traj.expr || '') + '</b>' +
      (traj.hits.length ? ' · 路径上会命中 <b>' + traj.hits.length + '</b> 名士兵' : '');
    status.className = traj.hits.length ? 'expr-status ok' : 'expr-status';
    this.renderer.setPreview(traj);
    this._mirrorSketchExpr(traj.expr);
    this.setFuncDisplay(traj.expr, { mode: 'preview', team: g.players[g.currentTurn].team });
    this.tutorial.notify('sketch');
    this.tutorial.notify('preview');
  };

  /** 把手绘拟合出的函数式镜像到下方函数输入框，便于玩家做细微修改。
   *  仅在输入框为空或仍等于上次镜像值时覆盖，避免冲掉玩家的手动修改。 */
  GW.UI.prototype._mirrorSketchExpr = function (expr) {
    if (!expr) return;
    var input = $('expr-input');
    if (input.disabled) return;
    if (input.value === '' || input.value === this._mirrorExpr) {
      input.value = expr;
      this._mirrorExpr = expr;
      this.schedulePreview();
    }
  };

  GW.UI.prototype.fireSketch = function () {
    var g = this.game;
    if (!g || g.state !== 'aim') return;
    /* 本回合选了「位移」时，手绘窗口的按钮同样走位移（沿手绘路线走一段） */
    if (this.action === 'move') { this.doMove(); return; }
    var status = $('sketch-status');
    if (this.isRemote && !this.isHost) {
      if (g.currentTurn !== this.myTeam) { this.toast('还没轮到你。', 'sys'); return; }
      if (this.sketch.isEmpty()) {
        status.textContent = '✗ 请先在左侧画板上拖出一条曲线';
        status.className = 'expr-status error';
        return;
      }
      var traj0 = this.sketchTraj();
      if (!traj0 || traj0.numSteps < 2) {
        status.textContent = '✗ 这一笔无法形成有效弹道，请重画或调小尺寸';
        status.className = 'expr-status error';
        return;
      }
      this.net.sketch(this.sketch.stroke(), this.sketch.rot, this.sketch.scale);
      this.setSketchRot(0);   // 使用完手绘后方向归零，下次重画从 0° 开始
      return;
    }
    if (g.players[g.currentTurn].isAI) {
      this.toast('现在是电脑回合，请稍候。', 'sys');
      return;
    }
    if (this.sketch.isEmpty()) {
      status.textContent = '✗ 请先在左侧画板上拖出一条曲线';
      status.className = 'expr-status error';
      return;
    }
    var traj = this.sketchTraj();
    if (!traj || traj.numSteps < 2) {
      status.textContent = '✗ 这一笔无法形成有效弹道，请重画';
      status.className = 'expr-status error';
      return;
    }
    var res = g.fireTrajectory(traj, traj.expr, C.FUNCTION_VELOCITY, this.weapon);
    if (!res.ok) {
      status.textContent = '✗ ' + res.reason;
      status.className = 'expr-status error';
      return;
    }
    status.textContent = '已出膛，拟合函数：' + (traj.expr || '');
    status.className = 'expr-status';
    this.lastFired = traj.expr;
    this.lastFiredTeam = g.players[g.currentTurn].team;
    this.setFuncDisplay(traj.expr, { mode: 'fired', team: this.lastFiredTeam });
    this.renderer.setPreview(null);
    this.tutorial.notify('fire');
    this.setSketchRot(0);   // 使用完手绘后方向归零，下次重画从 0° 开始
  };

  /** 对战形式切换：多人模式显示「队伍总数 / 每队人数 + 电脑难度」，双人对战显示每方士兵 */
  GW.UI.prototype._syncOpponentUI = function () {
    var multi = this.settings.opponent === 'multi';
    $('group-soldiers').style.display = multi ? 'none' : '';
    $('group-players').style.display = multi ? 'none' : '';
    $('group-roster').classList.toggle('hidden', !multi);
    $('group-difficulty').style.display = (multi || this.settings.opponent === 'ai') ? '' : 'none';
    var hint = $('opponent-hint');
    if (hint) {
      hint.innerHTML = multi
        ? '多人模式下先设好<b>队伍总数</b>与<b>每队人数</b>：例如 2 队 × 3 人 = <b>3v3 共 6 人</b>，4 队 × 2 人 = <b>2v2v2v2 共 8 人</b>；超过 2 人时每人只指挥 1 名士兵。'
        : (this.settings.opponent === 'ai' ? '这局由你先手，其余回合交给电脑。' : '双方各带若干名士兵，轮流开炮。');
    }
    this._syncRosterNote();
  };

  /** 赛制取值：队伍总数 × 每队人数（自动收敛到 2..8 人） */
  GW.UI.prototype._localRoster = function () {
    return GW.seatsFromRoster(
      this.settings.teams != null ? this.settings.teams : 2,
      this.settings.perTeam != null ? this.settings.perTeam : 1
    );
  };

  /** 赛制即时预览：共 N 人 · XvX · 每队几人 */
  GW.UI.prototype._syncRosterNote = function () {
    var el = $('roster-note');
    if (!el) return;
    var r = this._localRoster();
    el.innerHTML = '当前：<b>' + r.teams + ' 队 × ' + r.perTeam + ' 人 = 共 ' + r.count + ' 人</b>' +
      '（赛制 <b>' + GW.teamLabel(r.teams, r.perTeam) + '</b>），' +
      (r.count > 2 ? '每人 1 名士兵，打光某一整队即该队判负。' : '每人可带 ' + this.settings.soldiers + ' 名士兵。');
  };

  GW.UI.prototype._bindSeg = function (id, cb) {
    var items = document.querySelectorAll('#' + id + ' .seg-item');
    Array.prototype.forEach.call(items, function (btn) {
      btn.onclick = function () {
        Array.prototype.forEach.call(items, function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        cb(btn.getAttribute('data-value'));
      };
    });
  };

  /** 教程进行中锁定在对战页，任何界面切换都不许把教程顶掉 */
  GW.UI.prototype.showScreen = function (id) {
    if (this.tutorial && this.tutorial.isActive() && id !== 'screen-game') return;
    ['screen-menu', 'screen-setup', 'screen-game', 'screen-lobby'].forEach(function (s) {
      $(s).classList.toggle('active', s === id);
    });
  };

  GW.UI.prototype.openHelp = function () {
    if (this.tutorial && this.tutorial.isActive()) return;   // 教程期间不允许弹窗遮挡
    $('help-modal').classList.remove('hidden');
  };

  /* ============================================================
   * 回合准备：回合开始前先选好「行动 / 炮弹 / 技能」
   * 正式对局（单机 / 人机 / 联机）每次轮到真人玩家时先弹这个窗，
   * 选完才进入瞄准——避免打了一半才发现行动或炮弹选错了。
   * 教程模式下不弹此窗，三组控件直接显示在指令台里逐步讲解。
   * ============================================================ */

  /** 应用「本回合行动」：攻击 / 位移（同步指令台的只读摘要与距离滑杆） */
  GW.UI.prototype._applyAction = function (act) {
    var self = this;
    this.action = (act === 'move') ? 'move' : 'fire';
    var isMove = this.action === 'move';
    var mr = $('move-row'); if (mr) mr.classList.toggle('hidden', !isMove);
    var seg = document.querySelectorAll('#seg-action .seg-item');
    Array.prototype.forEach.call(seg, function (b) {
      b.classList.toggle('active', b.getAttribute('data-value') === self.action);
    });
    var input = $('expr-input');
    if (input) input.placeholder = isMove ? '位移曲线：函数图像就是移动路径' : '例如 ((x-3)^2)/20';
    var mh = $('move-hint');
    if (mh) mh.textContent = isMove ? '位移模式：本回合改为沿曲线移动（下方设距离），撞山/出界会被拒绝。' : '';
    var sf = $('btn-sketch-fire');
    if (sf) sf.textContent = isMove ? '沿手绘路线位移' : '发射手绘弹道';
    this._refreshOrderStrip();
    this.schedulePreview();
  };

  /** 选择炮弹（0 重炮弹 / 1 标准弹 / 2 散弹） */
  GW.UI.prototype._setWeapon = function (w) {
    var self = this;
    this.weapon = (w === 0 || w === 2) ? w : 1;
    var weapons = document.querySelectorAll('#weapon-row .weapon');
    Array.prototype.forEach.call(weapons, function (b) {
      b.classList.toggle('active', (parseInt(b.getAttribute('data-w'), 10) || 0) === self.weapon);
    });
    this._refreshOrderStrip();
  };

  /** 指令台顶部只读摘要：本回合选了哪些 */
  GW.UI.prototype._refreshOrderStrip = function () {
    var g = this.game;
    if (!g) return;
    var p = g.players[g.currentTurn];
    if (!p) return;
    var isMove = this.action === 'move';
    var ae = $('order-action-text');
    if (ae) ae.textContent = '本回合：' + (isMove ? '位移' : '攻击');
    var we = $('order-weapon-text');
    if (we) {
      we.textContent = isMove ? '炮弹：—' : ('炮弹：' + ((GW.weaponById(this.weapon) || {}).name || ''));
      we.classList.toggle('off', isMove);
    }
    var se = $('order-skill-text');
    if (se) {
      if (!p.skill) { se.textContent = '技能：无'; se.classList.add('off'); }
      else if (p.skillUsed) { se.textContent = '技能：已用'; se.classList.add('off'); }
      else { se.textContent = '技能：' + ((GW.skillById(p.skill) || {}).name || '') + '（可用）'; se.classList.remove('off'); }
    }
    var chg = $('btn-order-change');
    if (chg) chg.disabled = !this._canActNow();
  };

  /** 现在是否轮到自己行动（「重选本回合」与回合准备弹窗的开关条件） */
  GW.UI.prototype._canActNow = function () {
    var g = this.game;
    if (!g || g.state !== 'aim') return false;
    var p = g.players[g.currentTurn];
    if (!p) return false;
    if (this.isRemote) return g.currentTurn === this.myTeam && !p.isAI;
    return !p.isAI;
  };

  GW.UI.prototype._bindTurnPrep = function () {
    var self = this;
    function bindOpts(containerId, attr, onPick) {
      var box = $(containerId);
      if (!box) return;
      var opts = box.querySelectorAll('.order-opt');
      Array.prototype.forEach.call(opts, function (btn) {
        btn.onclick = function () {
          var val = btn.getAttribute(attr);
          onPick(val);
          Array.prototype.forEach.call(opts, function (b) { b.classList.toggle('active', b === btn); });
        };
      });
    }
    bindOpts('turn-action-opts', 'data-act', function (v) {
      self._prepAction = (v === 'move') ? 'move' : 'fire';
      self._syncTurnPrepBlocks();
    });
    bindOpts('turn-skill-opts', 'data-skill', function (v) {
      self._prepSkill = (v === '1');
      self._syncTurnPrepBlocks();
    });
    var ok = $('turn-ok');
    if (ok) ok.onclick = function () { self._confirmTurnPrep(); };
  };

  /** 炮弹选项按 C.WEAPONS 动态生成（展示顺序：标准弹 / 重炮弹 / 散弹） */
  GW.UI.prototype._renderTurnWeaponOpts = function () {
    var box = $('turn-weapon-opts');
    if (!box) return;
    var self = this;
    var order = [1, 0, 2], html = '', i;
    for (i = 0; i < order.length; i++) {
      var w = C.WEAPONS[order[i]];
      if (!w) continue;
      html += '<button class="order-opt" data-w="' + order[i] + '">' +
        '<b>' + escapeHtml(w.name) + '</b><span>' + escapeHtml(w.hint) + '</span></button>';
    }
    box.innerHTML = html;
    var opts = box.querySelectorAll('.order-opt');
    Array.prototype.forEach.call(opts, function (btn) {
      btn.onclick = function () {
        var w = parseInt(btn.getAttribute('data-w'), 10);
        self._prepWeapon = (w === 0 || w === 2) ? w : 1;
        Array.prototype.forEach.call(opts, function (b) { b.classList.toggle('active', b === btn); });
        self._syncTurnPrepBlocks();
      };
    });
  };

  /** 选了「使用技能」→ 行动 / 炮弹失去意义；选了「位移」→ 炮弹失去意义 */
  GW.UI.prototype._syncTurnPrepBlocks = function () {
    var using = !!this._prepSkill;
    var ab = $('turn-action-block'); if (ab) ab.classList.toggle('dim', using);
    var wb = $('turn-weapon-block'); if (wb) wb.classList.toggle('dim', using || this._prepAction === 'move');
    var ok = $('turn-ok');
    if (ok) {
      ok.textContent = using ? '使用技能（消耗本回合）'
        : (this._prepAction === 'move' ? '开始位移' : '开始攻击');
    }
  };

  /** 打开「回合准备」：只在轮到你、且处于瞄准阶段时有效 */
  GW.UI.prototype.openTurnPrep = function () {
    var g = this.game;
    if (this.isTutorial) return;
    if (!this._canActNow()) return;
    var modal = $('turn-modal');
    if (!modal) return;
    var p = g.players[g.currentTurn];
    this._prepAction = (this.action === 'move') ? 'move' : 'fire';
    this._prepWeapon = (typeof this.weapon === 'number') ? this.weapon : 1;
    this._prepSkill = false;
    this._prepOpenedAt = GW.now();

    var title = $('turn-modal-title');
    if (title) title.textContent = '第 ' + (g.round + 1) + ' 回合 · 回合准备';
    var owner = $('turn-modal-owner');
    if (owner) owner.textContent = this._seatName(g.currentTurn);
    var sk = p.skill ? (GW.skillById(p.skill) || null) : null;
    var hint = $('turn-modal-hint');
    if (hint) {
      hint.innerHTML = '轮到你了：先定好这一回合做什么，再进入瞄准。' +
        (sk ? '你的技能是「<b>' + escapeHtml(sk.name) + '</b>」（' + escapeHtml(sk.hint || '') +
              '），每局只能发动一次。' : '');
    }
    /* ① 行动 */
    var aBox = $('turn-action-opts');
    if (aBox) {
      var aOpts = aBox.querySelectorAll('.order-opt');
      Array.prototype.forEach.call(aOpts, function (b) {
        b.classList.toggle('active', b.getAttribute('data-act') === this);
      }, this._prepAction);
    }
    /* ② 炮弹 */
    this._renderTurnWeaponOpts();
    var wBox = $('turn-weapon-opts');
    if (wBox) {
      var wOpts = wBox.querySelectorAll('.order-opt');
      var curW = (this._prepWeapon === 0 || this._prepWeapon === 2) ? this._prepWeapon : 1;
      Array.prototype.forEach.call(wOpts, function (b) {
        var w = parseInt(b.getAttribute('data-w'), 10);
        w = (w === 0 || w === 2) ? w : 1;
        b.classList.toggle('active', w === curW);
      });
    }
    /* ③ 技能（只在本局还没用过时出现） */
    var skillOk = !!p.skill && !p.skillUsed;
    var skBlock = $('turn-skill-block');
    if (skBlock) skBlock.classList.toggle('hidden', !skillOk);
    if (skillOk) {
      var sh = $('turn-skill-hint');
      if (sh) sh.textContent = '立刻发动「' + sk.name + '」：' + (sk.hint || '') + '（本回合不再开炮）';
    }
    var sBox = $('turn-skill-opts');
    if (sBox) {
      var sOpts = sBox.querySelectorAll('.order-opt');
      Array.prototype.forEach.call(sOpts, function (b) {
        b.classList.toggle('active', b.getAttribute('data-skill') === '0');
      });
    }
    this._syncTurnPrepBlocks();
    modal.classList.remove('hidden');
  };

  GW.UI.prototype._confirmTurnPrep = function () {
    var g = this.game;
    var modal = $('turn-modal');
    if (modal) modal.classList.add('hidden');
    if (!g || g.state !== 'aim') { this._prepOpenedAt = 0; return; }
    /* 回合准备期间不计入思考时间：把回合起点往后推相同的毫秒数 */
    if (this._prepOpenedAt) {
      var used = GW.now() - this._prepOpenedAt;
      if (used > 0 && used < 10 * 60 * 1000) g.turnStartTime += used;
    }
    this._prepOpenedAt = 0;
    if (this._prepSkill) { this.useSkill(); return; }   // 用技能 = 消耗本回合
    this._setWeapon(this._prepWeapon);
    this._applyAction(this._prepAction);
    if (typeof this.updateTurnUI === 'function') this.updateTurnUI();
    var input = $('expr-input');
    if (input && !input.disabled) { try { input.focus(); } catch (e) { /* 忽略 */ } }
  };

  /* ---------------- 进入战斗 ---------------- */
  GW.UI.prototype.enterGame = function (isTutorial) {
    this.isTutorial = !!isTutorial;
    this.showScreen('screen-game');
    var seats = this._seatPlan();
    var multi = !isTutorial && this.settings.opponent === 'multi' ? seats.n > 2 : false;
    var opts = {
      mode: this.settings.mode,
      soldiersPerPlayer: seats.n > 2 ? 1 : this.settings.soldiers,
      opponent: isTutorial ? 'human' : this.settings.opponent,
      aiLevel: this.settings.difficulty,
      turnTimeSec: this.settings.turnTime
    };
    if (multi) { opts.teams = seats.teams; opts.perTeam = seats.perTeam; }
    else { opts.playerCount = seats.n; }
    this.game = new GW.Game(opts);
    if (isTutorial) this.game.setupTutorial();
    this._assignDefaultSkills();
    this.renderer = new GW.Renderer($('stage'), this.game);
    this._attachGameEvents();
    /* 新的对局：战场缩放复位（手机端默认略缩小，确保边框完整可见） */
    var mob = window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
    this.zoom = mob ? 0.92 : 1; this.panX = 0; this.panY = 0;
    if (this._applyStageZoom) this._applyStageZoom();
    $('badge-mode').textContent = C.MODE_NAME[this.game.mode] +
      (seats.n > 2 ? ' · ' + GW.teamLabel(seats.teams, seats.perTeam) : '');
    this.lastFired = '';
    this.lastFiredTeam = 0;
    this.setFuncDisplay('');
    this.toast(isTutorial
      ? '教程战场已就绪：这里是固定的教学地图。'
      : '战斗开始：' + C.MODE_NAME[this.game.mode] + '，' +
        this.game.teams + ' 队 × ' + this.game.perTeam + ' 人（共 ' + this.game.playerCount +
        ' 人 · ' + GW.teamLabel(this.game.teams, this.game.perTeam) + '），每人 ' +
        this.game.soldiersPerPlayer + ' 名士兵。', 'sys');
    $('expr-input').value = '';
    $('expr-status').textContent = '提示：输入表达式即可预览弹道，回车发射';
    $('expr-status').className = 'expr-status';
    $('sketch-status').textContent = '按住拖动即可定方向，松手后可继续微调';
    $('sketch-status').className = 'expr-status';
    this.sketch.clear();
    this.setSketchRot(0);
    this.setSketchScale(1);
    this.setQuickVisible(false);   // 单机 / 人机无需快捷语
    /* 新对局默认从「攻击」开始；教程：三组控件直接摆在指令台，正式对局收进「回合准备」弹窗 */
    this.action = 'fire';
    this._setupOrderUI(!!isTutorial);
    this.syncModeUI();
    this._applyAction(this.action);
    this.renderer.resize();
    this.sketch.resize();
    this.refreshTeams();
    this.updateTurnUI();
    this.startLoop();
    /* 构造 Game 时事件监听还没挂上，第一回合的 UI 状态要在这里补一次（顺带弹出回合准备） */
    this.onTurn();
    return this.game;
  };

  /** 席位安排：由「队伍总数 × 每队人数」得出总人数；多人模式下每人 1 名士兵，
   *  选「人机」时除先手外全部交给电脑（玩家自己占第一个席位）。 */
  GW.UI.prototype._seatPlan = function () {
    var r = this._localRoster();
    var n = r.count;
    var ai = {};
    if (this.settings.opponent === 'ai') { for (var i = 1; i < n; i++) ai[i] = 1; }
    return { n: n, teams: r.teams, perTeam: r.perTeam, ai: ai };
  };

  /** 给未选技能的玩家配技：真人用开局选择的，AI 随机 */
  GW.UI.prototype._assignDefaultSkills = function () {
    var g = this.game;
    var pending = this._pendingSkills || {};
    for (var i = 0; i < g.players.length; i++) {
      var p = g.players[i];
      p.skill = pending[i] || (p.isAI ? C.SKILLS[GW.randInt(C.SKILLS.length)].id : C.SKILLS[0].id);
    }
    this._pendingSkills = null;
  };

  /* ---------------- 开局技能选择弹窗 ---------------- */
  /** 每个玩家各选一次：轮流点选、可「上一位」改选，最后统一确认进入战场。
   *  seats: [{label:'绿方·1号', index:0}...]；确认后回调 onDone(picksBySeat)。 */
  GW.UI.prototype.openSkillPick = function (seats, onDone) {
    var self = this;
    var picks = {};             // seatIndex -> skillId（保留已选，可回退重改）
    var idx = 0;
    var modal = $('skill-modal'), grid = $('skill-grid'), title = $('skill-title');
    grid.innerHTML = '';
    var backBtn = $('skill-back');
    C.SKILLS.forEach(function (sk) {
      var b = document.createElement('button');
      b.className = 'skill-item' + (picks[seats[idx].index] === sk.id ? ' active' : '');
      b.innerHTML = '<span class="sk-tag">一次性</span><span class="sk-name">' + sk.name + '</span><span class="sk-hint">' + sk.hint + '</span>';
      b.onclick = function () {
        picks[seats[idx].index] = sk.id;
        /* 选完自动轮到下一位，但弹窗留着等人确认（已选结果都记着，可回头改） */
        if (idx < seats.length - 1) idx++;
        render();
      };
      grid.appendChild(b);
    });
    if (backBtn) backBtn.onclick = function () { if (idx > 0) { idx--; render(); } };
    $('skill-ok').onclick = function () {
      var missing = null;
      for (var i = 0; i < seats.length; i++) if (!picks[seats[i].index]) { missing = seats[i]; break; }
      if (missing) { self.toast('还有玩家没选技能：' + missing.label, 'warn'); idx = seats.indexOf(missing); render(); return; }
      modal.classList.add('hidden');
      var arr = [];
      for (var k = 0; k < seats.length; k++) arr[seats[k].index] = picks[seats[k].index];
      onDone(arr);
    };

    function render() {
      var cur = seats[idx];
      title.textContent = '第 ' + (idx + 1) + ' / ' + seats.length + ' 位 · ' + cur.label + ' 选技能';
      if (backBtn) backBtn.classList.toggle('hidden', idx === 0);
      var items = grid.children;
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('active', picks[cur.index] === C.SKILLS[i].id);
      }
      var chips = $('skill-chosen');
      if (chips) {
        var html = '';
        for (var s = 0; s < seats.length; s++) {
          var pid = picks[seats[s].index];
          html += '<span class="sk-chip' + (pid ? ' on' : '') + '">' +
            escapeHtml(seats[s].label) + '：' +
            escapeHtml(pid ? ((GW.skillById(pid) || {}).name || '?') : '待选') + '</span>';
        }
        chips.innerHTML = html;
      }
    }
    render();
    modal.classList.remove('hidden');
    this._skillPickOnDone = onDone;
  };

  /** 「进入战场」入口：先让每位真人玩家各选一次技能，再开局 */
  GW.UI.prototype.startLocalGame = function () {
    var self = this;
    var plan = this._seatPlan();
    var n = plan.n;
    var teamCount = plan.teams || (n % 2 === 0 ? 2 : n);
    var seats = [];
    for (var i = 0; i < n; i++) {
      if (plan.ai[i]) continue;                       // 电脑席位自动配技，不打断真人流程
      var teamNo = GW.seatTeamIn(teamCount, i);
      var seatNo = Math.floor(i / teamCount) + 1;
      seats.push({
        label: (n > 2 ? ('第 ' + teamNo + ' 队 · ' + seatNo + ' 号')
                      : (i === 0 ? '绿方（先手）' : '青方（后手）')),
        index: i
      });
    }
    if (!seats.length) { self.enterGame(false); return; }   // 8 人也可以人人过一遍（技能允许重复）
    this.openSkillPick(seats, function (picksBySeat) {
      self._pendingSkills = {};
      for (var k = 0; k < seats.length; k++) self._pendingSkills[seats[k].index] = picksBySeat[seats[k].index];
      self.enterGame(false);
    });
  };

  GW.UI.prototype.startTutorialBattle = function () {
    this.enterGame(true);
    return this.game;
  };

  /** 主菜单「新手教程」入口：只创建一次战场，避免重复建局 */
  GW.UI.prototype.startTutorial = function () {
    this.settings.mode = C.NORMAL_FUNC;
    this.settings.soldiers = 2;
    this.settings.opponent = 'human';
    this.enterGame(true);
    this.tutorial.start(false);
  };

  GW.UI.prototype.onTutorialEnd = function () {
    this.isTutorial = false;
    this.game = null;
    this.showScreen('screen-menu');
  };

  GW.UI.prototype.restart = function () {
    if (this.isRemote) {
      if (this.isHost) { this._p2pHostStart(); this.toast('已重开一局：新地图、同一条直连。', 'sys'); return; }
      this.net.rematch(); this.toast('已请求重新开局，等待服务器…', 'sys'); return;
    }
    if (this.isTutorial && this.tutorial.isActive()) {
      this.tutorial.stop(true);
      this.tutorial.start(false);
      return;
    }
    if (this.tutorial.isActive()) this.tutorial.stop(true);
    this.enterGame(false);
  };

  GW.UI.prototype.quitToMenu = function () {
    this.tutorial.stop(true);
    this.isTutorial = false;
    if (this.isRemote) {
      try { this.net.quit(); } catch (e) { /* 忽略 */ }
      this.net = null;
      this.isRemote = false;
      this.myTeam = 0;
      this.botTeam = -1;
      this.isHost = false;
      this._mirrorExpr = '';
    }
    this.setQuickVisible(false);
    var sb = $('btn-skill');
    if (sb) sb.classList.add('hidden');
    this.game = null;
    this.showScreen('screen-menu');
  };

  GW.UI.prototype._attachGameEvents = function () {
    var self = this;
    this.game.on(function (type, data) {
      if (type === 'log') self.addLog(data.text, data.kind);
      if (type === 'explosion') self.renderer.addExplosion(data.x, data.y, data.at);
      if (type === 'turn') self.onTurn();
      if (type === 'shot' && self.game.shot && self.game.shot.isAI) {
        /* 电脑开炮也要把它的函数式显示到最上方 */
        self.setFuncDisplay(self.game.shot.source, { mode: 'fired', team: self.game.players[self.game.shot.playerIndex].team });
      }
      if (type === 'reward') {
        var def = GW.packById(data.kind);
        self.toast('拾取「' + (def ? def.name : data.kind) + '」：' + (def ? def.hint : ''), 'hit');
      }
      if (type === 'pack') {
        var def2 = GW.packById(data.pack.kind);
        self.toast('空投「' + (def2 ? def2.name : '') + '」出现！炮弹击中或位移碰到即可拾取。', 'sys');
      }
      if (type === 'skill') {
        var sk = GW.skillById(data.skill);
        var who = (self.game.players[data.playerIndex] || {}).name || '';
        self.toast(who + ' 发动技能「' + (sk ? sk.name : data.skill) + '」。', 'hit');
      }
      if (type === 'skills') {
        /* 权威端（服务器 / 点对点房主）下发的全员技能名单：同步到本机镜像面板 */
        for (var si = 0; si < data.players.length && si < self.game.players.length; si++) {
          var sp = data.players[si];
          self.game.players[si].skill = sp.skill || self.game.players[si].skill;
          self.game.players[si].skillUsed = !!sp.skillUsed;
        }
        self.refreshTeams();
        self.updateTurnUI();
      }
      if (type === 'over') {
        if (!self.isTutorial) self.showResult(data);
      }
      if (type === 'newbattle') self.refreshTeams();
    });
  };

  GW.UI.prototype.syncModeUI = function () {
    var mode = this.game.mode;
    $('expr-prefix').textContent = mode === C.NORMAL_FUNC ? 'y =' : (mode === C.FST_ODE ? "y' =" : "y'' =");
    $('angle-row').style.display = mode === C.SND_ODE ? 'flex' : 'none';
    var ph = [
      '例如 ((x-3)^2)/20',
      "例如 -y/3 或 sin(x)*2",
      "例如 -y + y' + 2*x - 1"
    ][mode];
    $('expr-input').placeholder = ph;
    var examples = [
      ['抛物线', '((x-3)^2)/20'], ['正弦波', 'sin(x/20)*5'], ['对数', 'ln(abs(x))']
    ];
    if (mode === C.FST_ODE) examples = [['衰减', '-y/3'], ['摆动', 'sin(x/20)*5'], ['抬升', '1/(abs(x)+1)']];
    if (mode === C.SND_ODE) examples = [['回弹', '-y'], ['阻尼', "-y'-y"], ['拱桥', '1.04^(-(x+3)^2)*20']];
    var chips = document.querySelectorAll('.chip[data-func]');
    Array.prototype.forEach.call(chips, function (btn, i) {
      if (examples[i]) {
        btn.textContent = examples[i][0];
        btn.setAttribute('data-func', examples[i][1]);
      }
    });
  };

  /* ---------------- 输入 ---------------- */
  GW.UI.prototype.insertToken = function (tok) {
    var input = $('expr-input');
    if (input.disabled) return;
    var start = input.selectionStart == null ? input.value.length : input.selectionStart;
    var end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    var insert = tok;
    if (/^[a-z]+$/i.test(tok) && tok.length > 2 && tok.indexOf('(') < 0) insert = tok + '(';
    input.value = input.value.slice(0, start) + insert + input.value.slice(end);
    var pos = start + insert.length;
    input.focus();
    input.setSelectionRange(pos, pos);
    this.schedulePreview();
  };

  GW.UI.prototype.schedulePreview = function () {
    var self = this;
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(function () { self.updatePreview(); }, 120);
  };

  GW.UI.prototype.updatePreview = function () {
    var g = this.game;
    if (!g || g.state !== 'aim') {
      if (this.renderer) this.renderer.setPreview(null);
      return;
    }
    var raw = $('expr-input').value;
    if (g.players[g.currentTurn].isAI) {
      this.renderer.setPreview(null);
      return;
    }
    var status = $('expr-status');
    if (!raw.trim()) {
      status.textContent = '提示：输入表达式即可预览弹道，回车发射';
      status.className = 'expr-status';
      $('expr-input').classList.remove('invalid');
      this.renderer.setPreview(null);
      this.setFuncDisplay(this.lastFired || '', { mode: 'idle', team: this.lastFiredTeam });
      return;
    }
    var traj, source = raw.trim();
    try {
      var compiled = GW.compileString(raw);
      source = GW.treeToString(compiled.tree);
      traj = g._run(compiled, null, g.currentTurn, C.FUNC_MAX_STEPS);
    } catch (e) {
      status.textContent = '✗ ' + e.message;
      status.className = 'expr-status error';
      $('expr-input').classList.add('invalid');
      this.renderer.setPreview(null);
      return;
    }
    if (!traj || traj.numSteps <= 1) {
      status.textContent = '✓ 表达式合法，但在这名士兵身上无法形成有效弹道（可能在定义域外爆炸）';
      status.className = 'expr-status error';
      this.renderer.setPreview(null);
      return;
    }
    var hint = traj.numSteps >= C.FUNC_MAX_STEPS ? '轨迹未终止于地形，将飞出战场边界' : '';
    status.innerHTML = '✓ 可发射 · 预计 ' + traj.numSteps + ' 步' +
      (traj.hits.length ? ' · 路径上会命中 <b>' + traj.hits.length + '</b> 名士兵（务必确认没有自己人）' : '') +
      (hint ? ' · ' + hint : '');
    status.className = traj.hits.length ? 'expr-status ok' : 'expr-status';
    $('expr-input').classList.remove('invalid');
    this.renderer.setPreview(traj);
    this.setFuncDisplay(source, { mode: 'preview', team: g.players[g.currentTurn].team });
    this.tutorial.notify('preview');
  };

  GW.UI.prototype.fire = function () {
    var g = this.game;
    if (!g || g.state !== 'aim') return;
    if (this.action === 'move') return this.doMove();
    var raw = $('expr-input').value;
    if (this.isRemote && !this.isHost) {
      if (g.currentTurn !== this.myTeam) { this.toast('还没轮到你。', 'sys'); return; }
      if (!raw.trim()) {
        $('expr-status').textContent = '✗ 请先输入函数表达式';
        $('expr-status').className = 'expr-status error';
        return;
      }
      /* 本地先校验表达式，给出即时反馈；真正开炮由服务器权威执行 */
      try { GW.compileString(raw); } catch (e) {
        $('expr-status').textContent = '✗ ' + e.message;
        $('expr-status').className = 'expr-status error';
        $('expr-input').classList.add('invalid');
        return;
      }
      $('expr-input').classList.remove('invalid');
      this.net.fire(raw.trim(), g.players[g.currentTurn].getCurrentTurnSoldier().angle, this.weapon);
      return;
    }
    if (g.players[g.currentTurn].isAI) {
      this.toast('现在是电脑回合，请稍候。', 'sys');
      return;
    }
    if (!raw.trim()) {
      $('expr-status').textContent = '✗ 请先输入函数表达式';
      $('expr-status').className = 'expr-status error';
      return;
    }
    var compiled = null;
    try { compiled = GW.compileString(raw); } catch (e) { compiled = null; }
    var res = g.fire(raw, false, this.weapon);
    if (!res.ok) {
      $('expr-status').textContent = '✗ ' + res.reason;
      $('expr-status').className = 'expr-status error';
      $('expr-input').classList.add('invalid');
      return;
    }
    $('expr-input').value = '';
    this._mirrorExpr = '';
    $('expr-status').textContent = '炮弹已出膛…';
    $('expr-status').className = 'expr-status';
    this.lastFired = compiled ? GW.treeToString(compiled.tree) : raw.trim();
    this.lastFiredTeam = g.players[g.currentTurn].team;
    this.setFuncDisplay(this.lastFired, { mode: 'fired', team: this.lastFiredTeam });
    this.renderer.setPreview(null);
    this.tutorial.notify('fire');
  };

  /** 位移：沿函数 / 手绘曲线移动一小段距离（有上限），消耗本回合 */
  GW.UI.prototype.doMove = function () {
    var g = this.game;
    if (!g || g.state !== 'aim') return;
    var status = $('expr-status');
    var dist = this.moveDist;
    if (this.isRemote && !this.isHost) {
      if (g.currentTurn !== this.myTeam) { this.toast('还没轮到你。', 'sys'); return; }
      var raw0 = $('expr-input').value;
      if (!this.sketch.isEmpty()) {
        var t0 = this.sketchTraj();
        if (!t0) { status.textContent = '✗ 这一笔无法作为位移路径'; status.className = 'expr-status error'; return; }
        this.net.sketchMove(this.sketch.stroke(), this.sketch.rot, this.sketch.scale, dist);
        return;
      }
      if (!raw0.trim()) { status.textContent = '✗ 请先输入位移函数'; status.className = 'expr-status error'; return; }
      this.net.move(raw0.trim(), dist);
      return;
    }
    if (g.players[g.currentTurn].isAI) { this.toast('现在是电脑回合，请稍候。', 'sys'); return; }
    if (!this.sketch.isEmpty()) {
      var traj = this.sketchTraj();
      if (!traj || traj.numSteps < 2) {
        status.textContent = '✗ 这一笔无法作为位移路径，请重画';
        status.className = 'expr-status error';
        return;
      }
      var resS = this._moveAlongTrajectory(traj, dist);
      if (!resS.ok) { status.textContent = '✗ ' + resS.reason; status.className = 'expr-status error'; return; }
      this._afterMove();
      return;
    }
    var raw = $('expr-input').value;
    if (!raw.trim()) { status.textContent = '✗ 请先输入位移函数'; status.className = 'expr-status error'; return; }
    var res = g.move(raw, dist, false);
    if (!res.ok) { status.textContent = '✗ ' + res.reason; status.className = 'expr-status error'; return; }
    this._afterMove();
  };

  /* 手绘位移：让权威端沿已生成的弹道移动（本地 / 房主端直接调用） */
  GW.UI.prototype._moveAlongTrajectory = function (traj, dist) {
    var g = this.game;
    var maxDist = C.MAX_MOVE_DIST + (g.players[g.currentTurn].moveBonus || 0);
    var pxPerUnit = C.PLANE_LENGTH / C.PLANE_GAME_LENGTH;
    var wantPx = Math.max(0.5, Math.min(maxDist, dist)) * pxPerUnit;
    var soldier = g.players[g.currentTurn].getCurrentTurnSoldier();
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
    /* 终点合法性：山体 / 士兵 / 边界 */
    if (g.terrain.soldierCollides(gx, gy, C.SOLDIER_RADIUS) || gx < 4 || gx > C.PLANE_LENGTH - 4) {
      return { ok: false, reason: '位移终点被地形挡住，请缩短距离或换曲线' };
    }
    soldier.x = Math.round(gx * 10) / 10;
    soldier.y = Math.round(gy * 10) / 10;
    g.moveAnim = { playerIndex: g.currentTurn, soldierIndex: g.players[g.currentTurn].currentSoldierIndex, fx: fx, fy: fy, tx: soldier.x, ty: soldier.y, start: GW.now() };
    for (var m = 0; m < picked.length; m++) g._collectPack(m);
    g.state = 'moving';
    g._moveStart = GW.now();
    g.round++;
    g.log(C.TEAM_NAME[g.players[g.currentTurn].team] + ' 手绘位移。', 'sys');
    g.emit('move', { playerIndex: g.currentTurn, soldierIndex: g.players[g.currentTurn].currentSoldierIndex, fx: fx, fy: fy, tx: soldier.x, ty: soldier.y });
    return { ok: true };
  };

  GW.UI.prototype._afterMove = function () {
    $('expr-input').value = '';
    this._mirrorExpr = '';
    this.renderer.setPreview(null);
    this.tutorial.notify('move');
  };

  /** 联机：选完技能立刻上报权威端；房主（权威端）直接写本地对局 */
  GW.UI.prototype._pickSkillOnline = function (skillId, seat) {
    var g = this.game;
    if (!g) return;
    if (this.isHost) {
      var res = g.pickSkill(seat == null ? this.myTeam : seat, skillId);
      if (!res.ok) { this.toast(res.reason, 'bad'); return; }
      g.emit('skills', { players: GW.snapshotPlayers(g).map(function (p) { return { skill: p.skill, skillUsed: p.skillUsed }; }) });
      this.refreshTeams();
      return;
    }
    this.net.skillPick(skillId);
    if (g.players[this.myTeam]) g.players[this.myTeam].skill = skillId;   // 本机先显示，等权威端确认
    this.refreshTeams();
  };

  /** 联机开局：给自己（自己的席位）选一次技能 */
  GW.UI.prototype._askRemoteSkill = function () {
    var self = this;
    if (this._skillPicked) { this._afterRemoteSkillPick(); return; }
    this.openSkillPick([{ label: this._seatName(this.myTeam) || '你', index: this.myTeam }], function (picks) {
      self._skillPicked = true;
      if (picks && picks.length) self._pickSkillOnline(picks[0]);
      self._afterRemoteSkillPick();
    });
  };

  /** 联机开局技能选完后：若正好轮到自己，才开始「回合准备」（避免两个弹窗叠在一起） */
  GW.UI.prototype._afterRemoteSkillPick = function () {
    this._suppressPrep = false;
    this.openTurnPrep();
  };

  /** 使用开局技能（每局一次，消耗本回合） */
  GW.UI.prototype.useSkill = function () {
    var g = this.game;
    if (!g || g.state !== 'aim') return;
    if (this.isRemote && !this.isHost) {
      if (g.currentTurn !== this.myTeam) { this.toast('还没轮到你。', 'sys'); return; }
      this.net.skill();
      return;
    }
    var res = g.useSkill();
    if (!res.ok) this.toast(res.reason || '技能不可用', 'bad');
  };

  GW.UI.prototype.adjustAngle = function (dir) {
    var g = this.game;
    if (!g || g.state !== 'aim' || g.mode !== C.SND_ODE) return;
    var p = g.players[g.currentTurn];
    if (this.isRemote && !this.isHost) {
      if (g.currentTurn !== this.myTeam) return;
      var s = p.getCurrentTurnSoldier();
      g.setAngle(s.angle + dir * Math.PI / 180);
      this.updateAngleUI();
      this.schedulePreview();
      this.net.angle(s.angle);
      return;
    }
    if (p.isAI) return;
    var s2 = p.getCurrentTurnSoldier();
    g.setAngle(s2.angle + dir * Math.PI / 180);
    this.updateAngleUI();
    this.schedulePreview();
  };

  GW.UI.prototype.updateAngleUI = function () {
    var g = this.game;
    if (!g) return;
    var p = g.players[g.currentTurn];
    if (!p) return;
    var s = p.getCurrentTurnSoldier();
    if (!s) return;
    var ang = s.angle || 0;
    var deg = ang * 180 / Math.PI;
    $('angle-value').textContent = (deg >= 0 ? '+' : '') + deg.toFixed(0) + '°';
    $('angle-fill').style.width = (50 + (ang / (Math.PI / 2)) * 50) + '%';
  };

  /* ---------------- 局面同步 ---------------- */
  GW.UI.prototype.onTurn = function () {
    var g = this.game;
    var p = g.players[g.currentTurn];
    var isAI = p.isAI;
    /* 联机：是否轮到我由 currentTurn === myTeam 决定；单机：是否电脑回合 */
    var myTurn = this.isRemote ? (g.currentTurn === this.myTeam) : !isAI;
    var disabled = !myTurn;
    /* 新回合开始：先收掉上一个「回合准备」弹窗 */
    var tm = $('turn-modal'); if (tm) tm.classList.add('hidden');
    this._prepOpenedAt = 0;
    $('expr-input').disabled = disabled;
    $('btn-fire').disabled = disabled;
    $('btn-sketch-fire').disabled = disabled;
    this.sketch.setEnabled(myTurn);
    $('sketch').classList.toggle('disabled', disabled);
    var skillBtn = $('btn-skill');
    if (skillBtn) {
      skillBtn.disabled = disabled || !p.skill || p.skillUsed;
      skillBtn.classList.toggle('ready', !disabled && !!p.skill && !p.skillUsed);
      skillBtn.title = p.skill ? ((GW.skillById(p.skill) || {}).hint || '') + '（每局一次，消耗本回合）' : '本局未选择技能';
    }
    /* 圆形按钮：正式对局里改成「回合准备」的重选入口 */
    var fab = $('skill-fab');
    if (fab) {
      var showFab = !disabled && !this.isTutorial;
      fab.classList.toggle('show', showFab);
      fab.disabled = !showFab;
      fab.title = '打开「回合准备」：重选本回合的行动 / 炮弹 / 技能';
    }
    this.updateTurnUI();
    this.refreshTeams();
    this._refreshOrderStrip();
    if (disabled) {
      if (this.isRemote) this.toast('等待 ' + this._seatName(g.currentTurn) + ' 行动…', 'sys');
      else this.toast('电脑正在计算射击诸元…', 'ai');
      if (this.renderer) this.renderer.setPreview(null);
    } else {
      this.updateAngleUI();
      /* 轮到你 → 先弹「回合准备」（回合开始前选好 行动 / 炮弹 / 技能），选完才进入瞄准 */
      var prepping = !this.isTutorial && !this._suppressPrep && g.state === 'aim';
      if (prepping) {
        var tip = $('turn-tip'); if (tip) tip.textContent = '请先完成「回合准备」…';
        this.openTurnPrep();
      } else {
        try { $('expr-input').focus(); } catch (e) { /* 忽略 */ }
      }
      /* 轮到自己时，把手绘笔迹按新士兵重新解算一次 */
      if (!this.sketch.isEmpty()) this.onSketchChanged();
      else {
        if (this.renderer) this.renderer.setPreview(null);
        this.setFuncDisplay(this.lastFired || '', { mode: 'idle', team: this.lastFiredTeam });
      }
    }
  };

  /** 教程模式：把「行动 / 炮弹 / 技能」三组控件显示在指令台里逐步讲解；
   *  正式对局：隐藏它们，改由「回合准备」弹窗在回合开始前统一选择。 */
  GW.UI.prototype._setupOrderUI = function (tutorial) {
    var lo = $('legacy-order'); if (lo) lo.classList.toggle('hidden', !tutorial);
    var os = $('order-strip'); if (os) os.classList.toggle('hidden', !!tutorial);
    var bs = $('btn-skill'); if (bs) bs.classList.toggle('hidden', !tutorial);
    var tm = $('turn-modal'); if (tm) tm.classList.add('hidden');
    this._prepOpenedAt = 0;
    this._suppressPrep = false;
  };

  /** 席位称呼：多人混战时叫玩家名，1v1 / 分组对战时叫阵营名 */
  GW.UI.prototype._seatName = function (idx) {
    var g = this.game;
    var p = g && g.players[idx];
    if (!p) return '对手';
    return (g.playerCount > 2 && p.name) ? p.name : C.TEAM_NAME[p.team];
  };

  GW.UI.prototype.updateTurnUI = function () {
    var g = this.game;
    if (!g) return;
    var p = g.players[g.currentTurn];
    var s = p.getCurrentTurnSoldier();
    $('turn-owner').textContent = (g.playerCount > 2 ? (p.name || ('玩家 ' + (g.currentTurn + 1)))
      : C.TEAM_NAME[p.team]) + ' 行动';
    $('turn-owner').style.color = C.TEAM_COLOR[p.team];
    $('current-soldier-tag').textContent = (p.currentSoldierIndex + 1) + ' 号兵';
    if (g.state === 'drawing') $('turn-tip').textContent = '炮弹飞行中…';
    else if (g.state === 'exploding') $('turn-tip').textContent = '炮弹已落地，稍后轮转';
    else if (p.isAI) $('turn-tip').textContent = '电脑思考中…';
    else $('turn-tip').textContent = '在底部写函数，或在左侧画一笔';
    if (s) this.updateAngleUI();
  };

  GW.UI.prototype.refreshTeams = function () {
    var g = this.game;
    if (!g) return;
    for (var i = 0; i < g.players.length; i++) {
      var p = g.players[i];
      var pi = i + 1;
      var row = $('soldiers-t' + pi);
      if (!row) continue;
      var color = (C.PLAYER_COLORS && C.PLAYER_COLORS[i]) || C.TEAM_COLOR[p.team];
      var nameEl = $('fb-name-' + pi);
      if (nameEl) {
        nameEl.textContent = p.name || (C.TEAM_NAME[p.team] || ('玩家' + pi)) +
          (p.skill ? ' · ' + (GW.skillById(p.skill) || {}).name : '');
        nameEl.style.color = color;
      }
      var html = '';
      for (var k = 0; k < p.numSoldiers; k++) {
        var s = p.getSoldiers()[k];
        var cls = 'soldier-chip ' + (s.alive ? 'alive' : 'dead') + ' t' + p.team +
          (g.currentTurn === i && k === p.currentSoldierIndex && s.alive ? ' active' : '');
        var hpTag = s.alive ? ' title="生命 ' + s.hp + '/' + s.maxHp + '"' : '';
        html += '<span class="' + cls + '"' + hpTag + '>' + (k + 1) + '</span>';
      }
      row.innerHTML = html;
      $('stat-t' + pi).textContent = '生命 ' + (function () {
        var cur = p.getCurrentTurnSoldier();
        return cur && cur.alive ? (cur.hp + '/' + cur.maxHp) : '—';
      })() + ' · 命中 ' + p.kills + ' · 误伤 ' + p.friendly;
      $('score-t' + pi).textContent = p.score() + ' 分' +
        (p.powerShot ? ' · 强化' : '') + (p.aimBonus ? ' · 瞄准+' + p.aimBonus : '');
      var block = $('fb-team-' + pi);
      if (block) {
        block.classList.toggle('acting', g.currentTurn === i);
        block.classList.toggle('hidden', i >= g.playerCount);
      }
    }
  };

  /* ---------------- 复制到剪贴板（带兜底） ----------------
   * Clipboard API 在「非 https / 非用户手势 / 部分手机浏览器」下会直接失败或静默失败，
   * 所以这里三级兜底：Clipboard API → execCommand('copy') → 选中文本让用户手动复制。 */
  function copyText(text, selEl, onOk, onFail) {
    text = String(text == null ? '' : text);
    if (!text) { if (onFail) onFail(); return; }
    function selectEl() {
      try {
        if (selEl && selEl.select) { selEl.focus(); selEl.select(); }
        else if (selEl && selEl.setSelectionRange && selEl.value != null) {
          selEl.focus(); selEl.setSelectionRange(0, selEl.value.length);
        }
      } catch (e) { /* 忽略 */ }
    }
    function legacy() {
      var ok = false;
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = !!(document.execCommand && document.execCommand('copy'));
        document.body.removeChild(ta);
      } catch (e) { ok = false; }
      if (ok) { if (onOk) onOk(); return; }
      selectEl();
      if (onFail) onFail();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        var pr = navigator.clipboard.writeText(text);
        if (pr && pr.then) { pr.then(function () { if (onOk) onOk(); })['catch'](legacy); return; }
        if (onOk) onOk();
        return;
      } catch (e) { /* 落到兜底 */ }
    }
    legacy();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------------- 主循环 ---------------- */
  GW.UI.prototype.startLoop = function () {
    var self = this;
    if (this._looping) return;
    this._looping = true;
    function frame(ts) {
      if (!self.game) { self._looping = false; return; }
      var now = Date.now();
      self.game.update(now);
      var g = self.game;
      /* 状态文字 */
      if (g.state === 'drawing' || g.state === 'exploding') self.updateTurnUI();
      /* 计时 */
      var remain = g.remainingTime(now);
      var fill = $('timer-fill');
      if (remain < 0) {                       // 不限时
        fill.style.width = '100%';
        fill.className = 'timer-fill';
        $('timer-text').textContent = '∞';
      } else {
        var ratio = remain / (g.turnTimeMs || C.TURN_TIME);
        fill.style.width = (ratio * 100) + '%';
        fill.className = 'timer-fill' + (ratio < 0.15 ? ' danger' : (ratio < 0.35 ? ' low' : ''));
        $('timer-text').textContent = (remain / 1000).toFixed(1);
      }
      self.refreshTeams();
      self.renderer.draw(now);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  };

  /* ---------------- 结算 ---------------- */
  GW.UI.prototype.showResult = function (result) {
    if (this.tutorial && this.tutorial.isActive()) return;   // 教程期间不弹结算
    var g = this.game;
    $('result-title').textContent = result.winner ? (C.TEAM_NAME[result.winner.team] + ' 获胜！') : '战斗结束';
    $('result-reason').textContent = result.reason;
    var rows = '';
    for (var i = 0; i < g.players.length; i++) {
      var p = g.players[i];
      var color = (C.PLAYER_COLORS && C.PLAYER_COLORS[i]) || C.TEAM_COLOR[p.team];
      rows += '<tr><td style="color:' + color + '">' + (p.name || C.TEAM_NAME[p.team]) + '</td>' +
        '<td>' + p.aliveCount() + ' / ' + p.numSoldiers + '</td>' +
        '<td>' + p.kills + '</td><td>' + p.friendly + '</td><td><b>' + p.score() + '</b></td></tr>';
    }
    $('result-rows').innerHTML = rows;
    $('result-extra').textContent = '共进行了 ' + g.round + ' 次射击 · ' + C.MODE_NAME[g.mode];
    $('result-modal').classList.remove('hidden');
  };

  /* ============================================================
   * 联机（多人）对战
   * 架构：服务器权威。客户端只发送「开炮意图」，并播放服务器下发的弹道动画。
   * ============================================================ */

  GW.UI.prototype._teamName = function (team) {
    var g = this.game;
    if (g && team != null) {
      var p = g.players[team];
      if (p && g.playerCount > 2) return p.name || ('玩家 ' + (team + 1));
      if (p) return (C.TEAM_NAME[p.team] || '第 ' + p.team + ' 队') + ' · ' + p.name;
    }
    return team === 0 ? '绿方（左军）' : '青方（右军）';
  };

  GW.UI.prototype._segActive = function (id) {
    var el = document.querySelector('#' + id + ' .seg-item.active');
    return el ? el.getAttribute('data-value') : null;
  };

  GW.UI.prototype._mpMode = function () { return parseInt(this._segActive('seg-mp-mode') || '0', 10); };
  GW.UI.prototype._mpSoldiers = function () { return parseInt(this._segActive('seg-mp-soldiers') || '2', 10); };
  /** 联机人数：由「队伍总数 × 每队人数」得出（2 队 × 3 人 = 6 人 = 3v3）。点对点直连仅支持 2 人。 */
  GW.UI.prototype._mpTeams = function () { return parseInt(this._segActive('seg-mp-teams') || '2', 10); };
  GW.UI.prototype._mpPerTeam = function () { return parseInt(this._segActive('seg-mp-perteam') || '1', 10); };
  GW.UI.prototype._mpRoster = function () {
    return GW.seatsFromRoster(GW.clampTeamCount(this._mpTeams()), this._mpPerTeam());
  };
  /** 兼容旧接口：只取总人数 */
  GW.UI.prototype._mpPlayers = function () { return this._mpRoster().count; };

  GW.UI.prototype._mpUrl = function () {
    var v = $('mp-url').value.trim();
    if (!v) v = 'ws://' + (loc().host || 'localhost:8080');
    if (v.indexOf('://') < 0) v = 'ws://' + v;
    return v;
  };

  /** 房主创建房间后，生成一条「朋友点开直接进」的邀请链接（自带房间号） */
  GW.UI.prototype._buildInviteLink = function (num) {
    /* 信令走 PeerJS 公共云（全局可用），链接只需带房间号即可，玩家零配置 */
    return location.origin + location.pathname + '?room=' + encodeURIComponent(num);
  };

  GW.UI.prototype._lobbyStatus = function (html, kind) {
    var el = $('lobby-status');
    if (!el) return;
    el.className = 'lobby-status ' + (kind || 'info');
    el.innerHTML = html;
    el.classList.remove('hidden');
  };

  GW.UI.prototype._bindLobby = function () {
    var self = this;
    this._bindSeg('seg-mp-mode', function () {});
    this._bindSeg('seg-mp-soldiers', function () {});
    this._bindSeg('seg-mp-turntime', function (v) { self.mpTurnTime = parseInt(v, 10); });
    this._bindSeg('seg-mp-teams', function (v) {
      if (GW.clampTeamCount(v) * self._mpPerTeam() > C.MAX_PLAYERS) {
        self._switchSegValue('seg-mp-perteam', String(GW.clampPerTeam(self._mpPerTeam(), v)));
      }
      self._syncMpRoster();
    });
    this._bindSeg('seg-mp-perteam', function () { self._syncMpRoster(); });

    $('btn-mp-create').onclick = function () {
      var url = self._mpUrl();
      var fillAI = $('chk-mp-fillai') && $('chk-mp-fillai').checked;
      self.net = new GW.Net(url);
      self._setupNet(self.net);
      self.net.whenOpen(function () {
        var r = self._mpRoster();
      self.net.create({
        mode: self._mpMode(),
        soldiers: r.count > 2 ? 1 : self._mpSoldiers(),
        teams: r.teams,
        perTeam: r.perTeam,
        playerCount: r.count,
        turnTime: self.mpTurnTime,
        fillAI: !!fillAI
      });
      });
      self._lobbyStatus('正在连接服务器 <b>' + escapeHtml(url) + '</b> …' +
        (fillAI ? ' 已勾选「人机补齐」，将直接以 AI 为对手开局。' : ''), 'info');
    };

    $('btn-mp-tutorial').onclick = function () { self.tutorial.start('online'); };

    $('btn-mp-join').onclick = function () {
      var code = $('mp-code').value.trim().toUpperCase();
      if (!code) { self._lobbyStatus('请输入对方发来的房间号。', 'error'); return; }
      var url = self._mpUrl();
      self.net = new GW.Net(url);
      self._setupNet(self.net);
      self.net.whenOpen(function () { self.net.join(code); });
      self._lobbyStatus('正在连接服务器 <b>' + escapeHtml(url) + '</b> 并加入 ' + code + ' …', 'info');
    };

    $('btn-mp-back').onclick = function () { self._leaveLobby(); };

    /* ---------------- 房间联机（房主浏览器即权威端，数据点对点直连） ---------------- */

    /* 房间模式：房主创建房间（PeerJS 公共云信令注册房间号）→ 朋友输房间号加入，数据走 WebRTC 直连 */
    $('btn-room-create').onclick = function () {
      var p = self._mkRoomTunnel('host');
      if (!p) return;
      self.net = p;
      p.hostRoom();
    };
    $('btn-room-join').onclick = function () {
      var num = $('p2p-room-input').value.trim();
      var p = self._mkRoomTunnel('guest');
      if (!p) return;
      self.net = p;
      p.joinRoom(num);
    };
    $('btn-room-copy').onclick = function () {
      var num = self.net && self.net.room;
      if (!num) { self._lobbyStatus('还没有创建房间。', 'error'); return; }
      copyText(num, $('p2p-room-num'), function () {
        self._lobbyStatus('房间号 <b>' + escapeHtml(num) + '</b> 已复制，发给朋友即可。', 'ok');
      }, function () {
        self._lobbyStatus('复制没成功：房间号框已选中（<b>' + escapeHtml(num) + '</b>）——' +
          '长按选择「复制」，或者直接念给朋友。', 'info');
      });
    };
    /* 复制「邀请链接」：朋友点开链接直接进房间（链接自带房间号，信令走公共云，零配置） */
    $('btn-room-link').onclick = function () {
      var link = $('p2p-room-link').value;
      if (!link) { self._lobbyStatus('还没有创建房间。', 'error'); return; }
      copyText(link, $('p2p-room-link'), function () {
        self._lobbyStatus('邀请链接已复制，发给朋友即可（他点开直接进房间）。', 'ok');
      }, function () {
        self._lobbyStatus('复制没成功：链接框已选中——长按选择「复制」，发给朋友即可。', 'info');
      });
    };
    /* 手动复制连接码（旧方案）已移除：联机房间自动生成邀请链接，房主只需发链接 */

    $('btn-mp-copy').onclick = function () {
      var code = self.net && self.net.room;
      if (code && navigator.clipboard) {
        try { navigator.clipboard.writeText(code); self._lobbyStatus('房号 <b>' + code + '</b> 已复制，发给对手即可。', 'ok'); } catch (e) { /* 忽略 */ }
      }
    };
  };

  /** 以编程方式切换某个分段控件的值（群组内部只保留一个 active） */
  GW.UI.prototype._switchSegValue = function (id, value) {
    var items = document.querySelectorAll('#' + id + ' .seg-item');
    Array.prototype.forEach.call(items, function (b) {
      b.classList.toggle('active', b.getAttribute('data-value') === String(value));
    });
  };

  /** 赛制说明：邀请链接联机一次只连一条直连通道，固定 2 人（1v1） */
  GW.UI.prototype._syncMpRoster = function () {
    var note = $('mp-roster-note');
    if (!note) return;
    var r = this._mpRoster();
    if (r.count > 2) {
      this._switchSegValue('seg-mp-teams', '2');
      this._switchSegValue('seg-mp-perteam', '1');
      r = this._mpRoster();
      note.innerHTML = '<b>房间联机是 1v1</b>（2 队 × 1 人）。多人组队需要自建联机服务器（进阶）。';
      return;
    }
    document.querySelectorAll('#seg-mp-teams .seg-item').forEach(function (b) {
      b.classList.toggle('disabled', parseInt(b.getAttribute('data-value'), 10) > 2);
    });
    document.querySelectorAll('#seg-mp-perteam .seg-item').forEach(function (b) {
      b.classList.toggle('disabled', parseInt(b.getAttribute('data-value'), 10) > 1);
    });
    note.innerHTML = '当前：<b>' + r.teams + ' 队 × ' + r.perTeam + ' 人 = 共 ' + r.count + ' 人</b>（' +
      GW.teamLabel(r.teams, r.perTeam) + '），' +
      (r.count > 2 ? '每人只指挥 1 名士兵，打光某一整队即该队判负。' : '每人可带 ' + this._mpSoldiers() + ' 名士兵。');
  };

  /* ---------------- 联机房间（房主即权威端，PeerJS 公共云信令牵线，零服务器） ---------------- */
  GW.UI.prototype._setLinkMode = function () {
    this._mpLink = 'room';
    this._syncMpRoster();
    $('p2p-box').classList.remove('hidden');
    if ($('mp-url-row')) $('mp-url-row').classList.add('hidden');
    if ($('lobby-cols')) $('lobby-cols').classList.add('hidden');
    if ($('relay-url-row')) $('relay-url-row').classList.add('hidden');
    if ($('mp-share')) $('mp-share').classList.add('hidden');
    this._lobbyStatus('联机：房主点「🏠 创建房间」→ 把<b>邀请链接</b>发给朋友 → 朋友点开链接<b>直接进房间、自动开局</b>。不用记房间号，也不用开任何服务器。', 'info');
  };

  /** 联机房间（房主浏览器权威 + PeerJS 公共云信令牵线，零服务器）：房主 / 客人通用工厂 */
  GW.UI.prototype._mkTunnel = function (role, extra) {
    var self = this;
    this._p2pRole = role;
    if (GW.roomSupported && !GW.roomSupported()) {
      this._lobbyStatus('当前页面无法联机：浏览器需要 https 或 localhost，并支持 WebRTC。请通过线上网址（https）打开，或换 Chrome / Edge 等现代浏览器。', 'error');
      return null;
    }
    var opts = {
      role: role,
      onStatus: function (text, kind) { self._lobbyStatus(text, kind); },
      onOpen: function () { self._onTunnelOpen(role); }
    };
    if (extra && extra.onRoom) opts.onRoom = extra.onRoom;
    var t = new GW.Room(opts);
    this._setupNet(t);
    return t;
  };

  /** 房间号模式：房主创建房间拿到 6 位房间号；客人输号加入 */
  GW.UI.prototype._mkRoomTunnel = function (role) {
    var self = this;
    return this._mkTunnel(role, {
      onRoom: function (num) {
        $('p2p-room-no').classList.remove('hidden');
        var numEl = $('p2p-room-num');
        if (numEl && numEl.value != null) numEl.value = num;
        else if (numEl) numEl.textContent = num;
        var link = self._buildInviteLink(num);
        $('p2p-link-row').classList.remove('hidden');
        $('p2p-room-link').value = link;
        /* 房间号先大大地显示出来（不依赖复制）；然后再尽量自动把邀请链接复制进剪贴板 */
        self._lobbyStatus('房间已创建！房间号 <b>' + escapeHtml(num) + '</b> 已显示在左侧——' +
          '把「邀请链接」发给朋友（他点开直接进房间），或者把「房间号」发给朋友、让他自己输。', 'ok');
        copyText(link, $('p2p-room-link'), function () {
          self._lobbyStatus('房间已创建！邀请链接已自动复制，直接粘贴发给朋友即可；' +
            '房间号 <b>' + escapeHtml(num) + '</b> 也已显示在左侧备用。', 'ok');
        }, function () {
          self._lobbyStatus('房间已创建！房间号 <b>' + escapeHtml(num) + '</b>，' +
            '点「复制邀请链接」或「复制房间号」发给朋友（若复制没反应，长按号码框手动复制）。', 'ok');
        });
      }
    });
  };

  GW.UI.prototype._onTunnelOpen = function (role) {
    if (role === 'host') {
      this._lobbyStatus('连接已建立，正在生成战场…', 'ok');
      this._p2pHostStart();
    } else {
      this._lobbyStatus('连接已建立，等待房主开局…', 'ok');
    }
  };

  /** 房主端开局：本地生成战场 → 把同一份地图发给客人 → 本机作为权威端开打 */
  GW.UI.prototype._p2pHostStart = function () {
    var mode = this._mpMode(), soldiers = this._mpSoldiers();
    /* 房间联机最多 2 人（房主 + 1 位客人） */
    var roster = this._mpRoster();
    if (roster.count > 2) {
      this._switchSegValue('seg-mp-teams', '2');
      this._switchSegValue('seg-mp-perteam', '1');
      roster = this._mpRoster();
      this._lobbyStatus('房间联机只支持 1v1（2 队 × 1 人），已自动改为 2 人开打。', 'info');
    }
    var n = roster.count;
    var battle = n > 2
      ? GW.generateBattle(soldiers, n, roster.teams, roster.perTeam)
      : GW.generateBattle(soldiers);
    var currentTurn = GW.randInt(n);
    var base = {
      type: 'start',
      config: { mode: mode, soldiers: soldiers, playerCount: n, teams: roster.teams, perTeam: roster.perTeam, turnTime: this.mpTurnTime },
      terrain: { circles: battle.circles, positions: battle.positions },
      currentTurn: currentTurn,
      botTeam: -1
    };
    this.net.send({ type: 'start', config: base.config, terrain: base.terrain, currentTurn: currentTurn, botTeam: -1, team: 1 });
    this.enterRemoteGame({ type: 'start', config: base.config, terrain: base.terrain, currentTurn: currentTurn, botTeam: -1, team: 0 },
      { authoritative: true });
  };

  /** 房主是权威端：把自己的对局事件原样广播给客人（与 server.js 的广播内容一致） */
  GW.UI.prototype._attachHostBroadcast = function () {
    var self = this;
    this.game.on(function (type, data) {
      if (!self.net) return;
      if (type === 'shot') {
        self.net.send({ type: 'shot', round: self.game.round, shot: GW.packShot(data.shot) });
      } else if (type === 'turn') {
        self.net.send({
          type: 'turn', currentTurn: self.game.currentTurn,
          players: GW.snapshotPlayers(self.game), packs: GW.snapshotPacks(self.game)
        });
      } else if (type === 'move') {
        self.net.send({ type: 'move', round: self.game.round, playerIndex: data.playerIndex, soldierIndex: data.soldierIndex, fx: data.fx, fy: data.fy, tx: data.tx, ty: data.ty });
      } else if (type === 'skill') {
        self.net.send({ type: 'skill_used', playerIndex: data.playerIndex, skill: data.skill });
      } else if (type === 'reward') {
        self.net.send({ type: 'reward', playerIndex: data.playerIndex, kind: data.kind, x: data.x, y: data.y, pack: self._packOf(data) });
      } else if (type === 'pack') {
        self.net.send({ type: 'pack', pack: data.pack });
      } else if (type === 'over') {
        self.net.send({
          type: 'over',
          result: { winner: data.winner ? { team: data.winner.team } : null, reason: data.reason }
        });
      }
    });
  };

  GW.UI.prototype._packOf = function (data) {
    var packs = (this.game && this.game.packs) || [];
    for (var i = 0; i < packs.length; i++) {
      if (packs[i].kind === data.kind && Math.abs(packs[i].x - data.x) < 3) return packs[i];
    }
    return null;
  };

  /** 房主端代客人执行开炮（校验与 server.js 的 applyFire 完全一致） */
  GW.UI.prototype._hostApplyFire = function (m) {
    var g = this.game;
    if (!g) { this.net.send({ type: 'fire_error', msg: '对局尚未开始' }); return; }
    if (g.state !== 'aim') { this.net.send({ type: 'fire_error', msg: '炮弹还在飞，请稍候' }); return; }
    if (g.currentTurn !== 1) { this.net.send({ type: 'fire_error', msg: '还没轮到你' }); return; }
    if (g.mode === C.SND_ODE) g.setAngle(m.angle || 0);
    var res = g.fire(m.expr, false, m.weapon);
    if (!res.ok) this.net.send({ type: 'fire_error', msg: res.reason });
  };

  /** 房主端代客人执行手绘弹道（校验与 server.js 的 applySketch 完全一致） */
  GW.UI.prototype._hostApplySketch = function (m) {
    var g = this.game;
    if (!g) { this.net.send({ type: 'fire_error', msg: '对局尚未开始' }); return; }
    if (g.state !== 'aim') { this.net.send({ type: 'fire_error', msg: '炮弹还在飞，请稍候' }); return; }
    if (g.currentTurn !== 1) { this.net.send({ type: 'fire_error', msg: '还没轮到你' }); return; }
    if (!m.norm || !m.norm.length) { this.net.send({ type: 'fire_error', msg: '请先在画板上拖出一笔' }); return; }
    var traj = g.buildSketchTrajectory(m.norm, m.rot || 0, m.scale == null ? 1 : m.scale);
    if (!traj || traj.numSteps < 2) {
      this.net.send({ type: 'fire_error', msg: '这一笔无法形成有效弹道，请重画或调小尺寸' });
      return;
    }
    var res = g.fireTrajectory(traj, traj.expr, C.FUNCTION_VELOCITY, m.weapon);
    if (!res.ok) this.net.send({ type: 'fire_error', msg: res.reason });
  };

  /** 房主端代客人执行位移（写函数 / 手绘曲线两种） */
  GW.UI.prototype._hostApplyMove = function (m) {
    var g = this.game;
    if (!g) { this.net.send({ type: 'fire_error', msg: '对局尚未开始' }); return; }
    if (g.state !== 'aim') { this.net.send({ type: 'fire_error', msg: '请等当前行动结束' }); return; }
    if (g.currentTurn !== 1) { this.net.send({ type: 'fire_error', msg: '还没轮到你' }); return; }
    var res;
    if (m.norm && m.norm.length) {
      var traj = g.buildSketchTrajectory(m.norm, m.rot || 0, m.scale == null ? 1 : m.scale);
      if (!traj || traj.numSteps < 2) { this.net.send({ type: 'fire_error', msg: '这一笔无法作为位移路径' }); return; }
      var saved = this.action;
      this.action = 'move';
      res = this._moveAlongTrajectory(traj, m.dist);
      this.action = saved;
    } else {
      res = g.move(m.expr, m.dist, false);
    }
    if (!res.ok) this.net.send({ type: 'fire_error', msg: res.reason });
  };

  /** 房主端代客人写技能（点对点：房主即权威端） */
  GW.UI.prototype._hostApplySkillPick = function (m) {
    var g = this.game;
    if (!g) { this.net.send({ type: 'fire_error', msg: '对局尚未开始' }); return; }
    var seat = (typeof m.seat === 'number') ? m.seat : g.currentTurn;
    var res = g.pickSkill(seat, m.skill);
    if (!res.ok) { this.net.send({ type: 'fire_error', msg: res.reason }); return; }
    g.emit('skills', { players: GW.snapshotPlayers(g).map(function (p) { return { skill: p.skill, skillUsed: p.skillUsed }; }) });
  };

  /** 房主端代客人使用技能 */
  GW.UI.prototype._hostApplySkill = function () {
    var g = this.game;
    if (!g || g.state !== 'aim') { this.net.send({ type: 'fire_error', msg: '请等当前行动结束' }); return; }
    if (g.currentTurn !== this.myTeam) { this.net.send({ type: 'fire_error', msg: '还没轮到你' }); return; }
    var res = g.useSkill();
    if (!res.ok) this.net.send({ type: 'fire_error', msg: res.reason });
  };

  GW.UI.prototype.enterLobby = function () {
    if (this.net) { try { this.net.quit(); } catch (e) { /* 忽略 */ } this.net = null; }
    this.isRemote = false;
    this.myTeam = 0;
    this.isHost = false;
    this._p2pRole = null;
    this.showScreen('screen-lobby');
    $('btn-mp-copy').style.display = 'none';
    $('mp-share').classList.add('hidden');
    $('p2p-room-no').classList.add('hidden');
    if ($('p2p-link-row')) $('p2p-link-row').classList.add('hidden');
    var roomNumEl = $('p2p-room-num');
    if (roomNumEl && roomNumEl.value != null) roomNumEl.value = '······';
    $('p2p-room-input').value = '';
    this._setLinkMode();   // 联机房间模式（房主即权威端，零服务器）
    /* 若带邀请链接进来（?room=），自动进房，玩家零操作 */
    try {
      var params = new URLSearchParams(location.search);
      var roomParam = params.get('room');
      if (roomParam) {
        this._setLinkMode();
        $('p2p-room-input').value = roomParam;
        this._lobbyStatus('检测到邀请链接，正在为你加入房间 <b>' + escapeHtml(roomParam) + '</b> …', 'info');
        try { history.replaceState({}, '', location.pathname); } catch (e) {}  // 清掉参数，避免刷新重复触发
        var joinBtn = $('btn-room-join');
        var self2 = this;
        setTimeout(function () { if (joinBtn && !self2._roomJoinFired) { self2._roomJoinFired = true; joinBtn.click(); } }, 700);
      }
    } catch (e) { /* 解析失败不影响手动操作 */ }
  };

  GW.UI.prototype._leaveLobby = function () {
    if (this.net) { try { this.net.quit(); } catch (e) { /* 忽略 */ } this.net = null; }
    this.isRemote = false;
    this.myTeam = 0;
    this.botTeam = -1;
    this.isHost = false;
    this._p2pRole = null;
    this._mirrorExpr = '';
    this.setQuickVisible(false);
    this.showScreen('screen-menu');
  };

  /** 把服务器事件接到 UI（每次新建连接时调用一次） */
  GW.UI.prototype._setupNet = function (net) {
    var self = this;
    net.on('error', function (m) { self._lobbyStatus('连接错误：' + escapeHtml(m.msg || '未知') + '。请确认房间号正确、网络可访问公网后重试。', 'error'); });
    net.on('created', function (m) {
      self.myTeam = m.team;
      $('btn-mp-copy').style.display = 'inline-block';
      self._lobbyStatus('房间已创建，房号 <b>' + m.code + '</b>（你是 ' + self._teamName(m.team) +
        '）。把下方链接发给对手，他点开即可自动加入。', 'ok');
      if (m.share) self._renderShare(m.share, m.code);
    });
    net.on('share', function (m) { self._renderShare(m.share, self.net && self.net.room); });
    net.on('chat', function (m) { self._onRemoteChat(m); });
    net.on('joined', function (m) {
      self.myTeam = m.team;
      self._lobbyStatus('已加入房间 <b>' + m.code + '</b>，你是 ' + self._teamName(m.team) + '。等待房主开始…', 'ok');
    });
    net.on('wait', function (m) { self._lobbyStatus(m.msg || '等待对手加入…', 'info'); });
    net.on('start', function (m) { self.enterRemoteGame(m); });
    net.on('turn', function (m) { self._onRemoteTurn(m); });
    net.on('shot', function (m) { self._onRemoteShot(m); });
    net.on('move', function (m) { self._onRemoteMove(m); });
    net.on('skill_used', function (m) { self._onRemoteSkill(m); });
    net.on('skills', function (m) { if (self.game) self.game.emit('skills', { players: m.players }); });
    net.on('reward', function (m) { self._onRemoteReward(m, false); });
    net.on('pack', function (m) { self._onRemoteReward(m, true); });
    net.on('over', function (m) { self._onRemoteOver(m); });
    net.on('fire_error', function (m) { self._onRemoteFireError(m); });
    net.on('opponent_left', function (m) { self._onOpponentLeft(m); });
    net.on('bot_tookover', function (m) { self._onBotTookover(m); });
    /* 只对点对点联机生效：房主端（权威端）会收到客人的行动意图 */
    net.on('close', function () { if (self.isRemote && self.game) self._onOpponentLeft(); });
    net.on('fire', function (m) { if (self.isHost) self._hostApplyFire(m); });
    net.on('sketch', function (m) { if (self.isHost) self._hostApplySketch(m); });
    net.on('move_intent', function (m) { if (self.isHost) self._hostApplyMove(m); });
    net.on('skill', function (m) { if (self.isHost) self._hostApplySkill(m); });
    net.on('skill_pick', function (m) { if (self.isHost) self._hostApplySkillPick(m); });
    net.on('rematch', function () {
      if (!self.isHost) return;
      self._p2pHostStart();
      self.toast('已重开一局：新地图、同一条直连。', 'sys');
    });
  };

  /** 服务器下发对局开始：建立本地镜像 */
  GW.UI.prototype.enterRemoteGame = function (msg, opts) {
    if (this.tutorial && this.tutorial.isActive()) this.tutorial.stop(true);
    /* authoritative：点对点联机的房主端——本机就是对局权威端，回合由自己推进 */
    var authoritative = !!(opts && opts.authoritative);
    this.isHost = authoritative;
    this.isRemote = true;
    this.myTeam = msg.team;
    this.botTeam = (typeof msg.botTeam === 'number') ? msg.botTeam : -1;
    this._mirrorExpr = '';
    this.showScreen('screen-game');
    var gopts = {
      mode: msg.config.mode,
      soldiersPerPlayer: msg.config.soldiers,
      playerCount: msg.config.playerCount || 2,
      opponent: 'human',
      aiLevel: 2,
      turnTimeSec: (msg.config.turnTime == null) ? 120 : msg.config.turnTime
    };
    /* 回合快照会带上赛制（队伍总数 / 每队人数），带上它才能开出同一份队伍构成 */
    if (msg.config && msg.config.teams) { gopts.teams = msg.config.teams; gopts.perTeam = msg.config.perTeam; }
    this.game = new GW.Game(gopts);
    this.renderer = new GW.Renderer($('stage'), this.game);
    this._attachGameEvents();
    this._assignDefaultSkills();   // 先兜底配技（权威端的技能随后由 turn / skills 覆盖）
    if (authoritative) this._attachHostBroadcast();   // 房主：把本地对局事件广播给客人
    this._skillPicked = false;
    this.action = 'fire';
    this._setupOrderUI(false);
    /* 开局先弹「选择开局技能」，这时不弹回合准备；选完技能再弹（见 _afterRemoteSkillPick） */
    this._suppressPrep = true;
    /* 必须在 _attachGameEvents 之后调用：loadBattle 会 emit 'turn'，
     * 由 onTurn 据此启用 / 禁用输入并聚焦到当前行动方。 */
    this.game.loadBattle(msg.terrain.circles, msg.terrain.positions, msg.currentTurn, !authoritative);
    $('badge-mode').textContent = C.MODE_NAME[this.game.mode] +
      (this.game.playerCount > 2 ? ' · ' + GW.teamLabel(this.game.teams, this.game.perTeam) : '') +
      (authoritative ? ' · 联机（房主）' : ' · 联机');
    this.lastFired = '';
    this.lastFiredTeam = 0;
    this.setFuncDisplay('');
    var vsNote = (this.botTeam >= 0 && this.botTeam !== msg.team) ? '（对手为 AI 电脑）' : '';
    var linkNote = authoritative ? '（点对点直连 · 你是房主）'
      : ('，房号 ' + (this.net ? this.net.room : ''));
    this.toast((authoritative ? '联机对战开始' : '联机对战开始') + '：你是 ' +
      this._teamName(msg.team) + linkNote + vsNote, 'sys');
    $('expr-input').value = '';
    $('expr-status').textContent = '提示：输入表达式即可预览弹道，回车发射';
    $('expr-status').className = 'expr-status';
    $('sketch-status').textContent = '按住拖动即可定方向，松手后可继续微调';
    $('sketch-status').className = 'expr-status';
    this.sketch.clear();
    this.setSketchRot(0);
    this.setSketchScale(1);
    this.setQuickVisible(true);    // 联机对局显示「快捷语」互动入口
    this.syncModeUI();
    this._applyAction(this.action);
    this.renderer.resize();
    this.sketch.resize();
    this.refreshTeams();
    this.updateTurnUI();
    this.startLoop();
    this._askRemoteSkill();   // 联机开局也走一次技能选择（自己的席位）
  };

  GW.UI.prototype._onRemoteTurn = function (m) {
    var g = this.game;
    if (!g) return;
    for (var i = 0; i < m.players.length; i++) {
      var sp = m.players[i], pp = g.players[i];
      pp.currentSoldierIndex = sp.currentSoldierIndex;
      pp.kills = sp.kills;
      pp.friendly = sp.friendly;
      pp.aimBonus = sp.aimBonus || 0;
      pp.moveBonus = sp.moveBonus || 0;
      pp.powerShot = !!sp.powerShot;
      pp.skill = sp.skill || pp.skill;
      pp.skillUsed = !!sp.skillUsed;
      for (var k = 0; k < pp.numSoldiers; k++) {
        var ss = sp.soldiers[k];
        var soldier = pp.getSoldiers()[k];
        soldier.alive = ss.alive;
        soldier.hp = (typeof ss.hp === 'number') ? ss.hp : soldier.hp;
        if (typeof ss.x === 'number') { soldier.x = ss.x; soldier.y = ss.y; }
      }
    }
    if (m.packs) {
      g.packs = m.packs.map(function (p) { return { id: p.id, x: p.x, y: p.y, kind: p.kind }; });
    }
    g.currentTurn = m.currentTurn;
    g.state = 'aim';
    g.moveAnim = null;
    g.turnStartTime = Date.now();
    g.ai = null;
    g.emit('turn', { playerIndex: m.currentTurn });
  };

  /** 对手位移：镜像端播放滑动动画 */
  GW.UI.prototype._onRemoteMove = function (m) {
    var g = this.game;
    if (!g) return;
    var p = g.players[m.playerIndex];
    if (!p) return;
    var s = p.getSoldiers()[m.soldierIndex] || p.getCurrentTurnSoldier();
    g.moveAnim = { playerIndex: m.playerIndex, soldierIndex: m.soldierIndex, fx: m.fx, fy: m.fy, tx: m.tx, ty: m.ty, start: Date.now() };
    s.x = m.tx; s.y = m.ty;
    g.state = 'moving';
    g.round = (typeof m.round === 'number') ? m.round : g.round + 1;
    this.toast(this._seatName(m.playerIndex) + ' 位移。', 'sys');
  };

  /** 对手用技能（HP 变化随后由 turn 快照同步） */
  GW.UI.prototype._onRemoteSkill = function (m) {
    var sk = GW.skillById(m.skill);
    this.toast(this._seatName(m.playerIndex) + ' 发动技能「' + (sk ? sk.name : m.skill) + '」。', 'hit');
    var g = this.game;
    if (g && g.players[m.playerIndex]) g.players[m.playerIndex].skillUsed = true;
  };

  /** 奖励包：spawn=新空投；否则为对手拾取 */
  GW.UI.prototype._onRemoteReward = function (m, spawn) {
    var g = this.game;
    if (!g) return;
    if (spawn) {
      if (m.pack && !g.packs.some(function (p) { return p.id === m.pack.id; })) {
        g.packs.push({ id: m.pack.id, x: m.pack.x, y: m.pack.y, kind: m.pack.kind });
      }
      var def0 = GW.packById(m.pack ? m.pack.kind : '');
      this.toast('空投「' + (def0 ? def0.name : '') + '」出现！', 'sys');
      return;
    }
    for (var i = g.packs.length - 1; i >= 0; i--) {
      if (!m.pack || g.packs[i].id === m.pack.id || (Math.abs(g.packs[i].x - m.x) < 2 && g.packs[i].kind === m.kind)) {
        g.packs.splice(i, 1);
        break;
      }
    }
    if (m.playerIndex !== this.myTeam) {
      var def = GW.packById(m.kind);
      this.toast(this._seatName(m.playerIndex) + ' 拾取「' + (def ? def.name : m.kind) + '」。', 'sys');
    }
  };

  GW.UI.prototype._onRemoteShot = function (m) {
    var g = this.game;
    if (!g) return;
    var s = m.shot, traj = s.traj;
    var shot = {
      traj: {
        xs: Float64Array.from(traj.xs), ys: Float64Array.from(traj.ys),
        numSteps: traj.numSteps, hits: traj.hits, fireAngle: traj.fireAngle,
        lastX: traj.lastX, lastY: traj.lastY, inverted: traj.inverted,
        sketch: traj.sketch, expr: traj.expr
      },
      source: s.source,
      start: Date.now(),
      playerIndex: s.playerIndex,
      soldierIndex: s.soldierIndex,
      velocity: s.velocity,
      weapon: (typeof s.weapon === 'number') ? s.weapon : 1,
      killed: [],
      exploded: false,
      isAI: false
    };
    g.shot = shot;
    g.state = 'drawing';
    g.round = (typeof m.round === 'number') ? m.round : g.round + 1;

    var shooterTeam = g.players[s.playerIndex].team;
    $('expr-input').value = '';
    this._mirrorExpr = '';
    $('expr-status').textContent = '炮弹已出膛…';
    $('expr-status').className = 'expr-status';
    this.lastFired = s.source;
    this.lastFiredTeam = shooterTeam;
    this.setFuncDisplay(s.source, { mode: 'fired', team: shooterTeam });
    this.renderer.setPreview(null);
    this.toast(C.TEAM_NAME[shooterTeam] + ' 开炮：' + s.source, s.playerIndex === this.myTeam ? 'me' : 'shoot');
  };

  GW.UI.prototype._onRemoteOver = function (m) {
    var g = this.game;
    if (!g) return;
    g.state = 'over';
    g.result = m.result;
    g.emit('over', m.result);
  };

  GW.UI.prototype._onRemoteFireError = function (m) {
    if (this.isRemote && this.game && this.game.currentTurn === this.myTeam) {
      $('expr-status').textContent = '✗ ' + (m.msg || '开炮失败');
      $('expr-status').className = 'expr-status error';
    }
    this.toast('开炮未生效：' + (m.msg || ''), 'bad');
  };

  GW.UI.prototype._onOpponentLeft = function () {
    this.toast('对手已离开，对局结束。', 'bad');
    var self = this;
    setTimeout(function () { self.quitToMenu(); }, 1800);
  };

  /** 联机中对手掉线，服务器用 AI 顶替其阵地，对局继续 */
  GW.UI.prototype._onBotTookover = function (m) {
    this.botTeam = (typeof m.team === 'number') ? m.team : -1;
    this.toast('对手掉线，AI 已接管 ' + this._teamName(m.team) + ' 阵地，对局继续。', 'sys');
    this.refreshTeams();
  };

  /** 对手发来快捷语 → 气泡提示（青色，区别于系统消息） */
  GW.UI.prototype._onRemoteChat = function (m) {
    var who = (typeof m.from === 'number') ? this._teamName(m.from) : '对手';
    this.toast(who + '：' + (m.text || ''), 'chat');
  };

  /** 把服务器探测到的公网 / 局域网地址渲染成「一键分享链接」 */
  GW.UI.prototype._renderShare = function (share, code) {
    var box = $('mp-share');
    if (!box || !share) return;
    code = code || (this.net && this.net.room) || '';
    var L = loc();
    var port = share.port || (L.port ? parseInt(L.port, 10) : 80);
    var hosts = [];
    if (share.publicIp) hosts.push({ tag: '公网', host: share.publicIp });
    var lans = share.lanIps || [];
    if (lans.length) hosts.push({ tag: '局域网', host: lans[0] });
    if (!hosts.length) hosts.push({ tag: '本机', host: L.hostname || 'localhost' });

    var self = this;
    var html = '<div class="share-title">朋友点开下面任意一条链接即可<b>自动加入本房间</b>' +
      (share.publicIp ? '' : '（暂未探测到公网 IP，先给出局域网地址）') + '：</div>';
    hosts.forEach(function (h) {
      var url = 'http://' + h.host + (port && port !== 80 ? ':' + port : '') + '/' +
        (code ? '?room=' + code : '');
      html += '<div class="share-line"><span class="share-tag">' + h.tag + '</span>' +
        '<code class="share-url">' + escapeHtml(url) + '</code>' +
        '<button class="btn btn-mini share-copy" data-url="' + escapeHtml(url) + '">复制</button></div>';
    });
    box.innerHTML = html;
    box.classList.remove('hidden');
    Array.prototype.forEach.call(box.querySelectorAll('.share-copy'), function (btn) {
      btn.onclick = function () {
        var url = btn.getAttribute('data-url');
        if (navigator.clipboard) {
          try { navigator.clipboard.writeText(url); self._lobbyStatus('分享链接已复制：<b>' + escapeHtml(url) + '</b>', 'ok'); return; } catch (e) { /* 退化为提示 */ }
        }
        self._lobbyStatus('请手动复制分享链接：<b>' + escapeHtml(url) + '</b>', 'info');
      };
    });
  };

  /** 打开带 ?room=XXXX 的分享链接时，自动进入大厅并加入该房间 */
  GW.UI.prototype.handleInvite = function () {
    var m = /[?&]room=([A-Za-z0-9]{1,8})/.exec(loc().search || '');
    if (!m) return;
    var code = m[1].toUpperCase();
    this.enterLobby();
    $('mp-code').value = code;
    this._lobbyStatus('检测到邀请房号 <b>' + code + '</b>，正在自动加入…', 'info');
    setTimeout(function () { var b = $('btn-mp-join'); if (b) b.click(); }, 400);
  };

  /* 供页面 ready 后调用 */
  GW.boot = function () {
    GW.ui = new GW.UI();
    GW.ui.handleInvite();
  };

})(typeof window !== 'undefined' ? window : globalThis);
