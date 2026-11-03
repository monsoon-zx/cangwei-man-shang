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

巡检频率（2026-11-03 v1.9.6）
  workflow 本身仍是每小时触发，但脚本内部按 REPORT_INTERVAL_HOURS（12 小时）节流：
  只有距上次巡检满 12 小时才做完整的健康巡检 + Issue 判定/关闭；其余触发只跑
  「自愈补 K 线」（静默，零噪音）。**发现异常则改为 1 小时复查**，好在修好后尽快
  自动关闭遗留 Issue。为什么不用固定小时、状态存在哪，见该常量处注释。

Issue 生命周期（2026-10-28 修复）
  原逻辑只会「建 Issue」，从不关闭。9-28 那个 Issue 一直挂着，导致之后**所有新异常
  都不再建 Issue**（标题去重命中），报警内容彻底丢失，只能靠 workflow 红叉猜。
  现改为：检查全项健康时自动 close 遗留的同标题 open Issue 并留评论。

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
import time
import urllib.error
import urllib.request

BASE_URL = os.environ.get("BASE_URL", "https://cangwei-man-shang.onrender.com")
ISSUE_TITLE = "[监控] 线上健康异常"

# ---- 阈值（按需调整） ----
FRESHNESS_ALERT_DAYS = 7    # 数据落后 >=7 自然日才在日志里标警示（A股一周5个交易日，
                            # 原 3 天遇到「周五数据 + 周末 2 天」就会命中，过紧）
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

# ---- 自愈同步（2026-11-03 新增，代替从未入库的 sync.yml） ----
# 为什么放在 monitor.py 而不是独立 workflow：
#   .github/workflows/sync.yml 因 PAT 缺 workflow scope 一直无法推送（API 返回 404），
#   Render 免费实例的 node-cron 又随休眠失效（crowding 停更 66 天为证）。而
#   monitor.py 在 .github/scripts/ 下、属普通文件，可正常更新，且 monitor.yml
#   已经每小时触发它 —— 直接复用这条已验证可靠的调度。
AUTOSYNC_START = "15:05"     # 北京，15:00 收盘后留 5 分钟给数据落定
AUTOSYNC_END = "22:00"       # 超过此点不补当天，避免把隔夜数据算错
AUTOSYNC_BUDGET_MIN = 30     # 单轮总时长预算（Actions job 默认 360 分钟，留足余量）
AUTOSYNC_DISABLE = os.environ.get("AUTOSYNC_DISABLE") == "1"

# ---- 巡检节流（2026-11-03，v1.9.6）----
# 用户要求「每 12 小时跑一次」。但 monitor.yml 在 .github/workflows/ 下，当前 PAT
# 只有 `repo` scope、推不动 workflow 文件（API 返回 404），所以改在脚本内部节流。
# 两条通道分开处理，各取所需：
#   · 自愈同步（补 K 线）→ **每次触发都尝试**。它只写 Actions 日志、不建 Issue、不染红，
#     零噪音；而补数越早越好、窗口内多重试几次成功率明显更高。压到 12 小时反而
#     会让「补失败 → 等次日」成为单点故障。
#   · 健康巡检 + Issue 判定/关闭 → 距上次巡检满 12 小时才做。
# 代价（已告知用户）：服务挂掉的发现延迟从 1 小时延长到最长 12 小时。
#
# 为什么用「时间间隔 + 心跳」而不是「固定小时」：
#   实测这个公开仓库的 schedule 被 GitHub 严重限流 —— 最近 12 次运行实际发生在
#   03:50Z / 22:35Z / 13:06Z / 04:36Z …（约 4~7 小时一次，且整点漂移 30~60 分钟）。
#   写死「只在北京 04/16 点跑」会因漂移整点错过，导致一整天都不巡检。
#   改为记录「上次巡检时间」再算间隔，调度怎么漂都能精确 12 小时一次。
# 状态存哪：workflow 只给了 `issues: write` 权限（推不动文件、也不能提交状态文件），
#   所以用一个专用心跳 Issue 存时间戳，写完立刻自动关闭，不在 open 列表里碍眼。
REPORT_INTERVAL_HOURS = 12
REPORT_RETRY_HOURS = 1      # 本轮有异常（Issue 已存在或数据未补齐）时改为 1 小时复查：
                            # 复查不会产生新噪音（标题去重），但能让「修好了」尽快自动关 Issue，
                            # 而不是让 #7 在 open 里挂到下一个 12 小时窗口。
HEARTBEAT_TITLE = "[监控] 巡检心跳（自动生成，勿删）"


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


def post_json(path, payload, timeout=120):
    req = urllib.request.Request(
        BASE_URL.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "monitor-autosync"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode())


def parse_progress(p):
    """'12/200' → (12, 200)；格式不符返回 (None, None)"""
    if not p or "/" not in str(p):
        return None, None
    a, b = str(p).split("/", 1)
    try:
        return int(a), int(b)
    except ValueError:
        return None, None


def autoheal_kline_sync(health):
    """K 线落后时主动驱动服务端 step=kline，直到一轮跑完或超预算。

    为什么必须由外部驱动：`step=full-pipeline` 用**全库** MAX(trade_date) 判新鲜，
    只要一只股票写入就转去算指标，实测一轮只推进 9/200 只（假绿）。分步接口
    `step=kline` 用服务端内存 offset 顺序推进，才能把整轮跑完。

    约束：单次调用服务端最多跑 50 秒，实际由时间预算决定处理量，约 6~15 只/次。

    返回三态，用于决定要不要把 workflow 染红：
      "ok"   = 真的驱动过且复查已新鲜
      "fail" = 真的驱动过但复查仍落后（需要人工介入）
      None   = 没有尝试（不落后 / 不在时段 / 非交易日 / 别的任务在跑 / 已禁用）
    """
    if AUTOSYNC_DISABLE or not health:
        return None

    f = health.get("freshness", {}) or {}
    diff = f.get("kline_diff_days")
    if diff is None or diff < 1:
        return None

    now = beijing_now()
    t = now.strftime("%H:%M")
    if not (AUTOSYNC_START <= t <= AUTOSYNC_END):
        print(f"ℹ️ K线落后 {diff} 天，但 {t} 不在自愈时段 {AUTOSYNC_START}~{AUTOSYNC_END}，跳过")
        return None

    trading, _confirmed, why = trading_day_status(now)
    if not trading:
        print(f"ℹ️ 非交易日（{why}），不触发自愈")
        return None

    # 防并发：上一轮还没跑完（服务端 offset 非 idle）时不要插手。
    # 自愈最长 30 分钟，可能跨过整点与下一次定时触发重叠；两边同时驱动
    # 同一份内存 offset 虽然幂等但会重复拉取，先让在跑的那一轮跑完。
    sc = (health.get("sync") or {}).get("kline")
    if sc and sc != "idle":
        print(f"ℹ️ 服务端 K 线同步进行中（{sc}），跳过自愈避免并发")
        return None

    print(f"🔧 K线落后 {diff} 天（最新 {f.get('kline_latest')}，期望 {f.get('expected')}），"
          f"开始自愈同步，预算 {AUTOSYNC_BUDGET_MIN} 分钟")
    deadline = time.time() + AUTOSYNC_BUDGET_MIN * 60
    calls = 0
    prev_off = None
    empties = 0

    while time.time() < deadline:
        try:
            _, resp = post_json("/api/sync/step", {"step": "kline", "batchSize": 10})
        except Exception as e:
            print(f"  自愈调用失败: {type(e).__name__}: {e}")
            empties += 1
            if empties >= 3:
                print("  ❌ 连续 3 次调用失败，中止自愈")
                break
            time.sleep(8)
            continue

        calls += 1
        done = bool(resp.get("done"))
        processed = resp.get("processed", 0) or 0
        written = resp.get("klineCount", 0) or 0
        off, _tot = parse_progress(resp.get("progress"))
        note = ""
        if off is not None and prev_off is not None and off < prev_off:
            note = f"  ← ⚠ 进度回退 {prev_off}→{off}（实例重启）"
        if off is not None:
            prev_off = off
        print(f"  [{calls}] 处理 {processed:>3} 只 | 写入 {written:>5} 行 | "
              f"进度 {resp.get('progress')}{' | done ✅' if done else ''}{note}")

        if done:
            break
        if processed == 0:
            empties += 1
            if empties >= 3:
                print("  ❌ 连续 3 次空转（processed=0），中止自愈")
                break
        else:
            empties = 0

    if calls == 0:
        # 一次都没成功调用：可能是接口异常/网络问题，也可能是时间预算一开始就耗尽。
        # 前者算「尝试过但没成」，交给外层按同步故障处理；后者只是没轮到，不算失败。
        return "fail" if empties else None

    try:
        after = fetch_health()
    except Exception as e:
        print(f"  ⚠️ 自愈后复查失败: {type(e).__name__}: {e}")
        return "fail"
    nd = after.get("freshness", {}).get("kline_diff_days")
    print(f"🔧 自愈结束：{calls} 次调用，K线落后 {diff} → {nd} 天")
    return "ok" if nd == 0 else "fail"


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


def list_issues(state="open"):
    """列出 Issue（number/title）→ list；失败返回 None

    不用 `--search`：中文标题经 GitHub 全文检索分词后可能命中不了，
    后果一个是该关的报警关不掉、另一个更糟 —— `open_issue_exists()` 判成不存在，
    每次巡检都重复建 Issue 刷屏。本仓库 Issue 总量个位数，直接列全量再精确匹配最稳。
    """
    r = run_gh(["issue", "list", "--state", state, "--limit", "100", "--json", "number,title,body"])
    if r is None:
        return None
    if r.returncode != 0:
        print(f"⚠️ 查询 Issue 失败: {r.stderr.strip()}")
        return None
    try:
        return json.loads(r.stdout or "[]")
    except ValueError:
        print("⚠️ Issue 列表解析失败")
        return None


def open_issue_exists():
    items = list_issues("open")
    if items is None:
        return False        # 查不到就当不存在：多建一次报警好过漏报
    return any(it.get("title") == ISSUE_TITLE for it in items)


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


def close_stale_issue():
    """全项健康时关闭遗留的 open Issue

    不关的后果：`open_issue_exists()` 命中旧 Issue → 后续异常不再建 Issue →
    报警内容全部丢失，只剩一个无信息量的红叉。
    """
    items = list_issues("open")
    if items is None:
        return
    closed = 0
    for it in items:
        if it.get("title") != ISSUE_TITLE:
            continue
        num = it.get("number")
        cr = run_gh(["issue", "close", str(num), "--comment",
                     f"✅ 监控已恢复：{beijing_now().strftime('%Y-%m-%d %H:%M')} "
                     f"(北京时间) 全项健康，由监控任务自动关闭。"])
        if cr is not None and cr.returncode == 0:
            print(f"✅ 已自动关闭遗留 Issue #{num}")
            closed += 1
        elif cr is not None:
            print(f"❌ 关闭 Issue #{num} 失败: {cr.stderr.strip()}")
    if closed == 0:
        print("ℹ️ 无遗留 open Issue 需要关闭")


def read_heartbeat():
    """读巡检心跳 → (issue_number, 上次巡检 datetime|None, 下次应检 datetime|None)

    任何读取失败都返回 (None, None, None)，调用方据此按「已到期」处理：
    宁可多巡检一次，也不能因为状态读不到而永久失明。
    """
    items = list_issues("all")
    if items is None:
        return None, None, None
    for it in items:
        if it.get("title") != HEARTBEAT_TITLE:
            continue
        num = it.get("number")
        last = nxt = None
        for line in (it.get("body") or "").splitlines():
            line = line.strip()
            for prefix, setter in (("最后巡检:", "last"), ("下次应检:", "next")):
                if not line.startswith(prefix):
                    continue
                try:
                    val = datetime.datetime.fromisoformat(line.split(":", 1)[1].strip())
                except ValueError:
                    continue
                if setter == "last":
                    last = val
                else:
                    nxt = val
        return num, last, nxt
    return None, None, None


def write_heartbeat(num, dt, next_due):
    """记录本次巡检时间与下次应检时间。首次没有心跳 Issue 时新建并立即关闭（不占 open 列表）"""
    body = (f"最后巡检: {dt.isoformat()}\n"
            f"下次应检: {next_due.isoformat()}\n\n"
            "> 本 Issue 由监控任务自动维护，仅用于记录巡检节流状态："
            f"常规每 {REPORT_INTERVAL_HOURS} 小时巡检一次，"
            f"发现异常后每 {REPORT_RETRY_HOURS} 小时复查一次。\n"
            "> 删除或改写不会造成故障，只会让下一次巡检提前。\n")
    if num:
        r = run_gh(["issue", "edit", str(num), "--body", body])
        if r is not None and r.returncode == 0:
            print(f"✅ 巡检心跳已更新（Issue #{num}）")
        elif r is not None:
            print(f"⚠️ 巡检心跳更新失败: {r.stderr.strip()}")
        return
    r = run_gh(["issue", "create", "--title", HEARTBEAT_TITLE, "--body", body])
    if r is None or r.returncode != 0:
        print(f"⚠️ 巡检心跳创建失败: {'gh 不可用' if r is None else r.stderr.strip()}")
        return
    url = (r.stdout or "").strip()
    print(f"✅ 巡检心跳已创建: {url}")
    created = url.rstrip("/").split("/")[-1]
    if created.isdigit():
        cr = run_gh(["issue", "close", created, "--comment",
                     "巡检心跳记录，自动关闭以免占用 open 列表。"])
        if cr is not None and cr.returncode == 0:
            print(f"✅ 巡检心跳 Issue #{created} 已自动关闭")


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
    lines.append("_此 Issue 由监控任务自动巡检创建（每 12 小时，北京 04:00 / 16:00），修复后请手动关闭；持续异常时不会重复创建。_")
    return "\n".join(lines)


def main():
    checked_at = beijing_now().strftime("%Y-%m-%d %H:%M")
    problems = []
    version = "unknown"
    trading = True          # 供退出码判断：非交易日的数据陈旧不算故障
    trading_confirmed = True
    heal = None             # 自愈三态：None=未尝试 / "ok" / "fail"
    heal_failed = False     # 自愈尝试过但没补上（按配置只留日志，不报警）
    stale_notes = []        # 数据新鲜度备注：不进 problems（不建 Issue），但阻止误报「全健康」

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

        # 2b. 自愈：K线落后则先尝试主动补数，再用复查后的快照做告警判定。
        #     补成功就不该再报「数据过期」，遗留 Issue 也会在末尾自动关闭。
        heal = autoheal_kline_sync(health)
        heal_failed = (heal == "fail")
        if heal_failed:
            print("⚠️ 自愈未能把 K 线补到最新（按配置不建 Issue、不染红，此处仅留日志）")
        if heal == "ok":
            try:
                health = fetch_health()
                db = health.get("db", {})
                f = health.get("freshness", {})
                s = health.get("signals", {})
                print("✅ 自愈后 K 线已到最新交易日，重新判定")
            except Exception as e:
                print(f"⚠️ 自愈后重取健康接口失败: {type(e).__name__}: {e}")

        # 3. 数据新鲜度（同步窗口内、非交易日跳过，避免长假误报）
        trading, trading_confirmed, why = trading_day_status(beijing_now())
        print(f"ℹ️ 交易日判定: {'是' if trading else '否'}（{why}）"
              f"{'' if trading_confirmed else ' [判定不确定]'}")
        if in_sync_window():
            print("ℹ️ 同步窗口内，跳过新鲜度检查")
            # 但「跳过检查」不能等于「假定健康」：同步窗口内若数据仍落后且自愈没成功，
            # 必须留一条 note，否则会走「全健康 → 自动关闭 Issue」把 #7 误关（假绿）。
            kd = f.get("kline_diff_days")
            if kd is not None and kd >= 1 and heal != "ok":
                stale_notes.append(f"K线落后 {kd} 天（同步窗口内，未复核）")
                print(f"⚠️ 同步窗口内 K线仍落后 {kd} 天且自愈未成功，保留 Issue 不自动关闭")
        elif not trading:
            print(f"ℹ️ 非交易日（{why}），跳过新鲜度检查")
        else:
            # 数据陈旧**只写日志**（2026-11-03 按用户要求：不建 Issue、不染红）。
            # 补数由 autoheal_kline_sync 负责；它的结果也只在日志里体现。
            # 留着这几行是为了出问题时能从 Actions 日志回溯，而不是彻底失明。
            for name, diff, latest in (("K线", f.get("kline_diff_days"), f.get("kline_latest")),
                                       ("评分", f.get("score_diff_days"), f.get("score_latest"))):
                if diff is None:
                    stale_notes.append(f"{name}数据缺失（表无数据）")
                    print(f"⚠️ {name}数据缺失：最新日期为空（表无数据）")
                elif diff >= FRESHNESS_ALERT_DAYS:
                    stale_notes.append(f"{name}落后 {diff} 天")
                    print(f"⚠️ {name}数据过期：最新 {latest}，期望 {f.get('expected')}，落后 {diff} 天"
                          f"（阈值 {FRESHNESS_ALERT_DAYS} 天；按配置只记录，不建 Issue、不染红）")
                elif diff > 0:
                    stale_notes.append(f"{name}落后 {diff} 天")
                    print(f"ℹ️ {name}落后 {diff} 天（阈值 {FRESHNESS_ALERT_DAYS} 天，未超）")
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
                    # 同样只记录，不建 Issue、不染红（见上方新鲜度处的说明）
                    stale_notes.append(f"K线覆盖不足（{len(stale)}/{n} 只落后）")
                    print(f"⚠️ K线覆盖不足：抽样 {n} 只中 {len(stale)} 只落后于全库最新 "
                          f"{f.get('kline_latest')}，示例 {eg}（按配置只记录）")

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
    # 节流闸门：距上次巡检不满 REPORT_INTERVAL_HOURS 就只做自愈，不改动 Issue、不染红。
    # 检查逻辑全部照跑、日志照留，只是不产生任何对外噪音（见文件头 REPORT_INTERVAL_HOURS）。
    now_bj = beijing_now()
    hb_num, last_report, next_due = read_heartbeat()
    if next_due is not None:
        due = now_bj >= next_due
        due_why = f"下次应检 {next_due:%m-%d %H:%M}（{'已到' if due else '未到'}）"
    elif last_report is not None:
        elapsed = now_bj - last_report
        due = elapsed >= datetime.timedelta(hours=REPORT_INTERVAL_HOURS)
        due_why = f"距上次巡检 {elapsed.total_seconds() / 3600:.1f} 小时（无下次应检记录）"
    else:
        due, due_why = True, "无心跳记录"
    if not due:
        print(f"ℹ️ 巡检节流：{due_why}，本轮只做自愈")
        if problems or stale_notes:
            print(f"ℹ️ 本次观察（按配置不报警）：问题={[p[0] for p in problems]} 备注={stale_notes}")
        sys.exit(0)
    print(f"ℹ️ 巡检到期（{due_why}），执行完整巡检与报警判定")

    if problems:
        print(f"⚠️ 发现 {len(problems)} 个问题，尝试创建 Issue...")
        if not open_issue_exists():
            create_issue(build_body(problems, health or {}, version, checked_at))
        else:
            print("ℹ️ 已存在相同标题的 open Issue，跳过（避免刷屏）")
        # 有异常 → 1 小时后复查（Issue 已建，复查不产生新噪音，但能在恢复后尽快自动关闭）
        write_heartbeat(hb_num, now_bj,
                        now_bj + datetime.timedelta(hours=REPORT_RETRY_HOURS))
        # 染红与否：只有真故障才让 workflow 失败。数据陈旧走 Issue 通道即可——
        # 原先把一切都 exit(1)，导致长假期间每小时变红，报警疲劳后真故障也会被忽略。
        # 交易日判定不确定时（行情接口不可达）从宽处理，不因判定失败而误报红色。
        fatal = [p for p in problems if p[0] in FATAL_PROBLEMS]
        # 2026-11-03 按用户要求：数据新鲜度 / 覆盖度彻底退出报警体系
        # （不建 Issue、不染红），补数交给 autoheal_kline_sync。
        # 这里只保留真故障：服务不可用、监控接口异常。
        # 注意「数据坏了」（池子不足、表为空、信号全 sell）仍会建 Issue——
        # 那是数据质量问题，不是「今天还没更新」，两者不该混为一谈。
        if fatal:
            print(f"❌ 致命问题 {len(fatal)} 个，workflow 标记失败: {[p[0] for p in fatal]}")
            sys.exit(1)
        print("⚠️ 仅非致命问题（已建 Issue），workflow 保持成功，避免报警疲劳")
        sys.exit(0)
    else:
        # problems 为空 ≠ 全健康：数据陈旧不进 problems（不建 Issue），但也不能
        # 因此把遗留 Issue #7 关掉 —— 那会造成「数据还没补上就先报全绿」。
        # 只有新鲜度也没问题，才算真的健康并关闭遗留 Issue。
        if stale_notes:
            print("ℹ️ 无服务故障；但数据新鲜度仍有问题（按配置不建 Issue、不染红）："
                  + "；".join(stale_notes))
            print("ℹ️ 保留遗留 Issue 不自动关闭，待数据补齐后下次运行会自动关闭")
        else:
            print("✅ 全部健康")
            close_stale_issue()
        # 数据未补齐（stale_notes 非空）也按异常处理 → 1 小时后复查，等补数落地再关 Issue
        gap = REPORT_RETRY_HOURS if stale_notes else REPORT_INTERVAL_HOURS
        write_heartbeat(hb_num, now_bj, now_bj + datetime.timedelta(hours=gap))
        sys.exit(0)


if __name__ == "__main__":
    main()
