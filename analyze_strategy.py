import pandas as pd
import numpy as np
from datetime import datetime

# 读取数据
df = pd.read_csv('C:/Users/PC/PycharmProjects/PythonProject/trades.csv')

# 转换时间
df['时间'] = pd.to_datetime(df['时间'])

# 按事件和时间排序
df = df.sort_values(['slug', '时间'])

# 分析每个事件
print("=" * 80)
print("完整事件周期分析")
print("=" * 80)

for slug, group in df.groupby('slug'):
    print(f"\n{'='*80}")
    print(f"事件: {group['事件标题'].iloc[0]}")
    print(f"总交易数: {len(group)}")
    print(f"时间范围: {group['时间'].min()} 到 {group['时间'].max()}")
    print(f"持续时间: {(group['时间'].max() - group['时间'].min()).total_seconds():.0f}秒")
    
    # 统计UP/DOWN
    up_trades = group[group['结果'] == 'Up']
    down_trades = group[group['结果'] == 'Down']
    
    up_qty = up_trades['数量'].sum()
    down_qty = down_trades['数量'].sum()
    up_cost = up_trades['金额'].sum()
    down_cost = down_trades['金额'].sum()
    
    print(f"\n仓位统计:")
    print(f"  UP:   {up_qty:.2f} shares @ 平均 ${up_cost/up_qty if up_qty > 0 else 0:.4f} | 总成本 ${up_cost:.2f}")
    print(f"  DOWN: {down_qty:.2f} shares @ 平均 ${down_cost/down_qty if down_qty > 0 else 0:.4f} | 总成本 ${down_cost:.2f}")
    print(f"  组合成本: ${(up_cost + down_cost)/(up_qty if up_qty > 0 else 1):.4f} (每对)")
    print(f"  不平衡: {abs(up_qty - down_qty):.2f} shares")
    
    # 价格分析
    print(f"\n价格范围:")
    print(f"  UP:   ${up_trades['价格'].min():.2f} - ${up_trades['价格'].max():.2f}")
    print(f"  DOWN: ${down_trades['价格'].min():.2f} - ${down_trades['价格'].max():.2f}")
    
    # 时间序列分析 - 前10笔和后10笔
    print(f"\n交易时间序列 (前10笔):")
    for idx, row in group.head(10).iterrows():
        print(f"  {row['时间'].strftime('%H:%M:%S')} | {row['结果']:4s} | {row['数量']:6.2f} @ ${row['价格']:.3f} | 总${row['金额']:.2f}")
    
    if len(group) > 20:
        print(f"\n  ... (中间{len(group)-20}笔) ...")
        print(f"\n交易时间序列 (后10笔):")
        for idx, row in group.tail(10).iterrows():
            print(f"  {row['时间'].strftime('%H:%M:%S')} | {row['结果']:4s} | {row['数量']:6.2f} @ ${row['价格']:.3f} | 总${row['金额']:.2f}")
    
    # 分析交易模式
    print(f"\n交易模式分析:")
    
    # 看是否先买便宜的
    first_trades = group.head(20)
    first_up_avg = first_trades[first_trades['结果']=='Up']['价格'].mean()
    first_down_avg = first_trades[first_trades['结果']=='Down']['价格'].mean()
    
    print(f"  前20笔平均价格: UP ${first_up_avg:.3f} | DOWN ${first_down_avg:.3f}")
    
    if first_up_avg < 0.35 or first_down_avg < 0.35:
        print(f"  ✅ 策略特征: 开始买入便宜方 (<$0.35)")
    
    # 看是否有对冲
    up_first = up_trades['时间'].min()
    down_first = down_trades['时间'].min()
    time_diff = abs((up_first - down_first).total_seconds())
    
    print(f"  首次UP交易: {up_first.strftime('%H:%M:%S')}")
    print(f"  首次DOWN交易: {down_first.strftime('%H:%M:%S')}")
    print(f"  时间差: {time_diff:.1f}秒")
    
    if time_diff < 60:
        print(f"  ✅ 策略特征: 快速对冲 (<60秒)")
    else:
        print(f"  ⚠️ 策略特征: 延迟对冲或持仓策略")
    
    # 分析是否持续加仓
    if len(group) > 50:
        print(f"  ✅ 策略特征: 持续交易 ({len(group)}笔)")
    
    print(f"\n{'='*80}")

# 全局统计
print(f"\n\n{'='*80}")
print("全局策略总结")
print("="*80)

total_events = df['slug'].nunique()
print(f"总事件数: {total_events}")
print(f"总交易笔数: {len(df)}")
print(f"平均每事件交易: {len(df)/total_events:.1f}笔")

# 价格分布
print(f"\n价格分布:")
print(f"  UP价格: 中位数 ${df[df['结果']=='Up']['价格'].median():.3f}")
print(f"  DOWN价格: 中位数 ${df[df['结果']=='Down']['价格'].median():.3f}")

# 是否偏好某一边
up_total = df[df['结果']=='Up']['数量'].sum()
down_total = df[df['结果']=='Down']['数量'].sum()
print(f"\n整体仓位:")
print(f"  UP总量: {up_total:.2f}")
print(f"  DOWN总量: {down_total:.2f}")
print(f"  比例: {up_total/down_total:.2f} : 1")

print("\n分析完成！")

