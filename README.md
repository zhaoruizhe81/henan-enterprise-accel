# 河南企业登记 · 填表加速

河南省企业登记全程电子化服务平台的用户脚本。解决的是「填一格卡一下」——页面里 103 处同步 XHR 撞上后端串行队列，主线程轮流挂起。

## 问题在哪

先说清楚病根，不然改起来全靠猜。

`topnet.js` 有 40 处 `async: false`，`icpsp.js` 有 55 处，加上 `index.js` 5 处、`register.js` 2 处、jquery 1 处，一共 103 个同步 XHR。同步请求期间浏览器主线程完全停摆，滚动、光标、输入法全部无响应。

后端那边所有 `.action` 请求被串行处理。单次响应中位 0.6 秒的接口，10 个并发全部落在 43 秒以上；单次 0.7 秒的接口，10 并发正好 9–12 秒。同一时刻 10 个静态 CSS 并发只要 0.24 秒，说明瓶颈不在 Web 容器，在业务层后面那个独占资源。

两者相乘，就是你看到的现象。完整数据和测试方法见 [docs/diagnosis.md](docs/diagnosis.md)。

## 它做什么

1. **只读校验接口加缓存。** 词形检查同一个词结果永远不变，查重同一组名称要素十秒内不会变，代码表基本不动。第一次走网络，之后直接读本地。点「检查是否可用」原本 1795ms 全页面冻结，命中缓存后接近 0。
2. **清掉源码里的 `debugger`。** `topnet.js` 的 `checkNameFlow` 和 `toOtherSystem` 各有一句，开着 DevTools 时每次调用都停在断点，表现是点一下页面就没了。
3. **表单快照。** 每 3 秒把表单值写进 localStorage，重进页面自动回填空白字段，不覆盖你已经改过的。会话超时或后端 502 的时候，这一条能救命。
4. **停掉登录超时页的跳转循环。** 超时页 3 秒自动跳首页，首页又要十几秒才出来，再判超时再跳，用户完全感知不到发生了什么。脚本把它摁住，给一个手动重新登录的入口。

## 实测

同一个只读接口连发三次同步请求：

| 接口 | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| `checkComplexWord`（词形检查） | 610ms | **0ms** | **0ms** |
| `cnkiRepeakCheck`（查重） | 1201ms | **0ms** | **0ms** |

后端空闲时再测一轮，绝对值小一些，但第二次同样归零：

| 接口 | 第 1 次 | 第 2 次 |
|---|---|---|
| `checkComplexWord` | 140ms | **0ms** |
| `cnkiRepeakCheck` | 351ms | **0ms** |

响应体逐字一致，缓存没有改变任何业务语义。累计计数 `hit: 2, miss: 2`。

## 装

把 `userscript/henan-enterprise-accel.user.js` 拖进 Tampermonkey，或者新建脚本把内容粘进去。

只在这个域名生效：

```
@match  http://222.143.21.61:9080/*
```

改端口或换域名，改这一行。

## 控制台接口

```javascript
__hea.dump()    // 看命中统计：hit / miss / 累计省下多少毫秒
__hea.clear()   // 清空缓存，比如平台更新了敏感词库之后
__hea.config    // 运行时改配置，改完立即生效
```

## 配置

`src/core.js` 顶部是配置区：

```javascript
rules: [
  { re: /checkComplexWord/, ttl: 365 * 24 * 3600 * 1000 },  // 永久
  { re: /cnkiRepeakCheck/,  ttl: 10 * 60 * 1000 },          // 10 分钟
  { re: /\/code\/get[A-Z]/, ttl: 365 * 24 * 3600 * 1000 },  // 代码表永久
  ...
]
```

`ttl` 单位毫秒。想缓存哪些接口往里加正则，不想缓存从数组里删。

`blocklist` 是硬排除：`verification.action`、`operationData.action`、`save*`、`delete*`、`submit` 这些无论 `rules` 怎么写都不会被缓存。它们读的是你当前填写的完整内容，数据一改结果就变，缓存了会让提交时没反应。

## 目录

```
src/core.js                          逻辑主体，无 userscript 头，可单独注入
userscript/henan-enterprise-accel.user.js  成品，导入 Tampermonkey 用这个
build.sh                             从 core.js 拼头部生成成品
docs/diagnosis.md                    完整诊断数据与复现命令
```

改完 `src/core.js` 跑一次：

```bash
./build.sh 1.0.0
```

会重新生成 `userscript/` 下的成品并做语法检查。

## 边界

缓存 key 里保留了全部业务参数（`word`、`busiId`、`entType` 等），只削掉了 `t=`、`random=`、`csrfToken=` 和 `cnkiRepeakCheck.action?0.6598` 这种裸随机数。所以不同名称要素、不同企业不会串到别人的结果上。

`checkComplexWord` 设的永久缓存。这个接口返回的是词形合规判定，正常情况下不会变。平台哪天更新了敏感词库，`__hea.clear()` 清一下就行。

请求体里有 `pinKey` 和 `pinVal` 两个签名参数，服务端会校验。所以脚本只做「缓存页面自己发出去的请求」，不去构造新请求。

## 许可

MIT
