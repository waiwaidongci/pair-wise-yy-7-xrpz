import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);
const seed = {
  "items": [
    {
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "status": "调整中",
          "logs": [
            {
              "at": "2026-06-12",
              "note": "已缩短2mm"
            }
          ]
        }
      ],
      "logs": []
    }
  ]
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"],["allowance","长度裕量(mm)","number"]];
const stages = ["待检查","校准中","待复核","已交付"];
const statLabels = ["待检查","校准中","待复核","已交付"];
const shifts = ["早班","中班","晚班"];
const twistOptions = ["S捻","Z捻"];
const ropeStatuses = ["待交接","交接中","停待复尺","复测完成"];
const defaultAllowance = 5;

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
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
function newId(prefix) { return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function now() { return new Date().toISOString(); }
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function str(value) { return String(value ?? "").trim(); }
function round2(n) { return Math.round(n * 100) / 100; }
function findItem(db, key) { return db.items.find(x => x.id === key || x.code === key); }
function findRope(item, key) { return (item.tasks || []).find(t => t.id === key || t.position === key); }

// 旧数据补齐交接结构，只新增字段，不改动原有记录
function normalizeTask(task) {
  task.handoffs ||= [];
  task.rechecks ||= [];
  task.logs ||= [];
  if (task.prototypeLength == null) task.prototypeLength = null;
  if (task.allowance == null) task.allowance = null;
  return task;
}
function scaleDenominator(scale) {
  const match = /^\s*1\s*[:：/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(scale ?? ""));
  return match ? Number(match[1]) : null;
}
// 按模型比例换算：原型长度 ÷ 比例分母
function expectedLength(item, task) {
  const denominator = scaleDenominator(item.scale);
  const proto = num(task.prototypeLength);
  if (!denominator || proto == null) return null;
  return round2(proto / denominator);
}
function taskAllowance(item, task) {
  const allowance = num(task.allowance);
  if (allowance != null && allowance >= 0) return allowance;
  const itemAllowance = num(item.allowance);
  return itemAllowance != null && itemAllowance >= 0 ? itemAllowance : defaultAllowance;
}
function lastOf(list) { return list.length ? list[list.length - 1] : null; }
// 最新下料长度与换算长度对比，越过裕量即为超差
function lengthCheck(item, task) {
  const expected = expectedLength(item, task);
  const handoff = lastOf(task.handoffs);
  if (expected == null || !handoff) return { expected, cut: null, diff: null, over: false };
  const cut = num(handoff.cutLength);
  if (cut == null) return { expected, cut: null, diff: null, over: false };
  const diff = round2(cut - expected);
  return { expected, cut, diff, over: Math.abs(diff) > taskAllowance(item, task) };
}
// 索位状态由记录推导：复测签字 > 停待复尺 > 交接中 > 待交接
function ropeStatus(item, task) {
  const recheck = lastOf(task.rechecks);
  const handoff = lastOf(task.handoffs);
  if (recheck && handoff && recheck.at >= handoff.at) return "复测完成";
  if (!handoff) return "待交接";
  return lengthCheck(item, task).over ? "停待复尺" : "交接中";
}
function ropeView(item, task) {
  normalizeTask(task);
  const check = lengthCheck(item, task);
  return {
    ...task,
    status: ropeStatus(item, task),
    expectedLength: check.expected,
    allowance: taskAllowance(item, task),
    lastDiff: check.diff,
    overAllowance: check.over
  };
}
// 交付确认：全部索位复测完成才可交付，否则列出缺项索位名称
function deliverySummary(item) {
  const ropes = (item.tasks || []).map(t => ropeView(item, t));
  const missing = ropes.filter(r => r.status !== "复测完成").map(r => ({ position: r.position, status: r.status }));
  return { ropeCount: ropes.length, ready: ropes.length > 0 && missing.length === 0, missing };
}
function summarize(item) {
  (item.tasks || []).forEach(t => normalizeTask(t));
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length + t.handoffs.length + t.rechecks.length, 0);
  return { ...item, tasks: (item.tasks || []).map(t => ropeView(item, t)), delivery: deliverySummary(item), logCount };
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:16px; } h4 { margin:0 0 8px; font-size:14px; }
    main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.mini { padding:6px 10px; font-size:13px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .cards { display:grid; gap:16px; } .card { display:grid; gap:10px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .ropes { display:grid; gap:10px; } .rope { border:1px solid var(--line); border-radius:8px; padding:12px; display:grid; gap:8px; background:#fbfdfa; }
    .rope-head { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
    .st-待交接 { background:#eef1f4; color:#4a5568; } .st-交接中 { background:#e7f0fb; color:#2b5a8f; } .st-停待复尺 { background:#fbe9e4; color:#9b4937; } .st-复测完成 { background:#e6f2e4; color:#3c6b34; }
    .kv { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:4px 12px; font-size:13px; }
    .alert { border:1px solid #e5b8ae; background:#fdf1ee; color:var(--warn); border-radius:6px; padding:8px 10px; font-size:13px; font-weight:700; }
    .ok { border:1px solid #b7d3b0; background:#eef6ec; color:#3c6b34; border-radius:6px; padding:8px 10px; font-size:13px; }
    .hint { border:1px dashed var(--line); border-radius:6px; padding:8px 10px; font-size:13px; color:var(--muted); }
    details { border-top:1px solid var(--line); padding-top:8px; } summary { cursor:pointer; color:var(--muted); font-size:13px; }
    .history { max-height:220px; overflow:auto; display:grid; gap:6px; margin-top:8px; }
    .h-entry { border-left:3px solid var(--line); padding:2px 0 2px 8px; font-size:13px; }
    .h-entry.recheck { border-left-color:var(--accent); }
    .formgrid { display:grid; grid-template-columns:1fr 1fr; gap:0 10px; } .formgrid .full { grid-column:1 / -1; }
    .rope form { padding:10px; background:#f4f7f2; } .rope form h4 { color:var(--muted); }
    .delivery { border:1px solid var(--line); border-radius:8px; padding:12px; display:grid; gap:8px; }
    .delivery.ready { border-color:#8fb485; background:#eef6ec; } .delivery.pending { border-color:#e0c9a2; background:#fdf8ee; }
    .delivery ul { margin:4px 0; padding-left:20px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">按索位记录施工交接：下料长度、麻线批号、捻向、接手人；换算超差停待复尺，全部复测完成后确认交付</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="cards" id="cards"></div>
    </section>
  </main>
  <script>
    const fields = ${JSON.stringify(fields)};
    const stages = ${JSON.stringify(stages)};
    const shifts = ${JSON.stringify(shifts)};
    const twistOptions = ${JSON.stringify(twistOptions)};
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const createForm = document.querySelector('#createForm');
    let items = [];
    function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
    function fmtLen(n) { return n == null ? '—' : n + ' mm'; }
    function fmtDiff(n) { return n == null ? '—' : (n > 0 ? '+' : '') + n + ' mm'; }
    function fmtTime(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : ''; }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) {
        const missing = data.missing && data.missing.length ? '\\n缺项索位：' + data.missing.map(m => m.position + '（' + m.status + '）').join('、') : '';
        throw new Error((data.error || '请求失败') + missing);
      }
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+(key==='allowance'?' placeholder="默认 5"':'')+'>').join('');
    }
    function handoffForm(rope) {
      return '<form data-form="handoff" data-item="'+esc(rope.itemKey)+'" data-rope="'+esc(rope.id)+'"><h4>施工交接记录（新班次续记）</h4><div class="formgrid">'
        + '<div><label>班次</label><select name="shift">'+shifts.map(s => '<option>'+s+'</option>').join('')+'</select></div>'
        + '<div><label>下料长度(mm) *</label><input name="cutLength" type="number" step="0.1" required></div>'
        + '<div><label>麻线批号 *</label><input name="hempBatch" required></div>'
        + '<div><label>捻向 *</label><select name="twist">'+twistOptions.map(s => '<option>'+s+'</option>').join('')+'</select></div>'
        + '<div><label>交班人</label><input name="fromWorker"></div>'
        + '<div><label>接手人 *</label><input name="toWorker" required></div>'
        + '<div><label>张力读数</label><input name="tensionReading" placeholder="如 2.4N 或 偏松"></div></div>'
        + '<label>交接备注</label><input name="note" placeholder="裁线进度、注意事项">'
        + '<button>提交交接记录</button></form>';
    }
    function recheckForm(rope) {
      return '<form data-form="recheck" data-item="'+esc(rope.itemKey)+'" data-rope="'+esc(rope.id)+'"><h4>复测签字</h4><div class="formgrid">'
        + '<div><label>复测长度(mm) *</label><input name="measuredLength" type="number" step="0.1" required></div>'
        + '<div><label>复测签字 *</label><input name="signedBy" required></div></div>'
        + '<label>复测备注</label><input name="note">'
        + '<button>复测签字确认</button></form>';
    }
    function historyHtml(rope) {
      const entries = [];
      (rope.handoffs || []).forEach(h => entries.push({ at: h.at, kind: 'handoff', html:
        '<b>交接</b> ' + esc(h.shift || '') + ' · 下料 ' + fmtLen(h.cutLength) + ' · 批号 ' + esc(h.hempBatch) + ' · ' + esc(h.twist)
        + ' · 接手 ' + esc(h.toWorker) + (h.fromWorker ? ' · 交班 ' + esc(h.fromWorker) : '')
        + (h.tensionReading ? ' · 张力 ' + esc(h.tensionReading) : '') + (h.note ? ' · ' + esc(h.note) : '') }));
      (rope.rechecks || []).forEach(r => entries.push({ at: r.at, kind: 'recheck', html:
        '<b>复测签字</b> 实测 ' + fmtLen(r.measuredLength) + ' · 签字 ' + esc(r.signedBy) + (r.note ? ' · ' + esc(r.note) : '') }));
      entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      if (!entries.length) return '';
      return '<details><summary>交接与复测履历（' + entries.length + ' 条，复测签字后保留）</summary><div class="history">'
        + entries.map(e => '<div class="h-entry ' + e.kind + '"><span class="meta">' + fmtTime(e.at) + '</span> ' + e.html + '</div>').join('') + '</div></details>';
    }
    function ropeHtml(item, rope) {
      const itemKey = item.id || item.code;
      const r = { ...rope, itemKey };
      const last = (rope.handoffs || [])[ (rope.handoffs || []).length - 1 ];
      let banner = '';
      if (rope.status === '待交接') banner = '<div class="hint">尚无交接记录，请填写首班施工交接。</div>';
      if (rope.status === '交接中') banner = '<div class="hint">交接进行中，新班次请在原记录内续记，勿重复裁线。</div>';
      if (rope.status === '停待复尺') banner = '<div class="alert">下料长度越过裕量（偏差 ' + fmtDiff(rope.lastDiff) + '，裕量 ±' + rope.allowance + 'mm），已停待复尺；复测签字前不能标记校准完成。</div>';
      if (rope.status === '复测完成') banner = '<div class="ok">复测签字完成，本索位校准完成。</div>';
      const kv = '<div class="kv">'
        + '<div>原型长度 ' + fmtLen(rope.prototypeLength) + '</div>'
        + '<div>换算长度 ' + fmtLen(rope.expectedLength) + '</div>'
        + '<div>裕量 ±' + rope.allowance + ' mm</div>'
        + '<div>最近下料 ' + fmtLen(last ? last.cutLength : null) + '</div>'
        + '<div>偏差 ' + fmtDiff(rope.lastDiff) + '</div>'
        + (rope.tension ? '<div>松紧 ' + esc(rope.tension) + '</div>' : '')
        + '</div>';
      const lastLine = last ? '<div class="meta">当前交接：' + esc(last.shift || '') + ' · 接手 ' + esc(last.toWorker) + ' · 批号 ' + esc(last.hempBatch) + ' · ' + esc(last.twist) + (last.tensionReading ? ' · 张力 ' + esc(last.tensionReading) : '') + '</div>' : '';
      return '<div class="rope"><div class="rope-head"><h3>' + esc(rope.position) + '</h3><span class="pill st-' + rope.status + '">' + rope.status + '</span></div>'
        + banner + kv + lastLine + handoffForm(r)
        + (rope.status === '停待复尺' ? recheckForm(r) : '')
        + historyHtml(rope) + '</div>';
    }
    function deliveryHtml(item) {
      const d = item.delivery || { ready:false, missing:[], ropeCount:0 };
      const key = item.id || item.code;
      if (item.status === '已交付') return '<div class="delivery ready"><b>交付确认：已交付</b><div class="meta">全部索位已复测签字，履历保留备查。</div></div>';
      if (d.ready) return '<div class="delivery ready"><b>交付确认：全部 ' + d.ropeCount + ' 个索位已复测完成，可以交付。</b><button data-deliver="' + esc(key) + '">确认交付</button></div>';
      const list = d.missing.length ? '<ul>' + d.missing.map(m => '<li>' + esc(m.position) + '（' + m.status + '）</li>').join('') + '</ul>' : '';
      return '<div class="delivery pending"><b>交付确认：暂不能交付，缺项索位：</b>' + (list || '<div class="meta">暂无索位</div>') + '</div>';
    }
    function cardHtml(item) {
      const key = item.id || item.code;
      const main = fields.slice(0, 4).map(([k,label]) => '<div><b>' + label + '</b> ' + esc(item[k] ?? '') + '</div>').join('');
      const ropes = (item.tasks || []).map(t => ropeHtml(item, t)).join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>' + esc(l.step) + '：' + esc(l.note) + '</div>').join('');
      return '<article class="card"><div class="rope-head"><h3>' + esc(item.code || item.id) + '</h3><span class="pill">' + esc(item.status) + '</span></div>'
        + '<div class="kv">' + main + '</div>'
        + '<form data-form="rope" data-item="' + esc(key) + '"><h4>新增索位</h4><div class="formgrid">'
        + '<div><label>索位名称 *</label><input name="position" required placeholder="如 主桅升帆索"></div>'
        + '<div><label>原型长度(mm) *</label><input name="prototypeLength" type="number" step="0.1" required></div>'
        + '<div><label>裕量(mm)</label><input name="allowance" type="number" step="0.1" placeholder="默认沿用模型裕量"></div>'
        + '<div><label>松紧状态</label><input name="tension" placeholder="如 偏松"></div></div>'
        + '<label>备注</label><input name="note"><button>添加索位</button></form>'
        + '<div class="ropes">' + (ropes || '<div class="hint">暂无索位，请先添加。</div>') + '</div>'
        + deliveryHtml(item)
        + '<label>模型状态</label><select data-status="' + esc(key) + '">' + stages.map(s => '<option ' + (s === item.status ? 'selected' : '') + '>' + s + '</option>').join('') + '</select>'
        + '<button class="secondary" data-note="' + esc(key) + '">追加备注</button>'
        + '<div class="logs meta">' + (logs || '暂无记录') + '</div></article>';
    }
    function bindEvents() {
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        try { await api('/api/items/' + sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); }
        catch (e) { alert(e.message); }
        await load();
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => {
        const note = prompt('记录备注');
        if (note) { await api('/api/items/' + btn.dataset.note + '/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); }
      });
      document.querySelectorAll('[data-deliver]').forEach(btn => btn.onclick = async () => {
        try { await api('/api/items/' + btn.dataset.deliver, { method:'PATCH', body: JSON.stringify({ status:'已交付' }) }); }
        catch (e) { alert(e.message); }
        await load();
      });
      document.querySelectorAll('form[data-form]').forEach(form => form.onsubmit = async event => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        const kind = form.dataset.form, item = form.dataset.item, rope = form.dataset.rope;
        const path = kind === 'rope' ? '/api/items/' + item + '/ropes' : '/api/items/' + item + '/ropes/' + rope + (kind === 'handoff' ? '/handoffs' : '/recheck');
        try { await api(path, { method:'POST', body: JSON.stringify(data) }); }
        catch (e) { alert(e.message); return; }
        await load();
      });
    }
    function render() {
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(cardHtml).join('') || '<div class="panel meta">暂无模型</div>';
      bindEvents();
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => {
      event.preventDefault();
      try { await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); }
      catch (e) { alert(e.message); return; }
      createForm.reset(); await load();
    };
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      if (!str(input.code)) return send(res, 400, { error: "缺少模型编号" });
      const item = { id: newId("MR"), ...input, logs: [{ at: now(), step: "建档", note: "创建模型" }] };
      item.tasks = [];
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    const ropeCreate = url.pathname.match(/^\/api\/items\/([^/]+)\/ropes$/);
    if (ropeCreate && req.method === "POST") {
      const item = findItem(db, ropeCreate[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const position = str(input.position);
      if (!position) return send(res, 400, { error: "缺少索位名称" });
      item.tasks ||= [];
      if (item.tasks.some(t => t.position === position)) return send(res, 409, { error: "索位「" + position + "」已存在，请在原记录续班交接，避免重复裁线" });
      const prototypeLength = num(input.prototypeLength);
      if (prototypeLength == null || prototypeLength <= 0) return send(res, 400, { error: "原型长度需为正数(mm)" });
      if (!scaleDenominator(item.scale)) return send(res, 400, { error: "模型比例无法识别，需形如 1:48" });
      const allowance = input.allowance === "" || input.allowance == null ? null : num(input.allowance);
      if (input.allowance !== "" && input.allowance != null && (allowance == null || allowance < 0)) return send(res, 400, { error: "裕量需为不小于0的数(mm)" });
      const task = normalizeTask({
        id: newId("T"),
        position,
        prototypeLength,
        allowance,
        tension: str(input.tension),
        status: "待交接",
        logs: [{ at: now(), note: str(input.note) || "新增索位" }]
      });
      item.tasks.push(task);
      item.logs ||= [];
      item.logs.push({ at: now(), step: "索位", note: "新增索位 " + position });
      if (item.status === "待检查") item.status = "校准中";
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    const handoff = url.pathname.match(/^\/api\/items\/([^/]+)\/ropes\/([^/]+)\/handoffs$/);
    if (handoff && req.method === "POST") {
      const item = findItem(db, handoff[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const task = findRope(item, decodeURIComponent(handoff[2]));
      if (!task) return send(res, 404, { error: "rope_not_found" });
      normalizeTask(task);
      const input = await body(req);
      const cutLength = num(input.cutLength);
      if (cutLength == null || cutLength <= 0) return send(res, 400, { error: "下料长度需为正数(mm)" });
      if (!str(input.hempBatch)) return send(res, 400, { error: "缺少麻线批号" });
      if (!str(input.twist)) return send(res, 400, { error: "缺少捻向" });
      if (!str(input.toWorker)) return send(res, 400, { error: "缺少接手人" });
      const entry = {
        id: newId("H"),
        at: now(),
        shift: str(input.shift),
        cutLength,
        hempBatch: str(input.hempBatch),
        twist: str(input.twist),
        fromWorker: str(input.fromWorker),
        toWorker: str(input.toWorker),
        tensionReading: str(input.tensionReading),
        note: str(input.note)
      };
      task.handoffs.push(entry);
      const status = ropeStatus(item, task);
      task.logs.push({ at: now(), note: "交接续记：" + (entry.shift || "未注明班次") + " 下料 " + cutLength + "mm，接手 " + entry.toWorker });
      item.logs ||= [];
      item.logs.push({ at: now(), step: "交接", note: task.position + " 下料 " + cutLength + "mm（" + entry.toWorker + "接手）" + (status === "停待复尺" ? "，越过裕量停待复尺" : "") });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    const recheck = url.pathname.match(/^\/api\/items\/([^/]+)\/ropes\/([^/]+)\/recheck$/);
    if (recheck && req.method === "POST") {
      const item = findItem(db, recheck[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const task = findRope(item, decodeURIComponent(recheck[2]));
      if (!task) return send(res, 404, { error: "rope_not_found" });
      normalizeTask(task);
      const input = await body(req);
      if (!task.handoffs.length) return send(res, 400, { error: "尚无交接记录，不能复测签字" });
      if (ropeStatus(item, task) !== "停待复尺") return send(res, 400, { error: "当前无需复测：仅停待复尺的索位需要复测签字" });
      const measuredLength = num(input.measuredLength);
      if (measuredLength == null || measuredLength <= 0) return send(res, 400, { error: "复测长度需为正数(mm)" });
      if (!str(input.signedBy)) return send(res, 400, { error: "缺少复测签字" });
      const expected = expectedLength(item, task);
      const diff = expected == null ? null : round2(measuredLength - expected);
      if (diff != null && Math.abs(diff) > taskAllowance(item, task)) {
        return send(res, 400, { error: "复测长度仍越过裕量（偏差 " + (diff > 0 ? "+" : "") + diff + "mm，裕量 ±" + taskAllowance(item, task) + "mm），不能签字完成，请重新裁线交接" });
      }
      const entry = { id: newId("R"), at: now(), measuredLength, diff, signedBy: str(input.signedBy), note: str(input.note) };
      task.rechecks.push(entry);
      task.logs.push({ at: now(), note: "复测签字：实测 " + measuredLength + "mm，签字 " + entry.signedBy });
      item.logs ||= [];
      item.logs.push({ at: now(), step: "复测", note: task.position + " 复测合格，签字 " + entry.signedBy });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      if (input.status === "已交付") {
        const delivery = deliverySummary(item);
        if (!delivery.ready) {
          return send(res, 400, { error: "尚有索位未复测完成，不能标记交付", missing: delivery.missing });
        }
      }
      Object.assign(item, input);
      item.logs ||= [];
      item.logs.push({ at: now(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, summarize(item));
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(db, log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: now(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
