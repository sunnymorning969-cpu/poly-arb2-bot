import CONFIG from './config';
import Logger from './logger';
import { initClient, getBalance, getWalletAddress } from './client';
import { refreshMarkets, getActiveBookCount, getMarkets } from './scanner';
import { getPositionCount, getTotalCost, getExpectedProfit, getStats, checkAndSettleExpired, getPositionSummary } from './positions';
import { notifyBotStarted, notifySettlement, notifyRunningStats } from './telegram';
import { closeWebSocket, getOrderBook } from './orderbook-ws';
import { runMakerStrategy, getMakerStats, cancelAllOrders } from './maker';
import { runGridStrategy, cancelAllGridOrders } from './maker-grid';

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
  Logger.header(`🎯 套利机器人 - ${CONFIG.GRID_MODE ? '🌐 震荡网格模式' : 'Taker+Maker混合策略'}`);
  
  // 显示配置
  Logger.info(`模式: ${CONFIG.SIMULATION_MODE ? '🔵 模拟' : '🔴 实盘'}`);
  
  if (CONFIG.GRID_MODE) {
    Logger.info(`🔢 网格间隔: ${CONFIG.GRID_STEP} (${(CONFIG.GRID_STEP * 100).toFixed(0)}%)`);
    Logger.info(`📦 每档数量: ${CONFIG.GRID_SHARES_PER_LEVEL} shares`);
    Logger.info(`💰 总成本上限: $${CONFIG.MAX_COMBINED_COST} (核心风控)`);
  } else {
    Logger.info(`最大组合成本: $${CONFIG.MAX_COMBINED_COST} (核心风控)`);
    Logger.info(`单次吃单上限: $${CONFIG.ORDER_SIZE_USD} | 单事件上限: $${CONFIG.MAX_EVENT_INVESTMENT_USD}`);
  }
  
  Logger.info(`扫描间隔: ${CONFIG.SCAN_INTERVAL_MS}ms`);
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
      
      // 运行策略
      if (CONFIG.GRID_MODE) {
        await runGridStrategy();
      } else {
        await runMakerStrategy();
      }
      
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
        
        // 显示总持仓统计
        const makerStats = getMakerStats();
        if (makerStats.totalUp > 0 || makerStats.totalDown > 0) {
          const diff = makerStats.totalUp - makerStats.totalDown;
          const imbalanceRatio = (Math.abs(diff) / (makerStats.totalUp + makerStats.totalDown)) * 100;
          Logger.info(`   📝 总持仓: UP ${makerStats.totalUp.toFixed(0)} @ $${(makerStats.totalUpCost / makerStats.totalUp).toFixed(3)} | DOWN ${makerStats.totalDown.toFixed(0)} @ $${(makerStats.totalDownCost / makerStats.totalDown).toFixed(3)} | 组合: $${makerStats.avgCost.toFixed(3)} | 不平衡: ${diff > 0 ? '+' : ''}${diff.toFixed(0)} (${imbalanceRatio.toFixed(1)}%)`);
        }
        
        // 显示当前市场价格（诊断）
        const markets = getMarkets();
        for (const m of markets) {
          const upBook = getOrderBook(m.upTokenId);
          const downBook = getOrderBook(m.downTokenId);
          if (upBook && downBook && upBook.bestAsk > 0 && downBook.bestAsk > 0) {
            Logger.info(`   💹 ${m.asset}: UP $${upBook.bestAsk.toFixed(3)} | DOWN $${downBook.bestAsk.toFixed(3)}`);
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
  if (CONFIG.GRID_MODE) {
    await cancelAllGridOrders();
  } else {
    await cancelAllOrders();
  }
  closeWebSocket();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  Logger.info('收到终止信号，正在关闭...');
  if (CONFIG.GRID_MODE) {
    await cancelAllGridOrders();
  } else {
    await cancelAllOrders();
  }
  closeWebSocket();
  process.exit(0);
});

// 启动
mainLoop().catch(error => {
  Logger.error(`致命错误: ${error}`);
  process.exit(1);
});

