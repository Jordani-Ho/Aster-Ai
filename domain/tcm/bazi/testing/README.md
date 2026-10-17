# 验收参考资料与离线生成

- `hko-2024.xml`：香港天文台原始节气数据快照，URL/摘要见上级 README。
- `reference.ts`：不调用历法库的儒略日、干支、五鼠遁和节气边界参考实现。
- `generate-fixtures.mts`：只读官方 XML 和独立参考实现，生成上级 fixtures.json。Node 24 运行，不需额外依赖。运行方法见上级 README。
- `select-cities.ps1`：从本地 GeoNames 原始 ZIP 筛选城市，写上级 cities.json 与输入目录中的审计 TSV，不联网。

本目录只供开发时验收，运行时 `index.ts` 不导入任何测试资料。样例中的时刻是明确标注的合成测试扰动，不是公开或真实个人的生日资料。
