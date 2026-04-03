import { describe, expect, test } from 'bun:test';

import { MpTextDecoder } from '../src/index';

describe('mpTextDecoder', () => {
    const decoder = new MpTextDecoder();

    test('可以解码 ASCII 文本', () => {
        const bytes = new Uint8Array([72, 101, 108, 108, 111]);

        expect(decoder.decode(bytes)).toBe('Hello');
    });

    test('可以解码多字节 UTF-8 文本', () => {
        const text = '你好，Bun 😀';
        const bytes = new TextEncoder().encode(text);

        expect(decoder.decode(bytes)).toBe(text);
    });

    test('支持 ArrayBuffer 输入', () => {
        const bytes = new TextEncoder().encode('Buffer');
        const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

        expect(decoder.decode(input)).toBe('Buffer');
    });

    test('遇到非法续字节时会使用替换字符', () => {
        const bytes = new Uint8Array([0xc2, 0x20]);

        expect(decoder.decode(bytes)).toBe('\uFFFD ');
    });

    test('遇到非法起始字节时会使用替换字符', () => {
        const bytes = new Uint8Array([0x80, 0x61]);

        expect(decoder.decode(bytes)).toBe('\uFFFDa');
    });

    test('遇到被截断的序列时会在边界处停止', () => {
        const bytes = new Uint8Array([0xe4, 0xbd]);

        expect(decoder.decode(bytes)).toBe('');
    });

    test('会拒绝代理项范围的码点并返回替换字符', () => {
        const bytes = new Uint8Array([0xed, 0xa0, 0x80]);

        expect(decoder.decode(bytes)).toBe('\uFFFD');
    });
});
