/* ============================================================
 * 中文新手教程：固定战场 + 分步引导 + 高亮 + 动手任务
 * 每一步都对应真实 UI 区域；动手步骤会自动「虚化」——不再压暗全屏、
 * 卡片自动缩窄并躲到不挡面板的位置，玩家点点 Dickens 直接操作即可。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});
  var C = GW.C;

  var STEPS = [
    {
      title: '第 1 步 · 这游戏到底怎么玩？',
      target: '#stage',
      body: '<b>目标</b>：用<b>数学函数</b>当炮弹，消灭对面阵地上的全体士兵。' +
        '<ul><li>你写下的每一个表达式，都会变成一条真实的飞行轨迹；</li>' +
        '<li>轨迹会自动从<b>当前行动的士兵</b>脚下射出；</li>' +
        '<li>打中敌人得分，打中自己人同样会阵亡。</li></ul>' +
        '这是一场纯数学的炮术对决——不需要瞄准，只需要算准。'
    },
    {
      title: '第 2 步 · 认识这张坐标纸',
      target: '#stage',
      body: '战场就是一张<b>直角坐标平面</b>：' +
        '<ul><li>横轴范围 <code>x ∈ [-25, 25]</code>，纵轴范围约 <code>y ∈ [-15, 15]</code>；</li>' +
        '<li>中间两条深色线是坐标轴，交点是原点 (0, 0)；</li>' +
        '<li>把鼠标移到画布上，会实时显示该点的坐标，方便你估算敌人的位置。</li></ul>' +
        '<b>注意</b>：范围只有 ±25，函数值很容易变得巨大，比如 <code>x^2</code> 在 x=10 处就已经等于 100 了。'
    },
    {
      title: '第 3 步 · 谁是谁、还剩几个人',
      target: '#funcbar',
      body: '屏幕<b>最上方</b>这一条就是全局战况栏：' +
        '<ul><li>左边 <b>绿色</b> 是<b>左军</b>，右边 <b>青色</b> 是<b>右军</b>；</li>' +
        '<li>编号牌代表每名士兵，打光的一方判负，数字会变成灰色的叉；</li>' +
        '<li>中间那一大块，显示的是<b>刚刚操作的那条函数</b>——写函数显示原式，画函数显示拟合出的解析式。</li></ul>' +
        '对人多的局，主菜单选 <b>「多人模式（多队对抗）」</b>，先设<b>队伍总数</b>（2 / 3 / 4 队）、再设<b>每队人数</b>（1 / 2 / 3 / 4 人）：' +
        '两者相乘就是<b>总人数</b>——<b>2 队 × 2 人 = 4 人（2v2）</b>、<b>2 队 × 3 人 = 6 人（3v3）</b>、' +
        '<b>2 队 × 4 人 = 8 人（4v4）</b>、<b>3 队 × 2 人 = 6 人（2v2v2）</b>、<b>4 队 × 2 人 = 8 人（2v2v2v2）</b>，' +
        '<b>3 队 × 1 人</b> 就是人人一队的混战（徽章写成 <code>1v1v1</code>）。' +
        '总人数超过 2 人时每人只指挥 1 名士兵，席位名显示成「第 N 队 · M 号」，' +
        '打光<b>某一整队</b>就算这队判负。' +
        '战场上每个小人头顶也有编号，带闪动光圈的就是<b>本回合正在开炮</b>的那名士兵。'
    },
    {
      title: '第 4 步 · 函数怎么写',
      target: '#input-block',
      body: '底部这条横幅是<b>写函数</b>区。在输入框里填<b>等号右边</b>的部分就行（写 <code>y = ...</code> 也可以，会自动去掉）。' +
        '<table class="syntax-grid"><tr><th>类别</th><th>可用符号</th></tr>' +
        '<tr><td>变量</td><td><code>x</code>（普通模式）、<code>y</code> <code>y\'</code>（微分方程模式）</td></tr>' +
        '<tr><td>运算</td><td><code>+</code> <code>-</code> <code>*</code> <code>/</code> <code>^</code></td></tr>' +
        '<tr><td>函数</td><td><code>sqrt()</code> <code>log()</code> <code>ln()</code> <code>abs()</code> <code>sin()</code> <code>cos()</code> <code>tan()</code></td></tr>' +
        '<tr><td>常量</td><td><code>e</code> <code>pi</code>，省略乘号的写法如 <code>2x</code> 也支持</td></tr></table>' +
        '下面的符号键盘可以点击插入，右侧「示例」按钮能直接填入常用写法。' +
        '多写括号更保险：<code>1/(x+2)</code> 与 <code>1/x+2</code> 完全不同。'
    },
    {
      title: '第 5 步 · 最关键的一条：常数平移',
      target: '#input-block',
      require: 'preview',
      dim: false,
      body: '士兵不一定站在你的曲线上，所以系统会自动给函数<b>加上一个常数</b>，把整条曲线平移到他脚下。' +
        '<ul><li>因此 <code>2*x + 3</code>、<code>2*x - 8</code>、<code>2*x</code> 射出的轨迹' +
        '<span class="log-line bad">完全一样</span>——写常数没有意义。</li>' +
        '<li>反之，像 <code>x^2</code> 这种陡峭函数会被平移得认不出来，请务必缩放：<code>(x^2)/50</code> 才是一条漂亮的抛物线。</li></ul>' +
        '<div class="tut-task">动手试一试：在底部「写函数」输入框填入 <code>-((x+16)*(x-14))/20</code>，' +
        '战场上会出现虚线预览——它正好从 1 号兵脚下起飞、越过山头、砸中敌方。' +
        '（本步教程已自动虚化并让开位置，卡住了就点右上角「收起」）</div>'
    },
    {
      title: '第 6 步 · 开火',
      target: ['#input-block', '#stage'],
      require: 'fire',
      dim: false,
      body: '虚线就是这条函数的实际飞行轨迹。<b>确认轨迹既不撞山、也不扫到自己人</b>之后，按回车或点「发射」即可。' +
        '<div class="tut-task">动手试一试：保持刚才的输入，直接发射。教程卡片此时是虚化的，完全不会挡住你操作。</div>' +
        '<b>下一步的彩蛋</b>：教程地图上双方 1 号兵高度相同，之后再输入 <code>0</code>（一条水平直线）发射，你会看到什么叫「误伤」。'
    },
    {
      title: '第 7 步 · 地形阻挡与己方误伤',
      target: '#funcbar',
      body: '刚才发生了两件事：' +
        '<ul><li>炮弹撞到<b>深绿色山体</b>会立刻停下并炸出一个坑（下一发也许就能穿过去）；</li>' +
        '<li>轨迹<b>不分敌我</b>：只要经过任何一名士兵（<span class="log-line bad">包括你自己的队友</span>）都会将其炸死。</li></ul>' +
        '命中与误伤会实时结算在<b>顶部战况栏</b>里：<b>命中敌方 +100 分，误伤己方 −50 分</b>；' +
        '战况之外不再保留长长的日志，重要事件只在战场上短暂停留一行提示，避免占据画面。'
    },
    {
      title: '第 8 步 · 懒得写式子？直接画一笔',
      target: '#panel-draw',
      require: 'sketch',
      dim: false,
      body: '战场<b>左侧</b>这块画板（比例与战场完全一致）用来<b>画函数</b>：按住鼠标（或手指）拖出一笔，松手即可。' +
        '<ul><li>这一笔<b>只决定方向</b>，不决定长度——系统会把它拟合成一条<b>函数解析式</b>，' +
        '然后像普通函数一样<b>一直飞下去</b>，直到撞到地形、击中士兵或飞出战场；</li>' +
        '<li>拟合出来的解析式会显示在<b>屏幕最上方</b>，画板和写函数显示的是同一类「函数数值」；</li>' +
        '<li>画完还能用 <b>方向</b> 旋转、<b>大小</b> 缩放，上方函数式与战场虚线预览都会实时变化。</li></ul>' +
        '<div class="tut-task">动手试一试：在画板上随便拖出一笔，然后拖动「方向」看看函数式和瞄准线怎么变。</div>'
    },
    {
      title: '第 9 步 · 回合与胜负',
      target: '#funcbar',
      body: '<ul><li>每回合有 <b>2 分钟</b>思考时间（顶部进度条实时倒数），超时视为放弃本回合；</li>' +
        '<li>炮弹落地后约 3 秒自动轮转到下一名存活士兵；</li>' +
        '<li><b>胜负</b>：某一方士兵全部阵亡则判负；同时全灭为平局，结算面板会给出双方命中、误伤与积分。</li></ul>' +
        '你已经掌握全部核心机制了——接下来可以换一阶 / 二阶微分方程模式，挑战电脑 AI，或者拉上朋友同屏对战。'
    },
    {
      title: '第 10 步 · 血量与三种导弹',
      target: '#weapon-row',
      body: '现在炮弹<b>打不死人了</b>：每名士兵有 <b>100 点血</b>（头顶血条），' +
        '炮弹只按「飞过谁」和「炸在哪」扣血。<ul>' +
        '<li>发射前先选导弹：<b>重炮弹</b>高伤单发、<b>标准弹</b>均衡、<b>散弹</b>一次五枚覆盖面更广；</li>' +
        '<li>想补刀就直接轰脸，或者先叠一层增伤。</li></ul>'
    },
    {
      title: '第 11 步 · 位移：这一回合「走」而不是「打」',
      target: '#seg-action',
      body: '把动作切到 <b>位移</b>，会多出一条距离滑杆。<ul>' +
        '<li>表达式或手绘曲线在这一回合变成<b>移动路线</b>：士兵沿曲线走一小段；</li>' +
        '<li>距离默认上限 <b>5 格</b>（捡到「疾行靴」可临时 +3），终点撞山或出界会被拒绝，缩短即可；</li>' +
        '<li>路上碰到空投补给箱会<b>顺手捡走</b>，位移因此不只是逃命手段。</li></ul>'
    },
    {
      title: '第 12 步 · 开局技能与随机空投',
      target: '#btn-skill',
      body: '进战场前，<b>是每一位玩家（每一个席位）都自己选一个开局技能</b>，' +
        '不是统配给全队——弹窗会<b>一个席位一个席位地轮着选</b>：选完自动跳到下一位，' +
        '点「<b>上一位</b>」可以回去改，<b>最后一位点「确定」</b>才全部生效。' +
        '技能一局只能用一次、用了就消耗本回合：<b>应急修理</b>（+45 血）、<b>群体维修</b>（全队 +30）、' +
        '<b>火力强化</b>（下一发 ×1.6）、<b>侦察卫星</b>（辅助瞄准线 +80）。对局里每回合结束可能空投补给箱，' +
        '<b>炮弹炸中或位移撞上</b>都能拾取：维修包、瞄准镜（辅助线 +50）、强化弹头、疾行靴。'
    },
    {
      title: '第 13 步 · 两个可以收起来的小窗口',
      target: '#win-min-draw',
      body: '左侧<b>手绘窗口</b>和下方<b>手写窗口</b>都是次级窗口：' +
        '<b>电脑上</b>拖它们的<b>顶部把手</b>可以随意摆位，点右上角 <b>−</b> 可最小化，' +
        '只留一条标题；再点标题就还原。手写区是<b>竖屏计算器布局</b>：动作 → 位移距离 → 三种导弹 → 表达式 → 四列符号键盘 → 发射。' +
        '<b>手机上（窄屏）</b>它们不再飘在战场上，而是变成<b>贴底抽屉</b>，' +
        '战场下方多一条<b>标签页</b>：<b>「✎ 画函数」</b> / <b>「⌨ 指令台」</b> 切换抽屉（同一时刻只开一个），' +
        '点 <b>「▾ 让开战场」</b> 就把两块面板都收起、露出整块战场。' +
        '不想操作时把它们收起来，整块战场就全露出来了。'
    }
  ];

  GW.Tutorial = function Tutorial(ui) {
    this.ui = ui;
    this.index = 0;
    this.active = false;
    this.done = {};
    this.spots = [];
    this._spotEls = [];
  };

  GW.Tutorial.STEPS = STEPS;

  /* 联机对战教程：在大厅里分步讲解每个按钮，无需进入战场 */
  GW.Tutorial.ONLINE_STEPS = [
    {
      title: '联机对战怎么玩？',
      target: '#screen-lobby',
      body: '<b>联机对战</b>让你和另一名玩家（或 AI）在<b>同一张地图</b>上隔空对炮。' +
        '<ul><li>对局由<b>服务器权威</b>计算：你只发送「开炮意图」，服务器算好弹道后两边都播放同一颗炮弹；</li>' +
        '<li>所以双方看到的战场、爆炸、阵亡完全一致，不存在「你打中了他没死」的争执。</li></ul>' +
        '下面几步带你过一遍大厅里的每个按钮。'
    },
    {
      title: '连上服务器',
      target: '#mp-url',
      body: '首先得有一台运行着服务器的机器。在<b>能联网的电脑</b>上执行：' +
        '<div class="tut-task">node server/server.js</div>' +
        '然后用浏览器打开 <code>http://&lt;那台机器&gt;:8080</code>。' +
        '本框已默认填好「当前打开页面的服务器地址」，<b>一般不用改</b>；' +
        '跨设备时把 <code>localhost</code> 换成房主的内网 / 公网 IP，例如 <code>ws://203.0.113.5:8080</code>。'
    },
    {
      title: '选择弹道模式与赛制',
      target: ['#seg-mp-mode', '#seg-mp-soldiers'],
      body: '先挑<b>弹道模式</b>（普通函数 / 一阶 / 二阶微分方程）和<b>每方士兵数</b>；' +
        '这里设的是<b>赛制</b>：<b>队伍总数</b>（2 / 3 / 4 队）× <b>每队人数</b>（1 / 2 / 3 / 4 人）= 总人数，' +
        '如 <b>2 队 × 3 人 = 3v3 共 6 人</b>、<b>4 队 × 2 人 = 2v2v2v2 共 8 人</b>；' +
        '总人数超过 2 时每人只指挥 1 名士兵（服务器同样按赛制给每个席位分阵营）。' +
        '同一间房的赛制以<b>房主创建时</b>为准，后加入的人按这个人数落座。'
    },
    {
      title: '创建房间',
      target: '#btn-mp-create',
      body: '点「创建并等待对手」后，服务器会给你一个 <b>4 位房号</b>（如 <code>K7P2</code>）。' +
        '把房号发给朋友，等他加入即可开打。' +
        '<div class="tut-task">想一个人练？勾选下方的「人机补齐」，会直接以 AI 为对手开局，无需等别人。</div>'
    },
    {
      title: '加入房间',
      target: ['#mp-code', '#btn-mp-join'],
      body: '作为另一方，在「房间号」里填入朋友发来的 4 位房号，点「加入房间」。' +
        '两人都进入后，服务器立刻生成同一张地图并随机决定先手，两端同时开打。'
    },
    {
      title: '不想开服务器？用「点对点联机」',
      target: '#seg-mp-link',
      body: '把连接方式切到 <b>点对点联机</b>：两台设备<b>直连</b>，' +
        '<b>房主的浏览器就是服务器</b>，对局数据不经过任何第三方，也不需要 <code>server.js</code>。' +
        '<div class="tut-task">握手只需来回复制一次连接码：房主生成「邀请码」→' +
        '朋友粘贴后生成「回执码」→ 房主贴回回执码，对战立即开始。</div>' +
        '注意：页面必须是 <code>https://</code> 或 <code>localhost</code>（浏览器对 WebRTC 的硬性要求）；' +
        '少数网络（对称 NAT、部分校园网）连不通时，请回到「服务器联机」。'
    },
    {
      title: '人机补齐（AI 顶替）',
      target: '#chk-mp-fillai',
      body: '勾选「人机补齐」后有两种效果：' +
        '<ul><li><b>开局即补</b>：创建房间时若没有真人对手，服务器直接让 AI 执子，你立刻就能开练；</li>' +
        '<li><b>掉线接管</b>：对局中对手若中途离开，AI 会顶替他的阵地，对局不中断、不判负。</li></ul>'
    },
    {
      title: '对局内怎么打',
      target: '#screen-lobby',
      body: '进入战场后操作和单机完全一致：' +
        '<ul><li>轮到你时输入框与画板才会亮起，<b>写函数</b>或<b>画函数</b>都行；</li>' +
        '<li>手绘完，拟合出的函数式会<b>自动写进下方输入框</b>，你可以直接微调数字再发射；</li>' +
        '<li>顶部「<b>快捷语</b>」按钮可以给对手发预设语句（催一催、打得好…），对手会看到气泡提示；</li>' +
        '<li>开炮后服务器统一计算，对面看到的是同一颗炮弹；一方全灭即分胜负，可「再来一局」。</li></ul>' +
        '点「完成教程」回到大厅，去创建或加入一个房间试试吧！'
    }
  ];

  GW.Tutorial.prototype.start = function (arg) {
    var online = arg === 'online';
    this.online = online;
    this.steps = online ? GW.Tutorial.ONLINE_STEPS : STEPS;
    this.index = 0;
    this.done = {};
    this._closeModal('help-modal');
    this._closeModal('result-modal');
    this.active = true;
    var layer = document.getElementById('tutorial-layer');
    layer.classList.remove('hidden');
    document.getElementById('tut-card').classList.remove('minimized');
    document.getElementById('tut-min').textContent = '收起';
    if (online) {
      this.game = null;
    } else if (arg !== false) {
      this.game = this.ui.startTutorialBattle();
    } else {
      this.game = this.ui.game;
    }
    this.render();
  };

  GW.Tutorial.prototype._closeModal = function (id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  };

  GW.Tutorial.prototype.stop = function (silent) {
    this.active = false;
    this.online = false;
    this._clearSpots();
    document.getElementById('tutorial-layer').classList.add('hidden');
    if (!silent && !this.online && this.ui.onTutorialEnd) this.ui.onTutorialEnd();
  };

  /** 收起 / 展开卡片：任何时候都能把教程缩成一小条，让出操作区 */
  GW.Tutorial.prototype.toggleMin = function () {
    var card = document.getElementById('tut-card');
    if (!card) return;
    var min = card.classList.toggle('minimized');
    document.getElementById('tut-min').textContent = min ? '展开' : '收起';
    this._placeCard();
  };

  GW.Tutorial.prototype.render = function () {
    var step = this.steps[this.index];
    var layer = document.getElementById('tutorial-layer');
    document.getElementById('tut-step-tag').textContent = '第 ' + (this.index + 1) + ' / ' + this.steps.length + ' 步';
    document.getElementById('tut-title').textContent = step.title;
    document.getElementById('tut-body').innerHTML = step.body;
    document.getElementById('tut-prev').disabled = this.index === 0;
    var nextBtn = document.getElementById('tut-next');
    nextBtn.textContent = this.index === STEPS.length - 1 ? '完成教程' : '下一步';
    var required = step.require && !this.done[step.require];
    nextBtn.disabled = !!required;

    var dots = document.getElementById('tut-dots');
    dots.innerHTML = '';
    for (var i = 0; i < STEPS.length; i++) {
      var d = document.createElement('span');
      d.className = 'tut-dot' + (i < this.index ? ' done' : (i === this.index ? ' now' : ''));
      dots.appendChild(d);
    }

    /* 动手步骤：不压暗全屏、卡片自动缩小与避让，保证玩家能直接上手操作 */
    layer.classList.toggle('interactive', !!step.require);
    this._highlight(step.target);
  };

  /* ---------------- 高亮与聚光灯 ---------------- */
  GW.Tutorial.prototype._highlight = function (spec) {
    this._clearSpots();
    var sels = !spec ? [] : (Object.prototype.toString.call(spec) === '[object Array]' ? spec : [spec]);
    var els = [];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el) { el.classList.add('tut-spot'); els.push(el); }
    }
    this.spots = els;
    this._syncSpotlights();
    this._placeCard();
  };

  GW.Tutorial.prototype._clearSpots = function () {
    for (var i = 0; i < this.spots.length; i++) this.spots[i].classList.remove('tut-spot');
    this.spots = [];
    this._syncSpotlights();
  };

  GW.Tutorial.prototype._syncSpotlights = function () {
    var layer = document.getElementById('tutorial-layer');
    if (!layer) return;
    while (this._spotEls.length < this.spots.length) {
      var d = document.createElement('div');
      d.className = 'tut-spotlight';
      layer.appendChild(d);
      this._spotEls.push(d);
    }
    for (var i = 0; i < this._spotEls.length; i++) {
      var box = this._spotEls[i];
      var target = this.spots[i];
      if (!target || !target.getBoundingClientRect) {
        box.style.display = 'none';
        continue;
      }
      var r = target.getBoundingClientRect();
      var pad = 7;
      box.style.display = 'block';
      box.style.left = (r.left - pad) + 'px';
      box.style.top = (r.top - pad) + 'px';
      box.style.width = (r.width + pad * 2) + 'px';
      box.style.height = (r.height + pad * 2) + 'px';
    }
    /* 有聚光灯时不再需要整屏遮罩（遮罩由聚光灯的外扩阴影承担） */
    var mask = document.getElementById('tut-mask');
    if (mask) mask.style.opacity = this.spots.length ? '0' : '1';
  };

  /* ---------------- 卡片定位：绝不盖住要操作的区域 ---------------- */
  GW.Tutorial.prototype._unionRect = function () {
    var box = null;
    for (var i = 0; i < this.spots.length; i++) {
      var r = this.spots[i].getBoundingClientRect();
      if (!r) continue;
      if (!box) box = { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
      else {
        box.left = Math.min(box.left, r.left);
        box.top = Math.min(box.top, r.top);
        box.right = Math.max(box.right, r.left + r.width);
        box.bottom = Math.max(box.bottom, r.top + r.height);
      }
    }
    return box;
  };

  GW.Tutorial.prototype._placeCard = function () {
    var card = document.getElementById('tut-card');
    if (!card) return;
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 720;
    cwOrZero(card);
    var cw = card.offsetWidth || Math.min(720, vw - 28);
    var ch = card.offsetHeight || 200;
    if (cw > vw - 20) cw = vw - 20;

    if (!this.spots.length) {
      card.style.bottom = 'auto';
      card.style.left = Math.round((vw - cw) / 2) + 'px';
      card.style.top = Math.round(vh - ch - 18) + 'px';
      return;
    }

    var tr = this._unionRect();
    var margin = 12;
    var candidates = [
      { x: (vw - cw) / 2, y: vh - ch - margin },              // 底部居中
      { x: (vw - cw) / 2, y: margin },                        // 顶部居中
      { x: vw - cw - margin, y: (vh - ch) / 2 },              // 右侧居中
      { x: margin, y: (vh - ch) / 2 },                        // 左侧居中
      { x: vw - cw - margin, y: margin },                     // 右上
      { x: vw - cw - margin, y: vh - ch - margin },           // 右下
      { x: margin, y: margin }                                // 左上
    ];

    var best = null, bestOverlap = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var x = Math.max(margin, Math.min(vw - cw - margin, c.x));
      var y = Math.max(margin, Math.min(vh - ch - margin, c.y));
      var ov = rectOverlap(tr, x, y, cw, ch);
      if (ov < bestOverlap) { bestOverlap = ov; best = { x: x, y: y }; }
      if (ov === 0) break;      // 找到完全不重叠的位置就直接用
    }
    card.style.bottom = 'auto';
    card.style.left = Math.round(best.x) + 'px';
    card.style.top = Math.round(best.y) + 'px';
  };

  function rectOverlap(tr, x, y, w, h) {
    if (!tr) return 0;
    var ix = Math.max(0, Math.min(tr.right, x + w) - Math.max(tr.left, x));
    var iy = Math.max(0, Math.min(tr.bottom, y + h) - Math.max(tr.top, y));
    return ix * iy;
  }

  /* 某些 DOM 桩里 offsetWidth 恒为 0，这里统一兜一个可用宽度，避免算出 NaN */
  function cwOrZero(card) {
    if (!card.offsetWidth && !card.style.width) card.style.width = 'min(720px, calc(100% - 28px))';
    return card;
  }

  GW.Tutorial.prototype.refresh = function () {
    if (this.active) this.render();
  };

  GW.Tutorial.prototype.next = function () {
    var step = this.steps[this.index];
    if (step.require && !this.done[step.require]) return;
    if (this.index >= this.steps.length - 1) { this.stop(); return; }
    this.index++;
    this.render();
  };

  GW.Tutorial.prototype.prev = function () {
    if (this.index === 0) return;
    this.index--;
    this.render();
  };

  /** UI 在关键动作发生时调用：出现合法预览 / 成功发射 / 画好一笔 */
  GW.Tutorial.prototype.notify = function (event) {
    if (!this.active) return;
    var step = this.steps[this.index];
    if (!step.require || step.require !== event) return;
    this.done[event] = true;
    this.render();
    var self = this;
    setTimeout(function () {
      if (self.active && self.steps[self.index] === step) self.next();
    }, event === 'fire' ? 4200 : 1200);
  };

  GW.Tutorial.prototype.isActive = function () { return this.active; };

})(typeof window !== 'undefined' ? window : globalThis);
