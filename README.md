# mp-text-decoder

`mp-text-decoder` 是一个面向微信小程序场景的 `TextDecoder.decode` 兼容实现，主要用于小程序 SSE 响应和其他 UTF-8 二进制文本内容的解码。

A lightweight `TextDecoder.decode` polyfill for WeChat Mini Program SSE and UTF-8 decoding.

## 特性

- 微信小程序 `TextDecoder.decode` 兼容实现
- 适合小程序 SSE、`text/event-stream`、流式文本响应解码
- 支持 UTF-8 编码
- 支持多字节字符处理，包括中文、emoji 等内容
- 支持 `Uint8Array` 和 `ArrayBuffer` 输入
- 非法字节序列会回退为 Unicode 替换字符 `U+FFFD`
- 体积轻量、无运行时依赖

## 安装

```bash
npm install mp-text-decoder
```

## 使用示例

```ts
import { MpTextDecoder } from 'mp-text-decoder';

const decoder = new MpTextDecoder();

const text = decoder.decode(
  new Uint8Array([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd, 0xf0, 0x9f, 0x98, 0x80]),
);

console.log(text); // 你好😀
```

## 小程序 SSE 解码示例

下面这个例子适合把小程序收到的二进制 chunk 解成字符串，再交给 SSE 解析逻辑处理：

```ts
import { MpTextDecoder } from 'mp-text-decoder';

const decoder = new MpTextDecoder();
let buffer = '';

function handleChunk(chunk: ArrayBuffer) {
  buffer += decoder.decode(chunk);

  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';

  for (const frame of frames) {
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) {
        console.log(line.slice(5).trim());
      }
    }
  }
}
```

## API

### `new MpTextDecoder()`

创建一个 UTF-8 解码器实例。

### `decode(input: ArrayBuffer | Uint8Array): string`

把 UTF-8 二进制数据解码为字符串。

- 输入类型支持 `ArrayBuffer` 和 `Uint8Array`
- 主要面向 UTF-8 文本解码
- 可用于小程序 SSE chunk 的文本转换
- 遇到非法字节序列时会输出 `U+FFFD`
- 遇到被截断的不完整序列时，会在边界处停止解码

## 注意事项

当前 `decode` 是单次解码接口。

如果你的网络层会把一个 UTF-8 多字节字符拆到两个 chunk 中，建议先在业务层缓存残缺字节，再调用 `decode`，这样更适合严格的 SSE 流式解码场景。

## 适用场景

- 微信小程序中没有原生 `TextDecoder` 的环境
- 需要在小程序里解码 SSE、`text/event-stream` 或其他流式文本响应
- 需要在小程序里解码 UTF-8 文本、接口二进制响应或自定义协议数据
- 需要正确处理中文、emoji 等多字节字符
