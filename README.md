# mp-text-decoder

微信小程序 SSE 解析器，支持中文、emoji 跨块解码、消息缓存和 JSON 解析，无运行时依赖。

## 安装

```bash
npm install mp-text-decoder
```

## 使用

每个请求创建一个实例，直接传入 `onChunkReceived` 的 `data`。

```ts
import { MpSSEDecoder } from 'mp-text-decoder';
import type { MpSSEMessage } from 'mp-text-decoder';

const decoder = new MpSSEDecoder();

function handleMessages(messages: MpSSEMessage[]) {
  for (const message of messages) {
    if (message.done) {
      console.log('生成结束', message.data);
      continue;
    }
    console.log(message.event, message.value);
  }
}

const task = wx.request({
  url: 'https://your-domain.example/chat', // 替换为自己的接口
  method: 'POST',
  data: { prompt: '你好' },
  enableChunked: true,
  responseType: 'text',
  dataType: 'text',
  success() {
    handleMessages(decoder.end());
  },
  fail(error) {
    console.error(error);
  },
});

task.onChunkReceived(({ data }) => {
  handleMessages(decoder.decode(data));
});
```

## 并发与清理

- 多个请求可以同时进行，每个请求各自创建一个 `MpSSEDecoder`，不要共用实例。
- 正常结束调用 `end()`，处理剩余消息并自动重置，不需要手动释放实例。
- 失败或取消后，如果不再使用该实例，无需清理；复用前调用 `reset()`。

## 配置

```ts
new MpSSEDecoder({ mode: 'event', parseJSON: true });
```

- `mode: 'event'`（默认）：标准 SSE，空行结束一条事件，多行 `data:` 合并。
- `mode: 'line'`：每个 `data:` 行是一条消息，适用于逐行 JSON 的接口。
- `parseJSON: true`（默认）：自动解析 JSON，解析失败时保留原文。

## API

| 方法 | 说明 |
| --- | --- |
| `decode(data)` | 接收 `ArrayBuffer`、`Uint8Array` 或字符串，返回完整消息数组；未完成的内容自动缓存 |
| `end()` | 正常结束时返回剩余消息并重置，支持末尾没有换行的消息 |
| `reset()` | 失败或取消时丢弃缓存并重置 |

消息结构：

```ts
{
  event: 'message', // 事件名
  data: '{"msg":"你好"}', // 原始内容
  value: { msg: '你好' }, // JSON 结果，解析失败时为原文
  id: '', // SSE 消息 ID
  done: false, // data 为 [DONE] 或 [SENSITIVE] 时为 true
  // retry?: number，服务端指定的重连间隔
}
```

正文累加、页面更新和重连由业务处理。`done` 仅识别结束标记，不会主动关闭请求。

> 2.0 已移除 `MpTextDecoder`，统一使用 `MpSSEDecoder`。
