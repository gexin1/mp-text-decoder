/** 小程序 onChunkReceived 支持的二进制数据，以及已解码的字符串。 */
export type MpSSEChunk = ArrayBuffer | Uint8Array | string;

export interface MpSSEDecoderOptions {
    /** event：以空行分隔事件；line：兼容每一条 data 行都是一条消息的接口。 */
    mode?: 'event' | 'line';
    /** 尝试 JSON.parse(data)，失败时保留原始字符串，默认 true。 */
    parseJSON?: boolean;
}

export interface MpSSEMessage {
    /** SSE event 字段，未指定时为 message。 */
    event: string;
    /** 原始 data 内容；event 模式下，多行 data 使用 \n 拼接。 */
    data: string;
    /** JSON 解码结果；关闭 parseJSON 或解析失败时为 data。 */
    value: unknown;
    /** 最近有效的 SSE id，未指定时为空字符串。 */
    id: string;
    /** 服务端最近给出的重连间隔，仅提供元数据，不自动重连。 */
    retry?: number;
    /** data 恰好为 [DONE] 或 [SENSITIVE]。 */
    done: boolean;
}

/** 独立保存跨 chunk 的 UTF-8 状态，不依赖全局 TextDecoder 或 Buffer。 */
class Utf8StreamDecoder {
    private remaining = 0;
    private codePoint = 0;
    private lower = 0x80;
    private upper = 0xbf;

    get pending(): boolean {
        return this.remaining !== 0;
    }

    decode(bytes: Uint8Array): string {
        let text = '';
        for (let i = 0; i < bytes.length; i += 1) {
            const byte = bytes[i]!;
            if (this.remaining === 0) {
                if (byte <= 0x7f) {
                    text += String.fromCharCode(byte);
                } else if (byte >= 0xc2 && byte <= 0xdf) {
                    this.codePoint = byte & 0x1f;
                    this.remaining = 1;
                } else if (byte >= 0xe0 && byte <= 0xef) {
                    this.codePoint = byte & 0x0f;
                    this.remaining = 2;
                    if (byte === 0xe0) this.lower = 0xa0;
                    if (byte === 0xed) this.upper = 0x9f;
                } else if (byte >= 0xf0 && byte <= 0xf4) {
                    this.codePoint = byte & 0x07;
                    this.remaining = 3;
                    if (byte === 0xf0) this.lower = 0x90;
                    if (byte === 0xf4) this.upper = 0x8f;
                } else {
                    text += '\uFFFD';
                }
                continue;
            }

            if (byte < this.lower || byte > this.upper) {
                text += '\uFFFD';
                this.reset();
                i -= 1; // 非法续字节可能是下一字符的首字节，需要重新处理。
                continue;
            }
            this.lower = 0x80;
            this.upper = 0xbf;
            this.codePoint = (this.codePoint << 6) | (byte & 0x3f);
            this.remaining -= 1;
            if (this.remaining === 0) {
                if (this.codePoint <= 0xffff) {
                    text += String.fromCharCode(this.codePoint);
                } else {
                    const offset = this.codePoint - 0x10000;
                    text += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
                }
                this.codePoint = 0;
            }
        }
        return text;
    }

    end(): string {
        const text = this.pending ? '\uFFFD' : '';
        this.reset();
        return text;
    }

    reset(): void {
        this.remaining = 0;
        this.codePoint = 0;
        this.lower = 0x80;
        this.upper = 0xbf;
    }
}

/**
 * 有状态的 UTF-8 + SSE 分块解析器。每个请求使用一个实例。
 * decode() 只返回本次输入产生的完整消息，不累计业务回答。
 */
export class MpSSEDecoder {
    private readonly mode: 'event' | 'line';
    private readonly parseJSON: boolean;
    private readonly utf8 = new Utf8StreamDecoder();
    private partialLine = '';
    private skipLF = false;
    private atStart = true;
    private eventName = '';
    private dataLines: string[] = [];
    private lastEventId = '';
    private retry: number | undefined;

    constructor(options: MpSSEDecoderOptions = {}) {
        this.mode = options.mode ?? 'event';
        this.parseJSON = options.parseJSON ?? true;
    }

    /** 传入 onChunkReceived 的 res.data；没有完整消息时返回 []。 */
    decode(input: MpSSEChunk): MpSSEMessage[] {
        if (typeof input === 'string') {
            if (this.utf8.pending) {
                throw new TypeError('Cannot insert text into an incomplete UTF-8 byte sequence.');
            }
            return this.consume(input);
        }
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        return this.consume(this.utf8.decode(bytes));
    }

    /**
     * 请求正常结束时调用。宽容地提交没有末尾换行/空行的最后一条消息，随后重置。
     * 不完整的 UTF-8 字符以 U+FFFD 收尾；不会合成 [DONE]。
     */
    end(input?: MpSSEChunk): MpSSEMessage[] {
        const messages = input === undefined ? [] : this.decode(input);
        messages.push(...this.consume(this.utf8.end()));
        if (this.partialLine !== '') {
            this.processLine(this.partialLine, messages);
        }
        this.dispatch(messages);
        this.reset();
        return messages;
    }

    /** 丢弃未完成字符、行和事件。请求失败/取消或开始新请求时调用。 */
    reset(): void {
        this.utf8.reset();
        this.partialLine = '';
        this.skipLF = false;
        this.atStart = true;
        this.eventName = '';
        this.dataLines = [];
        this.lastEventId = '';
        this.retry = undefined;
    }

    private consume(text: string): MpSSEMessage[] {
        const messages: MpSSEMessage[] = [];
        if (text === '') return messages;
        if (this.atStart) {
            this.atStart = false;
            if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        }

        let start = 0;
        for (let i = 0; i < text.length; i += 1) {
            const char = text[i];
            if (this.skipLF) {
                this.skipLF = false;
                if (char === '\n') {
                    start = i + 1;
                    continue;
                }
            }
            if (char !== '\r' && char !== '\n') continue;
            this.processLine(this.partialLine + text.slice(start, i), messages);
            this.partialLine = '';
            this.skipLF = char === '\r';
            start = i + 1;
        }
        this.partialLine += text.slice(start);
        return messages;
    }

    private processLine(line: string, messages: MpSSEMessage[]): void {
        if (line === '') {
            this.dispatch(messages);
            return;
        }
        if (line[0] === ':') return; // 心跳/注释。

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value[0] === ' ') value = value.slice(1); // 只移除协议规定的一个空格。

        switch (field) {
            case 'event':
                this.eventName = value;
                // 参考接口的撤回/截断控制行没有配套 data 行。
                if (this.mode === 'line' && (value === 'message_revoke' || value === 'message_cutoff')) {
                    this.dataLines.push('');
                    this.dispatch(messages);
                }
                break;
            case 'data':
                this.dataLines.push(value);
                if (this.mode === 'line') this.dispatch(messages);
                break;
            case 'id':
                if (!value.includes('\0')) this.lastEventId = value;
                break;
            case 'retry':
                if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
                    this.retry = Number(value);
                }
                break;
        }
    }

    private dispatch(messages: MpSSEMessage[]): void {
        if (this.dataLines.length !== 0) {
            const data = this.dataLines.join('\n');
            let value: unknown = data;
            if (this.parseJSON) {
                try {
                    value = JSON.parse(data);
                } catch {
                    // 非 JSON 的文本、结束标记和损坏的 JSON 都保留原文。
                }
            }
            const message: MpSSEMessage = {
                event: this.eventName || 'message',
                data,
                value,
                id: this.lastEventId,
                done: data === '[DONE]' || data === '[SENSITIVE]',
            };
            if (this.retry !== undefined) message.retry = this.retry;
            messages.push(message);
        }
        this.eventName = '';
        this.dataLines = [];
    }
}
