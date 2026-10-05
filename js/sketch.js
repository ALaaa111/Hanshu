/* ============================================================
 * 手绘画板（画函数）
 * 玩家用鼠标 / 手指在画板上拖出一条曲线，松手后可用「方向」「大小」
 * 两个滑块继续调整：方向 = 绕起点旋转，大小 = 等比缩放。
 *
 * 关键规则：这一笔只用来确定弹道的<b>方向</b>（含走向 curvature），
 * 不决定飞行长度 —— 系统会把它拟合成一条多项式曲线，并向两端无限延长，
 * 直到撞到地形、击中士兵或飞出战场（见 game.buildSketchTrajectory）。
 *
 * 画板尺寸与战场保持同一比例 770:450，让你画的方向就是战场上看到的方向。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});
  var C = GW.C;

  var MIN_DIST = 1.2;   // 采样去抖：小于该像素的移动忽略
  var RATIO = C.PLANE_LENGTH / C.PLANE_HEIGHT;

  /* ============================================================
   * 多项式最小二乘拟合（含中心化，避免病态方程组）
   * ============================================================ */
  /**
   * @param {{x:number,y:number}[]} pts 采样点
   * @param {number} degree 次数
   * @returns {{a:number[], cx:number, sx:number, degree:number, eval:Function}|null}
   *          eval(x) = Σ a[i] * ((x-cx)/sx)^i
   */
  GW.fitPolynomial = function (pts, degree) {
    if (!pts || pts.length < degree + 1) return null;
    var n = degree + 1;
    var i, j, k, p;

    var xmin = Infinity, xmax = -Infinity;
    for (i = 0; i < pts.length; i++) {
      if (pts[i].x < xmin) xmin = pts[i].x;
      if (pts[i].x > xmax) xmax = pts[i].x;
    }
    var cx = (xmin + xmax) / 2;
    var sx = Math.max(1e-6, (xmax - xmin) / 2);

    /* 正规方程 A·a = b */
    var A = [], b = [];
    for (i = 0; i < n; i++) { A.push(new Array(n)); b.push(0); for (j = 0; j < n; j++) A[i][j] = 0; }
    var pw = new Array(n);
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      var t = (p.x - cx) / sx;
      pw[0] = 1;
      for (k = 1; k < n; k++) pw[k] = pw[k - 1] * t;
      for (j = 0; j < n; j++) {
        for (k = 0; k < n; k++) A[j][k] += pw[j] * pw[k];
        b[j] += pw[j] * p.y;
      }
    }
    /* 轻微的岭

       正则化，防止垂直笔画导致的奇异矩阵 */
    var ridge = 0;
    for (i = 0; i < n; i++) ridge = Math.max(ridge, Math.abs(A[i][i]));
    ridge = (ridge || 1) * 1e-9;
    for (i = 0; i < n; i++) A[i][i] += ridge;

    var a = solveLinear(A, b, n);
    if (!a) return null;

    return {
      a: a, cx: cx, sx: sx, degree: degree,
      eval: function (x) {
        var t = (x - this.cx) / this.sx;
        var sum = 0, pow = 1;
        for (var m = 0; m < this.a.length; m++) { sum += this.a[m] * pow; pow *= t; }
        return sum;
      }
    };
  };

  /* 高斯消元（带主元） */
  function solveLinear(A, b, n) {
    var M = [], i, j, k;
    for (i = 0; i < n; i++) { M.push(A[i].slice(0)); M[i].push(b[i]); }
    for (i = 0; i < n; i++) {
      var piv = i, best = Math.abs(M[i][i]);
      for (k = i + 1; k < n; k++) {
        var v = Math.abs(M[k][i]);
        if (v > best) { best = v; piv = k; }
      }
      if (best < 1e-14) return null;
      if (piv !== i) { var tmp = M[i]; M[i] = M[piv]; M[piv] = tmp; }
      for (k = i + 1; k < n; k++) {
        var f = M[k][i] / M[i][i];
        if (!isFinite(f)) return null;
        for (j = i; j <= n; j++) M[k][j] -= f * M[i][j];
      }
    }
    var out = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var sum = M[i][n];
      for (j = i + 1; j < n; j++) sum -= M[i][j] * out[j];
      out[i] = sum / M[i][i];
      if (!isFinite(out[i])) return null;
    }
    return out;
  }

  /** 把 fit 换算成「x 的幂」系数：P(x) = Σ c[k]·x^k */
  GW.polyCoefs = function (fit) {
    var d = fit.a.length - 1;
    var out = new Array(d + 1);
    var i, k;
    for (k = 0; k <= d; k++) out[k] = 0;
    /* (-cx)^(i-k) / sx^i —— 用递推避免大数溢出 */
    for (i = 0; i <= d; i++) {
      var binom = 1;
      for (k = 0; k <= i; k++) {
        if (k > 0) binom = (binom * (i - k + 1)) / k;
        var term = Math.pow(-fit.cx, i - k) / Math.pow(fit.sx, i);
        out[k] += fit.a[i] * binom * term;
      }
    }
    return out;
  };

  function trimNum(v, digits) {
    return v.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  /** 格式化成界面里可以直接读懂的函数式写法，例如 0.034*x^2 - 1.42*x + 2 */
  GW.formatPolynomial = function (coefs, digits) {
    digits = digits == null ? 3 : digits;
    var terms = [];
    for (var k = coefs.length - 1; k >= 0; k--) {
      var c = coefs[k];
      if (!isFinite(c)) return null;
      if (k > 0 && Math.abs(c) < Math.pow(10, -digits)) continue;   // 高阶项过小：忽略
      var body = trimNum(Math.abs(c), digits);
      if (k === 0) {
        terms.push({ sign: c < 0 ? '-' : '+', text: body });
      } else {
        var v = k === 1 ? 'x' : 'x^' + k;
        terms.push({ sign: c < 0 ? '-' : '+', text: body + '*' + v });
      }
    }
    if (!terms.length) return '0';
    var str = (terms[0].sign === '-' ? '-' : '') + terms[0].text;
    for (var i = 1; i < terms.length; i++) str += ' ' + terms[i].sign + ' ' + terms[i].text;
    return str;
  };

  /* ============================================================
   * 画板
   * ============================================================ */
  GW.SketchPad = function SketchPad(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.raw = [];             // 原始笔迹（画板 CSS 像素坐标）
    this.rot = 0;              // 方向（度，绕起点旋转）
    this.scale = 1;            // 大小（倍）
    this.enabled = true;
    this.drawing = false;
    this.cssW = 320;
    this.cssH = 188;
    this.dpr = 1;
    this.onChange = opts.onChange || function () {};
    this._bind();
    this.resize();
  };

  /** 画布尺寸按战场比例 770:450 在可用区域内取最大值 → 与战场同比例、手感一致 */
  GW.SketchPad.prototype.resize = function () {
    var c = this.canvas;
    var host = c.parentNode;
    var availW = (host && host.clientWidth) || c.clientWidth || 320;
    var availH = (host && host.clientHeight) || c.clientHeight || 188;
    availW = Math.max(60, availW - 2);
    availH = Math.max(40, availH - 2);
    var cssW = Math.floor(Math.min(availW, availH * RATIO));
    var cssH = Math.round(cssW / RATIO);
    if (cssH > availH) { cssH = Math.floor(availH); cssW = Math.round(cssH * RATIO); }
    cssW = Math.max(60, cssW);
    cssH = Math.max(34, cssH);

    if (c.style.width !== cssW + 'px') c.style.width = cssW + 'px';
    if (c.style.height !== cssH + 'px') c.style.height = cssH + 'px';

    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    var pw = Math.max(1, Math.round(cssW * dpr));
    var ph = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  };

  GW.SketchPad.prototype.setEnabled = function (v) {
    this.enabled = !!v;
    if (!this.enabled) this.drawing = false;
    this.redraw();
  };

  GW.SketchPad.prototype.clear = function () {
    this.raw = [];
    this.drawing = false;
    this.redraw();
    this.onChange(this);
  };

  GW.SketchPad.prototype.isEmpty = function () { return this.raw.length < 2; };

  /** 归一化笔迹：以画板宽度为统一单位、以笔画起点为原点（y 向下为正） */
  GW.SketchPad.prototype.stroke = function () {
    if (this.raw.length < 2) return [];
    var u = Math.max(40, this.cssW);
    var p0 = this.raw[0];
    var out = [];
    for (var i = 0; i < this.raw.length; i++) {
      out.push({ x: (this.raw[i].x - p0.x) / u, y: (this.raw[i].y - p0.y) / u });
    }
    return out;
  };

  /** 方向 / 大小调整后，笔画在画板像素空间里的实际形状 */
  GW.SketchPad.prototype.transformed = function () {
    if (this.raw.length < 2) return [];
    var p0 = this.raw[0];
    var rad = (this.rot || 0) * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var sc = this.scale == null ? 1 : this.scale;
    var out = [];
    for (var i = 0; i < this.raw.length; i++) {
      var ox = this.raw[i].x - p0.x, oy = this.raw[i].y - p0.y;
      out.push({ x: (ox * cos - oy * sin) * sc + p0.x, y: (ox * sin + oy * cos) * sc + p0.y });
    }
    return out;
  };

  /** 画板上展示用的拟合曲线（渲染「无限延长」效果） */
  GW.SketchPad.prototype.fit = function () {
    var pts = this.transformed();
    if (pts.length < 2) return null;
    var deg = pts.length >= 3 ? 2 : 1;
    return GW.fitPolynomial(pts, deg);
  };

  GW.SketchPad.prototype.setTransform = function (rotDeg, scale) {
    this.rot = rotDeg;
    this.scale = scale;
    this.redraw();
  };

  GW.SketchPad.prototype._pos = function (e) {
    var r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  GW.SketchPad.prototype._bind = function () {
    var self = this;
    var c = this.canvas;

    function down(e) {
      if (!self.enabled) return;
      if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return;
      if (e.cancelable) e.preventDefault();
      self.drawing = true;
      self.raw = [self._pos(e)];
      if (c.setPointerCapture && e.pointerId != null) {
        try { c.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
      self.redraw();
    }
    function move(e) {
      if (!self.drawing || !self.enabled) return;
      if (e.cancelable) e.preventDefault();
      var p = self._pos(e);
      var last = self.raw[self.raw.length - 1];
      if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < MIN_DIST) return;
      self.raw.push(p);
      self.redraw();
    }
    function up() {
      if (!self.drawing) return;
      self.drawing = false;
      self.redraw();
      self.onChange(self);
    }

    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', up);
  };

  /* ---------------- 画板绘制 ---------------- */
  GW.SketchPad.prototype.redraw = function () {
    var ctx = this.ctx;
    var w = this.cssW, h = this.cssH;
    if (!ctx || !w || !h) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f6fcf8';
    ctx.fillRect(0, 0, w, h);

    /* 与战场一致的迷你坐标网格：每 5 个游戏单位一条线 */
    var pxPerUnit = w / C.PLANE_GAME_LENGTH;
    var cx = w / 2, cy = h / 2;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(45, 122, 69, 0.10)';
    ctx.beginPath();
    for (var i = -25; i <= 25; i++) {
      if (i % 5 === 0) continue;
      var x = cx + i * pxPerUnit;
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(45, 122, 69, 0.20)';
    ctx.beginPath();
    for (var i2 = -25; i2 <= 25; i2 += 5) {
      var xa = cx + i2 * pxPerUnit;
      ctx.moveTo(xa, 0); ctx.lineTo(xa, h);
    }
    var stepY = pxPerUnit;
    for (var jv = cy % stepY; jv < h; jv += stepY) {
      var yv = Math.round(jv) + 0.5;
      ctx.moveTo(0, yv); ctx.lineTo(w, yv);
    }
    ctx.stroke();
    /* 中线 */
    ctx.strokeStyle = 'rgba(27, 94, 55, 0.30)';
    ctx.beginPath();
    ctx.moveTo(0, cy + 0.5); ctx.lineTo(w, cy + 0.5);
    ctx.stroke();

    if (!this.raw.length) {
      ctx.fillStyle = 'rgba(80, 110, 92, 0.55)';
      ctx.font = '12px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.enabled ? '在此按住拖动 = 定一个方向' : '当前不是你的回合', w / 2, h / 2 - 10);
      return;
    }

    var pts = this.transformed();
    var i3;
    if (!pts.length) {
      /* 只按下了还没拖动：画一个起点即可 */
      ctx.fillStyle = '#1d7a45';
      ctx.fillRect(this.raw[0].x - 3, this.raw[0].y - 3, 6, 6);
      return;
    }
    var p0 = pts[0];

    /* 原始笔迹（浅灰参考） */
    ctx.strokeStyle = 'rgba(120, 145, 130, 0.35)';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (i3 = 0; i3 < this.raw.length; i3++) {
      if (i3 === 0) ctx.moveTo(this.raw[i3].x, this.raw[i3].y); else ctx.lineTo(this.raw[i3].x, this.raw[i3].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    /* 拟合曲线：贯穿整个画板 —— 表示弹道会无限延长 */
    var fit = this.fit();
    if (fit) {
      ctx.strokeStyle = 'rgba(47, 158, 92, 0.42)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      var stepsN = 64;
      var started = false;
      for (var s = 0; s <= stepsN; s++) {
        var xx = (w * s) / stepsN;
        var yy = fit.eval(xx);
        if (!isFinite(yy) || yy < -h || yy > h * 2) { started = false; continue; }
        if (!started) { ctx.moveTo(xx, yy); started = true; }
        else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* 变换后的笔迹（实际手绘段） */
    ctx.strokeStyle = '#2f9e5c';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (i3 = 0; i3 < pts.length; i3++) {
      if (i3 === 0) ctx.moveTo(pts[i3].x, pts[i3].y); else ctx.lineTo(pts[i3].x, pts[i3].y);
    }
    ctx.stroke();

    /* 起点标记：这里就是炮口 */
    ctx.fillStyle = '#1d7a45';
    ctx.fillRect(p0.x - 3, p0.y - 3, 6, 6);

    /* 末尾箭头：沿着拟合曲线继续往前，示意「往这个方向一直飞出去」 */
    var last = pts[pts.length - 1];
    var tipX = last.x, tipY = last.y;
    var dx = 1, dy = 0;
    if (fit) {
      var ahead = Math.min(w, last.x + Math.max(10, w * 0.06));
      if (last.x + 1 < w) {
        var yA = fit.eval(last.x), yB = fit.eval(ahead);
        dx = ahead - last.x; dy = yB - yA;
      } else {
        dx = last.x - pts[pts.length - 2].x;
        dy = last.y - pts[pts.length - 2].y;
      }
    } else {
      dx = last.x - pts[pts.length - 2].x;
      dy = last.y - pts[pts.length - 2].y;
    }
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    tipX = Math.min(w - 4, Math.max(4, last.x + dx * Math.max(14, w * 0.055)));
    tipY = Math.min(h + 40, Math.max(-40, last.y + dy * Math.max(14, w * 0.055)));

    ctx.strokeStyle = 'rgba(27, 94, 55, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - dx * 8 - dy * 5, tipY - dy * 8 + dx * 5);
    ctx.lineTo(tipX - dx * 8 + dy * 5, tipY - dy * 8 - dx * 5);
    ctx.closePath();
    ctx.fill();
  };

})(typeof window !== 'undefined' ? window : globalThis);
