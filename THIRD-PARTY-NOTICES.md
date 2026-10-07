# 第三方组件声明

本仓库为「零构建」项目，第三方库以预编译文件直接内置在 `vendor/` 目录，
未使用包管理器。以下为其许可与出处。

## Apache ECharts

- 文件：`vendor/echarts.min.js`
- 版本：5.4.x（文件内标识 `5.4.4` / `5.4.3`）
- 版权：The Apache Software Foundation
- 许可：Apache License 2.0
- 项目主页：https://echarts.apache.org/
- 许可全文：https://www.apache.org/licenses/LICENSE-2.0

Apache-2.0 要求保留原始版权与许可声明。该文件顶部的许可注释块**未被移除**，
请勿在再分发时删除它。

## SheetJS (xlsx.js) 社区版

- 文件：`vendor/xlsx.full.min.js`
- 版本：0.18.5
- 版权：(C) 2013-present SheetJS LLC
- 许可：Apache License 2.0
- 项目主页：https://sheetjs.com/
- 许可全文：https://www.apache.org/licenses/LICENSE-2.0

该文件顶部保留了 `/*! xlsx.js (C) 2013-present SheetJS -- http://sheetjs.com */`
版权行，请勿在再分发时删除。

**版本提示：** 0.18.5 不是最新版。SheetJS 社区版已不再通过 npm 分发，
新版本需从官方站点获取；且 0.19.3 之前的版本存在已披露的原型污染问题
（GHSA-4r6h-8v6p-xvw6）。本项目中该库仅用于在**用户本地浏览器内**解析用户
自己主动选择的文件、不接受远程输入，风险面较小，但如果你要在更敏感的场景
复用这份 vendor 文件，建议先升级到 0.20+。

---

## 关于升级

两个文件均为直接下载的发行版构建产物，仓库内未使用包管理器。
升级方式是从上述官方来源获取新版并直接替换 `vendor/` 下的文件，
然后运行 `python tools/diag.py` 验证全部断言仍通过。
