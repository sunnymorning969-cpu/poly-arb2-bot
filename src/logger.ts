import chalk from 'chalk';

const getTimestamp = () => {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
};

export const Logger = {
  info: (message: string) => {
    console.log(chalk.blue(`[${getTimestamp()}]`), chalk.white('ℹ️'), message);
  },
  
  success: (message: string) => {
    console.log(chalk.blue(`[${getTimestamp()}]`), chalk.green('✅'), message);
  },
  
  warning: (message: string) => {
    console.log(chalk.blue(`[${getTimestamp()}]`), chalk.yellow('⚠️'), message);
  },
  
  error: (message: string) => {
    console.log(chalk.blue(`[${getTimestamp()}]`), chalk.red('❌'), message);
  },
  
  arbitrage: (message: string) => {
    console.log(chalk.blue(`[${getTimestamp()}]`), chalk.magenta('💰'), message);
  },
  
  trade: (success: boolean, message: string) => {
    const icon = success ? chalk.green('✅') : chalk.red('❌');
    console.log(chalk.blue(`[${getTimestamp()}]`), icon, message);
  },
  
  divider: () => {
    console.log(chalk.gray('─'.repeat(60)));
  },
  
  header: (title: string) => {
    console.log('\n' + chalk.cyan('═'.repeat(60)));
    console.log(chalk.cyan.bold(`  ${title}`));
    console.log(chalk.cyan('═'.repeat(60)) + '\n');
  },
};

export default Logger;
