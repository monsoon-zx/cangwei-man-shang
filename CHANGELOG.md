# Changelog

## v1.9.5 (2026-11-03)

### 🩹 根治：K 线同步改由监控任务自愈（绕开 workflow scope 死结）

**问题**：K 线自 2026-10-30 起停更，`kline_diff_days=3`，monitor 每小时建 Issue #7 并把 workflow 染红。

**根因链（三层叠加）**：
1. 站点 `node-cron` 有 4 个定时（北京 10:00 / 11:30 / 14:00 增量 + 15:30 收盘同步），但它们依赖 Render 实例常驻——**免费实例空闲 15 分钟即休眠，cron 根本不会触发**。`crowding_latest` 停在 2026-08-28（落后 66 天）是这一点的铁证
2. 本该由 `.github/workflows/sync.yml` 提供外部定时器，但该文件**从未入库**：PAT 缺 `workflow` scope，任何对 `.github/workflows/` 的写入都被 GitHub 拒绝（实测 Contents API PUT 返回 404）
3. `monitor.yml` 每小时确实唤醒了实例，但它只做健康检查，不驱动同步

**解法**：把 `sync_pipeline.py` 的驱动循环并入 `monitor.py`，复用监控任务已有的每小时调度。
关键点——`monitor.py` 在 `.github/scripts/` 下、属**普通文件**，推送不受 workflow scope 限制，因此这个死结可以完全绕过，且不再需要 `sync.yml`。

- 新增 `autoheal_kline_sync(health)`：K 线落后且已收盘时，循环 `POST /api/sync/step {"step":"kline"}` 直到一轮跑完
- 触发门槛：`kline_diff_days ≥ 1` 且北京 `15:05~22:00`（收盘后留 5 分钟给数据落定，避免把盘中价写成日线）且当日为交易日（沿用上证指数行情时间戳判据）
- 防并发：服务端 `sync.kline` 非 `idle` 时跳过，避免跨整点与下一次定时触发同时驱动同一份内存 offset
- 预算 30 分钟；连续 3 次空转或连续 3 次调用异常即中止，转回正常告警
- **自愈成功后会重取健康快照再做告警判定**，因此补数完成即不再报「数据过期」，遗留 Issue 会在末尾被 `close_stale_issue()` 自动关闭
- 可用环境变量 `AUTOSYNC_DISABLE=1` 一键停用

**为什么不用 `step=full-pipeline`**：它用全库 `MAX(trade_date)` 判新鲜，只要一只股票写入就转去算指标，实测一轮只推进 9/200 只（假绿）。分步接口用服务端 offset 顺序推进才跑得完整轮。

### 🔕 报警体系调整：数据新鲜度彻底退出报警（2026-11-03 按用户要求）

原判据（v1.9.4 引入）是「K线/评分过期」或「K线覆盖不足」即 `exit 1` 并建 Issue。理由是确凿的同步故障值得红叉。
但这次暴露了缺陷：**结构性停更（压根没有外部定时器）每天都会命中，于是每小时红一次**，Issue #7 从早上 11:50 挂到现在，把真正的服务故障淹没在红叉里——这正是报警疲劳的来源。

现按用户要求改为：

| 情况 | Issue | workflow 红叉 |
|---|---|---|
| 服务不可用 / 监控接口异常 | 建 | **红** |
| 股票池不足 / 表为空 / 信号全 sell（数据**坏了**） | 建 | 不红 |
| 数据陈旧（K线/评分过期） | **不建** | **不红** |
| K线覆盖不足（假绿） | **不建** | **不红** |

- `FRESHNESS_ALERT_DAYS` 3 → **7 天**（A股一周 5 个交易日，原 3 天遇到「周五数据 + 周末 2 天」就会命中，过紧）
- 数据新鲜度相关判据全部改为**只写 Actions 日志**，不进 `problems`，因而既不建 Issue 也不染红；出问题时仍可从 job 日志回溯，不是彻底失明
- 「数据坏了」与「今天还没更新」明确区分：前者仍建 Issue，后者静默

### 🧩 一个连带的必要修正：`problems` 为空 ≠ 全健康
数据陈旧不再进 `problems` 后，`problems` 会变空，原逻辑会打印「✅ 全部健康」并 `close_stale_issue()`——
**数据还没补上就把 Issue #7 关掉，等于自己制造假绿**。因此新增 `stale_notes`：
只要新鲜度仍有问题，就不关闭遗留 Issue（等数据补齐后下一次运行再关），日志也如实说明。

### ⏳ 待办：`monitor.yml` 的 cron 需改为每 12 小时（本机推不上去）
用户要求监控从「每小时」降到「每 12 小时」。该改动在 `.github/workflows/monitor.yml`，
与 `sync.yml` 受同一个限制——本机 PAT 缺 `workflow` scope，无法写入 workflows 目录。

需要在 GitHub 网页直接改一行（或给 PAT 补 `workflow` scope 后由本机推送）：

```yaml
# 改前
- cron: '0 * * * 1-5'     # 每小时（UTC），北京整点
# 改后
- cron: '0 8,20 * * *'    # 每 12 小时：UTC 08:00/20:00 = 北京 16:00 / 次日 04:00
```

选这两个时刻的理由：北京 16:00 落在自愈时段（15:05~22:00）内，正好补完当天数据；
北京 04:00 是纯探活（非交易时段，自愈自动跳过）。不限定 `1-5`，让周末也有探活。

⚠️ **代价（已知）**：降到 12 小时后，「服务挂了」的发现延迟从 1 小时变成最长 12 小时。
数据陈旧已静默，所以这套监控届时唯一还会叫人的就只剩「服务挂了」。

### ✅ 验证
- `parse_progress` / 时段边界 / 四个短路条件单测通过
- 用 mock 覆盖循环控制 7 个分支：正常完成、跑完仍落后、空转中止、进度回退、连续异常、预算耗尽、防并发跳过
- 完整 `main()` 端到端跑通，自愈在时段外正确跳过，主流程输出与改动前一致

---

## v1.9.4 (2026-10-28)

### ⏳ 待入库：Data Sync 工作流（`.github/workflows/sync.yml`）
- 文件已写好但**受凭证权限阻塞，尚未推送**：本机钥匙串里的 PAT 缺 `workflow` scope，GitHub 拒绝任何对 `.github/workflows/` 的写入
  （`refusing to allow a Personal Access Token to create or update workflow ... without workflow scope`）
- **这很可能就是它一直没上线的真正原因**：提交 `f735d2f` 推了驱动脚本 `.github/scripts/sync_pipeline.py`，而 workflow 文件在 push 时被拒，遂留在本地未跟踪
- 内容：北京 15:40（收盘后主同步）+ 17:10（兜底补跑）驱动 `POST /api/sync/step?step=kline`；手动 `workflow_dispatch` 可选 `phase` / `force`
- 解除条件：给 PAT 补 `workflow` scope 后推送，或在 GitHub 网页直接新建该文件

### 🔍 背景：线上 K 线自 10-26 起停更
- 远端仓库只有 `Service Monitor` 一个工作流，外部同步驱动不存在，K 线只能靠 Render 上不可靠的 node-cron 零星推进
- 实测池内 200 只中 **198 只停在 `20261026`，仅 2 只到 `20261027`**，而全库 `MAX(trade_date)` 已被那 2 只顶到 10-27 → 健康接口显示"新鲜"，monitor 的覆盖度抽检报「K线覆盖不足」把 workflow 染红

### 🐛 修复：监控报警内容丢失
- `monitor.py` 新增「健康时自动关闭遗留 Issue」。原逻辑只建 Issue 从不关闭，9-28 那个 Issue 一直挂着，导致之后所有新异常都被标题去重挡掉，只剩无信息量的 workflow 红叉

### 🐛 修复：健康接口两个恒错字段
- `/api/monitor/health` 的 `crowding_latest` 恒为 null（`dates` 对象只查了 kline/score，漏了 `crowding_score`）→ 拥挤度新鲜度维度永久失明
- `sync.running` 恒为 true（`stepSyncState` 初始 `done:false`，`0/0` 被当成"正在跑"）→ 改为 `total===0` 也算 idle

---

## v1.9.2 (2026-09-14)

### 🔒 仓库治理
- **下线账号清单文件**：`accounts.csv` / `账号清单.txt` 从版本库中移除（文件保留在本地，不入库）。两者含 105 个 Access Key 与用户名对应关系，不适合公开
- **清理 CHANGELOG 明文凭据**：移除 v1.1.0 章节中的管理员 Access Key 明细表格及清单文件引用
- **移除内部记忆文件**：`.workbuddy/memory/*.md` 取消跟踪（`.gitignore` 已有 `.workbuddy/` 规则，此前为历史遗留跟踪）
- **新增敏感文件忽略规则**：`.gitignore` 补充 `accounts.csv` / `账号清单.txt` / `*账号*` / `*access_key*` / `credentials*` / `secrets*`

### ✏️ 更名
- 产品名称统一：**A股智能决策辅助系统 → 交易决策辅助**
  - 文档 `A股智能决策辅助系统-产品架构文档.md/.html` → `交易决策辅助-产品架构文档.md/.html`（含文件内容标题）
  - `package.json` description 同步更新
- `README.md` 一键部署按钮链接由旧账号名更正为当前仓库地址

---

## v1.6.3 (2026-08-21)

### 🐛 Bug 修复
- **修复换手率turnover为null的根本原因**：腾讯K线API(fqkline)只返回6个字段(日期/O/C/H/L/成交量)，不包含换手率。将K线数据源从腾讯切换到东方财富(push2his.eastmoney.com)，东方财富返回11个字段含f61换手率(%)
- 涉及4处K线调用：/api/sync、/api/sync/step(kline)、runStepKline、cron同步
- 日期格式从YYYY-MM-DD改为YYYYMMDD（东方财富API要求）

### 🆕 新增
- **财务数据分步拉取**：新增finance step到/api/sync/step，分批拉取东方财富datacenter财务数据，避免scoreAllStocks内同步拉取200只财务数据超时
- full-pipeline在评分前自动检查并拉取财务数据
- GitHub Actions workflow新增finance选项

---

## v1.6.2 (2026-08-20)

### 🐛 Bug 修复
- **修复首次部署页面空白**：新增 seed.db 种子数据库（54支核心股票+评分+K线+拥挤度数据），Render 启动时自动从 seed 恢复，页面不会空白
- **修复同步接口 schema 不匹配**：stock_info 去掉不存在的 pe 列（pe 在 valuation 表）；stock_score 表补齐 name/industry/current_price/quality_detail 等缺失列
- **修复评分时财务数据不足导致返回null**：无财务数据时返回中性分50，确保评分能产生结果
- **修复菜单图标/emoji 不统一**：去掉 label 里的 emoji 前缀，全部使用 AntD 图标（8个模块icon互不重复）

### 🔧 优化
- 前端加版本检测：启动时检查 /api/version，发现新版本自动页面刷新，解决浏览器缓存旧版问题
- index.html 加 no-cache 响应头，assets URL 附加 ?v= 启动时间戳强制更新
- 服务启动后台更新行情时，API 超时15秒即放弃，避免海外节点阻塞

---

## v1.1.0 (2026-07-30)

### 🆕 新增
- **Access Key 账号体系**：替换原用户名+密码注册登录，改为内置 105 个账号（5 admin + 100 access），输入 8 位 Access Key 即可登录
  - admin 账号：策略配置等全部模块可用
  - access 账号：菜单自动隐藏策略配置，直接访问URL拦截并显示403
  - 用户名支持点击右上角头像旁✏️图标自定义修改，修改后本地保存
  - 登录界面简化为单输入框，输入Key自动转小写
- 新增 `/api/version` 接口，前端/运维可检查版本

### 🎨 UI 优化
- **菜单栏 icon 全部去重**：原 LineChart/BarChart/Fund/DollarCircle/Alert/Setting 多个模块图标风格混乱、语义不清，统一为语义化独立图标
  - 市场总览 → DashboardOutlined（仪表盘）
  - 价值信号 → ThunderboltOutlined（闪电）
  - 短线机会 → RocketOutlined 🚀（火箭）
  - 加密货币 → WalletOutlined 💰（钱包）
  - 拥挤度雷达 → RadarChartOutlined 📡（雷达图）
  - 自选持仓 → StarOutlined ⭐（星星）
  - 回测分析 → HistoryOutlined（历史回溯）
  - 策略配置 → ControlOutlined ⚙️（控制台，仅admin可见）
- Header 用户徽章增加角色标签（管理员/用户），管理员头像橙色、普通用户蓝色
- 登录窗口去除注册 Tab，只保留 Access Key 输入
- 403 无权限友好提示页

### 🔑 内置账号体系

管理员账号与普通用户账号均为内置 Access Key，明细不在版本库中留存（见运行时账号库）。

### 📦 部署
- 线上地址：https://cangwei-man-shang.onrender.com
- 平台：Render Free Plan，GitHub main 分支 push 触发自动部署
- 构建命令：`npm install && npm run build`
- 启动命令：`node server.js`

---

## v1.0.0 (2026-07-28 ~ 2026-07-29)

### 首发及迭代版本
- 市场总览：大盘温度计（估值/资金/趋势/情绪四维加权）、指数行情、板块涨跌、市值结构、信号统计
- 价值信号池：ROE+PE+技术面综合评分，信号分 buy/watch/hold/sell 四档
- 个股详情：估值/技术/资金/财务多维度分析 + AI诊断报告（占位）
- 自选持仓：手动添加，成本价/持仓比例，实时盈亏计算（localStorage）
- 回测分析：价值策略/趋势策略/均值回归三策略
- 📡 拥挤度雷达：量化资金拥挤度模型，板块热力图+减仓预警+动量搭车+冷清逆向
- ⚡ 短线机会（v1.0.1加）：换手率+量价+波动率综合打分，短线信号
- 🪙 加密货币（v1.0.1加）：接入Binance公开API，BTC/ETH/SOL等主流币种行情+MA/RSI分析
- 策略配置：评分权重等参数可视化调整
- 数据源：腾讯财经（GBK K线/实时行情）、新浪财经（板块）、东方财富（财务指标）、Binance（加密货币）
- 账号体系（v1.0版本）：本地用户名+密码注册登录，localStorage存储
- 部署到 Render，完成 Node+React 全栈 CI/CD 自动部署链路
