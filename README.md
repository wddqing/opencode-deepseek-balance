# opencode-deepseek-balance

在 [OpenCode](https://opencode.ai) TUI 右侧侧边栏显示 DeepSeek 账户余额，并估算当前会话开销的插件。

## 功能

- 仅当前模型为 DeepSeek 时显示，切换模型自动隐藏
- 显示总余额、赠送余额、充值余额
- 余额不足时给出提示
- 按 token 用量和 DeepSeek 官方单价估算当前会话开销，标注“约”
- 每 5 分钟自动刷新；每轮会话结束后刷新（60 秒内最多一次）
- 命令面板“刷新 DeepSeek 余额”或 `/deepseek-balance` 手动刷新

## 显示效果

```text
DeepSeek 余额
余额    ¥123.45
赠送    ¥10.00
充值    ¥113.45
本次约  ¥0.03
更新    14:32
```

赠送/充值金额为 0 时自动隐藏，保持紧凑。接口返回多种币种时逐行显示各自总余额。

## 安装

### 方式一：OpenCode 插件管理器

```sh
opencode plugin add github:wddqing/opencode-deepseek-balance
```

### 方式二：克隆到全局插件目录

```sh
git clone git@github.com:wddqing/opencode-deepseek-balance.git \
  ~/.config/opencode/plugins/deepseek-balance
```

安装后重启 OpenCode。

## 侧边栏

插件注册在 `sidebar.content` 顶部。OpenCode 的 `session.sidebar` 默认为 `auto`；如果设为 `hide`，侧边栏不会显示。

可在 `~/.config/opencode/cli.json` 中设置：

```json
{
  "session": {
    "sidebar": "auto"
  }
}
```

也可以按 `Ctrl+X B` 手动打开/关闭侧边栏。

## API Key

按以下优先级自动获取：

1. 环境变量 `DEEPSEEK_API_KEY`
2. 当前 provider 配置中的 `apiKey`
3. 全局/项目 `opencode.json(c)` 中 `baseURL` 含 `api.deepseek.com` 的 provider

支持 `apiKey` 写成 `{env:VAR}` 或 `${env:VAR}` 的形式。插件只在内存中使用 Key，不会打印或写入日志。

家里电脑最简单的配置方式：

```sh
export DEEPSEEK_API_KEY="sk-..."
```

如果使用代理，可以额外指定：

```sh
export DEEPSEEK_BASE_URL="https://your-proxy.example.com"
# 或直接覆盖余额接口
export DEEPSEEK_BALANCE_URL="https://your-proxy.example.com/user/balance"
```

## 会话开销说明

DeepSeek 开放平台只提供账户总余额接口，不提供按会话查询用量的接口，因此会话开销是根据本地消息 token 估算的：

```text
费用 = 非缓存输入 × 输入单价
     + (输出 + 推理) × 输出单价
     + 缓存命中 × 缓存命中单价
     + 缓存写入 × 缓存写入单价
```

- 使用 DeepSeek 官方价格，内置 `deepseek-flash` 和 `deepseek-v4-pro`
- 按每条消息的模型和时间戳计算，能处理会话中途切换模型
- 高峰时段按北京时间工作日 09:00-12:00、14:00-18:00 判断
- 中国法定节假日未单独处理，峰谷价和实际账单可能有差异
- 未知模型不显示会话开销

需要精确账单时，请以 DeepSeek 开放平台为准。

## 命令

| 命令 | 说明 |
|---|---|
| `/deepseek-balance` | 手动刷新余额 |
| 命令面板“刷新 DeepSeek 余额” | 手动刷新余额 |

## 故障排查

| 显示 | 处理 |
|---|---|
| `未配置 Key` | 设置 `DEEPSEEK_API_KEY`，或在 provider 配置中填写 `apiKey` |
| `Key 无效` | 检查 Key 是否有效、是否有余额接口权限 |
| `网络超时` / `网络错误` | 检查网络或代理；必要时设置 `DEEPSEEK_BALANCE_URL` |
| 侧边栏没有内容 | 确认当前模型是 DeepSeek，且 `session.sidebar` 不是 `hide` |
| 会话开销不显示 | 模型不在内置价格表，或当前会话还没有 token 用量 |

## 数据来源

```http
GET https://api.deepseek.com/user/balance
Authorization: Bearer <DEEPSEEK_API_KEY>
```

## 兼容性

- OpenCode v2.0.32+
- 仅作用于 OpenCode TUI，不影响桌面端/Web 端
