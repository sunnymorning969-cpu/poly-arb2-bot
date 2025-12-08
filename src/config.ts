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
  
  // ========== 同池套利核心参数 ==========
  // 最大同池成本阈值 (Up + Down 必须小于此值才交易)
  MAX_SAME_POOL_COST: parseFloat(process.env.MAX_SAME_POOL_COST || '0.995'),
  
  // 单笔订单最大金额 (USD)
  MAX_ORDER_SIZE_USD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '10'),
  
  // 交易冷却时间 (毫秒)
  TRADE_COOLDOWN_MS: parseInt(process.env.TRADE_COOLDOWN_MS || '2000'),
  
  // 扫描间隔 (毫秒)
  SCAN_INTERVAL_MS: 100,
  
  // ========== 市场开关 ==========
  ENABLE_15MIN: process.env.ENABLE_15MIN !== '0',
  ENABLE_1HR: process.env.ENABLE_1HR !== '0',
  
  // ========== 跨池套利开关 ==========
  // 跨池套利有方向风险，建议关闭
  ENABLE_CROSS_POOL: process.env.ENABLE_CROSS_POOL === '1',
  
  // ========== 挂单策略 ==========
  // 启用挂单策略（主动创造套利机会）
  ENABLE_MAKER: process.env.ENABLE_MAKER === '1',
  
  // 挂单间隔 (毫秒)
  MAKER_INTERVAL_MS: parseInt(process.env.MAKER_INTERVAL_MS || '5000'),
  
  // 单笔挂单金额 (USD)
  MAKER_ORDER_SIZE_USD: parseFloat(process.env.MAKER_ORDER_SIZE_USD || '5'),
  
  // 单笔挂单最大 shares
  MAKER_MAX_SHARES_PER_ORDER: parseInt(process.env.MAKER_MAX_SHARES_PER_ORDER || '10'),
  
  // 最大仓位失衡 (超过此值会强制平衡)
  MAKER_MAX_IMBALANCE: parseInt(process.env.MAKER_MAX_IMBALANCE || '20'),
  
  // ========== API ==========
  POLYMARKET_API: 'https://gamma-api.polymarket.com',
  CLOB_API: 'https://clob.polymarket.com',
  WS_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  CHAIN_ID: 137,
};

export default CONFIG;

