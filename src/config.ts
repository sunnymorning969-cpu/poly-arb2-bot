import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // ========== 钱包配置 ==========
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',
  PROXY_WALLET: process.env.PROXY_WALLET || '',
  
  // ========== Telegram 配置 ==========
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648',
  TELEGRAM_GROUP_ID: process.env.TELEGRAM_GROUP_ID || '@rickyhutest',
  
  // ========== 模式 ==========
  SIMULATION_MODE: process.env.SIMULATION_MODE !== 'false',
  
  // ========== 市场开关 ==========
  ENABLE_15MIN: process.env.ENABLE_15MIN !== '0',
  ENABLE_1HR: process.env.ENABLE_1HR === '1',  // 默认关闭1小时
  
  // 启用混合策略（默认开启）
  ENABLE_MAKER: true,
  
  // ========== 混合策略核心参数（基于数据分析） ==========
  // 数据来源：15000笔交易，6个事件，100%胜率，平均成本$0.9894
  
  // 目标组合成本阈值（数据显示66.7%事件成本在$0.95-$0.98）
  MAX_COMBINED_COST: parseFloat(process.env.MAX_COMBINED_COST || '0.98'),
  
  // 吃单阈值：低于此价格直接吃单（0.48 + 0.50 = 0.98，有利润空间）
  TAKER_THRESHOLD: parseFloat(process.env.TAKER_THRESHOLD || '0.48'),
  
  // ========== 价格范围（基于数据分析） ==========
  // Up 交易 74% 在 $0.50-$0.90
  UP_PRICE_MIN: 0.45,  // Up 挂单最低价格
  UP_PRICE_MAX: 0.85,  // Up 挂单最高价格（放宽以捕捉更多机会）
  
  // Down 交易 58% 在 $0.20-$0.50
  DOWN_PRICE_MIN: 0.15,  // Down 挂单最低价格（放宽）
  DOWN_PRICE_MAX: 0.55,  // Down 挂单最高价格（放宽）
  
  // ========== 挂单参数 ==========
  // 挂单间隔 (毫秒)
  MAKER_INTERVAL_MS: parseInt(process.env.MAKER_INTERVAL_MS || '3000'),
  
  // 单笔挂单金额 (USD)
  MAKER_ORDER_SIZE_USD: parseFloat(process.env.MAKER_ORDER_SIZE_USD || '10'),
  
  // 单笔挂单最大 shares
  MAKER_MAX_SHARES_PER_ORDER: parseInt(process.env.MAKER_MAX_SHARES_PER_ORDER || '20'),
  
  // 最大仓位失衡 (超过此值会强制平衡)
  MAKER_MAX_IMBALANCE: parseInt(process.env.MAKER_MAX_IMBALANCE || '30'),
  
  // 挂单偏移量（在 bestBid 上方多少挂单）
  MAKER_OFFSET: 0.01,
  
  // ========== API ==========
  POLYMARKET_API: 'https://gamma-api.polymarket.com',
  CLOB_API: 'https://clob.polymarket.com',
  WS_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  CHAIN_ID: 137,
};

export default CONFIG;

