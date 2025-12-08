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
  ENABLE_1HR: process.env.ENABLE_1HR !== '0',  // 默认开启1小时（更多机会）
  
  // 启用混合策略（默认开启）
  ENABLE_MAKER: true,
  
  // ========== 混合策略核心参数（基于数据分析） ==========
  // 数据来源：15000笔交易，6个事件，100%胜率，平均成本$0.9894
  
  // 目标组合成本阈值（$1.00 = 不亏不赚，<$1.00 = 有利润）
  MAX_COMBINED_COST: parseFloat(process.env.MAX_COMBINED_COST || '1.00'),
  
  // 吃单阈值：低于此价格视为便宜，优先吃单（放宽到 $0.55）
  TAKER_THRESHOLD: parseFloat(process.env.TAKER_THRESHOLD || '0.55'),
  
  // ========== 价格范围（放宽以适应市场波动） ==========
  // Up 和 Down 是互补的：Up 便宜时 Down 贵，反之亦然
  // 需要足够宽的范围才能配对成功
  UP_PRICE_MIN: 0.10,   // Up 最低
  UP_PRICE_MAX: 0.80,   // Up 最高（当 Down < $0.20 时，Up 可能 > $0.75）
  
  DOWN_PRICE_MIN: 0.10, // Down 最低
  DOWN_PRICE_MAX: 0.80, // Down 最高（当 Up < $0.20 时，Down 可能 > $0.75）
  
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

