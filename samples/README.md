# 样例记忆包

## godot-2d-pipeline.mirrorpack

一个 Godot 2D 小项目「从 0 到上线」的可复用判断，用来演示记忆包的完整形态：

- **6 条记忆**：铁律 / 偏好 / 决策 / 踩坑 / 模糊
- **4 条经验**：trigger（情境）→ action（做法）→ why（理由）→ boundary（边界）→ evidence（证据）
- 不含任何原始对话，也不含真实项目路径与账号

### 怎么用

1. 打开 Mirror 面板 → 记忆包 → 「高级：记忆包文件」→ 展开
2. 选中 `samples/godot-2d-pipeline.mirrorpack` → 导入（策略默认 `skip_conflicts`，不覆盖你已有的记忆）
3. 导入后：待确认 Tab 会显示来源为「记忆包导入」的条目；蒸馏卡片会显示该包带回来的画像

### 重新生成

```powershell
node scripts/build-samples.mjs
```

生成脚本会用**真实的包解析器**自校验（`packs.parse` + 试装），保证样例一定能被导入。
> 许可：本示例包随仓库以 MIT 提供，可自由使用、修改与再分发。
