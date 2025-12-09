import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // ========== 钱包配置 ==========
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',
  PROXY_WALLET: process.env.PROXY_WALLET || '',
  
  // ========== Telegram 配置 ==========
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_GROUP_ID: process.env.TELEGRAM_GROUP_ID || '',
  
  // ========== 模式 ==========
  SIMULATION_MODE: process.env.SIMULATION_MODE !== 'false',
  
  // ========== 核心参数 ==========
  // 最大组合成本阈值 (avgUp + avgDown 必须小于此值)
  MAX_COMBINED_COST: parseFloat(process.env.MAX_COMBINED_COST || '0.985'),
  
  // 单次吃单金额/上限 (USD) - 防止单笔过大
  ORDER_SIZE_USD: parseFloat(process.env.ORDER_SIZE_USD || '20'),
  
  // 单事件最大投入 (USD) - 风控上限
  MAX_EVENT_INVESTMENT_USD: parseFloat(process.env.MAX_EVENT_INVESTMENT_USD || '5000'),
  
  // 扫描间隔 (毫秒)
  SCAN_INTERVAL_MS: 5,
  
  // ========== 网格策略参数 ==========
  GRID_MODE: process.env.GRID_MODE === 'true',  // 是否启用网格模式
  GRID_STEP: parseFloat(process.env.GRID_STEP || '0.01'),  // 网格间隔
  GRID_SHARES_PER_LEVEL: parseInt(process.env.GRID_SHARES_PER_LEVEL || '16'),  // 每档shares
  
  // ========== 市场开关 ==========
  ENABLE_15MIN: process.env.ENABLE_15MIN !== '0',
  ENABLE_1HR: process.env.ENABLE_1HR === '1',
  
  // ========== API ==========
  POLYMARKET_API: 'https://gamma-api.polymarket.com',
  CLOB_API: 'https://clob.polymarket.com',
  WS_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  CHAIN_ID: 137,
};

export default CONFIG;

