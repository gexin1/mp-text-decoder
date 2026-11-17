import { describe, expect, test } from 'bun:test';
import { MpSSEDecoder } from '../src/index';

const encode = (text: string) => new TextEncoder().encode(text);

describe('MpSSEDecoder', () => {
    test('在空行之前缓存事件，不按网络 chunk 分发', () => {
        const decoder = new MpSSEDecoder();
        expect(decoder.decode(encode('data: {"msg":"你'))).toEqual([]);
        expect(decoder.decode(encode('好"}\n'))).toEqual([]);
        expect(decoder.decode(encode('\n'))).toEqual([{
            event: 'message', data: '{"msg":"你好"}', value: { msg: '你好' }, id: '', done: false,
        }]);
    });

    test('同一 chunk 中返回多条消息，JSON 失败时保留原文', () => {
        const decoder = new MpSSEDecoder();
        const messages = decoder.decode('data: hello\n\ndata: {broken}\n\ndata: [DONE]\n\n');
        expect(messages.map(message => message.value)).toEqual(['hello', '{broken}', '[DONE]']);
        expect(messages.map(message => message.done)).toEqual([false, false, true]);
    });

    test('标准事件的多行 data 使用换行拼接，保留有意义的空白', () => {
        const decoder = new MpSSEDecoder();
        const [message] = decoder.decode(': ping\nevent: update\ndata:  first \ndata:second\ndata\n\n');
        expect(message?.event).toBe('update');
        expect(message?.data).toBe(' first \nsecond\n');
    });

    test('支持所有换行格式，CRLF 拆到两个 chunk 时不产生额外空行', () => {
        for (const newline of ['\n', '\r', '\r\n']) {
            const text = `event: update${newline}data: hello${newline}${newline}`;
            const bytes = encode(text);
            const expected = new MpSSEDecoder().decode(bytes);
            expect(expected.map(message => message.data)).toEqual(['hello']);
            for (let i = 0; i <= bytes.length; i += 1) {
                const decoder = new MpSSEDecoder();
                expect([...decoder.decode(bytes.subarray(0, i)), ...decoder.decode(bytes.subarray(i))])
                    .toEqual(expected);
            }
        }
    });

    test('逐个字节输入完整 UTF-8 范围，支持 BOM、中文和 emoji', () => {
        const text = '\uFEFFdata: A¢€你好😀𐀀\u{10FFFF}\n\n';
        const decoder = new MpSSEDecoder();
        const messages = [...encode(text)].flatMap(byte => decoder.decode(new Uint8Array([byte])));
        expect(messages.map(message => message.data)).toEqual(['A¢€你好😀𐀀\u{10FFFF}']);
    });

    test('各种 UTF-8 和消息边界的任意二分，与整块输入结果相同', () => {
        const bytes = encode('\uFEFFid: 7\r\nevent: delta\r\ndata: {"msg":"你好😀"}\r\n\r\ndata: [DONE]\n\n');
        const expected = new MpSSEDecoder().decode(bytes);
        for (let i = 0; i <= bytes.length; i += 1) {
            const decoder = new MpSSEDecoder();
            expect([...decoder.decode(bytes.subarray(0, i)), ...decoder.decode(bytes.subarray(i))])
                .toEqual(expected);
        }
    });

    test('Uint8Array 只解码视图范围，ArrayBuffer 也可以输入', () => {
        const bytes = encode('ignoredata: 你好\n\nignore');
        const view = bytes.subarray(6, bytes.length - 6);
        expect(new MpSSEDecoder().decode(view)[0]?.data).toBe('你好');
        const buffer = new Uint8Array(view).buffer;
        expect(new MpSSEDecoder().decode(buffer)[0]?.data).toBe('你好');
    });

    test('id 持续生效、空 id 清除、包含 NUL 的 id 忽略', () => {
        const decoder = new MpSSEDecoder();
        const messages = decoder.decode('id: 7\ndata: a\n\ndata: b\n\nid: bad\0id\ndata: c\n\nid\ndata: d\n\n');
        expect(messages.map(message => message.id)).toEqual(['7', '7', '7', '']);
    });

    test('retry 只接受可安全表示的非负整数字段，不自动重连', () => {
        const decoder = new MpSSEDecoder();
        const messages = decoder.decode('retry: 1500\ndata: a\n\nretry: -1\ndata: b\n\nretry: 1.5\ndata: c\n\nretry: 9007199254740992\ndata: d\n\nretry: 0\ndata: e\n\n');
        expect(messages.map(message => message.retry)).toEqual([1500, 1500, 1500, 1500, 0]);
    });

    test('event 不跨事件继承，注释和未知字段不生成消息', () => {
        const decoder = new MpSSEDecoder();
        const messages = decoder.decode('event: update\n\n: ping\nunknown: x\n\ndata: a\n\nevent: error\ndata: failed\n\ndata: b\n\n');
        expect(messages.map(message => message.event)).toEqual(['message', 'error', 'message']);
    });

    test('空 data 也构成消息，但单独的事件元数据不构成消息', () => {
        const decoder = new MpSSEDecoder();
        expect(decoder.decode('id: 3\n\nevent: test\n\n')).toEqual([]);
        expect(decoder.decode('data:\n\n')[0]).toMatchObject({ data: '', value: '', id: '3' });
    });

    test('可关闭 JSON 解析，默认支持 JSON 原始值', () => {
        expect(new MpSSEDecoder({ parseJSON: false }).decode('data: {"a":1}\n\n')[0]?.value)
            .toBe('{"a":1}');
        expect(new MpSSEDecoder().decode('data: null\n\ndata: false\n\ndata: 0\n\n')
            .map(message => message.value)).toEqual([null, false, 0]);
    });

    test('识别结束标记，带 JSON 引号或额外空格的文本不误判', () => {
        const decoder = new MpSSEDecoder();
        const messages = decoder.decode('data: [SENSITIVE]\n\ndata: "[DONE]"\n\ndata: [DONE] \n\n');
        expect(messages.map(message => message.done)).toEqual([true, false, false]);
        expect(decoder.decode('data: next\n\n')[0]?.data).toBe('next');
    });

    test('end 提交最后一行/事件并重置，但不伪造终态', () => {
        const decoder = new MpSSEDecoder();
        expect(decoder.decode('id: 7\ndata: final')).toEqual([]);
        expect(decoder.end()[0]).toMatchObject({ data: 'final', id: '7', done: false });
        expect(decoder.end()).toEqual([]);
        expect(decoder.decode('\uFEFFdata: new\n\n')[0]).toMatchObject({ data: 'new', id: '' });
        expect(new MpSSEDecoder().end('data: last\n')[0]?.data).toBe('last');
    });

    test('正常结束时残缺 UTF-8 替换为 U+FFFD', () => {
        const decoder = new MpSSEDecoder();
        expect(decoder.decode(encode('data: '))).toEqual([]);
        expect(decoder.decode(new Uint8Array([0xf0, 0x9f]))).toEqual([]);
        expect(decoder.end()[0]?.data).toBe('\uFFFD');
    });

    test('reset 丢弃半个字符、未完成事件和元数据', () => {
        const decoder = new MpSSEDecoder();
        decoder.decode(encode('id: 7\nretry: 100\nevent: old\ndata: old'));
        decoder.decode(new Uint8Array([0xe4]));
        decoder.reset();
        expect(decoder.decode('\uFEFFdata: new\n\n')[0]).toEqual({
            event: 'message', data: 'new', value: 'new', id: '', done: false,
        });
    });

    test('中途插入文本不能越过尚未完成的 UTF-8 字符', () => {
        const decoder = new MpSSEDecoder();
        decoder.decode(new Uint8Array([0xe4]));
        expect(() => decoder.decode('data: text')).toThrow(TypeError);
        decoder.reset();
        expect(decoder.decode('data: text\n\n')[0]?.data).toBe('text');
    });

    test('UTF-8 非法序列的替换结果与原生 TextDecoder 一致，包括每个拆分点', () => {
        const cases = [
            [0xc0, 0xaf], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80],
            [0xf0, 0x80, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80],
            [0xf5, 0x80, 0x80, 0x80], [0xe4, 0xbd, 0x61], [0xe4, 0x61],
            [0x80, 0xbf, 0xff], [0xc2], [0xf0, 0x9f],
        ];
        for (const bytes of cases) {
            const expected = new TextDecoder().decode(new Uint8Array(bytes));
            for (let i = 0; i <= bytes.length; i += 1) {
                const decoder = new MpSSEDecoder();
                decoder.decode('data: ');
                decoder.decode(new Uint8Array(bytes.slice(0, i)));
                decoder.decode(new Uint8Array(bytes.slice(i)));
                expect(decoder.end()[0]?.data).toBe(expected);
            }
        }
    });

    test('只移除流开头的 BOM，正文中的 BOM 保留', () => {
        const decoder = new MpSSEDecoder();
        expect(decoder.decode('\uFEFFdata: \uFEFFa\n\ndata: \uFEFFb\n\n')
            .map(message => message.data)).toEqual(['\uFEFFa', '\uFEFFb']);
    });
});

describe('MpSSEDecoder line 模式（参考小程序的自定义协议）', () => {
    const input = 'event: speech_type\ndata: text\r\n'
        + 'data: [MSGINDEX:12]\r\ndata: [TRACEID:abc123]\r\n'
        + 'data: {"type":"text","msg":"你好😀"}\r\n'
        + 'event: message_cutoff\nevent: message_revoke\n'
        + 'event: speech_type\ndata: text\r\n'
        + 'data: {"type":"text","msg":"重写"}\r\n'
        + 'event: error\ndata: {"code":500,"msg":"失败"}\r\n'
        + 'data: [DONE]\n\n';

    test('逐行分发、保留事件顺序和控制消息，不把同块 data 合并成一个 JSON', () => {
        const messages = new MpSSEDecoder({ mode: 'line' }).decode(input);
        expect(messages.map(message => message.event)).toEqual([
            'speech_type', 'message', 'message', 'message', 'message_cutoff',
            'message_revoke', 'speech_type', 'message', 'error', 'message',
        ]);
        expect(messages[0]?.value).toBe('text');
        expect(messages[1]?.value).toBe('[MSGINDEX:12]');
        expect(messages[2]?.value).toBe('[TRACEID:abc123]');
        expect(messages[3]?.value).toEqual({ type: 'text', msg: '你好😀' });
        expect(messages[8]?.value).toEqual({ code: 500, msg: '失败' });
        expect(messages[9]?.done).toBe(true);
    });

    test('任意切分点和逐字节输入，与整块输入相同', () => {
        const bytes = encode(input);
        const expected = new MpSSEDecoder({ mode: 'line' }).decode(bytes);
        for (let i = 0; i <= bytes.length; i += 1) {
            const decoder = new MpSSEDecoder({ mode: 'line' });
            expect([...decoder.decode(bytes.subarray(0, i)), ...decoder.decode(bytes.subarray(i))])
                .toEqual(expected);
        }
        const decoder = new MpSSEDecoder({ mode: 'line' });
        expect([...bytes].flatMap(byte => decoder.decode(new Uint8Array([byte])))).toEqual(expected);
    });

    test('line 模式按 data 行分发，默认 event 模式保留多行 data', () => {
        const text = 'data: one\ndata: two\n\n';
        expect(new MpSSEDecoder({ mode: 'line' }).decode(text).map(message => message.data))
            .toEqual(['one', 'two']);
        expect(new MpSSEDecoder().decode(text).map(message => message.data)).toEqual(['one\ntwo']);
    });

    test('SENSITIVE 支持 LF 结束，业务替换标记不被破坏', () => {
        const messages = new MpSSEDecoder({ mode: 'line' })
            .decode('data: {"msg":"a[ENTRY]b"}\r\ndata: [SENSITIVE]\n\n');
        expect(messages[0]?.value).toEqual({ msg: 'a[ENTRY]b' });
        expect(messages[1]).toMatchObject({ data: '[SENSITIVE]', done: true });
    });
});
