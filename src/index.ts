import CONFIG from './config';
import Logger from './logger';
import { initClient, getBalance, getWalletAddress } from './client';
import { scanArbitrageOpportunities, refreshMarkets, getActiveBookCount, getMarkets } from './scanner';
import { executeArbitrage } from './executor';
import { getPositionCount, getTotalCost, getExpectedProfit, getStats, checkAndSettleExpired, getPositionSummary } from './positions';
import { notifyBotStarted, notifySettlement, notifyRunningStats } from './telegram';
import { closeWebSocket, getOrderBook } from './orderbook-ws';
import { runMakerStrategy, checkOrderStatus, getMakerStats, cancelAllOrders } from './maker';

const startTime = Date.now();

// 格式化运行时间
const formatRuntime = (): string => {
  const elapsed = Date.now() - startTime;
  const hours = Math.floor(elapsed / (1000 * 60 * 60));
  const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60));
  
  if (hours > 0) {
    return `${hours}小时${minutes}分钟`;
  }
  return `${minutes}分钟`;
};

// 统计
let scanCount = 0;
let tradeCount = 0;
let lastStatsTime = 0;
let lastTelegramTime = 0;

// 主循环
const mainLoop = async () => {
  Logger.header('🎯 套利机器人 - Maker挂单 + Taker配对');
  
  // 显示配置
  Logger.info(`模式: ${CONFIG.SIMULATION_MODE ? '🔵 模拟' : '🔴 实盘'}`);
  Logger.info(`最大组合成本: $${CONFIG.MAX_SAME_POOL_COST}`);
  Logger.info(`单轮挂单: $${CONFIG.MAKER_ORDER_SIZE_USD} | 单事件上限: $${CONFIG.MAX_EVENT_INVESTMENT_USD}`);
  Logger.info(`配对超时: ${CONFIG.PAIRING_TIMEOUT_SEC}秒`);
  Logger.info(`15分钟场: ${CONFIG.ENABLE_15MIN ? '✅' : '❌'} | 1小时场: ${CONFIG.ENABLE_1HR ? '✅' : '❌'}`);
  Logger.divider();
  
  // 实盘模式初始化
  if (!CONFIG.SIMULATION_MODE) {
    Logger.info('🔧 初始化实盘模式...');
    
    // 显示钱包地址
    const address = getWalletAddress();
    Logger.info(`钱包地址: ${address}`);
    
    // 初始化客户端（包含自动授权）
    await initClient();
    
    // 显示余额
    const balance = await getBalance();
    Logger.info(`账户余额: $${balance.toFixed(2)} USDC.e`);
    
    Logger.divider();
  } else {
    Logger.info('🔵 模拟模式 - 跳过钱包初始化');
    Logger.divider();
  }
  
  // 加载市场
  await refreshMarkets();
  
  // 发送启动通知
  notifyBotStarted().catch(() => {});
  
  Logger.success('机器人启动成功！开始扫描套利机会...');
  Logger.divider();
  
  // 主循环
  while (true) {
    try {
      scanCount++;
      
      // 扫描套利机会（同池 + 跨池）
      const opportunities = await scanArbitrageOpportunities();
      
      // 执行套利（按利润率排序，优先执行利润最高的）
      for (const opp of opportunities) {
        const { type, timeGroup, upMarket, downMarket, upAskPrice, downAskPrice, combinedCost, profitPercent } = opp;
        
        const typeTag = type === 'same_pool' ? '📊同池' : '🔀跨池';
        const pairInfo = type === 'same_pool' 
          ? upMarket.asset 
          : `${upMarket.asset}↑${downMarket.asset}↓`;
        
        // 执行交易
        const result = await executeArbitrage(opp);
        
        if (result.success && result.upFilled > 0 && result.downFilled > 0) {
          tradeCount++;
          // 只在成交时显示日志
          Logger.success(`🎯 ${timeGroup} ${typeTag} ${pairInfo}: $${combinedCost.toFixed(4)} (${profitPercent.toFixed(2)}%) | 买入 ${result.upFilled} shares`);
          break;
        }
      }
      
      // 运行挂单策略
      await runMakerStrategy();
      await checkOrderStatus();
      
      // 检查结算
      const settlements = await checkAndSettleExpired();
      for (const settlement of settlements) {
        const stats = getStats();
        notifySettlement(settlement, stats).catch(() => {});
      }
      
      // 定期显示状态（每30秒）
      const now = Date.now();
      if (now - lastStatsTime > 30000) {
        lastStatsTime = now;
        
        const bookCount = getActiveBookCount();
        const posCount = getPositionCount();
        const stats = getStats();
        const summary = getPositionSummary();
        
        // 显示仓位平衡情况
        let balanceInfo = '';
        for (const [group, data] of Object.entries(summary)) {
          const diff = data.totalUp - data.totalDown;
          balanceInfo += ` | ${group}: U${data.totalUp.toFixed(0)}/D${data.totalDown.toFixed(0)}(${diff >= 0 ? '+' : ''}${diff.toFixed(0)})`;
        }
        
        Logger.info(`📊 WS: ${bookCount} books | 仓位: ${posCount} | 结算: ${stats.totalSettled} | 盈亏: ${stats.totalProfit >= 0 ? '+' : ''}$${stats.totalProfit.toFixed(2)}${balanceInfo}`);
        
        // 显示挂单统计
        const makerStats = getMakerStats();
        if (makerStats.totalUp > 0 || makerStats.totalDown > 0) {
          const diff = makerStats.totalUp - makerStats.totalDown;
          Logger.info(`   📝 挂单累计: Up ${makerStats.totalUp} ($${makerStats.totalUpCost.toFixed(2)}) / Down ${makerStats.totalDown} ($${makerStats.totalDownCost.toFixed(2)}) | 平均成本: $${makerStats.avgCost.toFixed(4)} | 待配对: ${makerStats.pendingPairs}`);
        }
        
        // 显示当前市场成本（诊断）
        const markets = getMarkets();
        for (const m of markets) {
          const upBook = getOrderBook(m.upTokenId);
          const downBook = getOrderBook(m.downTokenId);
          if (upBook && downBook && upBook.bestAsk > 0 && downBook.bestAsk > 0) {
            const cost = upBook.bestAsk + downBook.bestAsk;
            const status = cost < CONFIG.MAX_SAME_POOL_COST ? '✅可套利' : '❌等待中';
            Logger.info(`   💹 ${m.asset}: Up $${upBook.bestAsk.toFixed(3)} + Down $${downBook.bestAsk.toFixed(3)} = $${cost.toFixed(4)} ${status}`);
          }
        }
      }
      
      // 每10分钟发送Telegram统计
      if (now - lastTelegramTime > 10 * 60 * 1000) {
        lastTelegramTime = now;
        const stats = getStats();
        notifyRunningStats({
          runtime: formatRuntime(),
          positionCount: getPositionCount(),
          totalCost: getTotalCost(),
          expectedProfit: getExpectedProfit(),
          ...stats,
        }).catch(() => {});
      }
      
      // 等待下一次扫描
      await new Promise(resolve => setTimeout(resolve, CONFIG.SCAN_INTERVAL_MS));
      
    } catch (error) {
      Logger.error(`主循环错误: ${error}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
};

// 优雅退出
process.on('SIGINT', async () => {
  Logger.info('收到退出信号，正在关闭...');
  await cancelAllOrders();
  closeWebSocket();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  Logger.info('收到终止信号，正在关闭...');
  await cancelAllOrders();
  closeWebSocket();
  process.exit(0);
});

// 启动
mainLoop().catch(error => {
  Logger.error(`致命错误: ${error}`);
  process.exit(1);
});

