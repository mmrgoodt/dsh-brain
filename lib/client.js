/**
 * client.js —— DSH 侧边栏「记忆」入口
 *
 * 面板不是空的：直接读本地控制台的数据，把统计、类型分布、最近记忆都摆出来。
 * 数据源是随 DSH 起落的那个只读服务（127.0.0.1:8737）。
 * 读不到就显示「服务没起来」，不报错、不白屏、不影响 DSH 启动。
 */
window.__ModuleLoader__.load({
  id: "dsh-brain",
  factory: (require) => {
    const react = require("react");
    const h = react.createElement;
    const useState = react.useState;
    const useEffect = react.useEffect;

    const PANEL_ID = "brain-main";
    // 面板数据走宿主挂的同源路由。以前是直接 fetch 8737，但 DSH 给页面下发的
    // CSP 是 connect-src 'self'，跨源的请求在浏览器里根本发不出去，
    // 面板只会显示「控制台服务没在跑（Failed to fetch）」。
    const PANEL_API = "/dsh-brain/api/stats";
    // 独立控制台仍是 8737，只用来点按钮跳转，不参与 fetch
    const BASE = "http://127.0.0.1:8737";

    const KIND = {
      fact: ["事实", "#58a6ff"],
      pref: ["偏好", "#39d0d8"],
      lesson: ["教训", "#f85149"],
      method: ["方法", "#3fb950"],
      promise: ["承诺", "#d29922"],
    };

    const S = {
      page: {
        padding: "24px 28px", color: "#c9d1d9", maxWidth: 900,
        font: '13px/1.7 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif',
      },
      h1: { fontSize: 18, color: "#58a6ff", fontWeight: 600, marginBottom: 2 },
      sub: { opacity: 0.42, fontSize: 11.5, marginBottom: 18 },
      row: { display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 16 },
      stat: {
        flex: "1 1 88px", minWidth: 88, background: "#11151c",
        border: "1px solid #21262d", borderRadius: 9, padding: "10px 12px",
      },
      num: { fontSize: 20, fontWeight: 600, color: "#e6edf3", lineHeight: 1.25 },
      lab: { fontSize: 10.5, opacity: 0.45, marginTop: 1 },
      btn: {
        border: "1px solid #30363d", background: "#1f6feb", color: "#fff",
        padding: "7px 14px", borderRadius: 7, cursor: "pointer",
        fontSize: 12.5, fontFamily: "inherit",
      },
      btnAlt: {
        border: "1px solid #30363d", background: "#21262d", color: "#58a6ff",
        padding: "7px 14px", borderRadius: 7, cursor: "pointer",
        fontSize: 12.5, fontFamily: "inherit",
      },
      item: {
        background: "#11151c", borderLeft: "3px solid #30363d",
        borderRadius: 6, padding: "7px 11px", marginBottom: 5,
      },
      tag: { fontSize: 9.5, padding: "0 6px", borderRadius: 20, border: "1px solid", marginRight: 6 },
      meta: { fontSize: 10, opacity: 0.35, marginTop: 2 },
      warn: { padding: "10px 13px", background: "#2d1618", border: "1px solid #5c2b30", borderRadius: 8, fontSize: 12 },
      foot: { marginTop: 18, padding: "9px 12px", background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, fontSize: 11, opacity: 0.5 },
    };

    const openUrl = (u) => { try { window.open(u, "_blank", "noopener"); } catch (e) {} };

    function Page() {
      const [d, setD] = useState(null);
      const [err, setErr] = useState("");

      useEffect(() => {
        let alive = true;
        const load = () => {
          const fail = (e) => { if (alive) setErr(String((e && e.message) || e)); };
          try {
            fetch(PANEL_API, { cache: "no-store" })
              .then((r) => {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
              })
              .then((j) => {
                if (!alive) return;
                if (j && j.error) { setErr(String(j.error)); return; }
                setD(j); setErr("");
              })
              .catch(fail);
          } catch (e) {
            fail(e);
          }
        };
        load();
        const t = setInterval(load, 15000);
        return () => { alive = false; clearInterval(t); };
      }, []);

      const stats = [
        ["印象", d ? d.impressions : "—"],
        ["事件", d ? d.events : "—"],
        ["场景", d ? d.scenes : "—"],
        ["关系", d ? d.bonds : "—"],
        ["因果", d ? d.causes : "—"],
        ["向量", d ? d.vectors : "—"],
      ];

      const out = [];
      out.push(h("div", { key: "t", style: S.h1 }, "记忆 "));
      out.push(h("div", { key: "s", style: S.sub },
        "本地单库 · 不联网 · " + (d ? "数据实时" : "等待数据")));

      // 统计卡片
      out.push(h("div", { key: "st", style: S.row },
        stats.map(([k, v], i) =>
          h("div", { key: i, style: S.stat },
            h("div", { style: S.num }, String(v)),
            h("div", { style: S.lab }, k)))));

      // 类型分布
      if (d && d.byKind && Object.keys(d.byKind).length) {
        out.push(h("div", { key: "kd", style: { ...S.row, marginBottom: 14 } },
          Object.keys(d.byKind).map((k) => {
            const pair = KIND[k] || [k, "#8b949e"];
            return h("div", {
              key: k,
              style: {
                fontSize: 11.5, padding: "3px 10px", borderRadius: 20,
                border: "1px solid " + pair[1] + "55", color: pair[1],
              },
            }, pair[0] + " " + d.byKind[k]);
          })));
      }

      // 按钮
      out.push(h("div", { key: "bt", style: S.row },
        h("button", { style: S.btn, onClick: () => openUrl(BASE) }, "打开控制台"),
        h("button", { style: S.btnAlt, onClick: () => openUrl(BASE + "/visual/neuron3d.html") }, "3D 神经元")));

      // 数据没取到
      if (err) {
        out.push(h("div", { key: "e", style: S.warn },
          "面板数据没取到（" + err.slice(0, 50) + "）",
          h("div", { style: { opacity: 0.6, marginTop: 4, fontSize: 11 } },
            "数据走的是宿主同源路由 /dsh-brain/api/stats，改完插件要重启 DSH 才生效。")));
      }

      // 最近记忆
      if (d && d.recent && d.recent.length) {
        out.push(h("div", { key: "rc" },
          h("div", { style: { ...S.sub, margin: "4px 0 8px" } }, "最近记住的"),
          d.recent.slice(0, 12).map((m, i) => {
            const pair = KIND[m.kind] || [m.kind, "#8b949e"];
            return h("div", { key: i, style: { ...S.item, borderLeftColor: pair[1] } },
              h("span", { style: { ...S.tag, color: pair[1], borderColor: pair[1] + "55" } }, pair[0]),
              (m.body || "").slice(0, 90),
              h("div", { style: S.meta },
                "确信 " + (m.certainty || 0).toFixed(2) +
                " · 用过 " + (m.uses || 0) + " 次 · " +
                new Date((m.created || 0) * 1000).toLocaleString("zh-CN")));
          })));
      }

      out.push(h("div", { key: "f", style: S.foot },
        "控制台是独立只读进程，跟着 DSH 起落；它挂了不影响 DSH，记忆照常写入。"));

      return h("div", { style: S.page }, out);
    }

    function Icon() {
      return h("span", {
        style: { fontSize: 15, lineHeight: "18px", display: "inline-block", width: 18, textAlign: "center" },
      }, "🧠");
    }

    const inject = ["slots", "layout"];

    function apply(ctx) {
      try {
        ctx.inject(["layout"], (pageCtx) => {
          pageCtx.slots.inject("main", () => {
            pageCtx.slots.register({ name: "main", key: PANEL_ID, inject: () => ({}) }, Page);
            pageCtx.slots.inject("sidebar.panellist", () =>
              pageCtx.slots.register({
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 30,
                label: () => "记忆",
              }, Icon)
            );
          });
        });
      } catch (e) {
        try { console.warn("[brain] 侧边栏注册失败：", e && e.message); } catch {}
      }
    }

    return { name: "dsh-brain", inject, apply };
  },
});
