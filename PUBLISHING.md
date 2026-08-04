# 发布操作规范

## 推荐结构

```text
GitHub 公共固定入口（主入口）
  ├─ README / Codex 执行规范
  ├─ 通道指针（pilot / stable）
  ├─ 不可变版本清单
  └─ 安装器与自动检查

同一不可变版本的 jsDelivr 备用入口
  └─ 只镜像公开说明、脚本和版本清单，不含客户包、票据或密钥

私有对象存储或私有 GitHub Release
  └─ 带版本号、大小与 SHA-256 的客户包

客户部署票据
  └─ 客户标识、平台、版本、不可变清单 URL、限时包 URL、到期时间
```

客户交付体验固定为：一个主入口（必要时自动切到同版本备用入口）+ 一个客户专属票据链接 + 一段短指令。客户不接收本地 ZIP，也不需要下载或上传票据文件。Python HTTPS 读取失败时，由安装器先调用系统 curl；Windows 仍失败时再调用本机 Edge/Chrome 回退，客户只在写入前确认一次。

公开仓库和公开 CDN 镜像不得包含 ZIP、客户票据、签名 URL、API Key、Cookie、客户资料或本地绝对路径。

## 每次发布新版本

1. 从唯一母版构建新的版本号，历史版本和历史 Release 不覆盖。
2. 完成范围反向对账、敏感扫描、隔离安装、安装后指纹和发布前检查。
3. 分别新建 Mac / Windows 的首次安装和升级清单，登记文件名、大小和 SHA-256。
4. 建立新 Git tag，例如 `workbench-v1.4.3`；不要移动旧 tag。
5. 先创建 GitHub Draft Release，附齐公开安装器/版本证据后再发布。
6. 在仓库设置中启用 GitHub Release immutability；发布后核对不可变标识和资产证明。
7. 真机试点通过前只更新 `pilot`；Mac、Windows 都通过后才更新 `stable`。

## 客户包下载控制

优先方案是腾讯云 COS 等私有对象存储的预签名 GET URL：

- 对象键包含版本和 SHA-256，上传后不覆盖。
- 每个客户/每台测试电脑单独签发票据。
- 链接有效期建议 24 小时，最长不超过 7 天。
- 预签名 URL 是 bearer token，任何拿到链接的人在到期前都能下载。
- 真正限制下载次数需要额外的鉴权服务；单靠预签名 URL 不能做到“一次后失效”。

如果使用私有 GitHub Release，客户必须登录并拥有仓库读取权限；它适合内部测试，不适合没有 GitHub 账号的普通客户，也不能自然提供逐客户限时链接。

## 签发票据

先在私有对象存储生成四个限时下载 URL，再运行：

```text
python scripts/make_ticket.py \
  --customer-id <客户或测试机标识> \
  --artifact <Mac首次安装清单> <不可变清单URL> <限时包URL> \
  --artifact <Mac升级清单> <不可变清单URL> <限时包URL> \
  --artifact <Windows首次安装清单> <不可变清单URL> <限时包URL> \
  --artifact <Windows升级清单> <不可变清单URL> <限时包URL> \
  --expires-in-hours 24 \
  --output <仓库外的安全目录>/<客户标识>.ticket.json
```

票据文件和完整票据链接只能单独发给对应客户，不提交 GitHub。
