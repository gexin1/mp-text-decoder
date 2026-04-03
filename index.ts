export class mpTextDecoder {
    // 仅支持 UTF-8 解码，且对非法输入进行容错处理
    decode(input: ArrayBuffer | Uint8Array): string {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        let result = '';
        let i = 0;

        while (i < bytes.length) {
            const byte = bytes[i]!;

            // 1 字节：0xxxxxxx（ASCII，U+0000 ~ U+007F）
            if ((byte & 0x80) === 0) {
                result += String.fromCharCode(byte);
                i += 1;
                continue;
            }

            // 2 字节：110xxxxx 10xxxxxx（U+0080 ~ U+07FF）
            if ((byte & 0xe0) === 0xc0) {
                if (i + 1 >= bytes.length) break; // 截断保护
                const b1 = bytes[i + 1]!;
                if ((b1 & 0xc0) !== 0x80) {
                    // 非法续字节，跳过
                    result += '\uFFFD';
                    i += 1;
                    continue;
                }
                const codePoint = ((byte & 0x1f) << 6) | (b1 & 0x3f);
                result += String.fromCharCode(codePoint);
                i += 2;
                continue;
            }

            // 3 字节：1110xxxx 10xxxxxx 10xxxxxx（U+0800 ~ U+FFFF，包含中文）
            if ((byte & 0xf0) === 0xe0) {
                if (i + 2 >= bytes.length) break; // 截断保护
                const b1 = bytes[i + 1]!;
                const b2 = bytes[i + 2]!;
                if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
                    result += '\uFFFD';
                    i += 1;
                    continue;
                }
                const codePoint = ((byte & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
                // 排除 surrogate 范围（U+D800 ~ U+DFFF）
                if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
                    result += '\uFFFD';
                } else {
                    result += String.fromCharCode(codePoint);
                }
                i += 3;
                continue;
            }

            // 4 字节：11110xxx 10xxxxxx 10xxxxxx 10xxxxxx（U+10000+，如 emoji）
            if ((byte & 0xf8) === 0xf0) {
                if (i + 3 >= bytes.length) break; // 截断保护
                const b1 = bytes[i + 1]!;
                const b2 = bytes[i + 2]!;
                const b3 = bytes[i + 3]!;
                if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) {
                    result += '\uFFFD';
                    i += 1;
                    continue;
                }
                const codePoint =
                    ((byte & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
                // 通过 surrogate pair 表示 BMP 以外的字符
                if (codePoint >= 0x10000 && codePoint <= 0x10ffff) {
                    const offset = codePoint - 0x10000;
                    result += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
                } else {
                    result += '\uFFFD';
                }
                i += 4;
                continue;
            }

            // 非法首字节，跳过并替换为 replacement character
            result += '\uFFFD';
            i += 1;
        }

        return result;
    }

}