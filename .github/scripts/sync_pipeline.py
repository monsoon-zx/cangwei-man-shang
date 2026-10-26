#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
仓位满上 TopUp — 线上数据同步驱动脚本（GitHub Actions 定时任务入口）
=====================================================================

为什么需要这个脚本
------------------
Render 免费实例空闲 15 分钟即休眠，服务端 `node-cron` 因此**不可靠地**触发，
线上 K 线/技术指标会随天数推移越来越旧。必须有外部定时器主动驱动。

为什么不用 `step=full-pipeline`
------------------------------
`full-pipeline` 用**全库** `MAX(trade_date)` 判断 K 线是否新鲜：

    } else if (status.klineLatest !== dayjs().format('YYYYMMDD')) { ... 拉K线 }

只要**任意一只**股票当天被写入，`MAX(trade_date)` 就等于今天，后续调用立刻
转到「指标」分支，剩下的股票再也不会被更新。实测：一次调用处理 9/200 只，
进度 `klineSync=9/200`，而健康接口已经显示 `kline_diff_days=0`（假绿）。

因此本脚本直接驱动**分步接口** `step=kline` / `step=indicators`，它们用
服务端内存里的 offset 指针顺序推进，能真正把一整轮 200 只跑完。

服务端行为约束（读 server.js 确认）
-----------------------------------
- `SYNC_STEP_TIMEOUT = 50000`：单次调用最多跑 50 秒，K线剩 <8s / 指标剩 <5s 即停。
  `batchSize` 只是上限，实际处理量由时间预算决定 → 单次约 45~50s 处理 6~15 只。
- K线股票池 = `stock_pool WHERE in_pool=1`（当前 200 只），**没有参数能指定代码**。
- 进度存在服务端进程内存，实例重启即归零；写入是 `INSERT OR REPLACE`，重跑幂等。
- K线结束日期取服务器当天 → 盘中运行会把盘中价写成当日日线，故定时任务放在收盘后。

用法
----
  python3 sync_pipeline.py                     # 跑 kline + indicators
  python3 sync_pipeline.py --phase kline       # 只跑 K线
  python3 sync_pipeline.py --force             # 跳过交易日判定（手工补数用）

退出码
------
  0 = 正常（含非交易日跳过）
  1 = 同步未完成 / 数据仍然陈旧
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE_URL = os.environ.get("BASE_URL", "https://cangwei-man-shang.onrender.com")
ENDPOINT = BASE_URL.rstrip("/") + "/api/sync/step"
HEALTH = BASE_URL.rstrip("/") + "/api/monitor/health"

# 单次调用实测约 45~50s，HTTP 超时留出余量；重试是必要的——单个请求失败
# 不该让整轮同步前功尽弃。
CALL_TIMEOUT = 120
MAX_RETRY_PER_CALL = 3
RETRY_SLEEP = 8


def bj_now():
    return datetime.now(timezone(timedelta(hours=8)))


def log(msg):
    print(f"[{bj_now().strftime('%H:%M:%S')}] {msg}", flush=True)


def post(payload):
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "sync-pipeline"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=CALL_TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def call_with_retry(payload):
    """带重试的单次调用；全部失败返回 None"""
    last = None
    for attempt in range(1, MAX_RETRY_PER_CALL + 1):
        try:
            return post(payload)
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
        except Exception as e:  # 网络抖动 / 实例冷启动
            last = f"{type(e).__name__}: {e}"
        log(f"  请求失败（{last}），第 {attempt}/{MAX_RETRY_PER_CALL} 次，{RETRY_SLEEP}s 后重试")
        if attempt < MAX_RETRY_PER_CALL:
            time.sleep(RETRY_SLEEP)
    log(f"  ❌ 放弃本次调用：{last}")
    return None


def health():
    req = urllib.request.Request(HEALTH, headers={"User-Agent": "sync-pipeline"})
    with urllib.request.urlopen(req, timeout=CALL_TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def market_quote_date(timeout=25):
    """上证指数行情日期 → 'YYYY-MM-DD'；取不到返回 None

    与 monitor.py 同一判据：节假日腾讯接口回吐上一交易日数据，日期自然不等于今天。
    不依赖任何需要维护的节假日日历。
    """
    try:
        req = urllib.request.Request(
            "http://qt.gtimg.cn/q=sh000001", headers={"User-Agent": "Mozilla/5.0"}
        )
        raw = urllib.request.urlopen(req, timeout=timeout).read().decode("gbk", errors="ignore")
        p = raw.split('"')[1].split("~")
        t = p[30]
        if len(t) >= 8 and t[:8].isdigit():
            return f"{t[:4]}-{t[4:6]}-{t[6:8]}"
    except Exception as e:
        log(f"行情交易日判定不可用: {type(e).__name__}: {e}")
    return None


def is_trading_day():
    """→ (是否交易日, 说明)。判定不确定时按「是」处理，宁可多跑一次也不漏同步。"""
    today = bj_now().date().isoformat()
    qd = market_quote_date()
    if qd is None:
        return True, "行情接口不可用，保守按交易日处理"
    if qd == today:
        return True, f"上证指数行情日期 {qd}"
    return False, f"上证指数行情停在 {qd}，今日非交易日"


def parse_progress(p):
    if not p or "/" not in str(p):
        return None, None
    a, b = str(p).split("/", 1)
    try:
        return int(a), int(b)
    except ValueError:
        return None, None


def run_phase(step, label, batch_size, max_calls, deadline, empty_guard=3):
    """循环驱动一个分步接口直到 done=True。

    返回 (是否完成, 调用次数, 最后响应)
    """
    log(f"===== {label} 阶段开始（batchSize={batch_size}，最多 {max_calls} 次调用）=====")
    prev_off = None
    resets = 0
    empties = 0
    calls = 0
    last_resp = None
    t0 = time.time()

    for i in range(1, max_calls + 1):
        if time.time() > deadline:
            log(f"  ⏰ 已达总时长预算，停止 {label}")
            return False, calls, last_resp

        tick = time.time()
        resp = call_with_retry({"step": step, "batchSize": batch_size})
        if resp is None:
            return False, calls, last_resp

        calls += 1
        last_resp = resp
        elapsed = time.time() - tick
        off, tot = parse_progress(resp.get("progress"))
        done = bool(resp.get("done"))
        processed = resp.get("processed", 0) or 0
        written = resp.get("klineCount", resp.get("indCount", 0)) or 0

        note = ""
        if prev_off is not None and off is not None and off < prev_off:
            resets += 1
            note = f"  ← ⚠ 进度回退（{prev_off}→{off}），服务端进程被重置"
        if off is not None:
            prev_off = off

        log(f"  [{i}] {elapsed:5.1f}s 处理 {processed:>3} 只 | 写入 {written:>6} 行 | "
            f"进度 {resp.get('progress')}"
            f"{' | done ✅' if done else ''}{note}")

        if done:
            log(f"  ✅ {label} 完成：{calls} 次调用，耗时 {time.time() - t0:.0f}s，状态重置 {resets} 次")
            return True, calls, resp

        # 空转保护：连续 N 次一只都没处理且未完成 → 服务端有问题，不要白跑
        if processed == 0:
            empties += 1
            if empties >= empty_guard:
                log(f"  ❌ {label} 连续 {empties} 次空转（processed=0），中止")
                return False, calls, resp
        else:
            empties = 0

    log(f"  ⚠ {label} 达到调用上限 {max_calls} 仍未完成")
    return False, calls, last_resp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", choices=["all", "kline", "indicators"], default="all")
    ap.add_argument("--batch-size", type=int, default=10,
                    help="单次调用批上限（实际由服务端 50s 时间预算决定）")
    ap.add_argument("--max-calls-kline", type=int, default=40)
    ap.add_argument("--max-calls-indicators", type=int, default=40)
    ap.add_argument("--deadline-min", type=int, default=45, help="整体时长预算（分钟）")
    ap.add_argument("--force", action="store_true", help="跳过交易日判定")
    args = ap.parse_args()

    deadline = time.time() + args.deadline_min * 60

    if not args.force:
        trading, why = is_trading_day()
        log(f"交易日判定: {'是' if trading else '否'}（{why}）")
        if not trading:
            log("非交易日，跳过同步")
            return 0

    results = {}
    if args.phase in ("all", "kline"):
        ok, calls, last = run_phase("kline", "K线", args.batch_size,
                                    args.max_calls_kline, deadline)
        results["kline"] = ok
        if not ok:
            # K线没跑完就没必要算指标（指标依赖 K线），直接失败上报
            log("❌ K线阶段未完成，跳过指标阶段")
            return 1

    if args.phase in ("all", "indicators"):
        ok, calls, last = run_phase("indicators", "技术指标", args.batch_size,
                                    args.max_calls_indicators, deadline)
        results["indicators"] = ok
        if not ok:
            log("❌ 指标阶段未完成")
            return 1

    # 收尾验收：只认服务端新鲜度，不认「本地觉得跑完了」
    try:
        h = health()
    except Exception as e:
        log(f"❌ 健康接口不可用，无法验收：{type(e).__name__}: {e}")
        return 1

    f = h.get("freshness", {})
    log("健康快照: " + json.dumps(
        {k: f.get(k) for k in ("kline_latest", "score_latest", "expected",
                               "kline_diff_days", "score_diff_days")},
        ensure_ascii=False))
    log("DB: " + json.dumps(h.get("db", {}), ensure_ascii=False))

    kd = f.get("kline_diff_days")
    if kd is None:
        log("❌ K线最新日期为空")
        return 1
    if kd > 0:
        log(f"❌ 同步跑完但 K线仍落后 {kd} 天（最新 {f.get('kline_latest')}）")
        return 1

    log("✅ 同步完成，K线已到最新交易日")
    return 0


if __name__ == "__main__":
    sys.exit(main())
