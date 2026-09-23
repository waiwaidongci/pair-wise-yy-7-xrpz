import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TWISTS,
  evaluatePosition,
  deliverySummary,
  decideRemeasure,
  missingEntryFields,
  canAppend,
} from "./rules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
const rulesPath = join(__dirname, "rules.js");
const port = Number(process.env.PORT || 3038);
const DEFAULT_ALLOWANCE = 3; // 模型尺寸 mm，默认下料/复测裕量 ±3mm

const seed = {
  items: [
    {
      code: "MR-001",
      shipType: "福船",
      scale: "1:48",
      allowanceMm: DEFAULT_ALLOWANCE,
      mastCount: 3,
      riggingMaterial: "蜡线",
      owner: "周宁",
      dueDate: "2026-06-28",
      status: "校准中",
      tasks: [
        {
          id: "T-1",
          position: "前桅侧支索",
          designLength: 9600,
          tension: "偏松",
          status: "调整中",
          calibratedAt: null,
          entries: [
            {
              id: "E-1",
              at: "2026-06-12T08:30:00.000Z",
              shift: "早班",
              cutLength: 9600,
              batch: "MX-2407",
              twist: "Z",
              handedBy: "周宁",
              receiver: "郑铎",
              tensionReading: "42cN（偏松）",
              note: "已缩短2mm，下班复尺",
              remeasure: null,
            },
          ],
          logs: [{ at: "2026-06-12", note: "已缩短2mm" }],
        },
        {
          id: "T-1782013829186",
          position: "后桅升帆索",
          designLength: 7200,
          tension: "偏紧",
          status: "待检查",
          calibratedAt: null,
          entries: [],
          logs: [
            {
              at: "2026-06-21T03:50:29.186Z",
              note: "回退半圈",
            },
          ],
        },
      ],
      logs: [
        {
          at: "2026-06-21T03:50:29.186Z",
          step: "帆索",
          note: "后桅升帆索 · 偏紧",
        },
      ],
    },
  ],
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例(如1:48)","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const stages = ["待检查","校准中","待复核","已交付"];

const nowIso = () => new Date().toISOString();
const newId = (p) => p + "-" + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36);

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  migrate(db);
  return db;
}

// 给旧数据补齐交接记录结构
function migrate(db) {
  for (const item of db.items || []) {
    if (!Number.isFinite(Number(item.allowanceMm))) item.allowanceMm = DEFAULT_ALLOWANCE;
    item.tasks ||= [];
    for (const t of item.tasks) {
      t.entries ||= [];
      if (!Number.isFinite(Number(t.designLength))) t.designLength = null;
      if (t.calibratedAt === undefined) t.calibratedAt = null;
      for (const e of t.entries) if (e.remeasure === undefined) e.remeasure = null;
    }
  }
}

async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
const findItem = (db, id) => db.items.find((x) => x.id === id || x.code === id);
const findTask = (item, taskId) => (item.tasks || []).find((t) => t.id === taskId);

function summarize(item) {
  const tasks = (item.tasks || []).map((t) => ({ ...t, stateInfo: evaluatePosition(t, item) }));
  const logCount =
    (item.logs || []).length +
    tasks.reduce((n, t) => n + (t.logs || []).length + (t.entries || []).length, 0);
  return { ...item, tasks, delivery: deliverySummary({ ...item, tasks }), logCount };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准 · 施工交接记录</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#b5482f; --ok:#3c7a4d; --info:#3d5f8f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0; font-size:16px; }
    main { display:grid; grid-template-columns:360px 1fr; gap:20px; padding:20px 28px; align-items:start; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:15px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; } textarea { min-height:52px; resize:vertical; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; font:inherit; } button.secondary { background:#69736a; } button.mini { padding:5px 9px; font-size:12px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:12px; } .stat strong { display:block; font-size:22px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; white-space:nowrap; }
    .pill.s-idle,.pill.s-incomplete { background:#ecefeb; color:#5a6158; } .pill.s-needData { background:#fdf1e0; color:#9a6217; }
    .pill.s-hold,.pill.s-failed { background:#fbe7e1; color:var(--hold); } .pill.s-wait { background:#e6edf6; color:var(--info); }
    .pill.s-passed { background:#e6f2e8; color:var(--ok); } .pill.s-done { background:#dff0e4; color:#25603a; font-weight:700; }
    .model-item { text-align:left; width:100%; background:#fff; border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; color:var(--ink); font-weight:400; }
    .model-item.active { border-color:var(--accent); box-shadow:0 0 0 2px rgba(82,111,67,.18); }
    .tasks { display:grid; grid-template-columns:repeat(auto-fill,minmax(430px,1fr)); gap:12px; }
    .card .head { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .calc { margin:8px 0; padding:8px 10px; background:#f7f8f5; border-radius:6px; font-size:13px; display:grid; gap:3px; }
    .calc .over { color:var(--hold); font-weight:700; } .calc .ok { color:var(--ok); }
    .banner { margin:8px 0; padding:8px 10px; border-radius:6px; font-size:13px; font-weight:700; }
    .banner.hold,.banner.fail { background:#fbe7e1; color:var(--hold); } .banner.pass,.banner.ready { background:#e6f2e8; color:var(--ok); }
    .banner.info { background:#e6edf6; color:var(--info); }
    .timeline { margin:8px 0 4px; padding-left:2px; display:grid; gap:8px; }
    .entry { border-left:3px solid var(--line); padding:6px 10px; background:#fafbf8; border-radius:0 6px 6px 0; font-size:13px; display:grid; gap:2px; }
    .entry.sealed { border-left-color:var(--ok); }
    .entry .rm { margin-top:3px; padding:5px 8px; border-radius:5px; font-weight:700; }
    .entry .rm.pass { background:#e6f2e8; color:var(--ok); } .entry .rm.fail { background:#fbe7e1; color:var(--hold); }
    .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
    .inline { display:grid; grid-template-columns:1fr 1fr; gap:0 10px; border-top:1px dashed var(--line); margin-top:8px; padding-top:6px; }
    .inline .full { grid-column:1 / -1; } .inline h4 { grid-column:1 / -1; margin:8px 0 2px; font-size:13px; color:var(--muted); }
    .delivery ul { margin:8px 0 0; padding-left:20px; } .delivery li { margin:3px 0; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:0 10px; }
    @media (max-width:960px){ header{display:block;padding:16px;} main{grid-template-columns:1fr;padding:14px;} .tasks{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准 · 施工交接记录</h1><div class="meta">每根帆索一份交接履历：下料长度 · 麻线批号 · 捻向 · 接手人；越裕量停待复尺，复测签字后张力读数留档</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm" class="panel"><h2>新增模型</h2><div id="fields"></div>
        <div class="row2"><div><label>下料裕量(模型mm，±)</label><input name="allowanceMm" type="number" step="0.1" min="0" value="3"></div></div>
        <label>初始状态</label><select name="status">${stages.map((s) => "<option>" + s + "</option>").join("")}</select>
        <div style="margin-top:10px"><button>保存模型</button></div>
      </form>
      <div class="panel" style="margin-top:14px"><h2>模型列表</h2><div id="modelList"></div></div>
    </section>
    <section id="detail"></section>
  </main>
  <script type="module">
    import { modelLength, round2, evaluatePosition, deliverySummary, STATE_LABELS } from "/rules.js";
    const fields = ${JSON.stringify(fields)};
    const stages = ${JSON.stringify(stages)};
    const TWISTS = ${JSON.stringify(TWISTS)};
    let items = [], currentId = null;

    const $ = (s, r=document) => r.querySelector(s);
    const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.error || "请求失败"); err.data = data; throw err; }
      return data;
    }

    function renderCreateForm() {
      $("#fields").innerHTML = fields.map(([key,label,type]) =>
        '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==="code"?"required":"")+">").join("");
    }

    function renderModelList() {
      $("#modelList").innerHTML = items.map(item =>
        '<button type="button" class="model-item '+(item.id===currentId||item.code===currentId?"active":"")+'" data-pick="'+esc(item.id||item.code)+'">'
        + '<b>'+esc(item.code)+'</b> · '+esc(item.shipType)+' · '+esc(item.scale)+'<div class="meta">'+esc(item.status)
        + ' ｜ 索位 '+item.tasks.length+' ｜ 完成 '+item.delivery.doneCount+'/'+item.delivery.total+'</div></button>').join("")
        || '<div class="meta">暂无模型</div>';
      document.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => { currentId = b.dataset.pick; renderAll(); });
    }

    function deliveryHtml(item) {
      const d = item.delivery;
      if (d.ready) return '<div class="banner ready">✓ 全部 '+d.total+' 个索位均已完成复测签字与校准，可办理交付确认。</div>';
      return '<div class="banner hold">尚有 '+d.missing.length+' 个索位存在缺项，不能交付：</div>'
        + '<ul>'+d.missing.map(m => '<li>'+esc(m)+'</li>').join("")+'</ul>';
    }

    function timelineHtml(item, task) {
      if (!task.entries.length) return '<div class="meta" style="margin:8px 0">暂无交接记录。</div>';
      return '<div class="timeline">' + task.entries.map((e, i) => {
        const ev = evaluatePosition({ designLength: task.designLength, entries: task.entries.slice(0, i+1) }, item).evaluation;
        const rm = e.remeasure;
        return '<div class="entry '+(rm && rm.result==="pass" ? "sealed":"")+'">'
          + '<div><b>第'+(i+1)+'班交接</b> · <span class="meta">'+esc((e.at||"").replace("T"," ").slice(0,16))+(e.shift? " · "+esc(e.shift):"")+'</span></div>'
          + '<div>下料长度 <b>'+esc(e.cutLength)+'</b> mm（真船） → 模型换算 <b>'+(ev? ev.modelLength+"":"—")+'</b> mm'
          + (ev ? ' <span class="'+(ev.overMargin?"over":"ok")+'">差值 '+ev.diff+' mm'+(ev.overMargin?" · 越过裕量 "+ev.allowance+"":"")+'</span>' : "")+'</div>'
          + '<div>麻线批号：'+esc(e.batch)+' ｜ 捻向：'+esc(e.twist)+'捻 ｜ 接手人：<b>'+esc(e.receiver)+'</b> ｜ 交班人：'+esc(e.handedBy||"—")+'</div>'
          + (e.tensionReading ? '<div>张力读数：'+esc(e.tensionReading)+'</div>' : "")
          + (e.note ? '<div class="meta">备注：'+esc(e.note)+'</div>' : "")
          + (rm ? '<div class="rm '+rm.result+'">'+(rm.result==="pass"?"复测合格 ✓":"复测不合格 ✗")
              +' ｜ 实测 '+esc(rm.measuredModelMm)+'mm ｜ 差值 '+esc(rm.diff)+'mm ｜ 签字：'+esc(rm.signer||"—")+' ｜ '+esc((rm.at||"").replace("T"," ").slice(0,16))+'</div>'
              + (rm.note ? '<div class="meta">复测备注：'+esc(rm.note)+'</div>' : "") : "")
          + '</div>';
      }).join("") + '</div>';
    }

    function entryFormHtml(task) {
      return '<form class="inline" data-entry="'+esc(task.id)+'"><h4>续记交接（新班次续在本索位原记录内）</h4>'
        + '<div><label>下料长度(真船mm)*</label><input name="cutLength" type="number" step="0.1" min="0" required data-preview></div>'
        + '<div><label>麻线批号*</label><input name="batch" required></div>'
        + '<div><label>捻向*</label><select name="twist">'+TWISTS.map(t => '<option value="'+t+'">'+t+'捻</option>').join("")+'</select></div>'
        + '<div><label>接手人*</label><input name="receiver" required></div>'
        + '<div><label>交班人</label><input name="handedBy"></div>'
        + '<div><label>张力读数(留档)</label><input name="tensionReading" placeholder="如 42cN / 偏松"></div>'
        + '<div class="full"><label>交接备注</label><textarea name="note"></textarea></div>'
        + '<div class="full"><div class="meta" data-preview-line>填写下料长度后显示模型换算结果</div><div style="margin-top:6px"><button type="submit">追加到本索位履历</button></div></div></form>';
    }

    function remeasureFormHtml(task, title) {
      return '<form class="inline" data-remeasure="'+esc(task.id)+'"><h4>'+title+'</h4>'
        + '<div><label>实测长度(模型mm)*</label><input name="measuredModelMm" type="number" step="0.1" min="0" required></div>'
        + '<div><label>复测签字人*</label><input name="signer" required></div>'
        + '<div class="full"><label>复测备注</label><textarea name="note"></textarea></div>'
        + '<div class="full" style="margin-top:6px"><button type="submit">提交复测签字</button></div></form>';
    }

    function taskHtml(item, task) {
      const st = task.stateInfo.state;
      const ev = st==="idle" ? null : evaluatePosition(task, item).evaluation;
      const designModel = modelLength(task.designLength, item.scale);
      let banner = "";
      if (st === "hold") banner = '<div class="banner hold">换算长度 '+ev.modelLength+'mm 越过裕量 ±'+ev.allowance+'mm（上限 '+ev.upperLimit+'mm），已停待复尺；复测签字通过前不能标记校准完成。</div>';
      if (st === "wait") banner = '<div class="banner info">下料在裕量内，等待复测签字。换班可由新班次直接续记。</div>';
      if (st === "failed") banner = '<div class="banner fail">复测不合格（差值 '+task.stateInfo.remeasure.diff+'mm）：请重新裁线并在本记录续记，或再次复尺。</div>';
      if (st === "passed") banner = '<div class="banner pass">复测合格，张力读数已随第'+task.entries.length+'班记录留档。确认校准后封档。</div>';
      if (st === "needData") banner = '<div class="banner" style="background:#fdf1e0;color:#9a6217">缺图纸实长或比例无法换算，请先补图纸实长。</div>';

      let actions = "";
      if (st === "idle" || st === "needData") actions = entryFormHtml(task);
      else if (st === "hold") actions = remeasureFormHtml(task, "停待复尺 · 实测复尺") + entryFormHtml(task);
      else if (st === "wait") actions = remeasureFormHtml(task, "复测签字") + entryFormHtml(task);
      else if (st === "failed") actions = remeasureFormHtml(task, "再次复尺") + entryFormHtml(task);
      else if (st === "passed") actions = '<div class="actions"><button data-calibrate="'+esc(task.id)+'">标记校准完成（封档）</button></div>';
      else if (st === "done") actions = '<div class="banner pass">已封档 · 校准完成于 '+esc((task.calibratedAt||"").replace("T"," ").slice(0,16))+'</div>';

      return '<article class="card"><div class="head"><h3>'+esc(task.position)+'</h3><span class="pill s-'+st+'">'+STATE_LABELS[st]+'</span></div>'
        + '<div class="meta">索位号 '+esc(task.id)+(task.tension? ' ｜ 初始状态 '+esc(task.tension):"")+'</div>'
        + '<div class="calc"><div>图纸实长：<b>'+esc(task.designLength ?? "未填")+'</b> mm（真船） → 模型长 <b>'+(designModel?? "—")+'</b> mm ｜ 裕量 ±'+esc(item.allowanceMm)+'mm'
        + (st==="idle"||st==="needData"
            ? ' <button type="button" class="mini secondary" data-edit="'+esc(task.id)+'">'+(task.designLength==null?"补图纸实长":"修改")+'</button>'
            : "")+'</div></div>'
        + banner + timelineHtml(item, task) + actions + '</article>';
    }

    function renderDetail() {
      const item = items.find(i => (i.id||i.code) === currentId);
      if (!item) { $("#detail").innerHTML = '<div class="panel meta">请从左侧选择一个模型。</div>'; return; }
      $("#detail").innerHTML =
        '<div class="panel delivery"><h2>交付确认 · '+esc(item.code)+' '+esc(item.shipType)+'</h2>'+deliveryHtml(item)+'</div>'
        + '<div class="panel" style="margin-top:12px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">'
        +   '<h2 style="margin:0">模型设置与索位</h2>'
        +   '<form id="statusForm" style="display:flex;gap:8px;align-items:center"><label style="margin:0">模型状态</label>'
        +   '<select name="status">'+stages.map(s => '<option '+(s===item.status?"selected":"")+'>'+s+'</option>').join("")+'</select>'
        +   '<button class="mini secondary" type="submit">更新</button></form></div>'
        + '<form id="settingForm" class="row2" style="margin-top:8px">'
        +   '<div><label>比例</label><input name="scale" value="'+esc(item.scale)+'"></div>'
        +   '<div><label>裕量(模型mm ±)</label><input name="allowanceMm" type="number" step="0.1" min="0" value="'+esc(item.allowanceMm)+'"></div>'
        +   '<div class="full" style="margin-top:6px"><button class="mini secondary" type="submit">保存换算参数</button></div></form></div>'
        + '<form id="taskForm" class="panel" style="margin-top:12px"><h2>新增索位</h2><div class="row2">'
        +   '<div><label>索具位置*</label><input name="position" required placeholder="如 前桅侧支索"></div>'
        +   '<div><label>图纸实长(真船mm)*</label><input name="designLength" type="number" step="0.1" min="0" required></div>'
        +   '<div><label>初始松紧</label><input name="tension" placeholder="如 偏松"></div>'
        +   '<div style="display:flex;align-items:flex-end"><button type="submit">新增索位</button></div></div></form>'
        + '<div class="tasks" style="margin-top:12px">'+item.tasks.map(t => taskHtml(item, t)).join("")+'</div>';

      $("#statusForm").onsubmit = async e => {
        e.preventDefault();
        try { await api("/api/items/"+encodeURIComponent(item.id||item.code), { method:"PATCH", body: JSON.stringify({ status: $("#statusForm select").value }) }); await load(); }
        catch (err) { alert((err.data && err.data.missing ? err.data.missing.join("\\n") : err.message)); await load(); }
      };
      $("#settingForm").onsubmit = async e => {
        e.preventDefault();
        const f = new FormData($("#settingForm"));
        await api("/api/items/"+encodeURIComponent(item.id||item.code), { method:"PATCH", body: JSON.stringify({ scale: f.get("scale"), allowanceMm: Number(f.get("allowanceMm")) }) });
        await load();
      };
      $("#taskForm").onsubmit = async e => {
        e.preventDefault();
        const f = new FormData($("#taskForm"));
        await api("/api/items/"+encodeURIComponent(item.id||item.code)+"/tasks", { method:"POST", body: JSON.stringify(Object.fromEntries(f.entries())) });
        await load();
      };
      document.querySelectorAll("[data-entry]").forEach(form => {
        const preview = () => {
          const v = Number(form.querySelector("[data-preview]").value);
          const m = modelLength(v, item.scale);
          const design = modelLength(form.dataset.design || item.tasks.find(t=>t.id===form.dataset.entry)?.designLength, item.scale);
          const line = form.querySelector("[data-preview-line]");
          if (m === null) { line.textContent = "比例无效，无法换算"; return; }
          const a = Number(item.allowanceMm);
          const over = design !== null && (m - design) > a;
          line.innerHTML = '换算后模型长度 <b>'+round2(m)+'</b> mm'+(design!==null ? '（图纸模型长 '+round2(design)+'mm，差值 '+round2(m-design)+'mm，上限 '+round2(design+a)+'mm）' : "")
            + (over ? ' — <span style="color:var(--hold)">越过裕量，提交后该索位将停待复尺</span>' : ' — 在裕量内，提交后待复测');
        };
        form.querySelector("[data-preview]").oninput = preview;
        form.onsubmit = async e => {
          e.preventDefault();
          const f = new FormData(form);
          const payload = Object.fromEntries(f.entries());
          payload.cutLength = Number(payload.cutLength);
          try {
            const saved = await api("/api/items/"+encodeURIComponent(item.id||item.code)+"/tasks/"+encodeURIComponent(form.dataset.entry)+"/entries", { method:"POST", body: JSON.stringify(payload) });
            const info = saved.tasks.find(t => t.id === form.dataset.entry).stateInfo;
            if (info.state === "hold") alert("换算长度 " + info.evaluation.modelLength + "mm 越过裕量，索位已停待复尺；复测签字通过前不能标记校准完成。");
          } catch (err) { alert(err.data && err.data.missing ? "缺项：" + err.data.missing.join("、") : err.message); }
          await load();
        };
      });
      document.querySelectorAll("[data-remeasure]").forEach(form => {
        form.onsubmit = async e => {
          e.preventDefault();
          const f = new FormData(form);
          try {
            const saved = await api("/api/items/"+encodeURIComponent(item.id||item.code)+"/tasks/"+encodeURIComponent(form.dataset.remeasure)+"/remeasure", { method:"POST",
              body: JSON.stringify({ measuredModelMm: Number(f.get("measuredModelMm")), signer: f.get("signer"), note: f.get("note") }) });
            const info = saved.tasks.find(t => t.id === form.dataset.remeasure).stateInfo;
            alert(info.state === "failed" ? "复测不合格，请重裁并续记交接。" : "复测合格，前班张力读数已保留，可标记校准完成。");
          } catch (err) { alert(err.message); }
          await load();
        };
      });
      document.querySelectorAll("[data-calibrate]").forEach(btn => btn.onclick = async () => {
        try { await api("/api/items/"+encodeURIComponent(item.id||item.code)+"/tasks/"+encodeURIComponent(btn.dataset.calibrate)+"/calibrate", { method:"POST" }); }
        catch (err) { alert(err.message); }
        await load();
      });
      document.querySelectorAll("[data-edit]").forEach(btn => btn.onclick = async () => {
        const v = prompt("图纸实长（真船mm）", item.tasks.find(t=>t.id===btn.dataset.edit)?.designLength ?? "");
        if (v === null) return;
        await api("/api/items/"+encodeURIComponent(item.id||item.code)+"/tasks/"+encodeURIComponent(btn.dataset.edit), { method:"PATCH", body: JSON.stringify({ designLength: Number(v) }) });
        await load();
      });
    }

    async function load() {
      items = await api("/api/items");
      if (!currentId && items[0]) currentId = items[0].id || items[0].code;
      renderAll();
    }
    function renderAll() { renderModelList(); renderDetail(); }

    $("#createForm").onsubmit = async e => {
      e.preventDefault();
      const f = new FormData($("#createForm"));
      const payload = Object.fromEntries(f.entries());
      payload.mastCount = Number(payload.mastCount);
      payload.allowanceMm = Number(payload.allowanceMm) || ${DEFAULT_ALLOWANCE};
      const created = await api("/api/items", { method:"POST", body: JSON.stringify(payload) });
      $("#createForm").reset();
      currentId = created.id || created.code;
      await load();
    };
    $("#reload").onclick = load;
    renderCreateForm();
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/rules.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end(await readFile(rulesPath, "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const stats = Object.fromEntries(stages.map((s) => [s, 0]));
      for (const item of db.items) if (stats[item.status] !== undefined) stats[item.status] += 1;
      return send(res, 200, stats);
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      if (!input.code || !String(input.code).trim()) return send(res, 400, { error: "模型编号必填" });
      if (db.items.some((x) => x.code === input.code)) return send(res, 409, { error: "模型编号已存在" });
      const item = {
        id: newId("MR"),
        code: String(input.code).trim(),
        shipType: input.shipType || "",
        scale: input.scale || "1:48",
        allowanceMm: Number.isFinite(Number(input.allowanceMm)) ? Number(input.allowanceMm) : DEFAULT_ALLOWANCE,
        mastCount: Number(input.mastCount) || 0,
        riggingMaterial: input.riggingMaterial || "",
        owner: input.owner || "",
        dueDate: input.dueDate || "",
        status: stages.includes(input.status) ? input.status : "待检查",
        tasks: [],
        logs: [{ at: nowIso(), step: "建档", note: "创建模型" }],
      };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    const itemMatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (itemMatch && req.method === "PATCH") {
      const item = findItem(db, decodeURIComponent(itemMatch[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      if (input.status !== undefined) {
        if (!stages.includes(input.status)) return send(res, 400, { error: "非法状态" });
        if (input.status === "已交付") {
          const sum = deliverySummary(item);
          if (!sum.ready) return send(res, 400, { error: "delivery_not_ready", missing: sum.missing });
        }
        item.status = input.status;
      }
      if (input.scale !== undefined) item.scale = String(input.scale);
      if (input.allowanceMm !== undefined) {
        const a = Number(input.allowanceMm);
        if (!Number.isFinite(a) || a < 0) return send(res, 400, { error: "裕量必须为非负数字" });
        item.allowanceMm = a;
      }
      for (const k of ["owner", "dueDate", "shipType", "riggingMaterial"]) if (input[k] !== undefined) item[k] = input[k];
      item.logs ||= [];
      item.logs.push({ at: nowIso(), step: "设置", note: "更新模型参数/状态" });
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    const taskCreate = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks$/);
    if (taskCreate && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(taskCreate[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      if (!input.position || !String(input.position).trim()) return send(res, 400, { error: "索具位置必填" });
      const design = Number(input.designLength);
      const task = {
        id: newId("T"),
        position: String(input.position).trim(),
        designLength: Number.isFinite(design) && design > 0 ? design : null,
        tension: input.tension || "",
        status: "待交接",
        calibratedAt: null,
        entries: [],
        logs: [{ at: nowIso(), note: "建立索位" }],
      };
      item.tasks ||= [];
      item.tasks.push(task);
      item.logs.push({ at: nowIso(), step: "索位", note: task.position + " 建位" });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    const taskPatch = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskPatch && req.method === "PATCH") {
      const item = findItem(db, decodeURIComponent(taskPatch[1]));
      const task = item && findTask(item, decodeURIComponent(taskPatch[2]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      if (!task) return send(res, 404, { error: "task_not_found" });
      if (task.calibratedAt) return send(res, 400, { error: "该索位已封档，不能再改图纸实长" });
      const input = await body(req);
      if (input.designLength !== undefined) {
        const d = Number(input.designLength);
        task.designLength = Number.isFinite(d) && d > 0 ? d : null;
      }
      if (input.position) task.position = String(input.position).trim();
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    const entryMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/entries$/);
    if (entryMatch && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(entryMatch[1]));
      const task = item && findTask(item, decodeURIComponent(entryMatch[2]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      if (!task) return send(res, 404, { error: "task_not_found" });
      const state = evaluatePosition(task, item).state;
      if (!canAppend(state)) return send(res, 400, { error: "该索位已复测封档，新交接请另立索位" });
      const input = await body(req);
      const entry = {
        id: newId("E"),
        at: nowIso(),
        shift: input.shift || "",
        cutLength: input.cutLength === "" || input.cutLength === null ? "" : Number(input.cutLength),
        batch: String(input.batch || "").trim(),
        twist: String(input.twist || "").trim(),
        handedBy: String(input.handedBy || "").trim(),
        receiver: String(input.receiver || "").trim(),
        tensionReading: String(input.tensionReading || "").trim(),
        note: String(input.note || "").trim(),
        remeasure: null,
      };
      if (!TWISTS.includes(entry.twist)) return send(res, 400, { error: "捻向必须为 Z 或 S" });
      const missing = missingEntryFields(entry);
      if (missing.length) return send(res, 400, { error: "交接记录缺项", missing });
      task.entries.push(entry);
      const info = evaluatePosition(task, item);
      task.status = info.state === "hold" ? "停待复尺" : "待复测";
      task.logs.push({ at: entry.at, note: `新班交接：${entry.receiver} 接手，下料 ${entry.cutLength}mm` });
      item.logs.push({
        at: entry.at,
        step: info.state === "hold" ? "停待复尺" : "交接",
        note: `${task.position} · ${entry.handedBy || "班前"}→${entry.receiver} · 批号${entry.batch} · ${entry.twist}捻`
          + (info.evaluation ? ` · 模型${info.evaluation.modelLength}mm` : "")
          + (info.state === "hold" ? " · 越过裕量停待复尺" : ""),
      });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    const rmMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/remeasure$/);
    if (rmMatch && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(rmMatch[1]));
      const task = item && findTask(item, decodeURIComponent(rmMatch[2]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      if (!task) return send(res, 404, { error: "task_not_found" });
      const state = evaluatePosition(task, item).state;
      if (!["hold", "wait", "failed"].includes(state)) {
        return send(res, 400, { error: "当前索位状态不接受复测（" + state + "）" });
      }
      const input = await body(req);
      const signer = String(input.signer || "").trim();
      if (!signer) return send(res, 400, { error: "复测签字人必填" });
      const decision = decideRemeasure(input.measuredModelMm, task, item);
      if (!decision) return send(res, 400, { error: "实测长度无效，或图纸实长/比例缺失" });
      const latest = task.entries[task.entries.length - 1];
      // 复测结论写入最新一条交接记录；交班张力读数原样保留
      latest.remeasure = { ...decision, signer, at: nowIso(), note: String(input.note || "").trim() };
      const info = evaluatePosition(task, item);
      task.status = info.state === "passed" ? "复测合格" : "复测不合格";
      item.logs.push({
        at: latest.remeasure.at,
        step: "复测",
        note: `${task.position} · 实测${decision.measuredModelMm}mm 差值${decision.diff}mm · ${decision.result === "pass" ? "合格" : "不合格"} · ${signer}签字`,
      });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    const calMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/calibrate$/);
    if (calMatch && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(calMatch[1]));
      const task = item && findTask(item, decodeURIComponent(calMatch[2]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      if (!task) return send(res, 404, { error: "task_not_found" });
      const info = evaluatePosition(task, item);
      const guard = {
        idle: "还没有交接记录，不能标记校准完成",
        incomplete: "交接记录有缺项（" + info.missing.join("、") + "），不能标记校准完成",
        needData: "缺图纸实长或有效比例，未完成换算，不能标记校准完成",
        hold: "换算长度越过裕量，索位停待复尺；复测签字通过前不能标记校准完成",
        wait: "尚未复测签字，不能先算校准完成",
        failed: "复测不合格，需重裁续记并重新复测",
        done: "该索位已封档",
      };
      if (info.state !== "passed") return send(res, 400, { error: guard[info.state] || "不能标记校准完成" });
      task.calibratedAt = nowIso();
      task.status = "校准完成";
      item.logs.push({ at: task.calibratedAt, step: "校准", note: `${task.position} 校准完成封档` });
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    // 兼容旧接口：追加模型级备注
    const logMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(logMatch[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: nowIso(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
