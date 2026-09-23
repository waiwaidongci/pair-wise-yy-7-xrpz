import assert from "node:assert/strict";
import {
  scaleDenominator,
  modelLength,
  evaluateEntry,
  missingEntryFields,
  evaluatePosition,
  deliveryMissing,
  decideRemeasure,
  canAppend,
} from "../rules.js";

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log("✓", name);
};

test("比例解析", () => {
  assert.equal(scaleDenominator("1:48"), 48);
  assert.equal(scaleDenominator("1：75"), 75);
  assert.equal(scaleDenominator("48"), null);
  assert.equal(scaleDenominator("1:0"), null);
});

test("模型换算", () => {
  assert.equal(modelLength(9600, "1:48"), 200);
  assert.equal(modelLength(9600, "比例未定"), null);
});

test("换算越过裕量判定（仅加长方向严格越限）", () => {
  const ctx = { scale: "1:48", allowanceMm: 3 };
  const task = { designLength: 9600 };
  const atLimit = evaluateEntry({ cutLength: 9744 }, task, ctx); // 203mm = 上限
  assert.equal(atLimit.overMargin, false);
  const over = evaluateEntry({ cutLength: 9792 }, task, ctx); // 204mm
  assert.equal(over.overMargin, true);
  const under = evaluateEntry({ cutLength: 9456 }, task, ctx); // 197mm
  assert.equal(under.overMargin, false);
});

test("交接四项必填校验", () => {
  assert.deepEqual(missingEntryFields({}), ["下料长度", "麻线批号", "捻向", "接手人"]);
  assert.deepEqual(missingEntryFields({ cutLength: 9792, batch: "MX-2407", twist: "Z", receiver: "郑铎" }), []);
  assert.ok(missingEntryFields({ cutLength: -1, batch: "b", twist: "Z", receiver: "r" }).includes("下料长度"));
});

test("索位状态：缺项 / 停待复尺 / 待复测", () => {
  const ctx = { scale: "1:48", allowanceMm: 3 };
  const task = { position: "前桅侧支索", designLength: 9600 };
  assert.equal(evaluatePosition(task, ctx).state, "idle");
  task.entries = [{ cutLength: 9600, batch: "MX-2407", twist: "Z", receiver: "郑铎" }];
  assert.equal(evaluatePosition(task, ctx).state, "wait");
  task.entries[0].cutLength = 9792;
  assert.equal(evaluatePosition(task, ctx).state, "hold");
  task.entries[0].cutLength = 9600;
  task.entries[0].batch = "";
  assert.equal(evaluatePosition(task, ctx).state, "incomplete");
});

test("复测签字后保留在履历，合格→待校准→完成；不合格可续记", () => {
  const ctx = { scale: "1:48", allowanceMm: 3 };
  const task = { position: "前桅侧支索", designLength: 9600 };
  const e = { cutLength: 9600, batch: "MX-2407", twist: "Z", receiver: "郑铎", tensionReading: "42cN", handedBy: "周宁" };
  task.entries = [e];
  e.remeasure = decideRemeasure(202, task, ctx);
  assert.equal(e.remeasure.result, "pass");
  const passed = evaluatePosition(task, ctx);
  assert.equal(passed.state, "passed");
  assert.equal(passed.latest.remeasure.measuredModelMm, 202);
  task.calibratedAt = "t";
  assert.equal(evaluatePosition(task, ctx).state, "done");
  delete task.calibratedAt;
  e.remeasure = decideRemeasure(205, task, ctx);
  assert.equal(e.remeasure.result, "fail");
  assert.equal(evaluatePosition(task, ctx).state, "failed");
  assert.ok(canAppend("failed"));
  assert.ok(!canAppend("passed"));
  assert.ok(!canAppend("done"));
  // 前一位师傅的张力读数仍保留在履历中
  assert.equal(task.entries[0].tensionReading, "42cN");
});

test("新班次续记后状态以最新一条为准，历史记录保留", () => {
  const ctx = { scale: "1:48", allowanceMm: 3 };
  const task = {
    position: "前桅侧支索",
    designLength: 9600,
    entries: [
      { cutLength: 9792, batch: "MX-2407", twist: "Z", receiver: "郑铎", tensionReading: "42cN" },
      { cutLength: 9600, batch: "MX-2408", twist: "Z", receiver: "郑铎" },
    ],
  };
  const info = evaluatePosition(task, ctx);
  assert.equal(info.state, "wait");
  assert.equal(task.entries.length, 2);
  assert.equal(task.entries[0].tensionReading, "42cN");
});

test("交付确认：有缺项列出索位名称，全部完成才 ready", () => {
  const ctx = { scale: "1:48", allowanceMm: 3 };
  const item = {
    scale: "1:48",
    allowanceMm: 3,
    tasks: [
      {
        position: "前桅侧支索",
        designLength: 9600,
        entries: [{ cutLength: 9600, batch: "MX-2407", twist: "Z", receiver: "郑铎", remeasure: decideRemeasure(201, { designLength: 9600 }, ctx) }],
        calibratedAt: "t",
      },
      { position: "主桅侧支索", designLength: 12000, entries: [] },
    ],
  };
  const missing = deliveryMissing(item);
  assert.equal(missing.length, 1);
  assert.ok(missing[0].startsWith("主桅侧支索："));
  const allDone = item;
  allDone.tasks[1].entries = [{ cutLength: 12000, batch: "MX-2409", twist: "S", receiver: "冯远", remeasure: decideRemeasure(250, { designLength: 12000 }, ctx) }];
  allDone.tasks[1].calibratedAt = "t";
  assert.deepEqual(deliveryMissing(allDone), []);
});

test("无索位时不给交付确认", () => {
  const item = { scale: "1:48", allowanceMm: 3, tasks: [] };
  const missing = deliveryMissing(item);
  assert.equal(missing.length, 1);
});

console.log(`\n${passed} 个测试全部通过`);
