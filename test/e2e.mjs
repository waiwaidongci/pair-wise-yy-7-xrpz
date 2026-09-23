// 端到端：完整帆索交接工作流
const BASE = "http://localhost:3038";
const api = async (path, options = {}) => {
  const res = await fetch(BASE + path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : {},
  });
  const data = await res.json();
  return { status: res.status, data };
};
const assert = (cond, msg) => { if (!cond) { console.error("✗ " + msg); process.exit(1); } console.log("✓ " + msg); };

const code = "MR-E2E";
await api("/api/items/" + code, { method: "DELETE" }); // 清理可能的残留（服务无 DELETE，忽略 404）

let r = await api("/api/items", { method: "POST", body: JSON.stringify({
  code, shipType: "福船", scale: "1:48", allowanceMm: 3, mastCount: 3, owner: "周宁", status: "校准中",
}) });
assert(r.status === 201, "创建模型 " + code);

r = await api(`/api/items/${code}/tasks`, { method: "POST", body: JSON.stringify({ position: "前桅侧支索", designLength: 9600, tension: "偏松" }) });
assert(r.status === 201, "新增索位（图纸实长 9600mm → 模型 200mm，裕量 ±3）");

const stateOf = (item, pos) => item.tasks.find(t => t.position === pos).stateInfo.state;

r = await api(`/api/items/${code}/tasks/${r.data.tasks.slice(-1)[0].id}/calibrate`, { method: "POST" });
// 上一行取的是列表最后一个；为稳妥下面按位置找 id
const getId = async (pos) => (await api(`/api/items/${code}`)).data?.tasks?.find(t => t.position === pos)?.id;
// /api/items 列表无单查，用列表接口
const item = async () => (await api("/api/items")).data.find(x => x.code === code);
const T1 = (await item()).tasks.find(t => t.position === "前桅侧支索").id;

r = await api(`/api/items/${code}/tasks/${T1}/calibrate`, { method: "POST" });
assert(r.status === 400, "未交接时校准被拒：" + r.data.error);

r = await api(`/api/items/${code}/tasks/${T1}/entries`, { method: "POST", body: JSON.stringify({ cutLength: 9600, twist: "Z" }) });
assert(r.status === 400 && r.data.missing.includes("麻线批号") && r.data.missing.includes("接手人"), "缺项被拒并列出缺项：" + r.data.missing.join("、"));

r = await api(`/api/items/${code}/tasks/${T1}/entries`, { method: "POST", body: JSON.stringify({
  cutLength: 9792, batch: "MX-2407", twist: "Z", handedBy: "周宁", receiver: "郑铎", tensionReading: "42cN 偏松", shift: "晚班",
}) });
assert(r.status === 201 && stateOf(r.data, "前桅侧支索") === "hold", "下料 9792mm → 模型 204mm 越过裕量，索位停待复尺");

r = await api(`/api/items/${code}/tasks/${T1}/calibrate`, { method: "POST" });
assert(r.status === 400 && r.data.error.includes("停待复尺"), "停待复尺期间不能先算校准完成");

r = await api(`/api/items/${code}/tasks/${T1}/remeasure`, { method: "POST", body: JSON.stringify({ measuredModelMm: 204.5, signer: "周宁" }) });
assert(r.status === 201 && stateOf(r.data, "前桅侧支索") === "failed", "复测实测 204.5mm 差值 +4.5 → 不合格");

// 新班次续在原记录里重裁
r = await api(`/api/items/${code}/tasks/${T1}/entries`, { method: "POST", body: JSON.stringify({
  cutLength: 9600, batch: "MX-2408", twist: "Z", handedBy: "郑铎", receiver: "冯远", tensionReading: "40cN", note: "重裁", shift: "早班",
}) });
assert(r.status === 201 && stateOf(r.data, "前桅侧支索") === "wait", "新班次续记重裁 9600mm → 200mm，转待复测");
const t1 = r.data.tasks.find(t => t.position === "前桅侧支索");
assert(t1.entries.length === 2 && t1.entries[0].tensionReading === "42cN 偏松", "前一位师傅的张力读数保留在履历（" + t1.entries[0].tensionReading + "）");
assert(t1.entries[0].remeasure.result === "fail", "前班不合格复测结论仍留档");

r = await api(`/api/items/${code}/tasks/${T1}/remeasure`, { method: "POST", body: JSON.stringify({ measuredModelMm: 201, signer: "周宁" }) });
assert(r.status === 201 && stateOf(r.data, "前桅侧支索") === "passed", "复测 201mm 差值 +1 合格，待校准");

r = await api(`/api/items/${code}/tasks/${T1}/entries`, { method: "POST", body: JSON.stringify({
  cutLength: 9600, batch: "X", twist: "Z", receiver: "谁",
}) });
assert(r.status === 400, "复测合格封档后禁止再续记：" + r.data.error);

r = await api(`/api/items/${code}/tasks/${T1}/calibrate`, { method: "POST" });
assert(r.status === 200 && stateOf(r.data, "前桅侧支索") === "done", "复测合格后标记校准完成");

// 第二个索位只建位不交接
r = await api(`/api/items/${code}/tasks`, { method: "POST", body: JSON.stringify({ position: "主桅升帆索", designLength: 12000 }) });
const T2 = r.data.tasks.slice(-1)[0].id;

r = await api(`/api/items/${code}`, { method: "PATCH", body: JSON.stringify({ status: "已交付" }) });
assert(r.status === 400 && r.data.missing.some(m => m.startsWith("主桅升帆索")), "有缺项拒绝交付，列出索位：" + r.data.missing.join(" / "));

// 把第二索位一次走完（在裕量内 → 复测 → 校准）
await api(`/api/items/${code}/tasks/${T2}/entries`, { method: "POST", body: JSON.stringify({
  cutLength: 12000, batch: "MX-2409", twist: "S", handedBy: "冯远", receiver: "郑铎",
}) });
await api(`/api/items/${code}/tasks/${T2}/remeasure`, { method: "POST", body: JSON.stringify({ measuredModelMm: 249, signer: "周宁" }) });
r = await api(`/api/items/${code}/tasks/${T2}/calibrate`, { method: "POST" });
assert(stateOf(r.data, "主桅升帆索") === "done", "第二索位校准完成（S 捻，250mm 图纸长，实测 249）");

r = await api(`/api/items/${code}`, { method: "PATCH", body: JSON.stringify({ status: "已交付" }) });
assert(r.status === 200 && r.data.status === "已交付", "全部索位复测+校准完成后给出交付确认");

const final = (await item());
console.log("\n交付缺项清单：", JSON.stringify(final.delivery, null, 2));
assert(final.delivery.ready && final.delivery.doneCount === 2, "交付摘要 2/2，缺项为空");
console.log("\n全部端到端断言通过");
