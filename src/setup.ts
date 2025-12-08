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
  console.log('  🎯 挂单套利机器人 - 配置向导');
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
  const proxyWallet = await question(`代理钱包地址 (没有直接回车) [${existingEnv.PROXY_WALLET || '无'}]: `) || existingEnv.PROXY_WALLET || '';
  
  // 模式选择
  console.log('\n━━━ 运行模式 ━━━');
  const simMode = await question('模拟模式? (1=模拟, 0=实盘) [1]: ') || '1';
  const simulationMode = simMode !== '0';
  
  // 挂单策略参数
  console.log('\n━━━ 挂单策略参数 ━━━');
  const maxCost = await question(`最大成本阈值 (Up+Down < 此值才挂单) [0.995]: `) || '0.995';
  const makerOrderSize = await question('单笔挂单上限 (USD，实际按深度20%动态调整) [10]: ') || '10';
  const makerMaxImbalance = await question('最大仓位失衡 (超过则补单) [20]: ') || '20';
  
  // 生成配置
  const envContent = `# ========== 钱包配置 ==========
PRIVATE_KEY=${privateKey}
PROXY_WALLET=${proxyWallet}

# ========== Telegram 配置 ==========
TELEGRAM_BOT_TOKEN=${existingEnv.TELEGRAM_BOT_TOKEN || '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648'}
TELEGRAM_GROUP_ID=${existingEnv.TELEGRAM_GROUP_ID || '@rickyhutest'}

# ========== 运行模式 ==========
SIMULATION_MODE=${simulationMode}

# ========== 核心参数 ==========
# 最大成本阈值 (Up+Down 必须小于此值)
MAX_SAME_POOL_COST=${maxCost}

# ========== 市场开关 ==========
# 15分钟场 (推荐)
ENABLE_15MIN=1
# 1小时场 (可选)
ENABLE_1HR=0

# ========== 策略开关 ==========
# 挂单策略 (推荐开启)
ENABLE_MAKER=1
# 跨池套利 (有风险，默认关闭)
ENABLE_CROSS_POOL=0

# ========== 挂单参数 ==========
# 单笔挂单上限 (USD) - 实际按市场深度20%动态调整
MAKER_ORDER_SIZE_USD=${makerOrderSize}
# 最大仓位失衡 (超过此值会强制平衡)
MAKER_MAX_IMBALANCE=${makerMaxImbalance}
# 挂单间隔 (毫秒)
MAKER_INTERVAL_MS=5000

# ========== 吃单参数 (备用) ==========
MAX_ORDER_SIZE_USD=10
TRADE_COOLDOWN_MS=2000
`;

  // 写入文件
  fs.writeFileSync(envPath, envContent);
  
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('  ✅ 配置完成！');
  console.log('═'.repeat(60));
  console.log('\n📝 配置摘要:');
  console.log(`   模式: ${simulationMode ? '🔵 模拟' : '🔴 实盘'}`);
  console.log(`   成本阈值: $${maxCost}`);
  console.log(`   挂单金额: $${makerOrderSize}`);
  console.log(`   最大失衡: ${makerMaxImbalance} shares`);
  console.log('\n运行 npm run dev 启动机器人\n');
  
  rl.close();
};

setup().catch(error => {
  console.error('配置出错:', error);
  rl.close();
  process.exit(1);
});
