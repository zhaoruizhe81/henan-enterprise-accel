# 诊断记录

目标站点是河南省企业登记全程电子化服务平台的名称自主申报模块，Struts2 `.action` 体系，HTTP/1.1，无 TLS。
下面所有数字都是实测，采集时间 2026-10-21，环境为同一台机器直连。

## 一、网络层：没问题

| 测试 | 结果 |
|---|---|
| TCP 建连 | 2ms |
| 10 并发拉纯静态 CSS | 全部 0.24s 返回 |
| 10 并发拉 292KB 的 jquery | 全部 1.2–1.5s |
| 不存在的路径（404） | 0.38–0.71s |

10 个并发下载 292KB 在 1.3 秒内全部完成，按这个算有效带宽在 17Mbps 以上。链路和带宽都不是瓶颈。

## 二、后端：所有 `.action` 被串行化

同一接口不同并发下的耗时：

| 并发数 | `entrance.action` | `zxPhone.action` |
|---|---|---|
| 1 | 0.2–35.8s（中位 0.6s） | 0.58–0.82s |
| 5 | 0.4–24.9s | — |
| 10 | **全部 43–47s** | **全部 9.3–12.2s** |

单次中位 0.6s 的接口，10 并发全部落在 43s 以上；单次 0.7s 的接口，10 并发正好变成 9–12s，都是整十倍。
同一时刻 10 个静态 CSS 并发只要 0.24s，说明 Web 容器的线程池没问题。

结论：业务请求被一个独占资源排队，吞吐量被压成「1 / 单次响应时间」。数据库连接池过小、Action 上的 `synchronized`、或者上游只有一个 worker，都属于这一类。

链路里还出现过 `502 Bad Gateway`，响应头里 `Server` 被剥掉、`Date` 由代理生成，说明前面有反向代理。

## 三、前端：同步 XHR 是卡死的直接原因

各 JS 文件里 `async: false` 的出现次数：

| 文件 | 数量 |
|---|---|
| `icpsp.js` | 55 |
| `topnet.js` | 40 |
| `template/admin/busiCfg/cssAndJs/index.js` | 5 |
| `register.js` | 2 |
| `jquery-464.js` | 1 |
| **合计** | **103** |

同步 XHR 期间浏览器主线程完全挂起：不能滚动、光标不闪、输入法不出候选词。叠加后端那个排队队列，实际感受就是「填一格卡一下，偶尔卡到像死了」。

页面加载本身也不轻：

| 指标 | 首次 | 刷新后 |
|---|---|---|
| TTFB | 4749ms | 9857ms |
| DOMContentLoaded | 5263ms | — |
| load | 5910ms | 11882ms |

「办理进度 → 名称信息」这一步切换（`viewRendering.action`）单独要 2.7–6.0 秒，期间页面只显示「正在加载，请稍后...」。

## 四、名称申报页的具体链路

页面上有个「检查是否可用」按钮，走 `cnkiName()`。一次点击连发 3 个同步请求：

| 请求 | 耗时 |
|---|---|
| `checkComplexWord.action?word=…`（词形检查） | 185ms |
| `checkComplexWord.action?word=…`（行业词检查） | 186ms |
| `cnkiRepeakCheck.action`（查重） | 1378ms |
| **合计阻塞** | **1795ms** |

后端负载上来时，同一次调用实测到 3974ms，其中单条 `checkComplexWord` 单独测过 1252ms。同一接口 185ms 到 1252ms，波动近 7 倍。

`save()`（保存并下一步）的流程是：

```
disabledButton()
 → baseVerification()
 → verificationDataForError(map)     ← 同步请求 verification.action
 → verificationDataForTip(map)       ← 同步请求 operationData.action
 → continueFlow()
```

两个后端校验都是 `async: false`，这是提交时卡住的来源。

请求体里带 `pinKey`、`pinVal` 两个签名参数，手搓参数会被服务端拒绝，所以预热或重放只能用页面自己的函数发起。

## 五、缓存实测

对同一个只读接口连发三次同步请求，中间夹着缓存层：

| 接口 | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| `checkComplexWord` | 610ms | **0ms** | **0ms** |
| `cnkiRepeakCheck` | 1201ms | **0ms** | **0ms** |

三次响应体逐字一致：

```
checkComplexWord  {"success":"true","code":20000,"msg":"调用成功",...}
cnkiRepeakCheck   {"tipWay":"0","bannedIdList":"","bannedInfos":"","tipKeyWords":""}
```

`checkComplexWord` 输入同一个词结果永远不变，可以永久缓存；`cnkiRepeakCheck` 依赖当前填写的名称要素，按参数做 key 后 10 分钟有效。

## 六、源码里的两个坑

`topnet.js` 里 `checkNameFlow` 和 `toOtherSystem` 各写了一句 `debugger;`。开发者工具开着的时候，每次调用都会停在断点上，表现是点一下页面就没了。

`checkRepeatByNameKey` 的函数体只有一行 `return true;`，查重逻辑实际是空的。

## 七、复现方式

```bash
# 网络与后端串行化
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{time_starttransfer}\n" --max-time 90 "$TARGET" &
done; wait

# 静态资源对照
curl -s -o /dev/null -w "%{time_starttransfer}\n" "$BASE/common/css/topnetnew.css"

# 同步 XHR 数量
curl -s "$BASE/common/js/topnet.js" | grep -c 'async *: *false'
curl -s "$BASE/common/js/icpsp.js" | grep -c 'async *: *false'
```

## 八、设立登记页（busiType=02）：链式加载 75 秒

`entrance.action?busiType=02&nameId=...` 这个入口比名称申报重得多，实测时间线：

| 阶段 | 累计耗时 | 单次耗时 |
|---|---|---|
| `entrance.action` 首字节 | 9.5s | 9516ms |
| `ck.action` 会话检查 | 11.2s | 1513ms |
| `refreshNavi.action` 返回 | 39.7s | **25685ms** |
| `BaseInfo/viewRendering.action` 返回 | 74.9s | **35070ms** |
| 表单可交互（63 个输入框） | **约 75s** | — |

三个 `.action` 严格串行：`viewRendering` 的开始时间 39701ms 正好是 `refreshNavi` 结束的时刻，中间没有重叠。

点「2. 人员信息」切换步骤，再触发一轮 `viewRendering.action`，耗时 **13201ms**。这个流程一共 12 个步骤（基本信息、人员信息、补充信息、多证合一、证照分离、上传材料、社保登记、税务信息填报、公积金、银行开户、刻制印章、水电气暖网报）。

### 为什么这个页面会被误认为「完全卡死」

浏览器渲染进程 CPU 0%、状态 S（睡眠）、CDP 的 `Runtime.evaluate` 和 `Page.captureScreenshot` 全部超时，看起来像整个标签页挂了。

原因是 `topnet.js` 里的 `debugger;`：CDP 连接着的时候（DevTools 或自动化工具），执行到断点会暂停整个 renderer，主线程停摆，任何注入的脚本都跑不了。手动打开浏览器、不开 F12 时，只是慢，不会完全冻结。

### 为什么缓存层帮不上

`refreshNavi.action` 和 `viewRendering.action` 不在白名单里，实测 `hit: 0, miss: 0`，脚本全程没有介入。这两个请求是首屏渲染必需的，返回的是当前填写状态的 HTML 片段，缓存了会让人看到上一版表单。

两个请求的业务参数几乎一致（`fromType`、`busiId`、`busiType`、`nameId`、`entType`、`uuid`），只有 `pinKey`/`pinVal` 签名不同。理论上可以并行发起省掉 25 秒，但签名算法在 `aes.js` + `md5.js` + `pad-zeropadding-min.js` 里，需要单独验证。

## 九、复现命令

```bash
# 设立登记入口的时间线（需要登录态 cookie）
curl -s -b "JSESSIONID=$SID" -o /dev/null \
  -w 'ttfb:%{time_starttransfer} total:%{time_total}\n' \
  "$BASE/entrance.action?fromType=______&busiType=02&nameId=$NAME_ID&uuid=$UUID&csrfToken=$TOKEN"
```
