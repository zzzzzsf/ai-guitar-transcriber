<!--
  提交前自查（方案 §3.3 / §8.3 / §12——烧死三件套与零改动是红线）
-->

## 改动说明

<!-- 一句话说明改了什么、为什么 -->

## 红线检查（发布安全）

- [ ] **未触碰首发三件套**：`src-tauri/tauri.conf.json` 的 `identifier` / `plugins.updater.pubkey` / `plugins.updater.endpoints` 与 main 一致（三者烧进首发二进制，首发后不可改——§8.3）
- [ ] **未改动 `app/`**（§3.3 零改动）：`git diff app-baseline -- app/ ':(exclude)app/package.json'` 为空；版本号变更属例外（§8.5 三处同源 + `check-versions.sh` 通过）
- [ ] **未向 `app/package.json` 添加任何依赖或脚本**（工具链零侵入）
- [ ] Tauri CLI 版本钉 2.12.4、tauri-action 钉 v1.0.0 未漂移（§3.1/§8.5）
- [ ] CI 门禁理解：W15（零改动）/ release-gate（三件套终审）/ 体积 ≤25MB 任一失败则不得合入

## 测试

- [ ] `cargo test` 通过（src-tauri/）
- [ ] `npm test` 通过（app/，如有前端相关变更——需先确认未违反零改动）
- [ ] 本地 `scripts/msvc.cmd npx --yes @tauri-apps/cli@2.12.4 build` 出 NSIS 成功

## 发布清单关联

<!-- 涉及发布流程的改动请注明对应的 R0~R9 待办项（方案 §11.2） -->
