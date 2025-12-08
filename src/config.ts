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
  // 根据分析：只交易 BTC 15分钟场效果最好
  ENABLE_15MIN: process.env.ENABLE_15MIN !== '0',
  ENABLE_1HR: process.env.ENABLE_1HR === '1',  // 默认关闭1小时
  
  // 启用 Maker 策略（默认开启）
  ENABLE_MAKER: true,
  
  // ========== 核心策略参数（基于数据分析：15000笔交易）==========
  // 发现：91% Maker，9% Taker；100% 事件 Maker 先成交
  // 策略：双边挂 Maker 单，单边成交后用 Taker 配对
  
  // 目标组合成本阈值（< $0.99 才有利润）
  MAX_COMBINED_COST: parseFloat(process.env.MAX_COMBINED_COST || '0.99'),
  
  // Taker配对阈值：用于失衡时Taker补单的最高价（不是入场阈值）
  TAKER_THRESHOLD: parseFloat(process.env.TAKER_THRESHOLD || '0.65'),
  
  // ========== 价格范围（放宽以适应市场波动） ==========
  // Up 和 Down 是互补的：Up 便宜时 Down 贵，反之亦然
  // 需要足够宽的范围才能配对成功
  UP_PRICE_MIN: 0.10,   // Up 最低
  UP_PRICE_MAX: 0.80,   // Up 最高（当 Down < $0.20 时，Up 可能 > $0.75）
  
  DOWN_PRICE_MIN: 0.10, // Down 最低
  DOWN_PRICE_MAX: 0.80, // Down 最高（当 Up < $0.20 时，Down 可能 > $0.75）
  
  // ========== 挂单参数 ==========
  // 扫描间隔 (毫秒) - 5ms 极速扫描
  MAKER_INTERVAL_MS: parseInt(process.env.MAKER_INTERVAL_MS || '5'),
  
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

