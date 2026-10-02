# 上游来源

- Clerki wrapper 与快照：[`kunji163/clerki`](https://github.com/kunji163/clerki) commit `44887f62f7b1a69fcc9d23583aa8df8f11898aca`，路径 `hclust-cpp/`；相关历史提交为 `2d566da8af2303aab77f02c01ea92661336b3241` 与 `10d397f747ee25aea384c615234dce916f9e174b`。
- fastcluster：[`cdalitz/hclust-cpp`](https://github.com/cdalitz/hclust-cpp) commit `d48fff6bba1199d80422cd37f5b635107a5a0c92`。该快照包含 v1.2 之后的 NaN 修复，不能只标记为 tag `v1.2`。
- 导入日期：2026-08-28。

本项目只保留 Node-API wrapper 与运行所需 fastcluster 源码；本地修改限于 Node 24/N-API 8 的可复现构建配置、关闭 Release DWARF，以及把日志 fallback 从 stdout 改到 stderr，避免污染 Worker framing。
