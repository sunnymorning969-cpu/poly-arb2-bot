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
  console.log('  🎯 套利机器人 - 配置向导');
  console.log('  📊 策略: 91% Maker + 9% Taker 配对');
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
  
  console.log('📋 请配置以下参数 (直接回车使用推荐值)\n');
  
  // 钱包配置
  console.log('━━━ 钱包配置 ━━━');
  const privateKey = await question(`私钥 [${existingEnv.PRIVATE_KEY ? '已配置' : '未配置'}]: `) || existingEnv.PRIVATE_KEY || '';
  const proxyWallet = await question(`代理钱包地址 (没有直接回车) [${existingEnv.PROXY_WALLET || '无'}]: `) || existingEnv.PROXY_WALLET || '';
  
  // 模式选择
  console.log('\n━━━ 运行模式 ━━━');
  const simMode = await question('模拟模式? (1=模拟, 0=实盘) [1]: ') || '1';
  const simulationMode = simMode !== '0';
  
  // 策略参数（基于数据分析的推荐值）
  console.log('\n━━━ 策略参数 (基于15000笔交易分析) ━━━');
  console.log('   发现: 91% Maker单, 9% Taker单');
  console.log('   发现: 配对平均需要20秒，不是同时');
  console.log('   策略: 双边挂Maker，单边成交后Taker配对');
  console.log('');
  
  const maxCombinedCost = await question('目标组合成本 (Up+Down < 此值) [0.99]: ') || '0.99';
  const takerThreshold = await question('Taker配对最高价 (失衡时配对用) [0.65]: ') || '0.65';
  const makerOrderSize = await question('单笔交易金额 (USD) [10]: ') || '10';
  const makerMaxImbalance = await question('最大仓位失衡 (超过则强制平衡) [30]: ') || '30';
  
  // 市场选择
  console.log('\n━━━ 市场选择 ━━━');
  const enable15min = await question('启用 15 分钟场? (1=是, 0=否) [1]: ') || '1';
  const enable1hr = await question('启用 1 小时场? (1=是, 0=否) [0]: ') || '0';
  
  // 生成配置
  const envContent = `# ═══════════════════════════════════════════════════════════
# 套利机器人配置（基于15000笔交易分析）
# 策略: 91% Maker + 9% Taker 配对
# ═══════════════════════════════════════════════════════════

# ========== 钱包配置 ==========
PRIVATE_KEY=${privateKey}
PROXY_WALLET=${proxyWallet}

# ========== Telegram 配置 ==========
TELEGRAM_BOT_TOKEN=${existingEnv.TELEGRAM_BOT_TOKEN || '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648'}
TELEGRAM_GROUP_ID=${existingEnv.TELEGRAM_GROUP_ID || '@rickyhutest'}

# ========== 运行模式 ==========
SIMULATION_MODE=${simulationMode}

# ========== 核心策略参数 ==========
# 目标组合成本（< $0.99 才有利润）
MAX_COMBINED_COST=${maxCombinedCost}

# Taker配对最高价（失衡时用Taker补单的最高价）
TAKER_THRESHOLD=${takerThreshold}

# ========== 市场开关 ==========
ENABLE_15MIN=${enable15min === '1' ? '1' : '0'}
ENABLE_1HR=${enable1hr === '1' ? '1' : '0'}

# ========== 交易参数 ==========
# 单笔交易金额 (USD)
MAKER_ORDER_SIZE_USD=${makerOrderSize}

# 最大仓位失衡 (超过此值会强制平衡)
MAKER_MAX_IMBALANCE=${makerMaxImbalance}

# 扫描间隔 (毫秒) - 5ms 极速扫描
MAKER_INTERVAL_MS=5

# 单笔最大 shares
MAKER_MAX_SHARES_PER_ORDER=20
`;

  // 写入文件
  fs.writeFileSync(envPath, envContent);
  
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('  ✅ 配置完成！');
  console.log('═'.repeat(60));
  console.log('\n📝 配置摘要:');
  console.log(`   模式: ${simulationMode ? '🔵 模拟' : '🔴 实盘'}`);
  console.log(`   目标组合成本: < $${maxCombinedCost}`);
  console.log(`   Taker配对最高价: $${takerThreshold}`);
  console.log(`   单笔金额: $${makerOrderSize}`);
  console.log(`   最大失衡: ${makerMaxImbalance} shares`);
  console.log(`   市场: ${enable15min === '1' ? '15分钟' : ''}${enable15min === '1' && enable1hr === '1' ? ' + ' : ''}${enable1hr === '1' ? '1小时' : ''}`);
  console.log('\n📊 策略说明 (基于数据分析):');
  console.log('   • 双边挂Maker单，等待成交 (91%交易)');
  console.log('   • 单边成交后，用Taker配对 (9%交易)');
  console.log('   • 配对不是同时的，平均间隔20秒');
  console.log('   • 75%交易在前半段完成，早期进场');
  console.log('\n运行 npm run dev 启动机器人\n');
  
  rl.close();
};

setup().catch(error => {
  console.error('配置出错:', error);
  rl.close();
  process.exit(1);
});
