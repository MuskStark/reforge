/* ReForge 工作台 / 后台重设计 —— 设计稿共享脚本:图标、示例数据、外壳渲染。
   纯静态,不依赖框架;各画板(workbench.html / admin.html / me.html)调用这里的方法拼页面。 */
(function () {
  "use strict";

  const I = window.ICONS;
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /** lucide 线性图标(与实现同一套) */
  function icon(name, style, cls = "ic") {
    const nodes = (I[name] || [])
      .map(([t, a]) => `<${t} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(" ")} />`)
      .join("");
    return `<svg class="${cls}"${style ? ` style="${style}"` : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${nodes}</svg>`;
  }

  /** 品牌图形:分叉汇聚的流程节点(与前台同构) */
  const brandMark = () =>
    `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="6" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="12" r="2.4"/><path d="M7.3 6.9 16.7 11.1M7.3 17.1 16.7 12.9"/></svg>`;

  const WALLPAPER = `<div class="wallpaper" aria-hidden="true"><div class="orb orb-1"></div><div class="orb orb-2"></div><div class="orb orb-3"></div><div class="orb orb-4"></div><div class="orb orb-5"></div><div class="orb orb-6"></div></div>`;

  /* ---------------- 模式:桌面 / 手机 / 内嵌画板 ---------------- */

  function applyMode() {
    const q = new URLSearchParams(location.search);
    const force = q.get("mode");
    const mob = force ? force === "mobile" : window.innerWidth < 768;
    document.body.classList.toggle("mob", mob);
    // embed 也标到 <html> 上:页面的滚动容器是 html,滚动条样式要作用在这一层
    document.body.classList.toggle("embed", q.has("embed"));
    document.documentElement.classList.toggle("embed", q.has("embed"));
  }
  applyMode();
  window.addEventListener("resize", () => {
    if (!new URLSearchParams(location.search).get("mode")) applyMode();
  });

  /* ---------------- 导航定义(两组 = 外壳的全部一级入口) ---------------- */

  const WORK_NAV = [
    { id: "work", href: "/work", label: "工作台", icon: "layout-grid" },
    { id: "projects", href: "/projects", label: "流程项目", icon: "waypoints" },
    { id: "inbox", href: "/inbox", label: "通知", icon: "bell" },
    { id: "monitor", href: "/monitor", label: "数据大屏", icon: "presentation" },
  ];
  const ADMIN_NAV = [
    { id: "admin:processes", href: "/admin/processes", label: "流程定义", icon: "workflow" },
    { id: "admin:systems", href: "/admin/systems", label: "线上系统库", icon: "server" },
    { id: "admin:users", href: "/admin/users", label: "用户与岗位", icon: "users" },
    { id: "admin:stages", href: "/admin/stages", label: "阶段模板", icon: "list-checks" },
    { id: "admin:channels", href: "/admin/channels", label: "通知渠道", icon: "send" },
  ];

  /** 设计稿里各路由落到哪张画板;没画的路由点了给提示 */
  function designHref(item) {
    if (item.id.startsWith("admin:")) return `admin.html#/${item.href.slice(1)}`;
    if (item.id === "work") return "workbench.html";
    return `#todo:${item.label}`;
  }

  function navItem(item, { active, counts = {} }) {
    const n = counts[item.id];
    const badge =
      n == null ? "" : `<span class="sb-count ${item.id === "inbox" ? "alert" : "quiet"}">${n}</span>`;
    return `<a class="sb-item${active === item.id ? " on" : ""}" href="${designHref(item)}" title="${esc(item.href)}">${icon(item.icon)}<span class="sb-label">${item.label}</span>${badge}</a>`;
  }

  /* ---------------- 外壳:侧栏(桌面) ---------------- */

  function sidebar({ active, user, unread = 0, todo = 0 }) {
    const counts = { inbox: unread || null, work: todo || null };
    // 结构:品牌(固定) / 导航(窗口矮时可滚动) / 提交流程 + 账号(固定,不收缩)
    return `<aside class="sidebar">
      <a class="sb-brand" href="workbench.html" title="/work"><span class="mark">${brandMark()}</span><span class="name">ReForge</span></a>
      <div class="sb-scroll">
        <div class="sb-group-label">工作空间</div>
        <nav class="sb-nav" aria-label="工作空间">${WORK_NAV.map((i) => navItem(i, { active, counts })).join("")}</nav>
        ${
          user.role === "admin"
            ? `<div class="sb-group-rule"></div><div class="sb-group-label">系统管理</div><nav class="sb-nav" aria-label="系统管理">${ADMIN_NAV.map((i) => navItem(i, { active, counts })).join("")}</nav>`
            : ""
        }
      </div>
      <a class="btn btn-primary sb-cta" href="#todo:提交流程" title="/ (流程收集表)">${icon("plus", "font-size:17px")}<span class="sb-label">提交流程</span></a>
      <div class="sb-user" onclick="Mock.toggleMenu(this)" role="button" tabindex="0" title="账号菜单">
        <span class="avatar ${user.av || ""}">${esc(user.name.slice(0, 1))}</span>
        <span class="who"><b>${esc(user.name)}</b><span>${esc(user.title)}</span></span>
        ${icon("chevron-up")}
        <div class="menu" hidden>
          <a href="me.html">${icon("user-round")}个人信息</a>
          <a href="#todo:数据大屏">${icon("presentation")}数据大屏</a>
          <div class="sep"></div>
          <a href="login.html" class="danger">${icon("log-out")}退出登录</a>
        </div>
      </div>
    </aside>`;
  }

  /* ---------------- 外壳:顶部紧凑栏 + 底部 Tab 栏(手机) ---------------- */

  function mTop({ user, ctx, back }) {
    return `<header class="m-top lg-clear">
      <a class="sb-brand" href="workbench.html"><span class="mark">${brandMark()}</span><span class="name">ReForge</span></a>
      ${ctx ? `<span class="ctx">${ctx}</span>` : ""}
      <span class="grow"></span>
      <a class="avatar ${user.av || ""}" href="me.html" title="我的">${esc(user.name.slice(0, 1))}</a>
    </header>`;
  }

  function mTabs({ active, unread = 0, todo = 0 }) {
    const tabs = [
      { id: "work", label: "工作台", icon: "layout-grid", n: todo, href: "workbench.html" },
      { id: "projects", label: "项目", icon: "waypoints", href: "#todo:流程项目" },
      { id: "inbox", label: "通知", icon: "bell", n: unread, alert: true, href: "#todo:通知" },
      { id: "me", label: "我的", icon: "user-round", href: "me.html" },
    ];
    return `<nav class="m-tabs lg-clear" aria-label="主导航">${tabs
      .map(
        (t) => `<a class="m-tab${active === t.id ? " on" : ""}" href="${t.href}">${icon(t.icon)}${t.label}${t.n ? `<span class="sb-count ${t.alert ? "alert" : "quiet"}">${t.n}</span>` : ""}</a>`,
      )
      .join("")}</nav>`;
  }

  /* ---------------- 小件 ---------------- */

  const badge = (text, tone = "plain", extra = "") => `<span class="badge ${tone}${extra ? " " + extra : ""}">${text}</span>`;
  const avatarOf = (name, tone) => `<span class="avatar sm ${tone || ""}">${esc((name || "?").slice(0, 1))}</span>`;

  const HEALTH = { on_track: ["正常", "ok"], at_risk: ["有风险", "amber"], off_track: ["已偏离", "warn"] };
  const PENDING = { admin: "待指派项目经理", pm: "待项目经理处理", cto: "待 CTO 评审", handler: "待经办确认" };
  const PRIORITY = { high: ["高优先", "amber"], medium: ["中优先", "plain"], low: ["低优先", "plain"] };

  /* ---------------- 示例数据(全部虚构) ---------------- */

  const USERS = {
    cto: { name: "陈曦", username: "chenxi", dept: "科技部", title: "CTO", role: "member", jobRole: "cto", av: "sand" },
    admin: { name: "林远", username: "linyuan", dept: "信息中心", title: "管理员", role: "admin", jobRole: "", av: "amber" },
    pm: { name: "苏航", username: "suhang", dept: "流程管理部", title: "项目经理", role: "member", jobRole: "pm", av: "mint" },
    handler: { name: "王倩", username: "wangqian", dept: "信息中心", title: "经办", role: "member", jobRole: "handler", av: "" },
  };
  /** 空状态预览用的身份:一个没有任何待办的普通成员 */
  USERS.clear = { ...USERS.handler, name: "李沐", username: "limu", dept: "科技部", title: "开发实施", jobRole: "dev", av: "sand" };

  /** 七个阶段:内置模板 */
  const STAGES = ["分析立项", "需求确认", "方案设计", "系统改造", "试运行", "验收上线", "运营优化"];

  /** 在途项目(全局一份,各角色按权限取子集) */
  const PROJECTS = [
    { id: 1, name: "采购申请审批流程改造", stage: 2, pct: 29, health: "on_track", pendingOn: "cto", pm: "周宁", dept: "采购部", overdue: 0, blocked: 0 },
    { id: 2, name: "差旅报销流程再造", stage: 4, pct: 57, health: "on_track", pendingOn: "cto", pm: "苏航", dept: "财务部", overdue: 0, blocked: 0 },
    { id: 3, name: "用车申请流程", stage: 2, pct: 14, health: "off_track", pendingOn: "pm", pm: "苏航", dept: "行政部", overdue: 3, blocked: 1 },
    { id: 4, name: "合同用印审批流程", stage: 1, pct: 0, health: "at_risk", pendingOn: "admin", pm: "", dept: "法务部", overdue: 1, blocked: 0 },
    { id: 5, name: "新员工入职办理流程", stage: 5, pct: 71, health: "on_track", pendingOn: "handler", pm: "周宁", dept: "人力资源部", overdue: 0, blocked: 0 },
    { id: 6, name: "固定资产盘点流程优化", stage: 1, pct: 0, health: "on_track", pendingOn: "admin", pm: "", dept: "信息中心", overdue: 0, blocked: 0 },
    { id: 7, name: "供应商准入流程", stage: 6, pct: 86, health: "on_track", pendingOn: "pm", pm: "苏航", dept: "供应链管理部", overdue: 0, blocked: 0 },
  ];

  /** 每个角色的工作台:页头一句摘要 + 四类行动 + 右栏项目 */
  const WORK = {
    admin: {
      lede: '2 条新流程等你指派项目经理，其中 <b class="warn">1 条已等 2 天</b>。',
      review: [],
      assign: [
        { project: "合同用印审批流程", by: "赵磊", dept: "法务部", steps: 9, countersign: 2, when: "已等 2 天", wait: 2 },
        { project: "固定资产盘点流程优化", by: "王倩", dept: "信息中心", steps: 6, countersign: 0, when: "今天提交", wait: 0 },
      ],
      advance: [],
      tasks: [],
      mine: [1, 2, 3, 4, 5, 6, 7],
      mineTitle: "在途项目",
      watch: [3, 4],
    },
    cto: {
      lede: '2 个关卡等你评审，其中 <b class="warn">1 个已等 4 天</b>。',
      review: [
        { project: "采购申请审批流程改造", stage: 2, gate: "G2 需求基线", mode: "会签", round: 2, priority: "high", when: "已等 4 天", wait: 4, by: "周宁" },
        { project: "差旅报销流程再造", stage: 4, gate: "G4 上线评审", mode: "或签", round: 1, priority: "medium", when: "今天提交", wait: 0, by: "苏航" },
      ],
      assign: [],
      advance: [],
      tasks: [],
      mine: [1, 2, 3, 4, 5, 6, 7],
      mineTitle: "在途项目",
      watch: [3, 4],
    },
    pm: {
      lede: '7 件事等你处理，其中 <b class="warn">2 件已逾期</b>。',
      review: [],
      assign: [],
      advance: [
        { project: "用车申请流程", stage: 2, need: "待确认业务需求", when: "已逾期 2 天", wait: 4 },
        { project: "供应商准入流程", stage: 6, need: "待提交验收评审", when: "11-28 截止", wait: 0 },
      ],
      tasks: [
        { title: "确认业务侧需求边界", project: "用车申请流程", status: "todo", when: "已逾期 2 天", wait: 4 },
        { title: "编写 To-Be 流程说明", project: "差旅报销流程再造", status: "in_progress", when: "今天截止", wait: 0 },
        { title: "更新项目风险台账", project: "用车申请流程", status: "in_progress", when: "11-27 截止", wait: 0 },
        { title: "提交本周项目简报", project: "供应商准入流程", status: "todo", when: "11-26 截止", wait: 0 },
        { title: "安排试运行用户培训", project: "差旅报销流程再造", status: "todo", when: "12-02 截止", wait: 0 },
      ],
      mine: [2, 3, 7],
      mineTitle: "我负责的项目",
      watch: [3],
    },
    handler: {
      lede: '2 件任务等你办理，其中 <b class="warn">1 件已逾期</b>。',
      review: [],
      assign: [],
      advance: [],
      tasks: [
        { title: "确认试运行问题清单", project: "新员工入职办理流程", status: "in_progress", when: "今天截止", wait: 0 },
        { title: "补充线下单据样例", project: "新员工入职办理流程", status: "blocked", blockReason: "等人事科盖章", when: "已逾期 1 天", wait: 2 },
      ],
      mine: [5, 3],
      mineTitle: "我参与的项目",
      watch: [],
    },
  };
  /** 空状态:什么都不用做 */
  WORK.clear = { lede: "现在没有等你处理的事情。", review: [], assign: [], advance: [], tasks: [], mine: [5, 3, 2], mineTitle: "我参与的项目", watch: [] };

  const JOB_BADGE = {
    cto: ["CTO", "indigo"],
    pm: ["项目经理", "blue"],
    handler: ["经办", "green"],
    dev: ["开发实施", "amber"],
    viewer: ["观察者", "plain"],
  };

  /* ---------------- 设计稿提示(点了没画的路由) ---------------- */

  function toast(msg) {
    let el = document.querySelector(".dg-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "dg-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#todo:"]');
    if (!a) return;
    e.preventDefault();
    const name = a.getAttribute("href").slice(6);
    toast(`「${name}」沿用现有页面，不在本次设计稿范围内`);
  });

  /* 侧栏导航被窗口高度截断时,底部做一道渐隐,提示下面还有 */
  function refreshSidebarOverflow() {
    document.querySelectorAll(".sb-scroll").forEach((el) => el.classList.toggle("overflow", el.scrollHeight > el.clientHeight + 1));
  }
  window.addEventListener("resize", refreshSidebarOverflow);

  function toggleMenu(el) {
    const m = el.querySelector(".menu");
    if (m) m.hidden = !m.hidden;
  }
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".sb-user .menu:not([hidden])").forEach((m) => {
      if (!m.parentElement.contains(e.target)) m.hidden = true;
    });
  });

  /* ---------------- 设计稿标注条(非产品 UI) ---------------- */

  function anno({ no, name, url, extra = "" }) {
    return `<div class="anno lg-clear"><span class="tag">${esc(no)}</span><span>${esc(name)}</span><span class="url">${icon("lock")}flow.summer.fan${esc(url)}</span>${extra}</div>`;
  }

  const style = document.createElement("style");
  style.textContent = `.dg-toast{position:fixed;left:50%;bottom:88px;transform:translate(-50%,8px);z-index:200;padding:10px 16px;border-radius:980px;background:rgba(29,29,31,.86);color:#fff;font:500 13px/1.3 var(--font);opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease}.dg-toast.show{opacity:1;transform:translate(-50%,0)}`;
  document.head.appendChild(style);

  window.Mock = {
    esc, icon, brandMark, WALLPAPER,
    sidebar, mTop, mTabs, anno,
    badge, avatarOf,
    HEALTH, PENDING, PRIORITY, JOB_BADGE, STAGES,
    USERS, PROJECTS, WORK, ADMIN_NAV,
    toast, refreshSidebarOverflow,
  };
})();
