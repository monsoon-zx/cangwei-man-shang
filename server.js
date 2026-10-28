/**
 * 仓位满上 Top Up - 后端API Server
 */
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

// ========== 启动前种子数据检查 ==========
if (!process.env.TURSO_AUTH_TOKEN) {
  (function initSeed() {
    const dbPath = path.join(__dirname, 'data', 'stock_advisor.db');
    const seedPath = path.join(__dirname, 'data', 'seed.db');
    try {
      let needSeed = false;
      if (!fs.existsSync(dbPath)) needSeed = true;
      else { const stat = fs.statSync(dbPath); if (stat.size < 100 * 1024) needSeed = true; }
      if (needSeed && fs.existsSync(seedPath)) { fs.copyFileSync(seedPath, dbPath); console.log('[init] ✅ 已从 seed.db 恢复种子数据库'); }
      else if (needSeed) { console.log('[init] ⚠️ 数据库为空且无 seed.db'); }
    } catch(e) { console.log('[init] 种子检查失败:', e.message); }
  })();
}

const { dbGet, dbAll, dbRun, dbBatch, dbIsReady, usePostgres, useTurso, client } = require('./src/data/db');
const stockPool = require('./src/data/stock_pool');
const ds = require('./src/data/datasources');
const tq = ds;
// 东方财富K线数据源（含换手率字段，腾讯K线不返回换手率）
const emKline = require('./src/data/eastmoney');
const { calcAllIndicators } = require('./src/factors/indicators');
const { scoreAllStocks, classifyIndustry, syncFinancialData, calcQualityScore, calcValuationScore, calcTechnicalScore, calcTotalScore } = require('./src/strategies/value_score');
const { getMarketOverview, calcMarketConcentration } = require('./src/data/money_flow');
const dayjs = require('dayjs');

const app = express();
app.use(cors());
app.use(express.json());

// ========== API 路由 ==========

app.get('/api/market/overview', async (req, res) => {
  try {
    const marketData = await getMarketOverview();
    const indices = marketData.indices.length > 0 ? marketData.indices : await tq.getIndexQuotes();
    let sectors = await dbAll(`SELECT sector_code, sector_name, change_pct, leader_name, leader_pct FROM sector_daily ORDER BY trade_date DESC, change_pct DESC LIMIT 40`);
    if (sectors.length === 0) {
      try { const live = await ds.getSectorList(); sectors = (live || []).slice(0, 40).map(s => ({ sector_code: s.sector_code, sector_name: s.sector_name, change_pct: s.change_pct, leader_name: s.leader_name || '', leader_pct: s.leader_pct || 0 })); } catch(e) {}
    }
    const sectorFlows = sectors.map(s => ({ name: s.sector_name, net_inflow: Math.round(s.change_pct * 12), leader_name: s.leader_name, leader_pct: s.leader_pct })).sort((a,b) => b.net_inflow - a.net_inflow);
    const concentration = calcMarketConcentration(sectorFlows);
    const latestDateRow = await dbGet('SELECT MAX(trade_date) as d FROM stock_score');
    const latestDate = latestDateRow?.d;
    const scores = await dbAll(`SELECT s.code, s.total_score, s.signal, s.quality_score, s.valuation_score, s.technical_score, v.pe, i.name, i.total_mv FROM stock_score s LEFT JOIN valuation v ON s.code = v.code AND v.trade_date = (SELECT MAX(trade_date) FROM valuation) LEFT JOIN stock_info i ON s.code = i.code WHERE s.trade_date = ? AND s.strategy = 'value'`, [latestDate]);
    const peValues = scores.map(s => s.pe).filter(v => v && v > 0 && v < 200);
    const medianPE = peValues.sort((a,b) => a-b)[Math.floor(peValues.length/2)] || 15;
    let valuationScore; if (medianPE < 10) valuationScore = 10; else if (medianPE < 14) valuationScore = 25; else if (medianPE < 20) valuationScore = 50; else if (medianPE < 28) valuationScore = 72; else valuationScore = 92;
    const totalAmount = marketData.total_amount_yi || 8000;
    const avgIdxPct = indices.reduce((a,b) => a + (b.pct_chg||0), 0) / indices.length;
    let moneyScore = 50; if (totalAmount < 6000) moneyScore = 20; else if (totalAmount < 8000) moneyScore = 35; else if (totalAmount < 10000) moneyScore = 50; else if (totalAmount < 12000) moneyScore = 62; else if (totalAmount < 15000) moneyScore = 72; else moneyScore = 80;
    if (totalAmount > 12000) { if (avgIdxPct > 1) moneyScore += 10; else if (avgIdxPct < -1) moneyScore -= 20; else if (avgIdxPct < -0.3) moneyScore -= 10; }
    moneyScore = Math.max(0, Math.min(100, moneyScore));
    const conc = concentration.concentration || 30;
    if (conc > 55) moneyScore = Math.min(95, moneyScore + 5); else if (conc < 20) moneyScore = Math.max(10, moneyScore - 5);
    let trendScore = 50;
    for (const idxCode of ['000001','000300']) {
      const kl = await dbAll(`SELECT close FROM daily_kline WHERE code=? ORDER BY trade_date DESC LIMIT 20`, [idxCode]);
      if (kl.length >= 20) { const ma20 = kl.reduce((a,b)=>a+b.close,0)/kl.length; const cur = kl[0].close; if (cur > ma20 * 1.02) trendScore += 15; else if (cur > ma20) trendScore += 5; else if (cur < ma20 * 0.98) trendScore -= 15; else trendScore -= 5; }
    }
    if (avgIdxPct > 1) trendScore += 15; else if (avgIdxPct > 0) trendScore += 5; else if (avgIdxPct < -2) trendScore -= 15; else if (avgIdxPct < -1) trendScore -= 8;
    trendScore = Math.max(0, Math.min(100, trendScore));
    const upIndices = indices.filter(i => i.pct_chg > 0).length;
    let sentimentScore = 50; if (avgIdxPct > 1.5) sentimentScore = 80; else if (avgIdxPct > 0.5) sentimentScore = 65; else if (avgIdxPct > -0.3) sentimentScore = 50; else if (avgIdxPct > -1) sentimentScore = 35; else if (avgIdxPct > -2) sentimentScore = 25; else sentimentScore = 15;
    const temp = Math.round(valuationScore * 0.30 + moneyScore * 0.35 + trendScore * 0.20 + sentimentScore * 0.15);
    let tempDesc, suggestedPos, tempColor;
    if (temp < 20) { tempDesc = '极度寒冷(地量见底)'; suggestedPos = '80-100%'; tempColor = '#12b76a'; } else if (temp < 35) { tempDesc = '偏冷(低估区间)'; suggestedPos = '60-80%'; tempColor = '#32d583'; } else if (temp < 55) { tempDesc = '温(估值合理)'; suggestedPos = '40-60%'; tempColor = '#fac515'; } else if (temp < 70) { tempDesc = '偏热(资金活跃)'; suggestedPos = '20-40%'; tempColor = '#f79009'; } else if (temp < 85) { tempDesc = '过热(警惕回调)'; suggestedPos = '10-20%'; tempColor = '#f04438'; } else { tempDesc = '🔥亢奋泡沫(减仓)'; suggestedPos = '0-10%'; tempColor = '#d92d20'; }
    const tempBreakdown = [
      { label: '估值', score: valuationScore, weight: '30%', detail: `PE中位数 ${medianPE.toFixed(1)}x`, color: '#12b76a' },
      { label: '资金', score: moneyScore, weight: '35%', detail: `成交${totalAmount}亿 抱团${conc}%`, color: '#2e90fa' },
      { label: '趋势', score: trendScore, weight: '20%', detail: `均线位置`, color: '#f79009' },
      { label: '情绪', score: sentimentScore, weight: '15%', detail: `均涨${avgIdxPct?.toFixed(1)||0}% ${upIndices}涨`, color: '#9e77ed' },
    ];
    const signalCounts = { buy: 0, watch: 0, hold: 0, sell: 0 };
    scores.forEach(s => { if (signalCounts[s.signal] !== undefined) signalCounts[s.signal]++; });
    const today = dayjs().format('YYYYMMDD');
    const topCandidates = scores.filter(s => s.signal === 'buy' || s.signal === 'watch').sort((a,b) => b.total_score - a.total_score).slice(0, 10);
    const topStocks = [];
    for (const s of topCandidates) {
      const val = await dbGet('SELECT pe, trade_date FROM valuation WHERE code = ? ORDER BY trade_date DESC LIMIT 1', [s.code]);
      const kline = await dbAll('SELECT close, pct_chg, trade_date FROM daily_kline WHERE code = ? ORDER BY trade_date DESC LIMIT 10', [s.code]);
      const todayClose = kline[0]?.close; const todayPct = kline[0]?.pct_chg;
      let pct7d = null; if (kline.length >= 5) { const ref = kline[kline.length - 1]?.close; if (ref && todayClose) pct7d = +((todayClose / ref - 1) * 100).toFixed(2); }
      topStocks.push({ code: s.code, name: s.name, total_score: s.total_score, signal: s.signal, quality: s.quality_score, valuation: s.valuation_score, technical: s.technical_score, pe: val?.pe, close: todayClose, pct_chg: todayPct, pct_7d: pct7d });
    }
    res.json({
      date: dayjs().format('YYYY-MM-DD HH:mm'),
      indices: indices.map(i => ({ name: i.name, code: i.code, close: i.close, pct_chg: i.pct_chg })),
      temperature: { value: temp, label: tempDesc, suggested_position: suggestedPos, median_pe: +medianPE.toFixed(1), color: tempColor, breakdown: tempBreakdown, total_amount: totalAmount, concentration: conc, top_flow_sectors: concentration.top_sectors, worst_flow_sectors: concentration.worst_sectors },
      signal_counts: signalCounts, top_stocks: topStocks, sectors: sectors.slice(0, 10), total_stocks: scores.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stocks', async (req, res) => {
  try {
    const { signal, industry, sort = 'total_score', order = 'desc', page = 1, pageSize = 20, minScore, isNewEconomy, isOldman } = req.query;
    const latestDateRow = await dbGet('SELECT MAX(trade_date) as d FROM stock_score');
    const latestDate = latestDateRow?.d;
    let where = `WHERE s.trade_date = ? AND s.strategy = 'value'`;
    const params = [latestDate];
    if (signal) { where += ` AND s.signal = ?`; params.push(signal); }
    if (minScore) { where += ` AND s.total_score >= ?`; params.push(parseInt(minScore)); }
    let rows = await dbAll(`SELECT s.*, COALESCE(s.name,i.name) as _name, COALESCE(s.mktcap_yi, i.total_mv) as total_mv, COALESCE(s.pe, v.pe) as pe, COALESCE(s.pb, v.pb) as pb, COALESCE(s.current_price, k.close) as current_price, k.pct_chg as daily_pct_chg FROM stock_score s LEFT JOIN stock_info i ON s.code = i.code LEFT JOIN valuation v ON v.code = s.code AND v.trade_date = (SELECT MAX(trade_date) FROM valuation WHERE code = s.code) LEFT JOIN daily_kline k ON k.code = s.code AND k.trade_date = (SELECT MAX(trade_date) FROM daily_kline WHERE code = s.code) ${where}`, [...params]);
    rows = rows.map(r => {
      let ind = r.sw_l1 || r.industry || null;
      let isNE = null, isOM = null;
      if (!ind && r.quality_detail) { try { const qd = JSON.parse(r.quality_detail); ind = qd.industry; isNE = qd.isNewEconomy; isOM = qd.isOldman; } catch(e) {} }
      return { ...r, name: r._name || r.name, _industry: ind, _isNewEconomy: isNE, _isOldman: isOM };
    });
    if (industry && industry !== 'all') rows = rows.filter(r => r._industry && r._industry.includes(industry));
    if (isNewEconomy === 'true') rows = rows.filter(r => r._isNewEconomy);
    if (isOldman === 'true') rows = rows.filter(r => r._isOldman);
    const sortField = sort === 'pe' ? 'pe' : sort === 'total_mv' ? 'total_mv' : sort === 'quality' ? 'quality_score' : sort === 'valuation' ? 'valuation_score' : sort === 'technical' ? 'technical_score' : sort === 'crowding' ? 'crowding_score' : sort === 'pct_chg' ? 'pct_chg' : 'total_score';
    const sortOrder = order === 'asc' ? 1 : -1;
    rows.sort((a,b) => { const va = a[sortField] ?? -999, vb = b[sortField] ?? -999; return (va - vb) * sortOrder; });
    const total = rows.length; const p = parseInt(page), ps = parseInt(pageSize);
    const pageData = rows.slice((p-1)*ps, p*ps);
    res.json({ total, page: p, pageSize: ps, data: pageData.map(r => ({ code: r.code, name: r.name, total_score: r.total_score, signal: r.signal, quality_score: r.quality_score, valuation_score: r.valuation_score, technical_score: r.technical_score, crowding_score: r.crowding_score, crowding_level: r.crowding_level, pe: r.pe, total_mv: r.total_mv, current_price: r.current_price, target_price: r.target_price, stop_loss: r.stop_loss, pct_chg: r.daily_pct_chg, industry: r._industry, is_new_economy: r._isNewEconomy, is_oldman: r._isOldman, reason: r.reason ? JSON.parse(r.reason) : [] })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stocks/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const info = await dbGet('SELECT * FROM stock_info WHERE code = ?', [code]);
    if (!info) return res.status(404).json({ error: '股票不存在' });
    const latestScore = await dbGet(`SELECT * FROM stock_score WHERE code = ? ORDER BY trade_date DESC LIMIT 1`, [code]);
    const val = await dbGet('SELECT * FROM valuation WHERE code = ? ORDER BY trade_date DESC LIMIT 1', [code]);
    const klines = (await dbAll(`SELECT k.trade_date, k.open, k.high, k.low, k.close, k.volume, k.pct_chg, t.ma5, t.ma10, t.ma20, t.ma60, t.macd_dif, t.macd_dea, t.macd_bar, t.rsi14, t.boll_upper, t.boll_mid, t.boll_lower FROM daily_kline k LEFT JOIN technical_indicators t USING(code, trade_date) WHERE k.code = ? ORDER BY k.trade_date DESC LIMIT 250`, [code])).reverse();
    const tech = klines[klines.length - 1];
    const financials = await dbAll(`SELECT * FROM financial_indicator WHERE code = ? ORDER BY report_date DESC LIMIT 8`, [code]);
    const valDetail = latestScore?.valuation_detail ? JSON.parse(latestScore.valuation_detail) : {};
    const qualityDetail = latestScore?.quality_detail ? JSON.parse(latestScore.quality_detail) : {};
    const qualityLatest = latestScore?.quality_latest ? JSON.parse(latestScore.quality_latest) : {};
    const techDetail = latestScore?.technical_detail ? JSON.parse(latestScore.technical_detail) : {};
    const industry = classifyIndustry(code, info.name);
    res.json({
      code, name: info.name, market: info.market, industry: industry.group.name, is_new_economy: industry.isNewEconomy, is_oldman: industry.isOldman, total_mv: info.total_mv,
      score: latestScore ? { total: latestScore.total_score, quality: latestScore.quality_score, valuation: latestScore.valuation_score, technical: latestScore.technical_score, signal: latestScore.signal, target_price: latestScore.target_price, stop_loss: latestScore.stop_loss, position_pct: latestScore.position_pct, quality_detail: qualityDetail, quality_latest: qualityLatest, valuation_detail: valDetail, technical_detail: techDetail, reason: latestScore.reason ? JSON.parse(latestScore.reason) : [] } : null,
      valuation: val ? { pe: val.pe, pe_ttm: val.pe_ttm, pb: val.pb, dv_ratio: val.dv_ratio, total_mv: val.total_mv } : null,
      klines: klines.map(k => ({ date: k.trade_date, open: k.open, close: k.close, high: k.high, low: k.low, volume: k.volume, pct_chg: k.pct_chg, ma5: k.ma5, ma10: k.ma10, ma20: k.ma20, ma60: k.ma60, macd_dif: k.macd_dif, macd_dea: k.macd_dea, macd_bar: k.macd_bar, boll_upper: k.boll_upper, boll_mid: k.boll_mid, boll_lower: k.boll_lower })),
      financials: financials.map(f => ({ report_date: f.report_date, report_type: f.report_type, roe: f.roe, gross_margin: f.gross_margin, net_margin: f.net_margin, revenue: f.revenue, revenue_yoy: f.revenue_yoy, net_profit: f.net_profit, net_profit_yoy: f.net_profit_yoy, debt_ratio: f.debt_ratio, current_ratio: f.current_ratio, eps: f.eps, roic: f.roic, ocf: f.ocf })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/industries', async (req, res) => {
  try {
    const latestDateRow = await dbGet('SELECT MAX(trade_date) as d FROM stock_score');
    const latestDate = latestDateRow?.d;
    const rows = await dbAll(`SELECT s.code, s.quality_detail, s.total_score, s.signal FROM stock_score s WHERE s.trade_date = ? AND s.strategy = 'value'`, [latestDate]);
    const industries = {};
    rows.forEach(r => { try { const qd = JSON.parse(r.quality_detail); const ind = qd.industry || '通用'; if (!industries[ind]) industries[ind] = { name: ind, count: 0, avg_score: 0, buy: 0, scores: [] }; industries[ind].count++; industries[ind].scores.push(r.total_score); if (r.signal === 'buy' || r.signal === 'watch') industries[ind].buy++; } catch(e) {} });
    const result = Object.values(industries).map(i => ({ name: i.name, count: i.count, avg_score: Math.round(i.scores.reduce((a,b)=>a+b,0) / i.scores.length), opportunities: i.buy })).sort((a,b) => b.avg_score - a.avg_score);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== 同步进度事件 ==========
const { EventEmitter } = require('events');
const syncEvents = new EventEmitter();
syncEvents.setMaxListeners(50);
let syncRunning = false;
let syncStartTime = 0;

function emitProgress(stage, message, percent, extra = {}) {
  const payload = JSON.stringify({ stage, message, percent, time: dayjs().format('HH:mm:ss'), ...extra });
  console.log('[sync]', payload);
  syncEvents.emit('progress', payload);
}

app.get('/api/sync/progress', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`retry: 3000\n`);
  res.write(`data: ${JSON.stringify({ type:'status', running: syncRunning, time: dayjs().format('HH:mm:ss') })}\n\n`);
  const onProgress = (data) => { res.write(`data: ${data}\n\n`); };
  syncEvents.on('progress', onProgress);
  req.on('close', () => { syncEvents.removeListener('progress', onProgress); });
});

app.post('/api/sync', async (req, res) => {
  // 如果上次同步超过15分钟还在running，强制重置（防止suspend导致死锁）
  if (syncRunning && syncStartTime > 0 && Date.now() - syncStartTime > 15 * 60 * 1000) {
    console.log('[sync] 检测到超时死锁，重置syncRunning');
    syncRunning = false;
  }
  if (syncRunning) return res.json({ status: 'running', message: '同步正在进行中' });
  syncRunning = true;
  syncStartTime = Date.now();
  const syncMode = req.body?.mode || req.query?.mode || 'incremental';
  const waitForComplete = req.body?.wait === true || req.query?.wait === '1';

  const doSync = (async () => {
    let result = { status: 'ok', klineCount: 0, indCount: 0, errors: 0 };
    let indCount = 0;
    try {
      const currentSettings = userSettings;
      emitProgress('init', syncMode === 'full' ? '开始全量数据同步（拉取2年历史K线）...' : '开始增量同步数据...', 0);
      let codes = await stockPool.getPoolCodes();
      if (codes.length === 0) { const infoRows = await dbAll('SELECT code FROM stock_info'); codes = infoRows.map(r => r.code).filter(c => /^\d{6}$/.test(c)); }
      if (codes.length === 0) {
        emitProgress('list', '数据库为空，加载热门股票池...', 5);
        codes = ['600519','000858','601318','600036','000333','600276','300750','601012','600900','601899','002594','601166','600030','000001','600887','601398','601288','600000','601988','600050','000725','600585','601668','601390','002475','300059','600438','002352','601888','600309','603288','000568','000596','600809','300124','002415','603501','688981','688012','688256','300760','002241','600048','601628','601601','600104','601857','600028','601088','600111','600547','601225','002460','300274'];
      }
      emitProgress('quote', `正在拉取 ${codes.length} 支股票实时行情...`, 5);
      let quotes = [];
      let klineErrors = 0;
      try { quotes = await tq.getQuickStockList(codes); } catch(e) { emitProgress('quote', `行情拉取失败: ${e.message}`, 8); }
      const nowStr = dayjs().format('YYYY-MM-DD HH:mm:ss');
      const today = dayjs().format('YYYYMMDD');
      const infoData = quotes.filter(q=>q.code&&q.name).map(q => ({ code:q.code, name:q.name, market:q.market||(q.code.startsWith('6')?'SH':'SZ'), is_st:q.is_st||(q.name&&q.name.includes('ST')?1:0), total_mv:q.total_mv, circ_mv:q.circ_mv }));
      await dbBatch(infoData.map(r => ({ sql: `INSERT OR REPLACE INTO stock_info (code,name,market,is_st,total_mv,circ_mv,updated_at) VALUES (?,?,?,?,?,?,?)`, args: [r.code, r.name, r.market, r.is_st, r.total_mv, r.circ_mv, nowStr] })));
      const valData = quotes.filter(q=>q.code&&q.pe!=null);
      await dbBatch(valData.map(q => ({ sql: `INSERT OR REPLACE INTO valuation (code,trade_date,pe) VALUES (?,?,?)`, args: [q.code, today, q.pe] })));
      emitProgress('quote', `行情更新完成：${quotes.length} 支`, 15);
      const klineHistoryDays = syncMode === 'full' ? 730 : 60;
      const klineStart = dayjs().subtract(klineHistoryDays,'day').format('YYYYMMDD');
      const klineEnd = dayjs().format('YYYYMMDD');
      emitProgress('kline', `更新K线数据（${syncMode === 'full' ? '全量2年' : '近60天增量'}）...`, 18);
      let klineCount = 0;
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        try {
          let klines = await emKline.getDailyKline(code, klineStart, klineEnd);
          // 东方财富失败则回退到腾讯+计算换手率
          if (!klines || klines.length === 0) {
            const info = await dbGet('SELECT circ_mv FROM stock_info WHERE code = ?', [code]);
            const tqKlines = await tq.getDailyKline(code, 
              dayjs(klineStart).format('YYYY-MM-DD'), 
              dayjs(klineEnd).format('YYYY-MM-DD')
            );
            if (tqKlines && tqKlines.length > 0) {
              klines = tqKlines.map(k => {
                let turnover = null;
                if (info && info.circ_mv && info.circ_mv > 0 && k.close > 0 && k.volume > 0) {
                  turnover = Math.round((k.volume * 100 * k.close / (info.circ_mv * 1e8) * 100) * 100) / 100;
                }
                return { ...k, turnover };
              });
            }
          }
          if (klines && klines.length > 0) {
            for (let j = 0; j < klines.length; j += 200) {
              await dbBatch(klines.slice(j, j+200).map(k => ({ sql: `INSERT OR REPLACE INTO daily_kline (code,trade_date,open,close,high,low,volume,amount,amplitude,pct_chg,chg,turnover) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [k.code, k.trade_date, k.open, k.close, k.high, k.low, k.volume, k.amount, k.amplitude, k.pct_chg, k.chg, k.turnover] })));
            }
            klineCount += klines.length;
          }
        } catch(e) { klineErrors++; if (klineErrors <= 3) emitProgress('kline', `K线警告: ${code} 拉取失败(${e.message?.slice(0,30)})`, -1); }
        if (i % 5 === 0 || i === codes.length - 1) { const pct = syncMode === 'full' ? 18 + Math.floor((i / codes.length) * 45) : 18 + Math.floor((i / codes.length) * 35); emitProgress('kline', `K线: ${i+1}/${codes.length} (${klineCount}条${klineErrors > 0 ? `, ${klineErrors}个失败` : ''})`, pct); }
        await tq.sleep(syncMode === 'full' ? 120 : 80);
      }
      emitProgress('kline', `K线更新完成：${klineCount} 条${klineErrors > 0 ? `（${klineErrors}个失败）` : ''}`, syncMode === 'full' ? 63 : 53);

      if (syncMode === 'full') {
        const indStartPct = 65;
        emitProgress('indicator', '计算技术指标（MA/MACD/RSI/KDJ/BOLL）...', indStartPct);
        const allCodeRows = await dbAll('SELECT DISTINCT code FROM daily_kline');
        const allCodes = allCodeRows.map(r => r.code);
        indCount = 0;
        for (let i = 0; i < allCodes.length; i++) {
          const code = allCodes[i];
          const ks = await dbAll(`SELECT trade_date,close,high,low,volume FROM daily_kline WHERE code = ? ORDER BY trade_date ASC`, [code]);
          if (ks.length < 25) continue;
          const inds = calcAllIndicators(ks);
          const validInds = inds.filter(r => r.ma5 !== null);
          for (let j = 0; j < validInds.length; j += 200) {
            await dbBatch(validInds.slice(j, j+200).map(r => ({ sql: `INSERT OR REPLACE INTO technical_indicators (code,trade_date,ma5,ma10,ma20,ma60,ma120,ma250,vol_ma5,vol_ma20,macd_dif,macd_dea,macd_bar,rsi6,rsi14,kdj_k,kdj_d,kdj_j,boll_upper,boll_mid,boll_lower) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [code, r.trade_date, r.ma5, r.ma10, r.ma20, r.ma60, r.ma120, r.ma250, r.vol_ma5, r.vol_ma20, r.macd_dif, r.macd_dea, r.macd_bar, r.rsi6, r.rsi14, r.kdj_k, r.kdj_d, r.kdj_j, r.boll_upper, r.boll_mid, r.boll_lower] })));
          }
          indCount++;
          if (i % 20 === 0) { const pct = indStartPct + Math.floor((i / allCodes.length) * 12); emitProgress('indicator', `指标: ${i+1}/${allCodes.length}`, pct); }
        }
        emitProgress('indicator', `技术指标计算完成：${indCount} 支`, indStartPct + 12);
        result.indCount = indCount;

        emitProgress('score', '计算多因子评分...', 80);
        if (!process.env.DISABLE_LEGACY_SCORING) {
          await scoreAllStocks(true, currentSettings);
        } else {
          console.log('[sync] DISABLE_LEGACY_SCORING=true，跳过旧引擎全量评分');
        }
        emitProgress('score', '评分步骤完成', 87);
        try { emitProgress('pool', '更新关注池...', 97); await stockPool.updateStockPool(200); } catch(e) { console.log('pool update error:', e.message); }
      } else {
        // 增量模式：若禁用了旧打分引擎，则跳过本地评分（由外部 upload 灌入新打分）
        if (!process.env.DISABLE_LEGACY_SCORING) {
          emitProgress('score', '增量同步：快速评分中...', 60);
          await scoreAllStocks(false, currentSettings);
          emitProgress('score', '评分完成', 95);
        } else {
          emitProgress('score', 'DISABLE_LEGACY_SCORING=true，跳过本地旧引擎评分（等待外部新打分上传）', 95);
        }
      }

      emitProgress('done', `同步完成！${quotes.length}支行情 / ${klineCount}条K线${syncMode === 'full' ? ' / 全量指标评分' : '（增量快速模式）'}${klineErrors > 0 ? `（${klineErrors}个K线拉取失败）` : ''}`, 100);
      console.log('[' + dayjs().format('YYYY-MM-DD HH:mm') + '] 同步完成 (' + syncMode + ')');
      result = { status: 'completed', mode: syncMode, quotes: quotes.length, klines: klineCount, indicators: indCount, errors: klineErrors };
    } catch(e) {
      emitProgress('error', '同步失败: ' + e.message, -1);
      console.error('同步失败:', e);
      result = { status: 'error', message: e.message };
    } finally {
      syncRunning = false;
      syncStartTime = 0;
      setTimeout(() => syncEvents.emit('progress', JSON.stringify({ type:'done', time: dayjs().format('HH:mm:ss') })), 500);
    }
    return result;
  })();

  if (waitForComplete) {
    const result = await doSync;
    return res.json(result);
  } else {
    res.json({ status: 'started', message: syncMode === 'full' ? '全量数据同步已启动' : '数据同步已启动', mode: syncMode });
    doSync.catch(e => console.error('sync error:', e));
  }
});

// ========== 分步同步 API ==========
// 解决Render免费版suspend问题：每个step在50秒内完成一批，可反复调用
// 前端/GitHub Actions通过轮询逐步完成全量同步

const SYNC_STEP_TIMEOUT = 50000; // 50秒超时，留足Render响应时间
const SYNC_BATCH_SIZE = 20;      // 每批处理20只股票的K线

// 通用分步同步状态（内存中维护，进程重启后从DB推断）
let stepSyncState = {
  kline: { offset: 0, total: 0, codes: [], done: false },
  indicators: { offset: 0, total: 0, codes: [], done: false },
  finance: { offset: 0, total: 0, codes: [], done: false },
  score: { offset: 0, total: 0, codes: [], done: false },
};

function getTimeLeft(startTime) {
  return SYNC_STEP_TIMEOUT - (Date.now() - startTime);
}

app.post('/api/sync/step', async (req, res) => {
  const step = req.body?.step || req.query?.step;
  const batchSize = parseInt(req.body?.batchSize || req.query?.batchSize) || SYNC_BATCH_SIZE;

  if (!step) return res.status(400).json({ error: '缺少step参数' });

  try {
    const startTime = Date.now();
    let result = {};

    if (step === 'kline') {
      // === K线分批同步 ===
      // 如果是第一次调用或codes为空，初始化
      if (stepSyncState.kline.codes.length === 0 || stepSyncState.kline.done) {
        let codes = await stockPool.getPoolCodes();
        if (codes.length === 0) {
          const infoRows = await dbAll('SELECT code FROM stock_info');
          codes = infoRows.map(r => r.code).filter(c => /^\d{6}$/.test(c));
        }
        if (codes.length === 0) {
          // 用内置热门列表
          codes = ['600519','000858','601318','600036','000333','600276','300750','601012','600900','601899','002594','601166','600030','000001','600887','601398','601288','600000','601988','600050','000725','600585','601668','601390','002475','300059','600438','002352','601888','600309','603288','000568','000596','600809','300124','002415','603501','688981','688012','688256','300760','002241','600048','601628','601601','600104','601857','600028','601088','600111','600547','601225','002460','300274'];
        }
        stepSyncState.kline = { offset: 0, total: codes.length, codes, done: false };
      }

      const state = stepSyncState.kline;
      const klineHistoryDays = req.body?.full ? 730 : 60;
      const klineStart = dayjs().subtract(klineHistoryDays, 'day').format('YYYYMMDD');
      const klineEnd = dayjs().format('YYYYMMDD');
      let processed = 0, klineCount = 0, errors = 0;

      // 先拉取本批的实时行情（full模式下跳过以节省时间给K线拉取）
      const isFullMode = req.body?.full === true;
      const batchCodes = isFullMode ? [] : state.codes.slice(state.offset, state.offset + batchSize * 5);
      if (batchCodes.length > 0) {
        try {
          const quotes = await tq.getQuickStockList(batchCodes);
          const nowStr = dayjs().format('YYYY-MM-DD HH:mm:ss');
          const today = dayjs().format('YYYYMMDD');
          const infoData = quotes.filter(q => q.code && q.name).map(q => ({
            code: String(q.code).replace(/^(sh|sz|bj)/, ''),
            name: q.name, market: q.market || (q.code.startsWith('6') ? 'SH' : 'SZ'),
            is_st: q.is_st || (q.name && q.name.includes('ST') ? 1 : 0),
            total_mv: q.total_mv, circ_mv: q.circ_mv
          }));
          await dbBatch(infoData.map(r => ({ sql: `INSERT OR REPLACE INTO stock_info (code,name,market,is_st,total_mv,circ_mv,updated_at) VALUES (?,?,?,?,?,?,?)`, args: [r.code, r.name, r.market, r.is_st, r.total_mv, r.circ_mv, nowStr] })));
          const valData = quotes.filter(q => q.code && q.pe != null).map(q => ({
            code: String(q.code).replace(/^(sh|sz|bj)/, ''), today, pe: q.pe
          }));
          if (valData.length > 0) await dbBatch(valData.map(r => ({ sql: `INSERT OR REPLACE INTO valuation (code,trade_date,pe) VALUES (?,?,?)`, args: [r.code, r.today, r.pe] })));
        } catch(e) { console.log('[step:kline] 行情拉取失败:', e.message); }
      }

      // 拉取K线（full模式并发拉取提升效率）
      // 策略：优先用东方财富（含turnover），失败则回退到腾讯+自行计算turnover
      const klineBatchSize = isFullMode ? 3 : batchSize;
      while (state.offset < state.total && processed < klineBatchSize && getTimeLeft(startTime) > 8000) {
        // 并发拉取本批K线（最多3只并发）
        const remaining = klineBatchSize - processed;
        const concurrentBatch = Math.min(3, remaining, state.total - state.offset);
        const batchCodes = [];
        for (let b = 0; b < concurrentBatch; b++) {
          batchCodes.push(state.codes[state.offset + b]);
        }
        
        // 优先尝试东方财富K线（含换手率）
        const emPromises = batchCodes.map(code =>
          emKline.getDailyKline(code, klineStart, klineEnd).catch(e => {
            errors++;
            console.error(`[step:kline] 东财失败 ${code}:`, e.message);
            return [];
          })
        );
        const emResults = await Promise.all(emPromises);
        
        // 对东方财富失败或数据不新鲜的股票，回退到腾讯K线并计算换手率
        const fallbackCodes = [];
        const freshCutoff = dayjs().subtract(2, 'day').format('YYYYMMDD'); // 最近2个自然日内必须有K线
        for (let i = 0; i < emResults.length; i++) {
          const kl = emResults[i];
          if (!kl || kl.length === 0) { fallbackCodes.push(batchCodes[i]); continue; }
          // 东财返回了数据但最新日期滞后(缺最近2个自然日以上)→视为不完整,用腾讯补齐
          const lastDate = kl[kl.length - 1]?.trade_date;
          if (lastDate && String(lastDate) < freshCutoff) {
            fallbackCodes.push(batchCodes[i]);
          }
        }
        
        let fallbackResults = [];
        if (fallbackCodes.length > 0) {
          // 获取流通市值用于计算换手率
          const circMvMap = {};
          for (const fc of fallbackCodes) {
            const info = await dbGet('SELECT circ_mv, total_mv FROM stock_info WHERE code = ?', [fc]);
            if (info) circMvMap[fc] = info;
          }
          
          const tqPromises = fallbackCodes.map(code =>
            tq.getDailyKline(code,
              dayjs(klineStart).format('YYYY-MM-DD'),
              dayjs(klineEnd).format('YYYY-MM-DD')
            ).catch(e => {
              errors++;
              console.error(`[step:kline] 腾讯回退失败 ${code}:`, e.message);
              return [];
            })
          );
          const tqResults = await Promise.all(tqPromises);
          
          // 为腾讯K线计算换手率: turnover = volume(手) * 100 * close / (circ_mv * 1e8) * 100
          fallbackResults = tqResults.map((klines, idx) => {
            const code = fallbackCodes[idx];
            const info = circMvMap[code];
            if (!klines || klines.length === 0) return [];
            return klines.map(k => {
              let turnover = null;
              if (info && info.circ_mv && info.circ_mv > 0 && k.close > 0 && k.volume > 0) {
                // circ_mv是亿元，volume是手(100股/手)
                // turnover(%) = volume(手) * 100(股/手) * close / (circ_mv * 1e8) * 100
                turnover = Math.round((k.volume * 100 * k.close / (info.circ_mv * 1e8) * 100) * 100) / 100;
              }
              return { ...k, turnover };
            });
          });
        }
        
        // 合并结果写入DB（回退的股票只用腾讯数据，避免与东财部分数据重复/复权不一致）
        const fallbackSet = new Set(fallbackCodes);
        const allKlines = [];
        for (let i = 0; i < emResults.length; i++) {
          if (emResults[i] && emResults[i].length > 0 && !fallbackSet.has(batchCodes[i])) {
            allKlines.push(...emResults[i]);
          }
        }
        for (const fr of fallbackResults) {
          if (fr && fr.length > 0) allKlines.push(...fr);
        }
        
        if (allKlines.length > 0) {
          for (let j = 0; j < allKlines.length; j += 200) {
            await dbBatch(allKlines.slice(j, j + 200).map(k => ({ sql: `INSERT OR REPLACE INTO daily_kline (code,trade_date,open,close,high,low,volume,amount,amplitude,pct_chg,chg,turnover) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [k.code, k.trade_date, k.open, k.close, k.high, k.low, k.volume, k.amount, k.amplitude, k.pct_chg, k.chg, k.turnover] })));
          }
          klineCount += allKlines.length;
        }
        
        state.offset += concurrentBatch;
        processed += concurrentBatch;
      }

      state.done = state.offset >= state.total;
      result = {
        step: 'kline', processed, klineCount, errors,
        progress: `${state.offset}/${state.total}`,
        progressPct: Math.round(state.offset / state.total * 100),
        done: state.done,
        timeElapsed: Date.now() - startTime,
      };

      if (state.done) {
        stepSyncState.kline = { offset: 0, total: 0, codes: [], done: false };
      }
    } else if (step === 'fix-turnover') {
      // === 用DB中已有数据批量计算换手率 ===
      // 单条SQL批量更新，避免逐条UPDATE太慢
      const startTimeFT = Date.now();
      
      // 使用子查询批量更新（PostgreSQL语法）
      await dbRun(`
        UPDATE daily_kline SET turnover = sub.turnover
        FROM (
          SELECT k.code, k.trade_date,
            ROUND(CAST(k.volume * 100 * k.close / (i.circ_mv * 100000000) * 100 AS numeric), 2) as turnover
          FROM daily_kline k
          JOIN stock_info i ON k.code = i.code
          WHERE (k.turnover IS NULL OR k.turnover = 0)
            AND i.circ_mv > 0 AND k.volume > 0 AND k.close > 0
          LIMIT 5000
        ) sub
        WHERE daily_kline.code = sub.code AND daily_kline.trade_date = sub.trade_date
      `);
      
      const totalNull = (await dbGet(`SELECT COUNT(*) as c FROM daily_kline k JOIN stock_info i ON k.code = i.code WHERE (k.turnover IS NULL OR k.turnover = 0) AND i.circ_mv > 0`))?.c || 0;
      
      result = {
        step: 'fix-turnover', remaining: totalNull,
        done: totalNull === 0,
        timeElapsed: Date.now() - startTime,
      };
    } else if (step === 'indicators') {
      // === 技术指标分批计算 ===
      if (stepSyncState.indicators.codes.length === 0 || stepSyncState.indicators.done) {
        const allCodeRows = await dbAll('SELECT DISTINCT code FROM daily_kline');
        stepSyncState.indicators = { offset: 0, total: allCodeRows.length, codes: allCodeRows.map(r => r.code), done: false };
      }

      const state = stepSyncState.indicators;
      const indBatchSize = batchSize * 3; // 指标计算是本地操作，可以快一些
      let processed = 0, indCount = 0;

      while (state.offset < state.total && processed < indBatchSize && getTimeLeft(startTime) > 5000) {
        const code = state.codes[state.offset];
        try {
          // 只查必要字段，减少远程DB传输量
          const ks = await dbAll(`SELECT trade_date,close,high,low,volume FROM daily_kline WHERE code = ? ORDER BY trade_date ASC`, [code]);
          if (ks.length >= 25) {
            const inds = calcAllIndicators(ks);
            // 只写入最近250天的指标，减少DB写入量
            const recentInds = inds.slice(-250).filter(r => r.ma5 !== null);
            // 使用多行VALUES单一INSERT，减少DB往返
            if (recentInds.length > 0) {
              const valuesStr = recentInds.map(r =>
                `('${code}','${r.trade_date}',${r.ma5 ?? 'NULL'},${r.ma10 ?? 'NULL'},${r.ma20 ?? 'NULL'},${r.ma60 ?? 'NULL'},${r.ma120 ?? 'NULL'},${r.ma250 ?? 'NULL'},${r.vol_ma5 ?? 'NULL'},${r.vol_ma20 ?? 'NULL'},${r.macd_dif ?? 'NULL'},${r.macd_dea ?? 'NULL'},${r.macd_bar ?? 'NULL'},${r.rsi6 ?? 'NULL'},${r.rsi14 ?? 'NULL'},${r.kdj_k ?? 'NULL'},${r.kdj_d ?? 'NULL'},${r.kdj_j ?? 'NULL'},${r.boll_upper ?? 'NULL'},${r.boll_mid ?? 'NULL'},${r.boll_lower ?? 'NULL'})`
              ).join(',');
              await dbRun(`INSERT INTO technical_indicators (code,trade_date,ma5,ma10,ma20,ma60,ma120,ma250,vol_ma5,vol_ma20,macd_dif,macd_dea,macd_bar,rsi6,rsi14,kdj_k,kdj_d,kdj_j,boll_upper,boll_mid,boll_lower) VALUES ${valuesStr} ON CONFLICT (code,trade_date) DO UPDATE SET ma5=EXCLUDED.ma5,ma10=EXCLUDED.ma10,ma20=EXCLUDED.ma20,ma60=EXCLUDED.ma60,ma120=EXCLUDED.ma120,ma250=EXCLUDED.ma250,vol_ma5=EXCLUDED.vol_ma5,vol_ma20=EXCLUDED.vol_ma20,macd_dif=EXCLUDED.macd_dif,macd_dea=EXCLUDED.macd_dea,macd_bar=EXCLUDED.macd_bar,rsi6=EXCLUDED.rsi6,rsi14=EXCLUDED.rsi14,kdj_k=EXCLUDED.kdj_k,kdj_d=EXCLUDED.kdj_d,kdj_j=EXCLUDED.kdj_j,boll_upper=EXCLUDED.boll_upper,boll_mid=EXCLUDED.boll_mid,boll_lower=EXCLUDED.boll_lower`);
            }
            indCount++;
          }
        } catch(e) { console.log(`[indicators] ${code} error:`, e.message); }
        state.offset++;
        processed++;
      }

      state.done = state.offset >= state.total;
      result = {
        step: 'indicators', processed, indCount,
        progress: `${state.offset}/${state.total}`,
        progressPct: Math.round(state.offset / state.total * 100),
        done: state.done,
        timeElapsed: Date.now() - startTime,
      };

      if (state.done) {
        stepSyncState.indicators = { offset: 0, total: 0, codes: [], done: false };
      }
    } else if (step === 'score') {
      // === 评分（含财务数据补全）===
      // 评分本身是一步完成，但可以限制只处理部分股票
      const fullScore = req.body?.full !== false;
      await scoreAllStocks(fullScore, userSettings);
      result = { step: 'score', done: true, timeElapsed: Date.now() - startTime };


    } else if (step === 'score-codes') {
      // === 指定股票列表评分（客户端控制进度，不依赖服务器内存state）===
      const codesParam = req.query.codes || req.body?.codes;
      const codeList = (codesParam || '').split(',').map(s => s.trim()).filter(s => /^\d{6}$/.test(s));
      if (codeList.length === 0) {
        result = { step: 'score-codes', error: 'no codes provided', processed: 0 };
      } else {
        const today = dayjs().format('YYYYMMDD');
        let processed = 0, scoreCount = 0;
        const results = [];
        for (const code of codeList) {
          if (getTimeLeft(startTime) < 5000) break;
          try {
            const info = await dbGet('SELECT name FROM stock_info WHERE code = ?', [code]);
            const name = info?.name || code;
            const quality = await calcQualityScore(code);
            if (quality) {
              const valuation = await calcValuationScore(code);
              const technical = await calcTechnicalScore(code);
              const total = calcTotalScore(code, quality, valuation, technical, null, userSettings);
              const latestKline = await dbGet('SELECT close FROM daily_kline WHERE code = ? ORDER BY trade_date DESC LIMIT 1', [code]);
              const currentPrice = latestKline?.close;
              let targetPrice = null, stopLoss = null;
              if (currentPrice) {
                const industry = classifyIndustry(code, name);
                if (total.signal === 'buy') { const upside = industry.isNewEconomy?0.4:industry.isOldman?0.2:0.3; targetPrice = +(currentPrice*(1+upside)).toFixed(2); stopLoss = +(currentPrice*(industry.isOldman?0.92:0.85)).toFixed(2); }
                else { stopLoss = +(currentPrice*(industry.isOldman?0.92:0.85)).toFixed(2); }
              }
              let positionPct = 5;
              if (total.signal === 'buy') positionPct = total.total_score >= 75 ? 15 : 10;
              else positionPct = 0;
              results.push({ code, name, trade_date: today, strategy: 'value',
                quality_score: quality.score, valuation_score: valuation.score,
                technical_score: technical.score, total_score: total.total_score,
                signal: total.signal, current_price: currentPrice, target_price: targetPrice, stop_loss: stopLoss, position_pct: positionPct,
                quality_detail: JSON.stringify({ ...quality.breakdown, industry: quality.industry, isNewEconomy: quality.isNewEconomy, isOldman: quality.isOldman, isDistressed: quality.isDistressed }),
                quality_latest: null,
                valuation_detail: JSON.stringify(valuation),
                technical_detail: JSON.stringify({ signals: technical.signals, rsi14: technical.rsi14 }),
                reason: JSON.stringify(total.reason),
                crowding_score: null, crowding_level: null,
              });
              scoreCount++;
            }
          } catch(e) { console.error(`[score-codes] ${code} error:`, e.message); }
          processed++;
        }
        if (results.length > 0) {
          const cols = ['code','name','trade_date','strategy','quality_score','valuation_score','technical_score','total_score','signal','current_price','target_price','stop_loss','position_pct','quality_detail','quality_latest','valuation_detail','technical_detail','reason','fund_score','sentiment_score','crowding_score','crowding_level'];
          // 用 ? 占位符让db.js自动转换为$N（与score-batch保持一致）
          const placeholders = results.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',');
          const flatVals = [];
          results.forEach(r => cols.forEach(c => flatVals.push(r[c] ?? null)));
          const updateSet = cols.filter(c => c !== 'code' && c !== 'trade_date' && c !== 'strategy').map(c => `${c} = EXCLUDED.${c}`).join(', ');
          await dbRun(`INSERT INTO stock_score (${cols.join(',')}) VALUES ${placeholders}
            ON CONFLICT (code, trade_date, strategy) DO UPDATE SET ${updateSet}`, flatVals);
        }
        result = { step: 'score-codes', processed, scoreCount, remaining: codeList.length - processed, timeElapsed: Date.now() - startTime };
      }
    } else if (step === 'score-list') {
      // 返回当前stock_pool中的所有code（让客户端控制分批）
      const rows = await dbAll('SELECT code FROM stock_pool WHERE in_pool = 1 ORDER BY code');
      result = { step: 'score-list', total: rows.length, codes: rows.map(r => r.code) };

    } else if (step === 'score-batch') {
      // === 分批评分（解决50秒超时问题）===
      if (stepSyncState.score.codes.length === 0 || stepSyncState.score.done) {
        const allCodeRows = await dbAll('SELECT code, name FROM stock_pool WHERE in_pool = 1');
        stepSyncState.score = { offset: 0, total: allCodeRows.length, codes: allCodeRows, done: false };
      }
      const state = stepSyncState.score;
      const today = dayjs().format('YYYYMMDD');
      let processed = 0, scoreCount = 0;
      const results = [];

      while (state.offset < state.total && processed < batchSize && getTimeLeft(startTime) > 5000) {
        const { code, name } = state.codes[state.offset];
        try {
          const quality = await calcQualityScore(code);
          if (quality) {
            const valuation = await calcValuationScore(code);
            const technical = await calcTechnicalScore(code);
            const total = calcTotalScore(code, quality, valuation, technical, null, userSettings);

            const latestKline = await dbGet('SELECT close FROM daily_kline WHERE code = ? ORDER BY trade_date DESC LIMIT 1', [code]);
            const currentPrice = latestKline?.close;
            let targetPrice = null, stopLoss = null;
            if (currentPrice) {
              const industry = classifyIndustry(code, name);
              if (total.signal === 'buy') {
                const upside = industry.isNewEconomy ? 0.4 : industry.isOldman ? 0.2 : 0.3;
                targetPrice = +(currentPrice * (1 + upside)).toFixed(2);
                stopLoss = +(currentPrice * (industry.isOldman ? 0.92 : 0.85)).toFixed(2);
              } else {
                stopLoss = +(currentPrice * (industry.isOldman ? 0.92 : 0.85)).toFixed(2);
              }
            }
            let positionPct = 5;
            if (total.signal === 'buy') positionPct = total.total_score >= 75 ? 15 : 10;
            else if (total.signal === 'watch' || total.signal === 'sell') positionPct = 0;

            results.push({
              code, name, trade_date: today, strategy: 'value',
              quality_score: quality.score, valuation_score: valuation.score,
              technical_score: technical.score, total_score: total.total_score,
              signal: total.signal, current_price: currentPrice,
              target_price: targetPrice, stop_loss: stopLoss, position_pct: positionPct,
              quality_detail: JSON.stringify({ ...quality.breakdown, industry: quality.industry, isNewEconomy: quality.isNewEconomy, isOldman: quality.isOldman, isDistressed: quality.isDistressed }),
              quality_latest: null,
              valuation_detail: JSON.stringify(valuation),
              technical_detail: JSON.stringify({ signals: technical.signals, rsi14: technical.rsi14 }),
              reason: JSON.stringify(total.reason),
              crowding_score: null, crowding_level: null,
            });
            scoreCount++;
          }
        } catch(e) { console.error(`  [score-batch] ${code} error:`, e.message); }
        state.offset++;
        processed++;
      }

      // 批量写入本批结果
      if (results.length > 0) {
        const cols = ['code','name','trade_date','strategy','quality_score','valuation_score','technical_score','total_score','signal','current_price','target_price','stop_loss','position_pct','quality_detail','quality_latest','valuation_detail','technical_detail','reason','fund_score','sentiment_score','crowding_score','crowding_level'];
        const valuesStr = results.map(r =>
          `('${(r.code||'').replace(/'/g,"''")}','${(r.name||'').replace(/'/g,"''")}','${r.trade_date}','${r.strategy}',${r.quality_score ?? 'NULL'},${r.valuation_score ?? 'NULL'},${r.technical_score ?? 'NULL'},${r.total_score ?? 'NULL'},'${r.signal || ''}',${r.current_price ?? 'NULL'},${r.target_price ?? 'NULL'},${r.stop_loss ?? 'NULL'},${r.position_pct ?? 'NULL'},'${(r.quality_detail||'').replace(/'/g,"''")}',NULL,'${(r.valuation_detail||'').replace(/'/g,"''")}','${(r.technical_detail||'').replace(/'/g,"''")}','${(r.reason||'').replace(/'/g,"''")}',0,0,${r.crowding_score ?? 'NULL'},${r.crowding_level ? `'${r.crowding_level}'` : 'NULL'})`
        ).join(',');
        await dbRun(`INSERT INTO stock_score (${cols.join(',')}) VALUES ${valuesStr} ON CONFLICT (code,trade_date,strategy) DO UPDATE SET quality_score=EXCLUDED.quality_score,valuation_score=EXCLUDED.valuation_score,technical_score=EXCLUDED.technical_score,total_score=EXCLUDED.total_score,signal=EXCLUDED.signal,current_price=EXCLUDED.current_price,target_price=EXCLUDED.target_price,stop_loss=EXCLUDED.stop_loss,position_pct=EXCLUDED.position_pct,quality_detail=EXCLUDED.quality_detail,quality_latest=EXCLUDED.quality_latest,valuation_detail=EXCLUDED.valuation_detail,technical_detail=EXCLUDED.technical_detail,reason=EXCLUDED.reason`);
      }

      state.done = state.offset >= state.total;
      result = {
        step: 'score-batch', processed, scoreCount,
        progress: `${state.offset}/${state.total}`,
        progressPct: Math.round(state.offset / state.total * 100),
        done: state.done,
        timeElapsed: Date.now() - startTime,
      };
      if (state.done) {
        stepSyncState.score = { offset: 0, total: 0, codes: [], done: false };
      }

    } else if (step === 'finance') {
      // === 财务数据分批拉取 ===
      if (stepSyncState.finance.codes.length === 0 || stepSyncState.finance.done) {
        const allCodeRows = await dbAll('SELECT code FROM stock_pool WHERE in_pool=1');
        stepSyncState.finance = { offset: 0, total: allCodeRows.length, codes: allCodeRows.map(r => r.code), done: false };
      }
      const state = stepSyncState.finance;
      let processed = 0, finCount = 0, errors = 0;
      while (state.offset < state.total && processed < batchSize * 2 && getTimeLeft(startTime) > 5000) {
        const code = state.codes[state.offset];
        try {
          const hasFin = (await dbGet('SELECT COUNT(*) as c FROM financial_indicator WHERE code = ?', [code]))?.c || 0;
          if (hasFin === 0) {
            const ok = await syncFinancialData(code);
            if (ok) finCount++;
            else { errors++; console.log(`[finance] ${code} returned false`); }
          }
        } catch(e) { errors++; }
        state.offset++;
        processed++;
        await new Promise(r => setTimeout(r, 150));
      }
      state.done = state.offset >= state.total;
      result = {
        step: 'finance', processed, finCount, errors,
        progress: `${state.offset}/${state.total}`,
        progressPct: Math.round(state.offset / state.total * 100),
        done: state.done,
        timeElapsed: Date.now() - startTime,
      };
      if (state.done) {
        stepSyncState.finance = { offset: 0, total: 0, codes: [], done: false };
      }

    } else if (step === 'finance-upload') {
      // === 从POST body直接写入财务数据（绕过Render无法访问东方财富API的问题）===
      const records = req.body?.records || [];
      if (records.length === 0) {
        result = { step: 'finance-upload', error: 'no records', written: 0 };
      } else {
        let written = 0;
        const columns = ['code', 'report_date', 'roe', 'roa', 'gross_margin', 'net_margin',
          'revenue', 'revenue_yoy', 'net_profit', 'net_profit_yoy', 'debt_ratio',
          'current_ratio', 'ocf', 'eps', 'bps', 'ocf_per_share', 'roic', 'report_type'];
        // 使用多行VALUES INSERT + ON CONFLICT
        const valuesStr = records.map(r =>
          `('${r.code}','${r.report_date}',${r.roe ?? 'NULL'},${r.roa ?? 'NULL'},${r.gross_margin ?? 'NULL'},${r.net_margin ?? 'NULL'},${r.revenue ?? 'NULL'},${r.revenue_yoy ?? 'NULL'},${r.net_profit ?? 'NULL'},${r.net_profit_yoy ?? 'NULL'},${r.debt_ratio ?? 'NULL'},${r.current_ratio ?? 'NULL'},${r.ocf ?? 'NULL'},${r.eps ?? 'NULL'},${r.bps ?? 'NULL'},${r.ocf_per_share ?? 'NULL'},${r.roic ?? 'NULL'},'${r.report_type || ''}')`
        ).join(',');
        await dbRun(`INSERT INTO financial_indicator (${columns.join(',')}) VALUES ${valuesStr} ON CONFLICT (code,report_date) DO UPDATE SET roe=EXCLUDED.roe,roa=EXCLUDED.roa,gross_margin=EXCLUDED.gross_margin,net_margin=EXCLUDED.net_margin,revenue=EXCLUDED.revenue,revenue_yoy=EXCLUDED.revenue_yoy,net_profit=EXCLUDED.net_profit,net_profit_yoy=EXCLUDED.net_profit_yoy,debt_ratio=EXCLUDED.debt_ratio,current_ratio=EXCLUDED.current_ratio,ocf=EXCLUDED.ocf,eps=EXCLUDED.eps,bps=EXCLUDED.bps,ocf_per_share=EXCLUDED.ocf_per_share,roic=EXCLUDED.roic,report_type=EXCLUDED.report_type`);
        written = records.length;
        result = { step: 'finance-upload', written, timeElapsed: Date.now() - startTime };
      }

    } else if (step === 'valuation-upload') {
      // === 批量上传估值数据(PE/PB/股息率等) ===
      const records = req.body?.records || [];
      if (records.length === 0) {
        result = { step: 'valuation-upload', error: 'no records', written: 0 };
      } else {
        const today = dayjs().format('YYYYMMDD');
        const valuesStr = records.map(r =>
          `('${r.code}','${r.trade_date || today}',${r.pe ?? 'NULL'},${r.pe_ttm ?? 'NULL'},${r.pb ?? 'NULL'},${r.ps ?? 'NULL'},${r.dv_ratio ?? 'NULL'},${r.total_mv ?? 'NULL'},${r.circ_mv ?? 'NULL'})`
        ).join(',');
        await dbRun(`INSERT INTO valuation (code,trade_date,pe,pe_ttm,pb,ps,dv_ratio,total_mv,circ_mv) VALUES ${valuesStr}
          ON CONFLICT(code,trade_date) DO UPDATE SET pe=EXCLUDED.pe,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,ps=EXCLUDED.ps,dv_ratio=EXCLUDED.dv_ratio,total_mv=EXCLUDED.total_mv,circ_mv=EXCLUDED.circ_mv`);
        // 同时更新stock_score的pe字段（最新的）
        for (const r of records) {
          if (r.pe != null) {
            try { await dbRun(`UPDATE stock_score SET pe = ? WHERE code = ? AND strategy = 'value' AND trade_date = (SELECT MAX(trade_date) FROM stock_score WHERE code = ? AND strategy='value')`, [r.pe, r.code, r.code]); } catch(e) {}
          }
        }
        result = { step: 'valuation-upload', written: records.length, timeElapsed: Date.now() - startTime };
      }

    } else if (step === 'pool') {
      // === 股票池刷新（分批拉行情）===
      const r = await stockPool.updateStockPoolBatch(200, startTime);
      result = { step: 'pool', done: r.done, ...r, timeElapsed: Date.now() - startTime };

    } else if (step === 'status') {
      // 查询当前同步状态
      const poolCount = (await dbGet('SELECT COUNT(*) as c FROM stock_pool WHERE in_pool=1'))?.c || 0;
      const stockCount = (await dbGet('SELECT COUNT(*) as c FROM stock_info'))?.c || 0;
      const klineCount = (await dbGet('SELECT COUNT(*) as c FROM daily_kline'))?.c || 0;
      const indCount = (await dbGet('SELECT COUNT(*) as c FROM technical_indicators'))?.c || 0;
      const scoreCount = (await dbGet('SELECT COUNT(DISTINCT code) as c FROM stock_score'))?.c || 0;
      const crowdCount = (await dbGet('SELECT COUNT(DISTINCT code) as c FROM crowding_score'))?.c || 0;
      const financeCount = (await dbGet('SELECT COUNT(DISTINCT code) as c FROM financial_indicator'))?.c || 0;
      result = {
        step: 'status',
        pool: poolCount, stocks: stockCount, klines: klineCount,
        indicators: indCount, scores: scoreCount, crowding: crowdCount,
        finance: financeCount,
        klineSync: stepSyncState.kline.done ? 'idle' : `${stepSyncState.kline.offset}/${stepSyncState.kline.total}`,
        indicatorSync: stepSyncState.indicators.done ? 'idle' : `${stepSyncState.indicators.offset}/${stepSyncState.indicators.total}`,
        financeSync: stepSyncState.finance.done ? 'idle' : `${stepSyncState.finance.offset}/${stepSyncState.finance.total}`,
      };

    } else if (step === 'full-pipeline') {
      // === 一键全流程（前端轮询调用，每次返回下一步）===
      // 检查各模块状态，自动执行下一步
      const status = await getSyncStatus();
      let nextStep = null;
      let stepResult = null;

      if (status.pool < 100) {
        // 先确保股票池有数据
        const r = await stockPool.updateStockPoolBatch(200, startTime);
        nextStep = r.done ? 'kline' : 'pool';
        stepResult = { subStep: 'pool', ...r };
      } else if (status.indicators === 0 && status.klines > 0) {
        // 有K线但没指标→先算指标
        nextStep = 'indicators';
        // 执行一批指标计算
        const r = await runStepIndicators(startTime, batchSize * 3);
        stepResult = r;
      } else if (status.klineLatest !== dayjs().format('YYYYMMDD')) {
        // K线最新日期落后于今天：按新鲜度补增量，不能再用累计行数判断。
        nextStep = 'kline';
        // full-pipeline 是定时增量任务：固定走 60 天窗口，避免工作流传 full:true
        // 时拉 730 天导致单次 HTTP 超时。730 天历史补数仍通过 step:kline 手动执行。
        const r = await runStepKline(startTime, batchSize, false);
        stepResult = r;
      } else if (status.indicatorLatest !== status.klineLatest) {
        // 指标落后于K线：补算指标，不能只看累计指标总量。
        nextStep = 'indicators';
        const r = await runStepIndicators(startTime, batchSize * 3);
        stepResult = r;
      } else if (status.finance < status.pool * 0.5) {
        // 财务数据不够→拉财务
        nextStep = 'finance';
        const r = await runStepFinance(startTime, batchSize * 2);
        stepResult = r;
      } else if (status.scores < status.pool && process.env.DISABLE_LEGACY_SCORING !== 'true') {
        // 评分不够→评分（旧引擎，可通过 DISABLE_LEGACY_SCORING=true 关闭）
        nextStep = 'score';
        await scoreAllStocks(false, userSettings);
        stepResult = { subStep: 'score', done: true };
      } else if (status.scores < status.pool) {
        // 线上评分已关闭（新打分由本地 Phase1.5 引擎经 /api/scores/upload 上传）
        nextStep = null;
        stepResult = { subStep: 'score-disabled', done: true, note: '线上评分已关闭，等待本地上传' };
      } else {
        // 全部完成
        nextStep = null;
        stepResult = { subStep: 'all-done', done: true };
      }

      result = { step: 'full-pipeline', nextStep, ...stepResult, status, timeElapsed: Date.now() - startTime };

    } else {
      return res.status(400).json({ error: `未知的step: ${step}` });
    }

    res.json(result);
  } catch(e) {
    console.error('[step-sync] 错误:', e);
    res.status(500).json({ error: e.message, step: req.body?.step || req.query?.step });
  }
});

// 清理退市/无效股票：从所有相关表删除指定code
app.post('/api/cleanup/remove-stocks', async (req, res) => {
  try {
    const codes = (req.body?.codes || []).map(c => String(c).replace(/^(sh|sz|bj)/, '')).filter(c => /^\d{6}$/.test(c));
    if (codes.length === 0) return res.status(400).json({ error: 'codes 必须是非空6位数字数组', given: req.body?.codes });
    const tables = ['stock_info', 'stock_score', 'stock_universe', 'valuation', 'crowding_score', 'financial_indicator', 'daily_kline', 'technical_indicators'];
    const summary = {};
    for (const t of tables) {
      try {
        const ph = codes.map((_, i) => `$${i + 1}`).join(',');
        const r = await dbRun(`DELETE FROM ${t} WHERE code IN (${ph})`, codes);
        summary[t] = r?.rowCount ?? r?.changes ?? 'ok';
      } catch (e) { summary[t] = 'ERR:' + e.message.substring(0, 80); }
    }
    res.json({ removed: codes, summary, time: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 辅助函数：获取同步状态摘要
async function getSyncStatus() {
  const poolCount = parseInt((await dbGet('SELECT COUNT(*) as c FROM stock_pool WHERE in_pool=1'))?.c || 0, 10);
  const stockCount = parseInt((await dbGet('SELECT COUNT(*) as c FROM stock_info'))?.c || 0, 10);
  const klineCount = parseInt((await dbGet('SELECT COUNT(*) as c FROM daily_kline'))?.c || 0, 10);
  const indCount = parseInt((await dbGet('SELECT COUNT(*) as c FROM technical_indicators'))?.c || 0, 10);
  const scoreCount = parseInt((await dbGet('SELECT COUNT(DISTINCT code) as c FROM stock_score'))?.c || 0, 10);
  let crowdCount = 0;
  try { crowdCount = parseInt((await dbGet('SELECT COUNT(DISTINCT code) as c FROM crowding_score'))?.c || 0, 10); } catch(e) { /* 表可能已删除 */ }
  const financeCount = parseInt((await dbGet('SELECT COUNT(DISTINCT code) as c FROM financial_indicator'))?.c || 0, 10);
  const klineLatest = (await dbGet('SELECT MAX(trade_date) as d FROM daily_kline'))?.d || null;
  const indicatorLatest = (await dbGet('SELECT MAX(trade_date) as d FROM technical_indicators'))?.d || null;
  return {
    pool: poolCount, stocks: stockCount, klines: klineCount, indicators: indCount,
    scores: scoreCount, crowding: crowdCount, finance: financeCount,
    klineLatest, indicatorLatest,
  };
}

// 辅助函数：执行一批K线同步
async function runStepKline(startTime, batchSize, full) {
  if (stepSyncState.kline.codes.length === 0 || stepSyncState.kline.done) {
    let codes = await stockPool.getPoolCodes();
    if (codes.length === 0) {
      const infoRows = await dbAll('SELECT code FROM stock_info');
      codes = infoRows.map(r => r.code).filter(c => /^\d{6}$/.test(c));
    }
    if (codes.length === 0) return { done: true, processed: 0, klineCount: 0 };
    stepSyncState.kline = { offset: 0, total: codes.length, codes, done: false };
  }

  const state = stepSyncState.kline;
  const klineHistoryDays = full ? 730 : 60;
  const klineStart = dayjs().subtract(klineHistoryDays, 'day').format('YYYYMMDD');
  const klineEnd = dayjs().format('YYYYMMDD');
  let processed = 0, klineCount = 0, errors = 0;

  // 行情
  const batchCodes = state.codes.slice(state.offset, state.offset + batchSize * 5);
  if (batchCodes.length > 0) {
    try {
      const quotes = await tq.getQuickStockList(batchCodes);
      const nowStr = dayjs().format('YYYY-MM-DD HH:mm:ss');
      const today = dayjs().format('YYYYMMDD');
      const infoData = quotes.filter(q => q.code && q.name).map(q => ({
        code: String(q.code).replace(/^(sh|sz|bj)/, ''),
        name: q.name, market: q.market || (q.code.startsWith('6') ? 'SH' : 'SZ'),
        is_st: q.is_st || (q.name && q.name.includes('ST') ? 1 : 0),
        total_mv: q.total_mv, circ_mv: q.circ_mv
      }));
      await dbBatch(infoData.map(r => ({ sql: `INSERT OR REPLACE INTO stock_info (code,name,market,is_st,total_mv,circ_mv,updated_at) VALUES (?,?,?,?,?,?,?)`, args: [r.code, r.name, r.market, r.is_st, r.total_mv, r.circ_mv, nowStr] })));
      const valData = quotes.filter(q => q.code && q.pe != null).map(q => ({
        code: String(q.code).replace(/^(sh|sz|bj)/, ''), today, pe: q.pe
      }));
      if (valData.length > 0) await dbBatch(valData.map(r => ({ sql: `INSERT OR REPLACE INTO valuation (code,trade_date,pe) VALUES (?,?,?)`, args: [r.code, r.today, r.pe] })));
    } catch(e) { console.log('[runStepKline] 行情拉取失败:', e.message); }
  }

  while (state.offset < state.total && processed < batchSize && getTimeLeft(startTime) > 5000) {
    // 并发拉取3只股票的K线，减少网络等待
    const concurrency = Math.min(3, batchSize - processed, state.total - state.offset);
    const batchCodes = [];
    for (let c = 0; c < concurrency; c++) {
      batchCodes.push(state.codes[state.offset + c]);
    }
    
    // 优先用东方财富K线（含换手率）
          const emPromises = batchCodes.map(code =>
            emKline.getDailyKline(code, klineStart, klineEnd).catch(e => {
              errors++;
              console.error(`[step:kline] 东财失败 ${code}:`, e.message);
              return [];
            })
          );
    const emResults = await Promise.all(emPromises);
    
    // 对东方财富失败的，回退到腾讯+计算换手率
    const allKlines = [];
    for (let i = 0; i < emResults.length; i++) {
      if (emResults[i] && emResults[i].length > 0) {
        allKlines.push(...emResults[i]);
      } else {
        // 回退到腾讯
        const code = batchCodes[i];
        try {
          const info = await dbGet('SELECT circ_mv FROM stock_info WHERE code = ?', [code]);
          const tqKlines = await tq.getDailyKline(code, 
            dayjs(klineStart).format('YYYY-MM-DD'), 
            dayjs(klineEnd).format('YYYY-MM-DD')
          );
          if (tqKlines && tqKlines.length > 0) {
            for (const k of tqKlines) {
              let turnover = null;
              if (info && info.circ_mv && info.circ_mv > 0 && k.close > 0 && k.volume > 0) {
                turnover = Math.round((k.volume * 100 * k.close / (info.circ_mv * 1e8) * 100) * 100) / 100;
              }
              allKlines.push({ ...k, turnover });
            }
          }
        } catch(e) { errors++; }
      }
      state.offset++;
      processed++;
    }
    
    if (allKlines.length > 0) {
      for (let j = 0; j < allKlines.length; j += 500) {
        await dbBatch(allKlines.slice(j, j + 500).map(k => ({ sql: `INSERT OR REPLACE INTO daily_kline (code,trade_date,open,close,high,low,volume,amount,amplitude,pct_chg,chg,turnover) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [k.code, k.trade_date, k.open, k.close, k.high, k.low, k.volume, k.amount, k.amplitude, k.pct_chg, k.chg, k.turnover] })));
      }
      klineCount += allKlines.length;
    }
    await tq.sleep(50);
  }

  state.done = state.offset >= state.total;
  const r = { subStep: 'kline', processed, klineCount, errors, progress: `${state.offset}/${state.total}`, progressPct: Math.round(state.offset / state.total * 100), done: state.done };
  if (state.done) stepSyncState.kline = { offset: 0, total: 0, codes: [], done: false };
  return r;
}

// 辅助函数：执行一批指标计算
async function runStepIndicators(startTime, batchSize) {
  if (stepSyncState.indicators.codes.length === 0 || stepSyncState.indicators.done) {
    const allCodeRows = await dbAll('SELECT DISTINCT code FROM daily_kline');
    stepSyncState.indicators = { offset: 0, total: allCodeRows.length, codes: allCodeRows.map(r => r.code), done: false };
  }
  const state = stepSyncState.indicators;
  let processed = 0, indCount = 0;
  while (state.offset < state.total && processed < batchSize && getTimeLeft(startTime) > 5000) {
    const code = state.codes[state.offset];
    try {
      const ks = await dbAll(`SELECT trade_date,close,high,low,volume FROM daily_kline WHERE code = ? ORDER BY trade_date ASC`, [code]);
      if (ks.length >= 25) {
        const inds = calcAllIndicators(ks);
        const recentInds = inds.slice(-250).filter(r => r.ma5 !== null);
        for (let j = 0; j < recentInds.length; j += 200) {
          await dbBatch(recentInds.slice(j, j + 200).map(r => ({ sql: `INSERT OR REPLACE INTO technical_indicators (code,trade_date,ma5,ma10,ma20,ma60,ma120,ma250,vol_ma5,vol_ma20,macd_dif,macd_dea,macd_bar,rsi6,rsi14,kdj_k,kdj_d,kdj_j,boll_upper,boll_mid,boll_lower) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [code, r.trade_date, r.ma5, r.ma10, r.ma20, r.ma60, r.ma120, r.ma250, r.vol_ma5, r.vol_ma20, r.macd_dif, r.macd_dea, r.macd_bar, r.rsi6, r.rsi14, r.kdj_k, r.kdj_d, r.kdj_j, r.boll_upper, r.boll_mid, r.boll_lower] })));
        }
        indCount++;
      }
    } catch(e) {}
    state.offset++;
    processed++;
  }
  state.done = state.offset >= state.total;
  const r = { subStep: 'indicators', processed, indCount, progress: `${state.offset}/${state.total}`, progressPct: Math.round(state.offset / state.total * 100), done: state.done };
  if (state.done) stepSyncState.indicators = { offset: 0, total: 0, codes: [], done: false };
  return r;
}

// 辅助函数：执行一批财务数据拉取
async function runStepFinance(startTime, batchSize) {
  if (stepSyncState.finance.codes.length === 0 || stepSyncState.finance.done) {
    const allCodeRows = await dbAll('SELECT code FROM stock_pool WHERE in_pool=1');
    if (allCodeRows.length === 0) return { done: true, processed: 0, finCount: 0 };
    stepSyncState.finance = { offset: 0, total: allCodeRows.length, codes: allCodeRows.map(r => r.code), done: false };
  }
  const state = stepSyncState.finance;
  let processed = 0, finCount = 0, errors = 0;
  while (state.offset < state.total && processed < batchSize && getTimeLeft(startTime) > 5000) {
    const code = state.codes[state.offset];
    try {
      const hasFin = (await dbGet('SELECT COUNT(*) as c FROM financial_indicator WHERE code = ?', [code]))?.c || 0;
      if (hasFin === 0) {
        const ok = await syncFinancialData(code);
        if (ok) finCount++;
      }
    } catch(e) { errors++; }
    state.offset++;
    processed++;
    await new Promise(r => setTimeout(r, 150));
  }
  state.done = state.offset >= state.total;
  const r = { subStep: 'finance', processed, finCount, errors, progress: `${state.offset}/${state.total}`, progressPct: Math.round(state.offset / state.total * 100), done: state.done };
  if (state.done) stepSyncState.finance = { offset: 0, total: 0, codes: [], done: false };
  return r;
}

// ========== 加密货币 API ==========
const binance = require('./src/data/binance');

app.get('/api/crypto/market', async (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({type:'start', total: binance.HOT_PAIRS.length})}\n\n`);
    const results = [];
    for (let i = 0; i < binance.HOT_PAIRS.length; i++) {
      try {
        const r = await binance.analyzeSymbol(binance.HOT_PAIRS[i]);
        if (r) { results.push(r); res.write(`data: ${JSON.stringify({type:'data', item:r, done:i+1, total: binance.HOT_PAIRS.length})}\n\n`); }
      } catch(e) {}
      await new Promise(r=>setTimeout(r,80));
    }
    const PRIORITY = ['BTC', 'ETH', 'SOL'];
    results.sort((a,b) => { const aIdx = PRIORITY.indexOf(a.symbol); const bIdx = PRIORITY.indexOf(b.symbol); if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx; if (aIdx !== -1) return -1; if (bIdx !== -1) return 1; return Math.abs(50-b.score) - Math.abs(50-a.score); });
    res.write(`data: ${JSON.stringify({type:'done', data:results})}\n\n`);
    res.end();
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/crypto/ticker/:symbol', async (req, res) => {
  try {
    const t = await binance.getTicker(req.params.symbol.toUpperCase()+'USDT');
    const klines = await binance.getKlines(req.params.symbol.toUpperCase()+'USDT','1d',100);
    const ind = binance.calcIndicators(klines);
    res.json({ticker: t, indicators: ind, klines: klines.slice(-60)});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// 数据库统计
app.get('/api/db/stats', async (req, res) => {
  try {
    const stocks = (await dbGet('SELECT COUNT(*) as c FROM stock_info')).c;
    const klines = (await dbGet('SELECT COUNT(*) as c FROM daily_kline')).c;
    const indicators = (await dbGet('SELECT COUNT(*) as c FROM technical_indicators')).c;
    const finance = (await dbGet('SELECT COUNT(*) as c FROM financial_indicator')).c;
    const latest = (await dbGet('SELECT MAX(trade_date) as d FROM daily_kline')).d;
    res.json({ stocks, klines, indicators, finance, latest_date: latest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== 监控健康检查（只读，供定时监控报警） ==========
app.get('/api/monitor/health', async (req, res) => {
  try {
    const db = {
      pool: Number((await dbGet('SELECT COUNT(*) as c FROM stock_pool WHERE in_pool=1'))?.c || 0),
      stocks: Number((await dbGet('SELECT COUNT(*) as c FROM stock_info'))?.c || 0),
      klines: Number((await dbGet('SELECT COUNT(*) as c FROM daily_kline'))?.c || 0),
      indicators: Number((await dbGet('SELECT COUNT(*) as c FROM technical_indicators'))?.c || 0),
      scores: Number((await dbGet('SELECT COUNT(DISTINCT code) as c FROM stock_score'))?.c || 0),
      finance: Number((await dbGet('SELECT COUNT(DISTINCT code) as c FROM financial_indicator'))?.c || 0),
    };
    // crowding_score 表在早期环境可能不存在，查不到就当缺失，不让整个 health 接口 500
    let crowdingLatest = null;
    try { crowdingLatest = (await dbGet('SELECT MAX(trade_date) as d FROM crowding_score'))?.d || null; } catch(e) {}
    const dates = {
      kline: (await dbGet('SELECT MAX(trade_date) as d FROM daily_kline'))?.d || null,
      score: (await dbGet('SELECT MAX(trade_date) as d FROM stock_score'))?.d || null,
      crowding: crowdingLatest,
    };
    // 期望最新交易日（按北京时间，Render 服务器为 UTC）：周六日→上周五；工作日15点前→昨天；15点后→今天
    const bj = dayjs().add(8, 'hour');
    const wd = bj.day();
    let expected;
    if (wd === 0) expected = bj.subtract(2, 'day');
    else if (wd === 6) expected = bj.subtract(1, 'day');
    else if (bj.hour() < 15) expected = bj.subtract(1, 'day');
    else expected = bj;
    const expectedDate = expected.format('YYYY-MM-DD');
    const norm = (d) => d ? String(d).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null;
    const toUTC = (s) => { const p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); };
    const diffDays = (d) => {
      const n = norm(d);
      if (!n) return null;
      return Math.round((toUTC(expectedDate) - toUTC(n)) / 86400000);
    };
    // 信号分布（按最新评分日期，value 策略）
    let signals = { buy: 0, watch: 0, hold: 0, sell: 0, total: 0 };
    if (dates.score) {
      const rows = await dbAll(`SELECT signal, COUNT(*) as c FROM stock_score WHERE trade_date = ? AND strategy = 'value' GROUP BY signal`, [dates.score]);
      const counts = {};
      for (const r of rows) counts[r.signal] = r.c;
      signals = {
        buy: Number(counts.buy || 0), watch: Number(counts.watch || 0), hold: Number(counts.hold || 0),
        sell: Number(counts.sell || 0),
        total: rows.reduce((a, r) => a + Number(r.c), 0),
      };
    }
    // 同步状态（内存进度，suspend 后可能非 idle）
    // total=0 表示这一轮从未启动（进程重启后 stepSyncState 归零），不能算「正在跑」，
    // 否则每次冷启动后 health 都报 running=true（Issue #4 就是这么来的）
    const stepStatus = (s) => (s.done || s.total === 0) ? 'idle' : `${s.offset}/${s.total}`;
    const sync = {
      kline: stepStatus(stepSyncState.kline),
      indicators: stepStatus(stepSyncState.indicators),
      finance: stepStatus(stepSyncState.finance),
    };
    let version = 'unknown';
    try { version = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); } catch (e) {}
    res.json({
      service: { version, time: new Date().toISOString() },
      db,
      freshness: {
        kline_latest: norm(dates.kline), score_latest: norm(dates.score), crowding_latest: norm(dates.crowding),
        expected: expectedDate,
        kline_diff_days: diffDays(dates.kline), score_diff_days: diffDays(dates.score), crowding_diff_days: diffDays(dates.crowding),
      },
      signals,
      sync: { running: Object.values(sync).some(v => v !== 'idle'), ...sync },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 设置接口（数据库持久化）
const defaultSettings = {
  valWeight: 35, qualWeight: 35, techWeight: 30,
  newEconBonus: 5, oldPenalty: 8,
  buyThreshold: 75, watchThreshold: 65, sellThreshold: 50,
  stopLoss: 15, takeProfit: 40,
  topCount: 10, autoSync: true, syncTime: '15:30',
};

async function loadSettings() {
  try {
    const rows = await dbAll('SELECT key, value FROM app_settings');
    const saved = {};
    for (const r of rows) { try { saved[r.key] = JSON.parse(r.value); } catch(e) { saved[r.key] = r.value; } }
    return { ...defaultSettings, ...saved };
  } catch(e) { return { ...defaultSettings }; }
}

async function saveSettingsToDB(settings) {
  const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
  await dbBatch(Object.entries(settings).map(([k, v]) => ({ sql: 'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)', args: [k, JSON.stringify(v), now] })));
}

let userSettings = { ...defaultSettings };

app.get('/api/settings', (req, res) => res.json(userSettings));
app.post('/api/settings', async (req, res) => {
  userSettings = { ...defaultSettings, ...(req.body || {}) };
  await saveSettingsToDB(userSettings);
  setTimeout(async () => {
    try {
      console.log('[settings] 设置已变更，重新计算评分...');
      await scoreAllStocks(true, userSettings);
      try { await calcAllCrowding(); } catch(e) {}
      try { await calcAllShortSignals(); } catch(e) {}
      console.log('[settings] 重新评分完成');
    } catch(e) { console.error('[settings] 重新评分失败:', e.message); }
  }, 100);
  res.json({ ok: true, settings: userSettings });
});

// 版本信息
app.get('/api/version', (req, res) => {
  let version = 'unknown';
  try { version = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); } catch(e) {}
  res.json({ version, name: '仓位满上 TopUp', build_time: new Date().toISOString() });
});

// ========== 期权模块 ==========
const { publicClient: deribit } = require('./src/options/deribit');
const { priceOption, impliedVolatility, timeToExpiry } = require('./src/options/pricing');
const { calcProfitCurve, detectStrategy, summarizeStrategy, calcLegPnL } = require('./src/options/calculator');
const { gammaExplosion, coveredCall, protectivePut, shortStrangle, longStraddle, scanAllSignals } = require('./src/options/strategies');
const { getHistoricalKlines, calcHistoricalVolatility } = require('./src/options/marketData');
const { runAllBacktests } = require('./src/options/backtest');

// 获取期权链行情
app.get('/api/options/chain', async (req, res) => {
  try {
    const currency = (req.query.currency || 'BTC').toUpperCase();
    const expiry = req.query.expiry ? parseInt(req.query.expiry) : null;
    const maxExp = parseInt(req.query.max || '6');
    const result = await deribit.getOptionChainSummary(currency, expiry, maxExp);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 获取期权策略信号
app.get('/api/options/signals', async (req, res) => {
  try {
    const currency = (req.query.currency || 'BTC').toUpperCase();
    const bias = req.query.bias || 'neutral'; // bullish/bearish/neutral
    const volRegime = req.query.volatility || 'normal'; // high/low/normal

    const chain = await deribit.getOptionChainSummary(currency, null, 10);
    const currentPrice = chain.indexPrice;
    // 取最近3个到期日做信号
    const signals = scanAllSignals({
      currentPrice,
      chain: chain.chains,
      marketBias: bias,
      volatilityRegime: volRegime
    });

    res.json({ currency, currentPrice, signals, timestamp: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 期权定价/Greeks计算
app.post('/api/options/greeks', (req, res) => {
  try {
    const { type, S, K, T, r = 0, sigma } = req.body;
    const Tyears = typeof T === 'number' && T > 10 ? T / 365.25 : T; // 如果T>10视为天数
    const result = priceOption(type, S, K, Tyears, r, sigma);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 盈亏计算器
app.post('/api/options/calculator', (req, res) => {
  try {
    const { legs, currentPrice, iv = 0.6, daysToExpiry = 7, r = 0, range = 0.5, atExpiry = true } = req.body;
    if (!legs || !Array.isArray(legs) || legs.length === 0) {
      return res.status(400).json({ error: '需要至少一个期权腿' });
    }
    // 对premium=0的腿用BS模型估算当前权利金
    const T = daysToExpiry / 365.25;
    const processedLegs = legs.map(leg => {
      if (leg.premium > 0) return leg;
      // 用BS估算当前价格
      const bsPrice = priceOption(leg.type, currentPrice, leg.K, T, r, iv);
      return { ...leg, premium: Math.max(bsPrice.price, 0.01) };
    });
    // 默认显示到期日盈亏（T=0），更直观
    const curveDays = atExpiry ? 0 : daysToExpiry;
    const curve = calcProfitCurve(processedLegs, currentPrice, curveDays, iv, r, { range, steps: 200 });
    // 同时计算当前价值（非到期）
    const currentCurve = atExpiry ? calcProfitCurve(processedLegs, currentPrice, daysToExpiry, iv, r, { range, steps: 50 }) : null;
    const summary = summarizeStrategy(processedLegs, curve, currentPrice);
    res.json({ summary, curve, currentCurve, legs: processedLegs, atExpiry });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 期权策略回测
app.get('/api/options/backtest', async (req, res) => {
  try {
    const currency = (req.query.currency || 'BTC').toUpperCase();
    const symbol = currency === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
    const days = parseInt(req.query.days || '365');
    const iv = parseFloat(req.query.iv || '0.6');

    const klines = await getHistoricalKlines(symbol, '1d', days);
    const histIv = calcHistoricalVolatility(klines) || iv;
    const results = runAllBacktests(klines, { iv: histIv, otmPercent: 0.1 });
    results.historicalVolatility = (histIv * 100).toFixed(1) + '%';
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 获取标的当前价格
app.get('/api/options/price', async (req, res) => {
  try {
    const currency = (req.query.currency || 'BTC').toUpperCase();
    const price = await deribit.getIndexPrice(currency);
    res.json({ currency, price, timestamp: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ========== 数据源管理 ==========
app.get('/api/datasource', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const status = await ds.getStatus(force);
    const labelMap = { tencent: '腾讯财经', sina: '新浪财经', yahoo: 'Yahoo Finance' };
    const activeSource = status.current === 'auto' ? Object.entries(status.sources).find(([k,v])=>v.ok)?.[0] || 'sina' : status.current;
    res.json({ current: status.current, configured: status.configured, current_label: labelMap[activeSource] || '自动', sources: Object.fromEntries(Object.entries(status.sources).map(([k, v]) => [k, { label: v.label, regions: v.regions, ok: v.ok, latency: v.latency || null, error: v.error || null }])) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/datasource', async (req, res) => {
  try { const { source } = req.body; const result = await ds.setSource(source); res.json({ ok: true, ...result }); }
  catch(e) { res.status(400).json({ error: e.message }); }
});

// ========== 股票池管理 ==========
app.get('/api/stock-pool', async (req, res) => {
  try {
    const stocks = await dbAll(`SELECT p.*, s.total_score, s.signal, s.quality_score, s.valuation_score, s.technical_score, k.close as current_price, k.pct_chg as today_pct, v.pe FROM stock_pool p LEFT JOIN stock_score s ON p.code = s.code AND s.trade_date = (SELECT MAX(trade_date) FROM stock_score) AND s.strategy='value' LEFT JOIN (SELECT code, close, pct_chg FROM daily_kline k1 WHERE trade_date = (SELECT MAX(trade_date) FROM daily_kline WHERE code=k1.code)) k ON p.code = k.code LEFT JOIN valuation v ON p.code = v.code AND v.trade_date = (SELECT MAX(trade_date) FROM valuation) WHERE p.in_pool = 1 ORDER BY p.pool_score DESC, p.is_manual DESC`);
    const stats = await dbGet(`SELECT COUNT(*) as total, SUM(is_manual) as manual FROM stock_pool WHERE in_pool=1`);
    res.json({ stocks, stats: { total: stats.total, manual: stats.manual || 0 } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stock-pool/refresh', async (req, res) => {
  try { const result = await stockPool.updateStockPool(200); res.json({ ok: true, ...result }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// 动态Universe更新（每月执行一次，或手动触发）
app.post('/api/universe/refresh', async (req, res) => {
  try {
    const result = await stockPool.updateUniverse();
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 查看Universe状态
app.get('/api/universe/stats', async (req, res) => {
  try {
    const stats = await dbGet(`SELECT COUNT(*) as total, SUM(in_universe) as active FROM stock_universe`);
    const lastUpdate = await dbGet(`SELECT MAX(updated_at) as t FROM stock_universe`);
    res.json({ total: stats.total, active: stats.active || 0, lastUpdate: lastUpdate.t });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 批量上传Universe数据（本地脚本使用）
app.post('/api/universe/upload-batch', async (req, res) => {
  try {
    const { stocks } = req.body;
    if (!Array.isArray(stocks) || stocks.length === 0) {
      return res.status(400).json({ error: 'stocks数组为空' });
    }
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const stmts = stocks.map(s => ({
      sql: `INSERT INTO stock_universe (code,name,market,total_mv,circ_mv,close,pct_chg,amount,is_st,updated_at,in_universe,universe_score,industry_group,industry_factor,score_mv,score_liq,score_active,score_risk,score_val,score_data,select_reason)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
            ON CONFLICT(code) DO UPDATE SET
              name=EXCLUDED.name,market=EXCLUDED.market,total_mv=EXCLUDED.total_mv,circ_mv=EXCLUDED.circ_mv,
              close=EXCLUDED.close,pct_chg=EXCLUDED.pct_chg,amount=EXCLUDED.amount,is_st=EXCLUDED.is_st,
              updated_at=EXCLUDED.updated_at,in_universe=1,universe_score=EXCLUDED.universe_score,
              industry_group=EXCLUDED.industry_group,industry_factor=EXCLUDED.industry_factor,
              score_mv=EXCLUDED.score_mv,score_liq=EXCLUDED.score_liq,score_active=EXCLUDED.score_active,
              score_risk=EXCLUDED.score_risk,score_val=EXCLUDED.score_val,score_data=EXCLUDED.score_data,
              select_reason=EXCLUDED.select_reason`,
      args: [s.code,s.name,s.market,s.total_mv||null,s.circ_mv||null,s.close||null,s.pct_chg||null,
             s.amount||null,s.is_st||0,now,s.universe_score||0,s.industry_group||'other',
             s.industry_factor||1.0,s.score_mv||50,s.score_liq||50,s.score_active||50,
             s.score_risk||50,s.score_val||50,s.score_data||50,s.select_reason||'data']
    }));
    await dbBatch(stmts);
    // 同时更新stock_info表（只更新该表存在的字段）
    const infoStmts = stocks.map(s => ({
      sql: `INSERT INTO stock_info (code,name,market,is_st,total_mv,circ_mv,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,market=EXCLUDED.market,is_st=EXCLUDED.is_st,total_mv=EXCLUDED.total_mv,circ_mv=EXCLUDED.circ_mv,updated_at=EXCLUDED.updated_at`,
      args: [s.code,s.name,s.market,s.is_st||0,s.total_mv||null,s.circ_mv||null,now]
    }));
    await dbBatch(infoStmts);
    res.json({ ok: true, written: stocks.length });
  } catch(e) {
    console.error('upload-batch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 重置Universe（清除in_universe标记，为批量上传做准备）
app.post('/api/universe/reset', async (req, res) => {
  try {
    await dbRun(`UPDATE stock_universe SET in_universe=0`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ========== Phase1.5 新打分上传 ==========
// 接收本地打分引擎产出的七维分（V/Q/G/F/T/M/L）+ 评级，upsert 到 stock_score。
// 字段映射：V→valuation_score  Q→quality_score  T→technical_score  M→fund_score
//           G/F/L→各自新列      rating→signal（buy/watch/hold/sell 与前端一致）
// 目的：旧版 value_score 引擎下线后，前端无需改造即可展示新打分。
app.post('/api/scores/upload', async (req, res) => {
  try {
    const { trade_date, rows, strategy: strategyIn } = req.body || {};
    if (!trade_date) return res.status(400).json({ error: '缺少 trade_date' });
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows 数组为空' });

    // 同时写入 'phase15'（新打分标识）和 'value'（兼容旧前端查询）两个strategy
    const strategies = ['phase15', 'value'];
    const useStrategy = strategyIn && !strategies.includes(strategyIn) ? [strategyIn, 'value'] : strategies;

    const COLS = ['code','trade_date','strategy','name','industry','sw_l1',
      'quality_score','valuation_score','technical_score','fund_score','sentiment_score',
      'score_E','score_G','score_F','score_L','total_score','signal','rank_num','market_pct',
      'current_price','pe','pb','mktcap_yi','np_mom','volatility_20d','ret_20d','ret_60d'];
    const PH = COLS.map(() => '?').join(',');

    const stmts = [];
    const infoStmts = [];
    const valStmts = [];
    const nowStr = dayjs().format('YYYY-MM-DD HH:mm:ss');
    for (const r of rows) {
      for (const strat of useStrategy) {
        stmts.push({
          sql: `INSERT OR REPLACE INTO stock_score (${COLS.join(',')}) VALUES (${PH})`,
          args: [
            String(r.code), String(trade_date), strat, r.name ?? null, r.sw_l1 ?? null, r.sw_l1 ?? null,
            // v3.0: quality←score_E(盈利动量), valuation←score_V, technical←score_M(资金面观察位)
            r.score_E ?? null, r.score_V ?? null, r.score_M ?? null, r.score_M ?? null, null,
            r.score_E ?? null, null, null, null, r.total_score ?? null,
            (r.rating ?? 'hold').toLowerCase(), r.rank ?? null, r.market_pct ?? null,
            r.price ?? null, r.pe ?? null, r.pb ?? null, r.mktcap_yi ?? null, r.np_mom ?? null,
            r.volatility_20d ?? null, r.ret_20d ?? null, r.ret_60d ?? null,
          ],
        });
      }
      // 同步更新 stock_info（name/market/total_mv），保证 /api/stocks 关联查询有数据
      if (r.name && r.mktcap_yi != null) {
        const market = r.code.startsWith('6') || r.code.startsWith('9') ? 'SH' : 'SZ';
        infoStmts.push({
          sql: `INSERT OR REPLACE INTO stock_info (code,name,market,total_mv,circ_mv,updated_at,is_st) VALUES (?,?,?,?,?,?,?)`,
          args: [String(r.code), r.name, market, r.mktcap_yi, r.mktcap_yi, nowStr, (r.name && r.name.includes('ST')) ? 1 : 0],
        });
      }
      // 同步更新 valuation（pe）
      if (r.pe != null) {
        valStmts.push({
          sql: `INSERT OR REPLACE INTO valuation (code,trade_date,pe,pb,total_mv) VALUES (?,?,?,?,?)`,
          args: [String(r.code), String(trade_date), r.pe ?? null, r.pb ?? null, r.mktcap_yi ?? null],
        });
      }
    }

    let written = 0;
    for (let i = 0; i < stmts.length; i += 200) {
      await dbBatch(stmts.slice(i, i + 200));
      written += Math.min(200, stmts.length - i);
    }
    if (infoStmts.length > 0) {
      for (let i = 0; i < infoStmts.length; i += 200) await dbBatch(infoStmts.slice(i, i + 200));
    }
    if (valStmts.length > 0) {
      for (let i = 0; i < valStmts.length; i += 200) await dbBatch(valStmts.slice(i, i + 200));
    }
    res.json({ ok: true, trade_date, strategy: useStrategy, written: rows.length, score_rows: stmts.length });
  } catch (e) {
    console.error('scores/upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ========== 清库（危险操作，仅限管理员） ==========
// body: { secret, tables: ['stock_score', ...], dry_run: true }
// 白名单表 + ADMIN_SECRET 校验；dry_run 只返回行数不执行删除。
const RESETTABLES = [
  'stock_score', 'daily_kline', 'technical_indicators', 'financial_indicator',
  'valuation', 'fund_flow', 'sector_daily', 'north_hold', 'news_sentiment',
  'stock_universe', 'stock_pool', 'sync_log', 'stock_info',
];

app.post('/api/admin/reset-data', async (req, res) => {
  try {
    const { secret, tables = [], dry_run = true } = req.body || {};
    const expected = process.env.ADMIN_SECRET;
    if (!expected) return res.status(503).json({ error: '服务端未配置 ADMIN_SECRET，接口已禁用' });
    if (secret !== expected) return res.status(403).json({ error: 'secret 不正确' });
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ error: 'tables 为空' });

    const invalid = tables.filter(t => !RESETTABLES.includes(t));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `不允许的表: ${invalid.join(', ')}`, allowed: RESETTABLES });
    }

    const counts = {};
    for (const t of tables) {
      const row = await dbGet(`SELECT COUNT(*) as c FROM ${t}`);
      counts[t] = Number(row?.c || 0);
    }

    if (dry_run) {
      return res.json({ ok: true, dry_run: true, would_delete: counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0) });
    }

    const deleted = {};
    for (const t of tables) {
      await dbRun(`DELETE FROM ${t}`);
      deleted[t] = counts[t];
    }
    console.log(`[admin] 清库执行: ${JSON.stringify(deleted)}`);
    res.json({ ok: true, dry_run: false, deleted,
      total: Object.values(deleted).reduce((a, b) => a + b, 0) });
  } catch (e) {
    console.error('admin/reset-data error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stock-pool/add', async (req, res) => {
  try {
    const { code, name } = req.body;
    if (!code) return res.status(400).json({ error: '缺少code' });
    const fullCode = await stockPool.addToPool(code, name, true);
    res.json({ ok: true, code: fullCode });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 新闻代理
app.get('/api/news', (req, res) => {
  const type = req.query.type || 'market';
  const mockNews = {
    market: [
      { title: 'A股三大指数集体收跌，两市成交额超1.9万亿', time: '15:00', source: '财经快讯', tag: '大盘' },
      { title: '市场放量下跌，机构建议控制仓位等待企稳', time: '15:15', source: '券商策略', tag: '策略' },
      { title: '央行公开市场净投放，资金面平稳', time: '09:45', source: '宏观', tag: '宏观' },
    ],
    stock: [
      { title: '半导体板块逆市飘红，国产替代持续推进', time: '14:20', source: '板块跟踪', tag: '板块' },
      { title: '新能源赛道集体调整，短期承压', time: '14:35', source: '盘面观察', tag: '板块' },
    ],
    global: [
      { title: '美股三大指数隔夜涨跌不一', time: '06:00', source: '全球市场', tag: '大盘' },
    ],
  };
  res.json({ items: mockNews[type] || [] });
});

// ========== 持仓管理 API ==========
app.get('/api/portfolio', async (req, res) => {
  try {
    const holdings = await dbAll(`SELECT p.*, s.total_score, s.signal, s.quality_score, s.valuation_score, s.technical_score, v.pe, v.pb, (SELECT close FROM daily_kline WHERE code=p.code ORDER BY trade_date DESC LIMIT 1) as current_price, (SELECT pct_chg FROM daily_kline WHERE code=p.code ORDER BY trade_date DESC LIMIT 1) as today_pct FROM portfolio p LEFT JOIN stock_score s ON p.code = s.code AND s.trade_date = (SELECT MAX(trade_date) FROM stock_score) AND s.strategy = 'value' LEFT JOIN valuation v ON p.code = v.code AND v.trade_date = (SELECT MAX(trade_date) FROM valuation) WHERE p.status = 'holding'`);
    let totalCost = 0, totalValue = 0, totalTodayPnL = 0;
    const items = holdings.map(h => {
      const currentPrice = h.current_price || h.buy_price;
      const costValue = h.buy_price * h.shares;
      const marketValue = currentPrice * h.shares;
      const pnl = marketValue - costValue;
      const pnlPct = h.buy_price > 0 ? ((currentPrice - h.buy_price) / h.buy_price * 100) : 0;
      const yesterdayClose = h.today_pct ? currentPrice / (1 + h.today_pct/100) : currentPrice;
      const todayPnL = (currentPrice - yesterdayClose) * h.shares;
      totalCost += costValue; totalValue += marketValue; totalTodayPnL += todayPnL;
      return { ...h, current_price: currentPrice, cost_value: Math.round(costValue), market_value: Math.round(marketValue), pnl: Math.round(pnl * 100) / 100, pnl_pct: +pnlPct.toFixed(2), today_pnl: Math.round(todayPnL * 100) / 100 };
    });
    const totalPnL = totalValue - totalCost;
    const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost * 100) : 0;
    res.json({ holdings: items, summary: { total_cost: Math.round(totalCost), total_value: Math.round(totalValue), total_pnl: Math.round(totalPnL * 100) / 100, total_pnl_pct: +totalPnLPct.toFixed(2), today_pnl: Math.round(totalTodayPnL * 100) / 100, count: items.length, suggested_position: 60 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/portfolio', async (req, res) => {
  try {
    const { code, name, buy_price, shares, buy_date, strategy = 'value' } = req.body;
    if (!code || !buy_price || !shares) return res.status(400).json({ error: '缺少必填字段' });
    const stockInfo = await dbGet('SELECT name FROM stock_info WHERE code=?', [code]);
    const stockName = name || stockInfo?.name || code;
    const score = await dbGet(`SELECT * FROM stock_score WHERE code=? AND strategy=? ORDER BY trade_date DESC LIMIT 1`, [code, strategy]);
    const stopLoss = +(buy_price * 0.85).toFixed(2);
    const targetPrice = score?.total_score >= 70 ? +(buy_price * 1.3).toFixed(2) : null;
    await dbRun(`INSERT OR REPLACE INTO portfolio (code,name,strategy,buy_date,buy_price,shares,stop_loss,target_price,status) VALUES (?,?,?,?,?,?,?,?,?)`, [code, stockName, strategy, buy_date || new Date().toISOString().slice(0,10), buy_price, shares, stopLoss, targetPrice, 'holding']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/portfolio/:code', async (req, res) => {
  try { await dbRun(`UPDATE portfolio SET status='closed' WHERE code=?`, [req.params.code]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/portfolio/closed', async (req, res) => {
  try { const closed = await dbAll(`SELECT * FROM portfolio WHERE status='closed' ORDER BY buy_date DESC`); res.json({ closed }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== 静态文件缓存策略 ==========
const staticPath = path.join(__dirname, 'web', 'dist');
app.use('/assets/', express.static(path.join(staticPath, 'assets'), {
  maxAge: '1y', immutable: false,
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache, must-revalidate'); }
}));

const BUILD_VERSION = Date.now().toString();
function serveIndex(req, res) {
  const indexPath = path.join(staticPath, 'index.html');
  if (!fs.existsSync(indexPath)) {
    res.status(200).send('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>仓位满上</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f7fa;color:#101828}.card{background:#fff;border-radius:12px;padding:40px;max-width:500px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08)}h1{font-size:24px;margin-bottom:8px}.sub{color:#667085;font-size:14px;line-height:1.7}.spin{display:inline-block;width:32px;height:32px;border:3px solid #eaecf0;border-top-color:#1677ff;border-radius:50%;animation:spin 0.8s linear infinite;margin:20px 0}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="card"><div class="spin"></div><h1>🥃 仓位满上 部署中</h1><p class="sub">前端静态资源正在构建，请稍等 1-2 分钟后刷新页面…<br/>如果持续看到此页面，说明前端构建失败，请查看 Render Build Logs。</p></div></body></html>');
    return;
  }
  let html = fs.readFileSync(indexPath, 'utf-8');
  html = html.replace(/<div id="crowding-banner".*?<\/script>/s, '<div id="root"></div>');
  html = html.replace(/(\/assets\/[^"?\s]+\.(js|css))/g, '$1?v=' + BUILD_VERSION);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(html);
}
app.get('/', serveIndex);
app.get(/^\/(?!api|assets)[^.]*$/, serveIndex);

// ========== 定时任务 ==========

// 提取同步逻辑为可复用函数（cron和手动触发共用）
async function runAutoSync(mode = 'incremental') {
  if (syncRunning) { console.log('[cron] 同步正在进行中，跳过'); return; }
  syncRunning = true;
  try {
    console.log(`[cron] 开始${mode === 'full' ? '全量' : '增量'}数据同步...`);
    const currentSettings = userSettings;
    let codes = await stockPool.getPoolCodes();
    if (codes.length === 0) { const infoRows = await dbAll('SELECT code FROM stock_info'); codes = infoRows.map(r => r.code).filter(c => /^\d{6}$/.test(c)); }
    if (codes.length === 0) { console.log('[cron] 无股票代码，跳过'); return; }

    // 1. 拉取实时行情
    let quotes = [];
    try { quotes = await tq.getQuickStockList(codes.slice(0, 250)); } catch(e) { console.log('[cron] 行情拉取失败:', e.message); }
    const nowStr = dayjs().format('YYYY-MM-DD HH:mm:ss');
    const today = dayjs().format('YYYYMMDD');
    const infoData = quotes.filter(q=>q.code&&q.name).map(q => ({ code:q.code, name:q.name, market:q.market||(q.code.startsWith('6')?'SH':'SZ'), is_st:q.is_st||(q.name&&q.name.includes('ST')?1:0), total_mv:q.total_mv, circ_mv:q.circ_mv }));
    if (infoData.length > 0) await dbBatch(infoData.map(r => ({ sql: `INSERT OR REPLACE INTO stock_info (code,name,market,is_st,total_mv,circ_mv,updated_at) VALUES (?,?,?,?,?,?,?)`, args: [r.code, r.name, r.market, r.is_st, r.total_mv, r.circ_mv, nowStr] })));
    const valData = quotes.filter(q=>q.code&&q.pe!=null);
    if (valData.length > 0) await dbBatch(valData.map(q => ({ sql: `INSERT OR REPLACE INTO valuation (code,trade_date,pe) VALUES (?,?,?)`, args: [q.code, today, q.pe] })));
    console.log(`[cron] 行情更新: ${quotes.length}支`);

    // 2. 拉取K线
    const klineHistoryDays = mode === 'full' ? 730 : 60;
    const klineStart = dayjs().subtract(klineHistoryDays,'day').format('YYYYMMDD');
    const klineEnd = dayjs().format('YYYYMMDD');
    let klineCount = 0;
    for (let i = 0; i < codes.length; i++) {
      try {
        let klines = await emKline.getDailyKline(codes[i], klineStart, klineEnd);
        // 东方财富失败则回退到腾讯+计算换手率
        if (!klines || klines.length === 0) {
          const info = await dbGet('SELECT circ_mv FROM stock_info WHERE code = ?', [codes[i]]);
          const tqKlines = await tq.getDailyKline(codes[i], 
            dayjs(klineStart).format('YYYY-MM-DD'), 
            dayjs(klineEnd).format('YYYY-MM-DD')
          );
          if (tqKlines && tqKlines.length > 0) {
            klines = tqKlines.map(k => {
              let turnover = null;
              if (info && info.circ_mv && info.circ_mv > 0 && k.close > 0 && k.volume > 0) {
                turnover = Math.round((k.volume * 100 * k.close / (info.circ_mv * 1e8) * 100) * 100) / 100;
              }
              return { ...k, turnover };
            });
          }
        }
        if (klines && klines.length > 0) {
          for (let j = 0; j < klines.length; j += 200) {
            await dbBatch(klines.slice(j, j+200).map(k => ({ sql: `INSERT OR REPLACE INTO daily_kline (code,trade_date,open,close,high,low,volume,amount,amplitude,pct_chg,chg,turnover) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [k.code, k.trade_date, k.open, k.close, k.high, k.low, k.volume, k.amount, k.amplitude, k.pct_chg, k.chg, k.turnover] })));
          }
          klineCount += klines.length;
        }
      } catch(e) {}
      await tq.sleep(mode === 'full' ? 120 : 60);
    }
    console.log(`[cron] K线更新: ${klineCount}条`);

    if (mode === 'full') {
      // 全量同步才重算技术指标、评分、短线、拥挤度
      // 3. 计算技术指标
      const allCodeRows = await dbAll('SELECT DISTINCT code FROM daily_kline');
      const allCodes = allCodeRows.map(r => r.code);
      let indCount = 0;
      for (let i = 0; i < allCodes.length; i++) {
        const ks = await dbAll('SELECT trade_date,close,high,low,volume FROM daily_kline WHERE code = ? ORDER BY trade_date ASC', [allCodes[i]]);
        if (ks.length < 25) continue;
        const inds = calcAllIndicators(ks);
        const validInds = inds.filter(r => r.ma5 !== null);
        for (let j = 0; j < validInds.length; j += 200) {
          await dbBatch(validInds.slice(j, j+200).map(r => ({ sql: `INSERT OR REPLACE INTO technical_indicators (code,trade_date,ma5,ma10,ma20,ma60,ma120,ma250,vol_ma5,vol_ma20,macd_dif,macd_dea,macd_bar,rsi6,rsi14,kdj_k,kdj_d,kdj_j,boll_upper,boll_mid,boll_lower) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [allCodes[i], r.trade_date, r.ma5, r.ma10, r.ma20, r.ma60, r.ma120, r.ma250, r.vol_ma5, r.vol_ma20, r.macd_dif, r.macd_dea, r.macd_bar, r.rsi6, r.rsi14, r.kdj_k, r.kdj_d, r.kdj_j, r.boll_upper, r.boll_mid, r.boll_lower] })));
        }
        indCount++;
      }
      console.log(`[cron] 技术指标: ${indCount}支`);

      // 4. 评分（syncFinance=true：仅对缺少财务数据的股票拉取，已有数据的不重复拉）
      await scoreAllStocks(true, currentSettings);
      console.log('[cron] 评分完成');

      // 5. 短线信号
      try { await calcAllShortSignals(); } catch(e) { console.log('[cron] 短线信号失败:', e.message); }

      // 6. 拥挤度
      try { await calcAllCrowding(); } catch(e) { console.log('[cron] 拥挤度失败:', e.message); }
    } else {
      // 增量同步：只更新行情+K线+快速评分（不重算指标和拥挤度）
      console.log('[cron] 增量模式：跳过技术指标/拥挤度重算');
      await scoreAllStocks(false, currentSettings);
      console.log('[cron] 快速评分完成');
    }

    console.log(`[cron] ✅ ${mode === 'full' ? '全量' : '增量'}同步完成`);
  } catch(e) {
    console.error('[cron] 同步失败:', e.message);
  } finally {
    syncRunning = false;
  }
}

// 周一凌晨00:30(北京时间)更新股票池 = UTC周日16:30
cron.schedule('30 16 * * 0', async () => {
  console.log('[cron] 周一00:30(北京时间)，开始更新股票池...');
  try { const r = await stockPool.updateStockPool(200); console.log('[cron] 股票池更新完成:', r); } catch(e) { console.log('[cron] 股票池更新失败:', e.message); }
});

// 每月1号凌晨00:00(北京时间)更新动态Universe = UTC上月最后一天16:00
cron.schedule('0 16 28-31 * *', async () => {
  // 取每月最后一天的UTC16:00 = 北京时间次月1号00:00
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (tomorrow.getUTCDate() === 1) {
    console.log('[cron] 月初，开始更新动态Universe...');
    try {
      const r = await stockPool.updateUniverse();
      console.log('[cron] Universe更新完成:', r);
      // Universe更新后立即刷新股票池
      const r2 = await stockPool.updateStockPool(200);
      console.log('[cron] 股票池刷新完成:', r2);
    } catch(e) { console.log('[cron] Universe更新失败:', e.message); }
  }
});

// 工作日盘中增量同步（北京时间：10:00开盘、11:30午盘、14:00下午盘）
// 注意：cron使用UTC时间，北京时间 = UTC+8
// 增量同步：快速行情+K线+评分（不重算指标和拥挤度）
cron.schedule('0 2 * * 1-5', () => runAutoSync('incremental'));   // UTC 02:00 = 北京10:00
cron.schedule('30 3 * * 1-5', () => runAutoSync('incremental'));  // UTC 03:30 = 北京11:30
cron.schedule('0 6 * * 1-5', () => runAutoSync('incremental'));   // UTC 06:00 = 北京14:00

// 收盘后全量同步（北京时间15:30）= UTC 07:30
// 改为分步同步：先拉K线，后续指标/评分/拥挤度由GitHub Actions轮询触发
cron.schedule('30 7 * * 1-5', async () => {
  console.log('[cron] 收盘后同步：K线+行情+评分...');
  await runAutoSync('incremental');
  // 额外触发拥挤度计算
  try { await calcAllCrowding(); } catch(e) { console.log('[cron] 拥挤度失败:', e.message); }
});

// 防休眠：每10分钟自ping，保持Render免费版不进入休眠
// 这样工作日盘中cron任务才能按时触发
setInterval(async () => {
  try {
    const http = require('http');
    const port = process.env.PORT || 3001;
    http.get(`http://127.0.0.1:${port}/api/version`, (res) => {
      res.resume();
    }).on('error', () => {});
  } catch(e) {}
}, 10 * 60 * 1000);

// ========== 启动 ==========
const PORT = process.env.PORT || 3001;

async function ensureSeedData() {
  try {
    const row = await dbGet('SELECT COUNT(*) as c FROM stock_info');
    if (row.c >= 50) console.log(`[init] 数据库就绪：${row.c} 支股票`);
    else console.log(`[init] ⚠️ 数据库仅 ${row.c} 支股票，数据较少`);
  } catch(e) { console.log('[init] 数据库检查失败:', e.message); }
}

// Debug: 直接测试单只股票评分
app.get('/api/debug/score/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const val = await dbGet('SELECT pe, pe_ttm, pb FROM valuation WHERE code = ? ORDER BY trade_date DESC LIMIT 1', [code]);
    const info = await dbGet('SELECT name FROM stock_info WHERE code = ?', [code]);
    const v = await calcValuationScore(code);
    const q = await calcQualityScore(code);
    const dbScores = await dbAll('SELECT trade_date, strategy, valuation_score, valuation_detail, total_score FROM stock_score WHERE code = ? ORDER BY trade_date DESC LIMIT 5', [code]);
    res.json({ code, name: info?.name, val_from_db: val, valuation_result: v, quality_score: q?.score, db_scores: dbScores });
  } catch(e) { res.status(500).json({ error: e.message, stack: e.stack?.slice(0,500) }); }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log('═══════════════════════════════════════');
  console.log('  🥃 仓位满上 Top Up  服务已启动');
  console.log('  API地址: http://0.0.0.0:' + PORT);
  console.log('  时间: ' + dayjs().format('YYYY-MM-DD HH:mm:ss'));
  console.log('  数据库: ' + (usePostgres ? 'Supabase/PostgreSQL' : (useTurso ? 'Turso云数据库' : '本地SQLite')));
  console.log('═══════════════════════════════════════');
  
  try { await dbIsReady(); } catch(e) { console.log('[init] 数据库初始化等待失败:', e.message); }

  try { await ds.waitReady(); console.log(`[init] 📡 数据源: ${ds.getSource().label} (${ds.getSource().name})`); } catch(e) { console.log('[init] 数据源初始化失败:', e.message); }

  // 加载设置
  try { userSettings = await loadSettings(); console.log('[init] 设置已加载'); } catch(e) { console.log('[init] 设置加载失败:', e.message); }

  await ensureSeedData();

  // 初始化动态Universe（如果数据库中为空）
  try {
    const uniRow = await dbGet('SELECT COUNT(*) as c FROM stock_universe WHERE in_universe=1');
    if (uniRow.c < 100) {
      console.log('[init] 动态Universe为空，开始从全市场拉取...');
      const r = await stockPool.updateUniverse();
      console.log(`[init] Universe更新完成: ${r.total}只`);
    } else {
      console.log(`[init] Universe已有 ${uniRow.c} 只`);
    }
  } catch(e) { console.log('[init] Universe初始化失败:', e.message); }

  // 初始化股票池
  try {
    const poolCountRow = await dbGet('SELECT COUNT(*) as c FROM stock_pool WHERE in_pool=1');
    const lastUpdateRow = await dbGet('SELECT MAX(updated_at) as t FROM stock_pool');
    const needUpdate = poolCountRow.c < 100 || !lastUpdateRow.t || dayjs().diff(dayjs(lastUpdateRow.t), 'day') >= 7;
    if (needUpdate) {
      console.log('[init] 股票池为空或过期，开始更新股票池...');
      const r = await stockPool.updateStockPool(200);
      console.log(`[init] 股票池更新完成: ${r.total}只`);
    } else { console.log(`[init] 股票池已有 ${poolCountRow.c} 只，跳过更新`); }
  } catch(e) { console.log('[init] 股票池初始化失败:', e.message); }

  // 后台尝试更新行情（轻量级，只拉行情+增量K线，不跑全量评分）
  (async () => {
    try {
      console.log('[init] 后台尝试更新行情...');
      let codes = await stockPool.getPoolCodes();
      if (codes.length === 0) { const infoRows = await dbAll('SELECT code FROM stock_info'); codes = infoRows.map(r => r.code).filter(c => /^\d{6}$/.test(c)); }
      if (codes.length === 0) throw new Error('无股票代码');
      const quotes = await Promise.race([
        tq.getQuickStockList(codes.slice(0, 100)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('行情拉取超时(20s)')), 20000)),
      ]);
      const nowStr = dayjs().format('YYYY-MM-DD HH:mm:ss');
      const today = dayjs().format('YYYYMMDD');
      const infoData = quotes.filter(s=>s.code && s.name).map(q => ({code:String(q.code).replace(/^(sh|sz|bj)/,''),name:q.name,market:q.market||(String(q.code).startsWith('6')?'SH':'SZ'),is_st:q.is_st||(q.name&&q.name.includes('ST')?1:0),total_mv:q.total_mv,circ_mv:q.circ_mv}));
      await dbBatch(infoData.map(r => ({ sql: `INSERT OR REPLACE INTO stock_info (code,name,market,is_st,total_mv,circ_mv,updated_at) VALUES (?,?,?,?,?,?,?)`, args: [r.code, r.name, r.market, r.is_st, r.total_mv, r.circ_mv, nowStr] })));
      const valData = quotes.filter(q => q.code && q.pe != null).map(q => ({ code: String(q.code).replace(/^(sh|sz|bj)/,''), today, pe: q.pe }));
      await dbBatch(valData.map(r => ({ sql: `INSERT OR REPLACE INTO valuation (code,trade_date,pe) VALUES (?,?,?)`, args: [r.code, r.today, r.pe] })));
      console.log(`[init] 行情更新完成: ${quotes.length} 支`);

      // 只在评分数据完全缺失时做快速评分（不拉财务，不算拥挤度）
      const scoredRow = await dbGet('SELECT COUNT(DISTINCT code) as c FROM stock_score');
      if (scoredRow.c === 0) {
        console.log('[init] 无评分数据，快速评分中...');
        await scoreAllStocks(false, userSettings);
        console.log('[init] 快速评分完成');
      } else {
        console.log(`[init] 已有 ${scoredRow.c} 只评分数据，跳过`);
      }
    } catch(e) { console.log('[init] 行情/评分更新跳过(可能API受限):', e.message); }
  })();
});// v1.6.9 build trigger
