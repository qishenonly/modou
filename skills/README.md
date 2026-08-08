# 内置 Skills

modou 0.15.0 起支持技能：遵循 [Agent Skills 开放标准](https://agentskills.io) 的
SKILL.md 格式，三级发现（仓库内置 `skills/` < 全局 `~/.modou/skills/` < 项目
`.modou/skills/`，后者覆盖前者），渐进式披露——只有 name + description 常驻
上下文，正文由模型按需通过 `skill` 工具加载。

## 内置技能

| 技能             | 说明                                                       |
| ---------------- | ---------------------------------------------------------- |
| `code-review`    | 逐文件审查代码改动，先 diff 后上下文，按严重度分级输出意见 |
| `write-tests`    | 按三明治结构为改动写测试：先失败用例、再实现、再补齐边界   |
| `commit-message` | 把工作区改动整理成符合仓库约定的 commit message            |
| `debugging`      | 系统化调试：复现 → 缩小范围 → 假设 → 验证 → 修复 → 回归    |

## 放一个第三方技能

直接把 skills.sh 生态的某个技能目录（含 `SKILL.md`）放进上面任一层级即可生效，
无需改造——解析只认标准的 name / description / allowed-tools 字段。
