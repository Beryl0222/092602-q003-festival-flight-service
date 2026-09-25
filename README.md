# 节日航班服务包重排

本项目提供节日航班服务包重排的服务端领域基础，当前包含不可重复的领域记录、进程内仓库、登记与查询服务、JSON 样例和命令行入口。基础能力保持精简，便于继续扩展复杂状态与持久化边界。

## 目录

- `src/domain.js` 定义已有记录和输入校验。
- `src/repository.js` 保存基础记录。
- `src/service.js` 提供登记、查询与健康检查。
- `contracts/record.json` 说明现有输入契约。
- `data/sample.json` 提供本地冒烟数据。
- `tests/` 覆盖登记、查询和重复编号边界。

## 运行

运行测试：`npm test`

检查源码：`npm run build`

验证样例：`npm run check:sample`

项目只使用 Node.js 内置模块，不需要连接其他运行服务。
