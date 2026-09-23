// 帆索施工交接记录的业务规则（纯函数）
// 长度口径：下料长度与图纸实长均按真船尺寸 mm 记录，按模型比例换算成模型 mm 后比对裕量。

export const TWISTS = ["Z", "S"];

// "1:48" / "1：48" -> 48；无法解析返回 null
export function scaleDenominator(scale) {
  if (typeof scale !== "string") return null;
  const m = scale.match(/^\s*1\s*[:：]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 真船 mm -> 模型 mm
export function modelLength(realMm, scale) {
  const d = scaleDenominator(scale);
  const n = Number(realMm);
  if (d === null || !Number.isFinite(n)) return null;
  return n / d;
}

export const round2 = (n) => Math.round(n * 100) / 100;

// 单条交接记录的换算判定
export function evaluateEntry(entry, task, ctx) {
  const designModel = modelLength(task?.designLength, ctx.scale);
  const model = modelLength(entry?.cutLength, ctx.scale);
  const allowance = Number(ctx.allowanceMm);
  if (designModel === null || model === null || !Number.isFinite(allowance)) return null;
  const diff = round2(model - designModel);
  return {
    designModel: round2(designModel),
    modelLength: round2(model),
    allowance,
    upperLimit: round2(designModel + allowance),
    lowerLimit: round2(designModel - allowance),
    diff,
    // “越过裕量”仅指加长方向严格超出，等于上限不算越限
    overMargin: diff > allowance,
  };
}

const ENTRY_FIELDS = [
  ["cutLength", "下料长度"],
  ["batch", "麻线批号"],
  ["twist", "捻向"],
  ["receiver", "接手人"],
];

// 交接记录四项必填校验，返回缺失字段中文名
export function missingEntryFields(entry) {
  const missing = [];
  for (const [k, label] of ENTRY_FIELDS) {
    const v = entry?.[k];
    if (v === undefined || v === null || String(v).trim() === "") missing.push(label);
  }
  const cut = Number(entry?.cutLength);
  if (
    entry?.cutLength !== undefined &&
    String(entry.cutLength).trim() !== "" &&
    (!Number.isFinite(cut) || cut <= 0) &&
    !missing.includes("下料长度")
  ) {
    missing.push("下料长度");
  }
  return missing;
}

export const STATE_LABELS = {
  idle: "未交接",
  incomplete: "交接缺项",
  needData: "缺换算依据",
  hold: "停待复尺",
  wait: "待复测",
  failed: "复测不合格",
  passed: "复测合格·待校准",
  done: "校准完成",
};

// 索位状态机（始终以最新一条交接记录为准）
export function evaluatePosition(task, ctx) {
  const entries = Array.isArray(task.entries) ? task.entries : [];
  const latest = entries[entries.length - 1] || null;
  if (!latest) return { state: "idle", latest: null, evaluation: null, missing: [] };
  const missing = missingEntryFields(latest);
  const evaluation = evaluateEntry(latest, task, ctx);
  if (missing.length) return { state: "incomplete", latest, evaluation, missing };
  if (!evaluation) return { state: "needData", latest, evaluation: null, missing: [] };
  const rm = latest.remeasure || null;
  if (rm) {
    if (rm.result === "pass") {
      return task.calibratedAt
        ? { state: "done", latest, evaluation, remeasure: rm, missing: [] }
        : { state: "passed", latest, evaluation, remeasure: rm, missing: [] };
    }
    return { state: "failed", latest, evaluation, remeasure: rm, missing: [] };
  }
  return evaluation.overMargin
    ? { state: "hold", latest, evaluation, remeasure: null, missing: [] }
    : { state: "wait", latest, evaluation, remeasure: null, missing: [] };
}

// 交付前逐索位列缺项（返回“索位名称：原因”）
export function deliveryMissing(item) {
  const out = [];
  const tasks = Array.isArray(item.tasks) ? item.tasks : [];
  if (!tasks.length) return ["（本模型尚无索位，请先新增索位并补齐交接记录）"];
  for (const t of tasks) {
    const name = t.position || t.id || "未命名索位";
    const info = evaluatePosition(t, item);
    switch (info.state) {
      case "idle":
        out.push(`${name}：还没有交接记录（下料长度、麻线批号、捻向、接手人）`);
        break;
      case "incomplete":
        out.push(`${name}：交接记录缺项（${info.missing.join("、")}）`);
        break;
      case "needData":
        out.push(`${name}：缺图纸实长或有效比例，无法换算`);
        break;
      case "hold":
        out.push(`${name}：换算长度越过裕量，停待复尺`);
        break;
      case "wait":
        out.push(`${name}：待复测签字`);
        break;
      case "failed":
        out.push(`${name}：复测不合格，需重裁并在原记录续记`);
        break;
      case "passed":
        out.push(`${name}：复测合格，待校准完成`);
        break;
      // done 不产生缺项
    }
  }
  return out;
}

export function deliverySummary(item) {
  const tasks = Array.isArray(item.tasks) ? item.tasks : [];
  const missing = deliveryMissing(item);
  const doneCount = tasks.filter((t) => evaluatePosition(t, item).state === "done").length;
  return { total: tasks.length, doneCount, missing, ready: missing.length === 0 };
}

// 复测结论：实测模型长度与图纸模型长度之差在 ±裕量 内为合格
export function decideRemeasure(measuredModelMm, task, ctx) {
  const designModel = modelLength(task.designLength, ctx.scale);
  const m = Number(measuredModelMm);
  const allowance = Number(ctx.allowanceMm);
  if (designModel === null || !Number.isFinite(allowance) || !Number.isFinite(m) || m <= 0) return null;
  const diff = round2(m - designModel);
  return {
    measuredModelMm: round2(m),
    designModel: round2(designModel),
    diff,
    allowance,
    result: Math.abs(diff) <= allowance ? "pass" : "fail",
  };
}

// 允许续记的状态：封档（复测合格/已校准）后不得再追加
export function canAppend(state) {
  return ["idle", "incomplete", "needData", "hold", "wait", "failed"].includes(state);
}
