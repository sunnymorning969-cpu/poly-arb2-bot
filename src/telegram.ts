import axios from 'axios';
import CONFIG from './config';
import { SettlementResult } from './positions';

const TELEGRAM_API = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}`;

// 消息队列
const messageQueue: Array<{ text: string; priority: boolean }> = [];
let isProcessing = false;

const sendTelegramMessage = async (text: string, priority = false): Promise<void> => {
  messageQueue.push({ text, priority });
  
  if (priority) {
    const item = messageQueue.pop()!;
    messageQueue.unshift(item);
  }
  
  processQueue();
};

const processQueue = async () => {
  if (isProcessing || messageQueue.length === 0) return;
  
  isProcessing = true;
  
  while (messageQueue.length > 0) {
    const { text } = messageQueue.shift()!;
    
    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: CONFIG.TELEGRAM_GROUP_ID,
        text,
        parse_mode: 'HTML',
      }, { timeout: 10000 });
    } catch (error) {
      // 忽略发送错误
    }
    
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  
  isProcessing = false;
};

// 发送启动通知
export const notifyBotStarted = async () => {
  const message = `
🚀 <b>【进化版】套利机器人启动</b>

⚙️ <b>配置:</b>
   • 模式: ${CONFIG.SIMULATION_MODE ? '🔵 模拟' : '🔴 实盘'}
   • 最大组合成本: $${CONFIG.MAX_SAME_POOL_COST}
   • 单轮挂单: $${CONFIG.MAKER_ORDER_SIZE_USD}
   • 单事件上限: $${CONFIG.MAX_EVENT_INVESTMENT_USD}
   • 15分钟场: ${CONFIG.ENABLE_15MIN ? '✅' : '❌'}
   • 1小时场: ${CONFIG.ENABLE_1HR ? '✅' : '❌'}

📌 <b>策略说明:</b>
   📝 Maker挂单 + Taker配对
   按深度分布到 3 档价格
`.trim();

  await sendTelegramMessage(message, true);
};

// 发送结算通知（标记第几次结算）
export const notifySettlement = async (
  result: SettlementResult,
  stats: { totalSettled: number; totalProfit: number; winCount: number; lossCount: number; winRate: number }
) => {
  const { position, outcome, payout, profit } = result;
  
  const profitEmoji = profit >= 0 ? '🎉' : '😢';
  const outcomeEmoji = outcome === 'up' ? '⬆️' : '⬇️';
  const profitSign = profit >= 0 ? '+' : '';
  const profitPercent = position.totalCost > 0 ? (profit / position.totalCost) * 100 : 0;
  const timeGroupName = position.timeGroup === '15min' ? '15分钟场' : '1小时场';
  
  const message = `
${profitEmoji} <b>【进化版】${timeGroupName} 第${stats.totalSettled}次结算</b>

📊 <b>${position.asset} ${outcomeEmoji} ${outcome.toUpperCase()} 获胜</b>

💰 <b>本次仓位:</b>
   • Up: ${position.upShares.toFixed(0)} shares ($${position.upCost.toFixed(2)})
   • Down: ${position.downShares.toFixed(0)} shares ($${position.downCost.toFixed(2)})
   • 成本: $${position.totalCost.toFixed(2)} → 收回: $${payout.toFixed(2)}
   • 盈亏: <b>${profitSign}$${profit.toFixed(2)}</b> (${profitSign}${profitPercent.toFixed(1)}%)

━━━━━━━━━━━━━━━
📊 <b>累计统计:</b>
   • 胜率: ${stats.winRate.toFixed(1)}% (${stats.winCount}胜/${stats.lossCount}负)
   • 累计盈亏: ${stats.totalProfit >= 0 ? '+' : ''}$${stats.totalProfit.toFixed(2)}

${CONFIG.SIMULATION_MODE ? '⚠️ <i>模拟模式</i>' : ''}
`.trim();

  await sendTelegramMessage(message, true);
};

// 发送运行统计
export const notifyRunningStats = async (stats: {
  runtime: string;
  positionCount: number;
  totalCost: number;
  expectedProfit: number;
  totalSettled: number;
  totalProfit: number;
  winCount: number;
  lossCount: number;
  winRate: number;
}) => {
  const profitEmoji = stats.totalProfit >= 0 ? '📈' : '📉';
  
  const message = `
📊 <b>【进化版】运行统计</b>

⏱️ 运行时间: ${stats.runtime}

💼 <b>当前仓位:</b>
   • 活跃: ${stats.positionCount} 个
   • 成本: $${stats.totalCost.toFixed(2)}
   • 预期利润: +$${stats.expectedProfit.toFixed(2)}

💰 <b>已结算:</b>
   • 事件数: ${stats.totalSettled}
   • 胜率: ${stats.winRate.toFixed(1)}% (${stats.winCount}胜/${stats.lossCount}负)
   • ${profitEmoji} 累计盈亏: ${stats.totalProfit >= 0 ? '+' : ''}$${stats.totalProfit.toFixed(2)}

${CONFIG.SIMULATION_MODE ? '⚠️ <i>模拟模式</i>' : ''}
`.trim();

  await sendTelegramMessage(message, false);
};

// 发送交易通知
export const notifyTrade = async (
  pairInfo: string,
  timeGroup: string,
  upPrice: number,
  downPrice: number,
  shares: number,
  totalCost: number,
  profit: number,
  type: 'same_pool' | 'cross_pool'
) => {
  const combinedCost = upPrice + downPrice;
  const typeTag = type === 'same_pool' ? '📊 同池套利' : '🔀 跨池套利';
  
  const message = `
💰 <b>【进化版】${typeTag}成交</b>

📊 <b>${timeGroup === '15min' ? '15分钟' : '1小时'}场 - ${pairInfo}</b>

💵 <b>价格:</b>
   • Up: $${upPrice.toFixed(3)}
   • Down: $${downPrice.toFixed(3)}
   • 组合: $${combinedCost.toFixed(4)}

📦 <b>成交:</b>
   • 数量: ${shares} shares (每边)
   • 成本: $${totalCost.toFixed(2)}
   • 利润: +$${profit.toFixed(2)} (${((1-combinedCost)*100).toFixed(2)}%)

${CONFIG.SIMULATION_MODE ? '⚠️ <i>模拟模式</i>' : ''}
`.trim();

  await sendTelegramMessage(message, false);
};

