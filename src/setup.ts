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
  console.log('  📝 策略: 低价挂单等待 + Taker配对');
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
  
  // Telegram
  console.log('\n━━━ Telegram 通知 ━━━');
  const telegramToken = await question(`Bot Token [${existingEnv.TELEGRAM_BOT_TOKEN ? '已配置' : '未配置'}]: `) || existingEnv.TELEGRAM_BOT_TOKEN || '';
  const telegramGroup = await question(`Group ID [${existingEnv.TELEGRAM_GROUP_ID || '未配置'}]: `) || existingEnv.TELEGRAM_GROUP_ID || '';
  
  // 模式选择
  console.log('\n━━━ 运行模式 ━━━');
  const simMode = await question('模拟模式? (1=模拟, 0=实盘) [1]: ') || '1';
  const simulationMode = simMode !== '0';
  
  // 核心参数
  console.log('\n━━━ 核心参数 ━━━');
  const maxCost = await question(`最大组合成本 (Up+Down < 此值) [0.995]: `) || '0.995';
  const orderSize = await question('单次挂单金额 (USD) [15]: ') || '15';
  const maxInvestment = await question('单事件最大投入 (USD) [5000]: ') || '5000';
  
  // 市场选择
  console.log('\n━━━ 市场选择 ━━━');
  const enable15min = await question('启用15分钟场? (1=是, 0=否) [1]: ') || '1';
  const enable1hr = await question('启用1小时场? (1=是, 0=否) [0]: ') || '0';
  
  // 生成配置
  const envContent = `# ========== 钱包配置 ==========
PRIVATE_KEY=${privateKey}
PROXY_WALLET=${proxyWallet}

# ========== Telegram 配置 ==========
TELEGRAM_BOT_TOKEN=${telegramToken}
TELEGRAM_GROUP_ID=${telegramGroup}

# ========== 运行模式 ==========
SIMULATION_MODE=${simulationMode}

# ========== 核心参数 ==========
# 最大组合成本 (目标价 = 此值 - 对面价格 - 0.01)
MAX_SAME_POOL_COST=${maxCost}

# 单次挂单金额 (USD)
MAKER_ORDER_SIZE_USD=${orderSize}

# 单事件最大投入 (USD)
MAX_EVENT_INVESTMENT_USD=${maxInvestment}

# ========== 市场开关 ==========
ENABLE_15MIN=${enable15min === '1' ? '1' : '0'}
ENABLE_1HR=${enable1hr === '1' ? '1' : '0'}
`;

  // 写入文件
  fs.writeFileSync(envPath, envContent);
  
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('  ✅ 配置完成！');
  console.log('═'.repeat(60));
  console.log('\n📝 配置摘要:');
  console.log(`   模式: ${simulationMode ? '🔵 模拟' : '🔴 实盘'}`);
  console.log(`   最大组合成本: $${maxCost}`);
  console.log(`   单次挂单: $${orderSize}`);
  console.log(`   单事件上限: $${maxInvestment}`);
  console.log(`   15分钟场: ${enable15min === '1' ? '✅' : '❌'}`);
  console.log(`   1小时场: ${enable1hr === '1' ? '✅' : '❌'}`);
  console.log('\n📌 策略说明:');
  console.log('   1. 计算目标价 = 阈值 - 对面价格 - 安全边际');
  console.log('   2. 挂低价单，耐心等待被吃');
  console.log('   3. 只有能挂更低价格时才撤单重挂');
  console.log('   4. 成交后立即 Taker 配对');
  console.log('\n运行 npm run dev 启动机器人\n');
  
  rl.close();
};

setup().catch(error => {
  console.error('配置出错:', error);
  rl.close();
  process.exit(1);
});
