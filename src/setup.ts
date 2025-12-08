import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (prompt: string): Promise<string> => {
  return new Promise(resolve => {
    rl.question(prompt, answer => resolve(answer.trim()));
  });
};

const setup = async () => {
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('  🎯 同池套利机器人 - 配置向导');
  console.log('═'.repeat(60));
  console.log('\n');
  
  // 读取现有配置
  const envPath = path.join(__dirname, '..', '.env');
  let existingEnv: { [key: string]: string } = {};
  
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split('\n').forEach(line => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        existingEnv[match[1].trim()] = match[2].trim();
      }
    });
  }
  
  console.log('📋 请配置以下参数 (直接回车使用默认值)\n');
  
  // 钱包配置
  console.log('━━━ 钱包配置 ━━━');
  const privateKey = await question(`私钥 [${existingEnv.PRIVATE_KEY ? '已配置' : '未配置'}]: `) || existingEnv.PRIVATE_KEY || '';
  const proxyWallet = await question(`代理钱包地址 [${existingEnv.PROXY_WALLET || '无'}]: `) || existingEnv.PROXY_WALLET || '';
  
  // 模式选择
  console.log('\n━━━ 运行模式 ━━━');
  const simMode = await question('模拟模式? (1=是, 0=否) [1]: ') || '1';
  const simulationMode = simMode !== '0';
  
  // 交易参数
  console.log('\n━━━ 交易参数 ━━━');
  const maxCost = await question(`最大同池成本阈值 (建议 0.99-0.995) [0.995]: `) || '0.995';
  const maxOrder = await question(`单笔订单上限 (USD) [10]: `) || '10';
  const cooldown = await question(`交易冷却时间 (毫秒) [2000]: `) || '2000';
  
  // 市场开关
  console.log('\n━━━ 市场开关 ━━━');
  const enable15m = await question('开启15分钟场? (1=是, 0=否) [1]: ') || '1';
  const enable1h = await question('开启1小时场? (1=是, 0=否) [1]: ') || '1';
  
  // 策略选择
  console.log('\n━━━ 策略选择 ━━━');
  console.log('⚠️  跨池套利有方向风险，建议关闭');
  const enableCross = await question('开启跨池套利? (1=是, 0=否) [0]: ') || '0';
  
  console.log('\n━━━ 挂单策略 (推荐) ━━━');
  console.log('💡 挂单策略可以主动创造套利机会');
  const enableMaker = await question('开启挂单策略? (1=是, 0=否) [1]: ') || '1';
  
  let makerOrderSize = '5';
  let makerMaxImbalance = '20';
  if (enableMaker === '1') {
    makerOrderSize = await question('单笔挂单金额 (USD) [5]: ') || '5';
    makerMaxImbalance = await question('最大仓位失衡 (shares) [20]: ') || '20';
  }
  
  // 生成配置
  const envContent = `# ========== 钱包配置 ==========
PRIVATE_KEY=${privateKey}
PROXY_WALLET=${proxyWallet}

# ========== Telegram 配置 ==========
TELEGRAM_BOT_TOKEN=7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648
TELEGRAM_GROUP_ID=@rickyhutest

# ========== 运行模式 ==========
SIMULATION_MODE=${simulationMode}

# ========== 交易参数 ==========
# 最大同池成本阈值 (Up+Down 必须小于此值)
MAX_SAME_POOL_COST=${maxCost}

# 单笔订单上限 (USD)
MAX_ORDER_SIZE_USD=${maxOrder}

# 交易冷却时间 (毫秒)
TRADE_COOLDOWN_MS=${cooldown}

# ========== 市场开关 ==========
ENABLE_15MIN=${enable15m}
ENABLE_1HR=${enable1h}

# ========== 策略开关 ==========
# 跨池套利有方向风险，建议关闭 (0=关闭, 1=开启)
ENABLE_CROSS_POOL=${enableCross}

# ========== 挂单策略 ==========
# 启用挂单策略 (0=关闭, 1=开启)
ENABLE_MAKER=${enableMaker}

# 单笔挂单金额 (USD)
MAKER_ORDER_SIZE_USD=${makerOrderSize}

# 最大仓位失衡 (超过此值会强制平衡)
MAKER_MAX_IMBALANCE=${makerMaxImbalance}
`;

  // 写入文件
  fs.writeFileSync(envPath, envContent);
  
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('  ✅ 配置完成！');
  console.log('═'.repeat(60));
  console.log('\n配置已保存到 .env 文件\n');
  console.log('运行 npm run dev 启动机器人\n');
  
  rl.close();
};

setup().catch(error => {
  console.error('配置出错:', error);
  rl.close();
  process.exit(1);
});
