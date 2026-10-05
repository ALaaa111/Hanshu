/* ============================================================
 * 表达式解析与编译
 * 解析规则严格参考原版 PolishNotationFunction.java：
 *   1) 统一小写 → "-" 替换为 "+-"（减法转化为「加负数」）→ "exp" 替换为 "e^" → "," 替换为 "."
 *   2) 用同一条正则切词（含 y' 优先于 y 的顺序）
 *   3) 补全省略的乘号（如 2x、(x+1)(x-1)、xsin(x)）
 *   4) 以「括号最浅 + 类型编号最小」的算符为根，递归重排为波兰式（前缀式）
 *   5) 用 valuesNeeded 校验表达式是否合法
 * 之后把波兰式还原成语法树，并编译为原生 JS 函数以保证弹道积分的速度。
 * ============================================================ */
(function (root) {
  'use strict';
  var GW = root.GW || (root.GW = {});

  /* ---------- 词法类型（编号与原版一致，编号即优先级：越小越晚结合） ---------- */
  var T = {
    ADD: 1, SUBTRACT: 2, MULTIPLY: 3, DIVIDE: 4, POW: 5,
    SQRT: 6, LOG: 7, ABS: 8, SIN: 9, COS: 10, TAN: 11, LN: 12,
    VARIABLE1: 13, VARIABLE2: 14, VARIABLE3: 15,
    VALUE: 16, LEFT_BRACKET: 17, RIGHT_BRACKET: 18
  };

  var MAX_TOKENS = 600;      // 防止病态输入把浏览器卡死
  var MAX_INPUT = 400;

  function MalformedFunction(msg) {
    this.name = 'MalformedFunction';
    this.message = msg || '表达式不合法';
  }
  MalformedFunction.prototype = Object.create(Error.prototype);
  GW.MalformedFunction = MalformedFunction;

  /* ---------- 操作符元数 ---------- */
  function getNumParam(type) {
    if (type === T.SUBTRACT) return 1;
    if (type >= T.ADD && type <= T.POW) return 2;
    if (type >= T.SQRT && type <= T.LN) return 1;
    return 0;
  }
  function isOperation(type) { return type >= 1 && type <= 12; }

  /* 是否需要在两个相邻 token 之间补乘号（与原版 isImplicit 一致） */
  function isImplicit(type1, type2) {
    var leftOperandLike = type1 === T.VALUE || type1 === T.VARIABLE1 ||
      type1 === T.VARIABLE2 || type1 === T.VARIABLE3 || type1 === T.RIGHT_BRACKET;
    if (!leftOperandLike) return false;
    var rightOperandLike = type2 === T.VALUE || type2 === T.VARIABLE1 ||
      type2 === T.VARIABLE2 || type2 === T.VARIABLE3 || type2 === T.LEFT_BRACKET ||
      getNumParam(type2) === 1;
    return rightOperandLike;
  }

  /* ---------- 输入预处理：兼容中文输入法与常见写法 ---------- */
  function normalizeInput(str) {
    var s = String(str == null ? '' : str).trim();
    // 全角符号 / 中文习惯写法
    s = s.replace(/[（）]/g, function (c) { return c === '（' ? '(' : ')'; });
    s = s.replace(/×/g, '*').replace(/÷/g, '/').replace(/[−–—]/g, '-');
    s = s.replace(/，/g, ',');
    s = s.replace(/√/g, 'sqrt');
    s = s.replace(/π/g, 'pi');
    // 去掉可写可不写的左端前缀：y''= / y'= / y= / f(x)=
    s = s.replace(/^\s*y\s*(?:''|"|’{2}|'{2})\s*=/i, '');
    s = s.replace(/^\s*y\s*(?:'|’)\s*=/i, '');
    s = s.replace(/^\s*y\s*=/i, '');
    s = s.replace(/^\s*f\s*\(\s*x\s*\)\s*=/i, '');
    return s.trim();
  }
  GW.normalizeInput = normalizeInput;

  /* 额外的括号配对检查：原版会静默忽略多余括号，这里给出明确报错更友好 */
  function assertBracketsBalanced(s) {
    var depth = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth < 0) throw new MalformedFunction('括号不匹配：多了一个右括号 )');
      }
    }
    if (depth > 0) throw new MalformedFunction('括号不匹配：缺少 ' + depth + ' 个右括号 )');
  }

  /* ---------- 切词（与原版正则完全一致） ---------- */
  var TOKEN_RE = /[0-9]*\.?[0-9]+|\(|\)|x|y'|y|\+|\*|\/|\^|sqrt|log|abs|sin|sen|cos|tan|tg|-|ln|e|pi/g;

  function makeToken(tk) {
    if (/^[0-9]*\.?[0-9]+$/.test(tk)) {
      var val = parseFloat(tk);
      if (isFinite(val)) return { t: T.VALUE, v: val };
    }
    switch (tk) {
      case 'x': return { t: T.VARIABLE1 };
      case 'y': return { t: T.VARIABLE2 };
      case "y'": return { t: T.VARIABLE3 };
      case '+': return { t: T.ADD };
      case '-': return { t: T.SUBTRACT };
      case '*': return { t: T.MULTIPLY };
      case '/': return { t: T.DIVIDE };
      case '^': return { t: T.POW };
      case 'sqrt': return { t: T.SQRT };
      case 'log': return { t: T.LOG };
      case 'abs': return { t: T.ABS };
      case 'sin': case 'sen': return { t: T.SIN };
      case 'cos': return { t: T.COS };
      case 'tan': case 'tg': return { t: T.TAN };
      case 'ln': return { t: T.LN };
      case 'e': return { t: T.VALUE, v: Math.E };
      case 'pi': return { t: T.VALUE, v: Math.PI };
      case '(': return { t: T.LEFT_BRACKET };
      case ')': return { t: T.RIGHT_BRACKET };
    }
    return null;
  }

  function createRegularNotationTokens(src) {
    if (src.length > MAX_INPUT) throw new MalformedFunction('表达式过长，请化简后再输入');
    var s = src.toLowerCase();
    s = s.replace(/-/g, '+-');
    s = s.replace(/exp/g, 'e^');
    s = s.replace(/,/g, '.');
    var tokens = [];
    var m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(s)) !== null) {
      var tk = makeToken(m[0]);
      if (tk) tokens.push(tk);
      if (tokens.length > MAX_TOKENS) throw new MalformedFunction('表达式过于复杂');
      if (m[0].length === 0) TOKEN_RE.lastIndex++;   // 防御死循环
    }
    return insertImplicitMultiplications(tokens);
  }

  function insertImplicitMultiplications(tokens) {
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      if (i > 0 && isImplicit(tokens[i - 1].t, tokens[i].t)) {
        out.push({ t: T.MULTIPLY });
      }
      out.push(tokens[i]);
    }
    return out;
  }

  /* ---------- 递归重排为波兰式（前缀式） ---------- */
  function toPolishNotation(tokens) {
    var polish = [];
    var nodes = 0;
    var quota = MAX_TOKENS * 4;

    function reorder(start, end) {
      if (start > end || start >= tokens.length) return false;
      var next = -1, nextNest = Infinity, nest = 0;
      for (var i = start; i <= end; i++) {
        var ty = tokens[i].t;
        if (ty === T.LEFT_BRACKET) {
          nest++;
        } else if (ty === T.RIGHT_BRACKET) {
          nest--;
        } else if (nest < nextNest ||
          (nest === nextNest && (next === -1 || ty < tokens[next].t))) {
          next = i;
          nextNest = nest;
        }
      }
      if (next === -1) return false;

      if (++nodes > quota) throw new MalformedFunction('表达式嵌套过深');

      var n = getNumParam(tokens[next].t);
      if (n === 0) {
        polish.push(tokens[next]);
      } else if (n === 1) {
        polish.push(tokens[next]);
        reorder(next + 1, end);
      } else {
        polish.push(tokens[next]);
        var leftExists = reorder(start, next - 1);
        // 与原版一致：加号允许缺失左操作数（因为 "-" 被改写成了 "+-"）
        if (tokens[next].t === T.ADD && !leftExists) polish.push({ t: T.VALUE, v: 0 });
        reorder(next + 1, end);
      }
      return true;
    }

    reorder(0, tokens.length - 1);
    return polish;
  }

  /* ---------- 合法性校验（与原版 getValuesNeeded 一致） ---------- */
  function getValuesNeeded(polish) {
    var needed = 1;
    for (var i = 0; i < polish.length; i++) {
      var t = polish[i].t;
      if (isOperation(t)) needed += getNumParam(t) - 1;
      else needed--;
      if (needed === 0 && i + 1 < polish.length) return -1;   // 提前结束但还有剩余 token
    }
    return needed;
  }

  /* ---------- 波兰式 → 语法树 ---------- */
  function treeFromPolish(polish) {
    var i = 0;
    var OPNAME = {};
    OPNAME[T.ADD] = 'add'; OPNAME[T.MULTIPLY] = 'mul'; OPNAME[T.DIVIDE] = 'div';
    OPNAME[T.POW] = 'pow'; OPNAME[T.SUBTRACT] = 'neg';
    OPNAME[T.SQRT] = 'sqrt'; OPNAME[T.LOG] = 'log'; OPNAME[T.ABS] = 'abs';
    OPNAME[T.SIN] = 'sin'; OPNAME[T.COS] = 'cos'; OPNAME[T.TAN] = 'tan'; OPNAME[T.LN] = 'ln';

    function build() {
      if (i >= polish.length) throw new MalformedFunction('表达式不完整');
      var tk = polish[i++];
      var t = tk.t;
      if (t === T.VALUE) return { op: 'num', value: tk.v };
      if (t === T.VARIABLE1) return { op: 'var', name: 'x' };
      if (t === T.VARIABLE2) return { op: 'var', name: 'y' };
      if (t === T.VARIABLE3) return { op: 'var', name: 'dy' };
      var n = getNumParam(t);
      var name = OPNAME[t];
      if (!name) throw new MalformedFunction('无法识别的运算');
      if (n === 1) return { op: name, args: [build()] };
      var a = build(), b = build();
      return { op: name, args: [a, b] };
    }
    var tree = build();
    if (i < polish.length) throw new MalformedFunction('表达式有多余内容');
    return tree;
  }

  /* ---------- 语法树 → JS 源码 → 可执行函数 ---------- */
  function treeSize(node) {
    if (node.op === 'num' || node.op === 'var') return 1;
    var s = 1;
    for (var i = 0; i < node.args.length; i++) s += treeSize(node.args[i]);
    return s;
  }

  GW.treeSize = treeSize;

  function emit(node) {
    switch (node.op) {
      case 'num': {
        var v = node.value;
        if (!isFinite(v)) throw new MalformedFunction('数值非法');
        return v < 0 ? '(' + v + ')' : String(v);
      }
      case 'var': return node.name;
      case 'add': return '(' + emit(node.args[0]) + '+' + emit(node.args[1]) + ')';
      case 'mul': return '(' + emit(node.args[0]) + '*' + emit(node.args[1]) + ')';
      case 'div': return '(' + emit(node.args[0]) + '/' + emit(node.args[1]) + ')';
      case 'pow': return 'Math.pow(' + emit(node.args[0]) + ',' + emit(node.args[1]) + ')';
      case 'neg': return '(-' + emit(node.args[0]) + ')';
      case 'sqrt': return 'Math.sqrt(' + emit(node.args[0]) + ')';
      // 与原版一致：log() 为常用对数（底 10），ln() 为自然对数
      case 'log': return 'Math.log10(' + emit(node.args[0]) + ')';
      case 'ln': return 'Math.log(' + emit(node.args[0]) + ')';
      case 'abs': return 'Math.abs(' + emit(node.args[0]) + ')';
      case 'sin': return 'Math.sin(' + emit(node.args[0]) + ')';
      case 'cos': return 'Math.cos(' + emit(node.args[0]) + ')';
      case 'tan': return 'Math.tan(' + emit(node.args[0]) + ')';
    }
    throw new MalformedFunction('不支持的运算：' + node.op);
  }

  GW.emit = emit;

  function compileTree(tree) {
    if (treeSize(tree) > MAX_TOKENS * 2) throw new MalformedFunction('表达式过于复杂');
    var src = emit(tree);
    var fn;
    try {
      /* eslint-disable no-new-func */
      fn = new Function('x', 'y', 'dy', 'return (' + src + ');');
    } catch (e) {
      throw new MalformedFunction('表达式无法编译：请检查括号与运算符');
    }
    if (typeof fn(1, 2, 3) !== 'number') throw new MalformedFunction('表达式不合法');
    return fn;
  }
  GW.compileTree = compileTree;

  /**
   * 把用户输入的字符串编译成可执行函数。
   * 返回 { eval(x,y,dy), tree, source, polish, input }
   */
  GW.compileString = function (src) {
    var normalized = normalizeInput(src);
    if (!normalized) throw new MalformedFunction('请先输入函数表达式');
    assertBracketsBalanced(normalized);
    var tokens = createRegularNotationTokens(normalized);
    if (tokens.length === 0) throw new MalformedFunction('没有识别到有效的函数内容');
    var polish = toPolishNotation(tokens);
    if (getValuesNeeded(polish) !== 0) throw new MalformedFunction('表达式不合法：括号是否配对？运算符是否缺少操作数？');
    var tree = treeFromPolish(polish);
    var fn = compileTree(tree);
    return { eval: fn, tree: tree, source: emit(tree), polish: polish, input: normalized };
  };

  /* ---------- 语法树 → 可读字符串（用于展示电脑的开炮函数） ---------- */
  GW.treeToString = function (node) {
    switch (node.op) {
      case 'num': {
        var v = node.value;
        var s = Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : String(Math.round(v * 100) / 100);
        return v < 0 ? '(' + s + ')' : s;
      }
      case 'var': return node.name === 'dy' ? "y'" : node.name;
      case 'add': return '(' + GW.treeToString(node.args[0]) + '+' + GW.treeToString(node.args[1]) + ')';
      case 'mul': return '(' + GW.treeToString(node.args[0]) + '*' + GW.treeToString(node.args[1]) + ')';
      case 'div': return '(' + GW.treeToString(node.args[0]) + '/' + GW.treeToString(node.args[1]) + ')';
      case 'pow': return '(' + GW.treeToString(node.args[0]) + '^' + GW.treeToString(node.args[1]) + ')';
      case 'neg': return '(-' + GW.treeToString(node.args[0]) + ')';
      default: return node.op + '(' + GW.treeToString(node.args[0]) + ')';
    }
  };

  /* ============================================================
   * 随机语法树（电脑 AI 的种群来源）
   * 算符概率分布与原版 getRandomOperator / getRandomValueToken 一致。
   * ============================================================ */
  var RANDOM_OPERATORS = [
    'sqrt', 'log', 'abs', 'sin', 'cos', 'tan', 'ln',
    'add', 'add', 'add', 'add',
    'mul', 'mul', 'mul',
    'div', 'div', 'div',
    'pow', 'pow'
  ];

  function randomTerminal(mode) {
    if (Math.random() < 0.5) {           // RANDOM_FUNC_VARIABLE_CHANCE
      if (mode === GW.C.SND_ODE) {
        var r = Math.random();
        return { op: 'var', name: r < 1 / 3 ? 'x' : (r < 2 / 3 ? 'y' : 'dy') };
      }
      if (mode === GW.C.FST_ODE) return { op: 'var', name: Math.random() < 0.5 ? 'x' : 'y' };
      return { op: 'var', name: 'x' };
    }
    return { op: 'num', value: GW.gaussRandom() * 10.2 };   // RANDOM_FUNC_VALUE_MEAN
  }

  function randomTree(mode, depth) {
    if (depth <= 0) return randomTerminal(mode);
    if (Math.random() < 0.5) return randomTerminal(mode);   // RANDOM_FUNC_VALUE_CHANCE
    var op = RANDOM_OPERATORS[GW.randInt(RANDOM_OPERATORS.length)];
    if (op === 'add' || op === 'mul' || op === 'div' || op === 'pow') {
      return { op: op, args: [randomTree(mode, depth - 1), randomTree(mode, depth - 1)] };
    }
    return { op: op, args: [randomTree(mode, depth - 1)] };
  }
  GW.randomTree = function (mode, depth) {
    return randomTree(mode, depth == null ? 3 : depth);
  };

  /* 子树交叉（模拟原版的 crossover）：把 B 的随机子树嫁接到 A 的随机位置 */
  GW.crossover = function (a, b) {
    var cloneA = GW.cloneTree(a);
    var cloneB = GW.cloneTree(b);
    var target = GW.randomNode(cloneA, null, -1);
    var donor = GW.randomSubtree(cloneB);
    if (target.parent) target.parent.args[target.index] = donor;
    else return donor;
    return cloneA;
  };

  GW.cloneTree = function clone(node) {
    if (!node.args) return { op: node.op, value: node.value, name: node.name };
    var args = [];
    for (var i = 0; i < node.args.length; i++) args.push(clone(node.args[i]));
    return { op: node.op, args: args };
  };

  GW.randomSubtree = function (node) {
    if (!node.args || node.args.length === 0 || Math.random() < 0.3) return GW.cloneTree(node);
    return GW.randomSubtree(node.args[GW.randInt(node.args.length)]);
  };

  GW.randomNode = function (node, parent, index) {
    var cur = { node: node, parent: parent, index: index };
    if (!node.args || node.args.length === 0 || Math.random() < 0.4) return cur;
    var i = GW.randInt(node.args.length);
    return GW.randomNode(node.args[i], node, i);
  };

  /* 单点变异：60% 微调数值，40% 替换子树 */
  GW.mutate = function (tree, mode) {
    if (Math.random() < 0.6) {
      var target = GW.randomNode(tree, null, -1);
      if (target.node.op === 'num') {
        target.node.value = Math.random() < 0.5
          ? GW.gaussRandom() * 10.2
          : target.node.value * (GW.gaussRandom() + 1);
      } else if (target.parent) {
        target.parent.args[target.index] = randomTerminal(mode);
      }
      return tree;
    }
    var t2 = GW.randomNode(tree, null, -1);
    if (t2.parent) t2.parent.args[t2.index] = GW.randomTree(mode, 2);
    else return GW.randomTree(mode, 3);
    return tree;
  };

})(typeof window !== 'undefined' ? window : globalThis);
