#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
仓位满上 TopUp 线上监控检查脚本（GitHub Actions 每小时触发）

检查维度：
1. 服务可用性  - /api/version 是否可响应（冷启动重试 3 次）
2. 数据新鲜度  - K线/评分最新日期 vs 期望交易日（同步窗口内、非交易日跳过）
3. 数据完整性  - pool/klines/indicators/finance 数量是否在合理区间
4. 信号合理性  - 最新评分信号分布是否异常（全部 sell）

报警方式：发现问题时用 gh 创建 GitHub Issue（标题固定去重，已有 open Issue 则跳过）

交易日感知（2026-10-08 修复）
  原逻辑用「最近工作日 Mon–Fri」推期望日期，不认中国法定节假日。长假期间 K线停在节前
  最后一个交易日不动，期望日期却一天天往前推，越过 FRESHNESS_ALERT_DAYS 后每小时误报，
  导致 workflow 连续 12+ 次变红（issue #4 就是国庆期间留下的）。
  现改为：判定当天非交易日则整体跳过新鲜度检查。判定优先级：
    ① 周末 → 非交易日
    ② 上证指数实时行情的时间戳（qt.gtimg.cn）→ 市场自己给的答案，最权威
    ③ 都拿不到时回退到 CN_HOLIDAYS 表；仍不确定则按交易日处理但只告警不染红
"""

import datetime
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

BASE_URL = os.environ.get("BASE_URL", "https://cangwei-man-shang.onrender.com")
ISSUE_TITLE = "[监控] 线上健康异常"

# ---- 阈值（按需调整） ----
FRESHNESS_ALERT_DAYS = 3    # 数据落后 >=3 自然日告警（周末 2 天 + 1 缓冲）
MIN_POOL = 100              # 股票池少于 100 只告警（正常 200）
MIN_KLINES = 10000          # K线少于 1 万条告警（正常 ~12.4 万）
SYNC_WINDOW_START = "15:30"  # 北京时间收盘同步窗口，窗口内跳过新鲜度检查
SYNC_WINDOW_END = "18:00"
COVERAGE_SAMPLES = 8        # 覆盖度抽样只数
COVERAGE_BAD_RATIO = 0.4    # 抽样中落后于全库最新日期的比例超过此值 → 判为覆盖不足
# -------------------------

# A股法定休市日（备用判据；主判据是上证指数行情时间戳，故本表只在下述情况生效：
# 行情接口不可达。每年年初需按国务院放假安排更新一次）
CN_HOLIDAYS = {
    # 2026 中秋 / 国庆（已由 2026-10 数据污染事故实际确认）
    "2026-09-25",
    "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
}

# 只有这些是真故障、值得把 workflow 染红；数据陈旧属于「要人看」而不是「服务挂了」
FATAL_PROBLEMS = {"服务不可用", "监控接口异常"}


def beijing_now():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))


def in_sync_window():
    now = beijing_now()
    t = now.strftime("%H:%M")
    return SYNC_WINDOW_START <= t <= SYNC_WINDOW_END


def market_quote_date(timeout=20):
    """上证指数的行情日期（腾讯接口 p[30] 时间戳）→ 'YYYY-MM-DD'；取不到返回 None

    这是判断「今天是不是交易日」最权威也最省事的办法：直接问市场本身。
    节假日接口会回吐上一个交易日的数据，日期自然不等于今天。
    """
    try:
        req = urllib.request.Request("http://qt.gtimg.cn/q=sh000001",
                                     headers={"User-Agent": "Mozilla/5.0"})
        raw = urllib.request.urlopen(req, timeout=timeout).read().decode("gbk", errors="ignore")
        p = raw.split('"')[1].split("~")
        t = p[30]
        if len(t) >= 8 and t[:8].isdigit():
            return f"{t[:4]}-{t[4:6]}-{t[6:8]}"
    except Exception as e:
        print(f"ℹ️ 行情交易日判定不可用: {type(e).__name__}: {e}")
    return None


def trading_day_status(now):
    """→ (是否交易日, 判定是否确定, 依据说明)

    confirmed=False 表示没拿到市场数据、只能保守假设是交易日，此时新鲜度告警降级为
    非致命（只写 Issue 不染红），避免误报。
    """
    d = now.date().isoformat()
    if now.weekday() >= 5:
        return False, True, "周末"
    if d in CN_HOLIDAYS:
        return False, True, "法定节假日（CN_HOLIDAYS）"
    qd = market_quote_date()
    if qd is None:
        return True, False, "行情接口不可用，保守按交易日处理"
    if qd == d:
        return True, True, f"上证指数行情日期 {qd}"
    return False, True, f"上证指数行情停在 {qd}，今日未开盘"


def http_json(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "monitor"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode())


def fetch_version():
    """服务可用性检查：冷启动可能较慢，重试 3 次"""
    last_err = None
    for i in range(3):
        try:
            status, data = http_json(f"{BASE_URL}/api/version", timeout=120)
            if status == 200 and data.get("version"):
                return True, data.get("version")
            last_err = f"HTTP {status}"
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
    return False, last_err


def fetch_health():
    status, data = http_json(f"{BASE_URL}/api/monitor/health", timeout=120)
    return data


def _norm_date(d):
    """'20261026' 或 '2026-10-26' → '20261026'，便于跨格式比较"""
    return str(d).replace("-", "") if d else None


def kline_coverage_probe(global_latest):
    """抽样池内个股，检查各自最新 K 线日期是否等于全库最新日期。

    为什么需要这一步：/api/monitor/health 的新鲜度用**全库** `MAX(trade_date)`
    判断，只要**任意一只**股票被写入，全局就显示「新鲜」。实测 full-pipeline
    一轮只推进 9/200 只（服务端用全局 MAX 判断，第一只写进去后就转去算指标），
    此时监控全绿而 191 只个股仍是几天前的数据——这就是历史「假绿」的来源。

    抽样对比可以直接识别「只有少数股票被更新」。判据不依赖交易日历：不比对
    「今天」，只比对「全库最领先的那只」，所以周末/长假都不会误报。

    返回 (样本数, 落后样本 [(code, latest), ...])
    """
    try:
        _, data = http_json(f"{BASE_URL}/api/stock-pool", timeout=120)
    except Exception as e:
        print(f"ℹ️ 覆盖度抽样跳过（股票池接口不可用: {type(e).__name__}）")
        return 0, []

    codes = sorted({s.get("code") for s in data.get("stocks", []) if s.get("code")})
    if not codes:
        return 0, []

    step = max(1, len(codes) // COVERAGE_SAMPLES)
    sample = codes[::step][:COVERAGE_SAMPLES]

    target = _norm_date(global_latest)
    stale = []
    for code in sample:
        try:
            _, d = http_json(f"{BASE_URL}/api/stocks/{code}", timeout=90)
            ks = d.get("klines") or []
            latest = _norm_date(ks[-1].get("date")) if ks else None
            if latest and latest != target:
                stale.append((code, ks[-1].get("date")))
        except Exception as e:
            print(f"ℹ️ 覆盖度抽样 {code} 失败: {type(e).__name__}")
    return len(sample), stale


def run_gh(args):
    """执行 gh 命令；gh 不可用（本地/CI 异常）时降级为警告，不崩溃"""
    try:
        return subprocess.run(["gh"] + args, capture_output=True, text=True)
    except FileNotFoundError:
        print("⚠️ gh CLI 不可用，跳过 Issue 操作")
        return None


def open_issue_exists():
    r = run_gh(["issue", "list", "--state", "open", "--search", f'"{ISSUE_TITLE}"', "--limit", "10"])
    if r is None:
        return False
    if r.returncode != 0:
        print(f"⚠️ 查询 Issue 失败: {r.stderr.strip()}")
        return False
    return ISSUE_TITLE in r.stdout


def create_issue(body):
    with open("/tmp/monitor_issue_body.md", "w", encoding="utf-8") as f:
        f.write(body)
    r = run_gh(["issue", "create", "--title", ISSUE_TITLE, "--body-file", "/tmp/monitor_issue_body.md"])
    if r is None:
        return
    if r.returncode == 0:
        print(f"✅ 已创建 Issue: {r.stdout.strip()}")
    else:
        print(f"❌ 创建 Issue 失败: {r.stderr.strip()}")


def build_body(problems, health, version, checked_at):
    lines = [f"## ⚠️ 线上服务健康异常", "", f"**检查时间**: {checked_at} (北京时间)", f"**服务版本**: {version}", ""]
    lines.append("### 发现问题")
    for i, p in enumerate(problems, 1):
        lines.append(f"{i}. **{p[0]}** — {p[1]}")
    lines.append("")
    lines.append("### 健康快照")
    db = health.get("db", {})
    f = health.get("freshness", {})
    s = health.get("signals", {})
    lines.append("| 指标 | 值 |")
    lines.append("|---|---|")
    rows = [
        ("pool 股票池", db.get("pool")), ("stock_info", db.get("stocks")),
        ("daily_kline", db.get("klines")), ("indicators", db.get("indicators")),
        ("scores", db.get("scores")),
        ("finance", db.get("finance")),
        ("K线最新日期", f.get("kline_latest")), ("评分最新日期", f.get("score_latest")),
        ("期望日期", f.get("expected")),
        ("信号分布", f"buy {s.get('buy')} / watch {s.get('watch')} / hold {s.get('hold')} / sell {s.get('sell')} / total {s.get('total')}"),
        ("同步状态", health.get("sync", {}).get("running")),
    ]
    for k, v in rows:
        lines.append(f"| {k} | {v} |")
    lines.append("")
    lines.append("---")
    lines.append("_此 Issue 由监控任务每小时自动检查创建，修复后请手动关闭；持续异常时不会重复创建。_")
    return "\n".join(lines)


def main():
    checked_at = beijing_now().strftime("%Y-%m-%d %H:%M")
    problems = []
    version = "unknown"
    trading = True          # 供退出码判断：非交易日的数据陈旧不算故障
    trading_confirmed = True

    # 1. 服务可用性
    ok, info = fetch_version()
    if ok:
        version = info
        print(f"✅ 服务可用, version={version}")
    else:
        problems.append(("服务不可用", f"/api/version 连续 3 次检查失败 ({info})"))
        print(f"❌ 服务不可用: {info}")

    # 2. 健康接口（服务不可用时也要尝试，可能只是 version 接口抖动）
    try:
        health = fetch_health()
    except Exception as e:
        health = None
        problems.append(("监控接口异常", f"/api/monitor/health 调用失败 ({type(e).__name__}: {e})"))
        print(f"❌ 监控接口异常: {e}")

    if health:
        db = health.get("db", {})
        f = health.get("freshness", {})
        s = health.get("signals", {})

        # 3. 数据新鲜度（同步窗口内、非交易日跳过，避免长假误报）
        trading, trading_confirmed, why = trading_day_status(beijing_now())
        print(f"ℹ️ 交易日判定: {'是' if trading else '否'}（{why}）"
              f"{'' if trading_confirmed else ' [判定不确定]'}")
        if in_sync_window():
            print("ℹ️ 同步窗口内，跳过新鲜度检查")
        elif not trading:
            print(f"ℹ️ 非交易日（{why}），跳过新鲜度检查")
        else:
            for name, diff, latest in (("K线", f.get("kline_diff_days"), f.get("kline_latest")),
                                       ("评分", f.get("score_diff_days"), f.get("score_latest"))):
                if diff is None:
                    problems.append((f"{name}数据缺失", "最新日期为空（表无数据）"))
                elif diff >= FRESHNESS_ALERT_DAYS:
                    problems.append((f"{name}数据过期", f"最新 {latest}，期望 {f.get('expected')}，落后 {diff} 天"))
            print(f"ℹ️ 新鲜度: K线 {f.get('kline_diff_days')}天 / 评分 {f.get('score_diff_days')}天")

        # 3b. 覆盖度抽样：全库 MAX(trade_date) 新鲜 ≠ 个股都新鲜（见 kline_coverage_probe）
        #     仅在「全库已判定新鲜」时才有假绿风险；全库陈旧时上面的数据过期已覆盖。
        if trading and trading_confirmed and not in_sync_window() \
                and f.get("kline_diff_days") == 0:
            n, stale = kline_coverage_probe(f.get("kline_latest"))
            if n:
                print(f"ℹ️ 覆盖度抽样: {n} 只中 {len(stale)} 只落后于全库最新 {f.get('kline_latest')}")
                if len(stale) / n > COVERAGE_BAD_RATIO:
                    eg = ", ".join(f"{c}({d})" for c, d in stale[:3])
                    problems.append(("K线覆盖不足",
                                     f"抽样 {n} 只中 {len(stale)} 只落后于全库最新 "
                                     f"{f.get('kline_latest')}，示例 {eg}"))

        # 4. 数据完整性
        if db.get("pool", 0) < MIN_POOL:
            problems.append(("股票池不足", f"pool={db.get('pool')}（阈值 {MIN_POOL}）"))
        if db.get("klines", 0) < MIN_KLINES:
            problems.append(("K线数据量异常", f"klines={db.get('klines')}（阈值 {MIN_KLINES}）"))
        for name, key in (("指标", "indicators"), ("财务", "finance")):
            if db.get(key, 0) == 0:
                problems.append((f"{name}数据为空", f"{key}=0"))

        # 5. 信号合理性（覆盖不足 / 全部 sell）
        total = s.get("total", 0)
        if total < 50:
            problems.append(("评分覆盖不足", f"最新评分 {total} 只（期望 ≥50）"))
        elif s.get("buy", 0) + s.get("watch", 0) + s.get("hold", 0) == 0:
            problems.append(("信号分布异常", f"全部为 sell（buy/watch/hold 均为 0，total={total}）"))
        print(f"ℹ️ 信号: {s}")

        # 打印快照
        print(f"ℹ️ DB: pool={db.get('pool')} klines={db.get('klines')} indicators={db.get('indicators')} "
              f"scores={db.get('scores')} finance={db.get('finance')}")
        print(f"ℹ️ 同步: {health.get('sync')}")

    # 6. 报警
    if problems:
        print(f"⚠️ 发现 {len(problems)} 个问题，尝试创建 Issue...")
        if not open_issue_exists():
            create_issue(build_body(problems, health or {}, version, checked_at))
        else:
            print("ℹ️ 已存在相同标题的 open Issue，跳过（避免刷屏）")
        # 染红与否：只有真故障才让 workflow 失败。数据陈旧走 Issue 通道即可——
        # 原先把一切都 exit(1)，导致长假期间每小时变红，报警疲劳后真故障也会被忽略。
        # 交易日判定不确定时（行情接口不可达）从宽处理，不因判定失败而误报红色。
        fatal = [p for p in problems if p[0] in FATAL_PROBLEMS]
        if not fatal:
            # 「数据过期」与「覆盖不足」都是确凿的同步故障：前者是全库没跟上，
            # 后者是全库看着新鲜但个股大面积没跟上（假绿），两者都值得染红。
            fatal = [p for p in problems if trading and trading_confirmed
                     and ("数据过期" in p[0] or p[0] == "K线覆盖不足")]
        if fatal:
            print(f"❌ 致命问题 {len(fatal)} 个，workflow 标记失败: {[p[0] for p in fatal]}")
            sys.exit(1)
        print("⚠️ 仅非致命问题（已建 Issue），workflow 保持成功，避免报警疲劳")
        sys.exit(0)
    else:
        print("✅ 全部健康")
        sys.exit(0)


if __name__ == "__main__":
    main()
