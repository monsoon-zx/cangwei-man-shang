# crypto brief · 加密模拟盘简报（公开数据源）

本分支只放**脱敏后的模拟盘简报**，供外部应用读取。不包含策略源码，也不包含任何账户金额。

## 取数

| 用途 | URL |
|---|---|
| 最新（JSON，给程序） | `https://raw.githubusercontent.com/monsoon-zx/cangwei-man-shang/brief/crypto/brief.json` |
| 最新（Markdown，给人） | `https://raw.githubusercontent.com/monsoon-zx/cangwei-man-shang/brief/crypto/brief.md` |
| 历史索引 | `https://raw.githubusercontent.com/monsoon-zx/cangwei-man-shang/brief/crypto/history/index.json` |
| 某日归档 | `.../brief/crypto/history/YYYY-MM-DD.json` |

CDN 备选（中国大陆更易访问）：把 `https://raw.githubusercontent.com/monsoon-zx/cangwei-man-shang/brief/`
换成 `https://cdn.jsdelivr.net/gh/monsoon-zx/cangwei-man-shang@brief/` 即可。
注意 jsDelivr 对分支引用有缓存（最长约 12 小时），需要强新鲜度请用上面 raw 地址。

## 刷新节奏

- 每 4 小时（4H K 线收盘后）静默刷新 `brief.json`
- 每天 22:00（北京）生成一份日版归档到 `history/`

## 字段（`brief.json`）

- `schema_version`：结构版本，字段有破坏性变更时递增
- `generated_at`：生成时间（ISO 8601，+08:00）
- `as_of_bar_utc`：数据截止的 4H K 线（UTC）
- `data_lag_bars`：本地缓存比数据截止时间领先几根（0 表示无滞后）
- `performance`：**唯一真实成绩**，前瞻段已实现口径
  - `nav_index` 起点 100；`return_pct` 累计收益 %；`drawdown_pct` 距峰值回撤 %
  - `closed_trades` / `win_rate_pct` / `avg_r`（平均 R 倍数，1R = 打满止损的亏损额）
- `equity_curve`：`[{t, index}]`，按已平仓时点复利还原的净值指数
- `positions`：当前活仓。**只给** `entry` / `stop` / `stop_dist_pct` / `lev_nominal`
  （名义杠杆 = 入场价÷止损距离，是风险杠杆不是借钱倍数）/ `r_now`（浮盈 R）。
  不给数量、风险金额、名义头寸、保证金
- `recent_closed`：近期平仓，含 `r` 与 `pnl_pct`
- `market`：四币阶段判定 `dir`（bull/bear/range）、`vol`（L/M/H）、`trend`（T=通过 ER 门控）、
  `can_long` / `can_short`
- `risk`：当前风控开关的实际值，含回撤刹车是否触发
- `replay_segment`：引擎与回测口径校验用的复利倍数，**不是真实收益**
- `alerts`：数据侧的异常提示（行情更新失败、资金费过期等）

## 脱敏口径

对外只披露**比值类**指标：净值指数、收益率 %、R 倍数、止损距离 %、杠杆倍数。
不披露本金规模、持仓数量、风险金额、名义头寸、保证金占用、回放段复利权益。
