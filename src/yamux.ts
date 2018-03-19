import * as net from 'net';
import {Duplex, Transform, Writable, Readable, DuplexOptions, ReadableOptions, WritableOptions, PassThrough, TransformOptions} from 'stream';
import { EventEmitter } from 'events';
import { read } from 'fs';

export type Options = {
    maxWindowSize: number;
    keepAliveInterval: number;
    keepAliveTimeout: number;
}

export function defaultOptions(options ?:any) :Options {
    return Object.assign({
        keepAliveInterval: 30*1000,
        keepAliveTimeout: 10*1000,
        // writeTimeout: 10*1000,
    }, options, {
        maxWindowSize: (options && options.maxWindowSize > initialWindowSize) ? options.maxWindowSize : initialWindowSize,
    })
}
type error = Error|undefined;
type done = (err ?:error) => void
const nopResume :done = (err) => {};

export const version = 0;
const headerSize = 12
export const initialWindowSize = 256*1024;
export const errUnexpectedEOF = new Error('Unexpected EOF')

export enum type {
    Data = 0x0,
    WindowUpdate = 0x1,
    Ping = 0x2,
    GoAway = 0x3,
}
export enum flag {
    SYN = 0x1,
    ACK = 0x2,
    FIN = 0x4,
    RST = 0x8,
}

export function isClosed(f :flag) :boolean {
    return (f&flag.FIN) == flag.FIN
}
export function isReset(f :flag) :boolean {
    return (f&flag.RST) == flag.RST
}
export function isEstablished(f :flag) :boolean {
    return (f&flag.ACK) == flag.ACK
}
export function isOpen(f :flag) :boolean {
    return (f&flag.SYN) == flag.SYN
}

export type Frame = {
    version: number;
    type: type;
    sid: number;
    flags: number;
    length: number;
    data?: Buffer;
}



export class FrameReader extends Readable {
    static readFrame (src :Readable) :Frame|undefined  {
        const h = src.read(headerSize)
        if (h == null) {
            return undefined
        }
        if (h.length < headerSize) {
            throw errUnexpectedEOF
        }
        const frame :Frame = {
            version: h.readUInt8(0, true),
            type: h.readUInt8(1, true),
            flags: h.readUInt16BE(2, true),
            sid: h.readUInt32BE(4, true),
            length: h.readInt32BE(8, true),
        }
        if (frame.version != version) {
            throw new Error('Invalid frame version ' + frame.version)
        }
        return frame
    }
    private _src :Readable
    // State
    private _pushable :boolean|undefined
    private _readable :boolean|undefined
    private _frame :Frame|undefined
    constructor(src :Readable, options ?:ReadableOptions) {
        super(Object.assign({}, options, {
            objectMode: true,
            read: (size ?:number|undefined) :void => {
                this._pushable = true
                process.nextTick(()  => this._readloop())
            },
        }))
        src.pause()
        this._src = src.on('readable', () :void => {
            this._readable = true
            process.nextTick(()  => this._readloop())
        })
    }
    private _readError(err :Error) {
        this.push(null)
        this._pushable = false
        this._readable = false
        this._frame = undefined
        process.nextTick(() => this.emit('error', err))
    }
    private _readloop() {
        while (this._readable && this._pushable) {
            if (this._frame == null) {
                try {
                    this._frame = FrameReader.readFrame(this._src)
                } catch (err) {
                    this._readError(err)
                    return
                }
            }
            if (this._frame == null) {
                this._readable = false
                return
            }
            switch(this._frame.type) {
            case type.Data:
                this._frame.data = this._src.read(this._frame.length)
                if (this._frame.data == null) {
                    this._readable = false
                    return
                }
                if (this._frame.data.length < this._frame.length) {
                    this.push(this._frame)
                    this._readError(errUnexpectedEOF)
                    return
                }
                // fallthrough
            default:
                this._pushable = this.push(this._frame)
                this._frame = undefined
            }
        }
    }
}

export class FrameWriter extends Writable {
    static frameSize(frame :Frame) :number {
        return (frame.type == type.Data ? headerSize + frame.length : headerSize)
    }

    static encodeFrame(frame :Frame) :Buffer {
        var data = Buffer.alloc(this.frameSize(frame))
        this.writeFrame(frame, data, 0)
        return data
    }

    static writeFrame(frame :Frame, data :Buffer, offset :number) :number {
        data.writeUInt8(frame.version, offset++)
        data.writeUInt8(frame.type, offset++)
        data.writeUInt16BE(frame.flags, offset)
        offset += 2
        data.writeUInt32BE(frame.sid, offset)
        offset += 4
        data.writeInt32BE(frame.length, offset)
        offset += 4
        if (frame.type === type.Data && frame.data != null) {
            offset += frame.data.copy(data, offset, 0, frame.length)
        }
        return offset
    }
    private _dst :Writable
    private _resume :done|undefined
    constructor(dst :Writable, options ?:WritableOptions) {
        super(Object.assign({}, options, {
            objectMode: true,
        }))
        this._dst = dst.on('drain', () :void => {
            if (this._resume == null) {
                return
            }
            process.nextTick(this._resume)
            this._resume = undefined
        }) 
    }
    _write(frame :Frame, enc :string, cb :(err :Error|undefined) => void) :void {
        const data = FrameWriter.encodeFrame(frame)
        this._writeData(data, cb)
    }
    _writev(frames :{chunk: Frame; encoding: string}[], cb :(err :Error|undefined) => void) :void {
        var size = 0 
        for (var i = 0; i < frames.length; i++) {
            size += FrameWriter.frameSize(frames[i].chunk)
        }
        const data = Buffer.alloc(size)
        size = 0
        for (var i = 0; i < frames.length; i++) {
            size += FrameWriter.writeFrame(frames[i].chunk, data, size)
        }
        this._writeData(data, cb)
    }
    private _writeData (data :Buffer, cb :(err :Error|undefined) => void) :void {
        if (this._dst.write(data)) {
            process.nextTick(cb)
            return
        }
        // Wait for drain
        this._resume = cb
    }
}

export const errStreamResetByPeer :Error = new Error("Stream reset by peer")
export const errStreamReset :Error = new Error("Stream reset")
export const errStreamClosed :Error = new Error("Stream closed")
export const errStreamClosedByPeer :Error = new Error("Stream closed by peer")
export const errReceiveWindowExceeded :Error = new Error('Receive window exceeded')
export class Stream extends Duplex {
    private _session :Session
    private _sid :number
    get sid() :number {
        return this._sid
    }
    get isLocal() :boolean {
        return this._session.isLocal(this._sid)
    }
    // Receive state
    private _recvFlags :flag = 0
    private _recvDelta :number
    private _pushable :boolean = false
    private _readable :boolean = false
    // Use a passthrough as a receive buffer to store incoming data
    private _recv :PassThrough
    get recvWindow() :number {
        return this._recv.writableHighWaterMark
    }

    // Send state
    private _sendFlags :flag = 0
    get sendClosed() :boolean {
        return (this._sendFlags&flag.FIN) == flag.FIN
    }
    private _sendWindow :number
    private _resumeSend = nopResume
    private _pendingSend? :Buffer
    constructor(session :Session, id: number) {
        super(Object.assign({
            readableHighWaterMark: session.options.maxWindowSize,
            writableHighWaterMark: initialWindowSize,
            allowHalfOpen: true,
            read: (size ?:number) :void => {
                this._pushable = true
                this._recvloop()
                // process.nextTick(() => this._recvloop(size))
            },
        }))
        this._sid = id
        this._session = session
        this._recvDelta = session.options.maxWindowSize - initialWindowSize
        // Initialize send window
        this._sendWindow = this._recvDelta < 0 ? session.options.maxWindowSize : initialWindowSize
        this._recv = new PassThrough(Object.assign({
            // Set write buffer size to maxWindowSize
            highWaterMark: session.options.maxWindowSize,
        })).on('readable', () => {
            this._readable = true
            this._recvloop()
        }).on('end', () => {
            this.push(null)
        })
    }
    private handleFlags(f :flag) {
        this._recvFlags |= f
        switch (true) {
        case f == 0:
            // nothing to do
            break
        case isOpen(f):
            // state is open
            this.sendWindowUpdate(flag.ACK)
            break
        case isEstablished(f):
            // state is established
            process.nextTick(() => this.emit('yamux_ack'))
            break
        case isClosed(f):
            this._recv.end()
            break
        case isReset(f):
            this.reset(errStreamResetByPeer)
            break
        }
    }
    reset(err ?:Error|undefined) :void {
        if (this.destroy) {
            this.destroy(err)
        } else {
            process.nextTick(() => this.emit('error', err))
            this._destroy(err)
        }

    }
    _destroy(err :Error|undefined) {
        process.nextTick(() => this.emit('yamux_reset', err))
        if (err === errStreamReset) {
            this.sendWindowUpdate(flag.FIN|flag.RST)
        }
        this._recvFlags |= flag.FIN | (err == null ? 0 : flag.RST)
        this._recv.end()
        this._recvFlags |= flag.FIN | (err == null ? 0 : flag.RST)
        this.end()
    }
    pushFrame(f :Frame) :void {
        switch (f.type) {
        case type.WindowUpdate:
            this._sendWindow += f.length
            if (this._sendWindow > 0 && this._pendingSend != null) {
                // Write any leftovers and signal that we're ready to write more
                if (this._pendingSend != null) {
                    const data = this._pendingSend
                    const resume = this._resumeSend
                    this._pendingSend = undefined
                    this._resumeSend = nopResume
                    process.nextTick(() => this._write(data, '', resume))
                }
            }
            break
        case type.Data:
            if (f.data != null && !isClosed(this._recvFlags)) {
                this._recvDelta += f.length
                if (!this._recv.write(f.data)) {
                    this.sendWindowUpdate(flag.RST)
                    this.reset(errReceiveWindowExceeded)
                }
            }
            break
        }
        this.handleFlags(f.flags)
    }
    private _recvloop(size ?:number) {
        while (this._pushable && this._readable) {
            const chunk = this._recv.read(size)
            if (chunk == null) {
                this._readable = false
                return
            }
            this._pushable = this.push(chunk)
            this._recvDelta -= chunk.length
        }
        if (this._pushable) {
            this.sendWindowUpdate(0)
        }
    }

    get windowUpdateThreshold() :number {
        return this._session.options.maxWindowSize / 2
    }

    private _checkReadable(cb :done) :boolean {
        if (isClosed(this._recvFlags)) {
            process.nextTick(() => cb(errStreamClosedByPeer) )
            return false
        }
        if (isReset(this._sendFlags)) {
            process.nextTick(() => cb(errStreamReset) )
            return false
        }
        if (isReset(this._recvFlags)) {
            process.nextTick(() => cb(errStreamResetByPeer) )
            return false
        }
        return true
    }
    private _checkWritable(cb :done) :boolean {
        if (isClosed(this._sendFlags)) {
            process.nextTick(() => cb(errStreamClosed) )
            return false
        }
        if (isReset(this._sendFlags)) {
            process.nextTick(() => cb(errStreamReset) )
            return false
        }
        if (isReset(this._recvFlags)) {
            process.nextTick(() => cb(errStreamResetByPeer) )
            return false
        }
        return true
    }
    sendWindowUpdate(flags :number, cb :(err :Error|undefined) => void = nopResume) :boolean {
        const delta = this._recvDelta
        // Unset already sent flags
        flags &= ~this._sendFlags
        if (flags != 0 || delta < 0 || delta > this.windowUpdateThreshold) {
            this._recvDelta = 0
            this._sendFlags |= flags
            const frame :Frame = {
                version: version,
                type: type.WindowUpdate,
                flags: flags,
                sid: this._sid,
                length: delta,
            }
            if (this._checkWritable(cb)) {
                this._session.writer.write(frame, cb)
                return true
            }
        }
        return false
    }

    _write(chunk :Buffer, encoding :string, cb :(err: Error|undefined) => void) :void {
        if (!this._checkWritable(cb)) {
            return
        }
        if (this._sendWindow < chunk.length) {
            this._pendingSend = chunk.slice(this._sendWindow)
            this._resumeSend = cb
            cb = nopResume
            chunk = chunk.slice(0, this._sendWindow)
            this._sendWindow = 0
        } else {
            this._sendWindow -= chunk.length
            this._pendingSend = undefined
            this._resumeSend = nopResume
        }

        const frame :Frame = {
            version: version,
            type: type.Data,
            flags: 0,
            sid: this._sid,
            length: chunk.length,
            data: chunk,
        }
        // Ignore session writer buffer errors
        this._session.writer.write(frame)
        process.nextTick( () => cb(undefined))
    }
}

export const errGoAway :Error = new Error('Sesion reset by peer')
export class Session extends EventEmitter {
    private _streams :Map<number,Stream>
    private _reader :FrameReader
    private _writer :FrameWriter
    get writer() :FrameWriter {
        return this._writer
    }
    private _options :Options
    get options() :Options {
        return this._options
    }
    private _sock: Duplex
    get socket() :Duplex {
        return this._sock
    }
    private _nextID = 0
    private _client :number = 0
    private _keepalive :NodeJS.Timer|undefined
    get client () :boolean {
        return this._client == 1
    }
    isLocal(sid :number) :boolean {
        return (sid%2) == this._client
    }
    constructor(sock: Duplex, client :boolean = false, options ?:Options|undefined) {
        super()
        this._sock = sock;
        this._streams = new Map<number,Stream>()
        this._pings = new Map<number,(f :Frame) => void>()
        this._options = Object.freeze(Object.assign(defaultOptions(), options))
        if (client) {
            this._client = 1
            this._nextID = 1
        } else {
            this._nextID = 2
        }
        this._writer = new FrameWriter(sock)
        this._reader = new FrameReader(sock)
        this._reader.on('data', this.onFrame.bind(this))
        // Setup keep alive
        if (this._options.keepAliveInterval > 0) {
            this._keepalive = setInterval(() => {
                this.ping(0).catch(err => this.emit('error', err))
            }, this.options.keepAliveInterval)
        }
    }
    private generateSid() :number {
        const id = this._nextID
        this._nextID += 2
        return id
    }
    open() :Stream {
        const sid = this.generateSid()
        const stream = this.newStream(sid)
        stream.sendWindowUpdate(flag.SYN)
        process.nextTick(() => {
            this.emit('open', stream)
        })
        return stream
    }

    private newStream(sid :number) :Stream {
        const stream = new Stream(this, sid)
        this._streams.set(sid, stream)
        stream.on('finish', () =>  this.closeStream(sid) )
        return stream
    }
    private accept(sid :number) :Stream|undefined {
        if (this.isLocal(sid)) {
            process.nextTick(() => {
                this.emit('error', new Error('Invalid accept stream id'))
                this.sendWindowUpdate(sid, 0, flag.RST, nopResume)
            })
            return
        }
        const stream = this.newStream(sid)
        process.nextTick(() => this.emit('accept', stream))
        return stream
    }
    private sendWindowUpdate(sid :number, delta :number, flags :number, cb :(err ?:Error|undefined) => void) :void {
        const f :Frame = {
            version: version,
            sid: sid,
            type: type.WindowUpdate,
            flags: flags,
            length: delta,
        }
        this._writer.write(f, cb)
    }
    private closeStream(sid :number) :void {
        const stream = this._streams.get(sid)
        if (stream == null) {
            return
        }
        this._streams.delete(sid)
        stream.end()
    }
    private frameStream(f :Frame) :Stream|undefined {
        var stream :Stream|undefined
        if ((f.flags&flag.SYN) === flag.SYN) {
            stream = this.accept(f.sid)
        } else {
            stream = this._streams.get(f.sid)
        }
        return stream

    }
    private _closed :boolean|undefined
    private _closedErr :Error|undefined
    close(err ?:Error|undefined) {
        this._close(err)
    }
    private _close(err :Error|undefined) :void {
        if (this._closed) {
            return
        }
        this._closed = true
        this._closedErr = err
        this._streams.forEach((stream, sid, streams) => {
            this.closeStream(sid)
        })
        if (this._keepalive != null) {
            clearInterval(this._keepalive)
        }
        if (err !== errGoAway) {
            this.writer.end({
                version: 0,
                sid: 0,
                type: type.GoAway,
                flags: 0,
                length: 0,
            })
        }
        process.nextTick(() => {
            this.emit('close', err)
        })
    }
    private _pings :Map<number, (f: Frame) => void>
    ping(sid :number) :Promise<void> {
        const now = Date.now()
        return new Promise<void>((resolve, reject) => {
            setTimeout(() => {
                reject(new Error('Ping timeout'))
            }, this._options.keepAliveTimeout)
            this._pings.set(now, (f :Frame) :void => {
                if (f.sid == sid && f.length == now) {
                    resolve()
                } else {
                    reject(new Error('Invalid ping response'))
                }
            })
        })
    }
    private onPing(f :Frame) :void {
        switch (true) {
        case (f.flags&flag.ACK) == flag.ACK:
            const ping = this._pings.get(f.length)
            if (ping != null) {
                this._pings.delete(f.sid)
                ping(f)
            }
            break

        case (f.flags&flag.SYN) == flag.SYN:
            const pong :Frame = {
                version: version,
                type: type.Ping,
                flags: flag.ACK,
                sid: f.sid,
                length: f.length,
            }
            this.writer.write(pong)
            break

        }

    }
    private onFrame(f :Frame) :void {
        switch (f.type) {
        case type.GoAway:
            this._close(errGoAway)
            return
        case type.Ping:
            this.onPing(f)
            return
        case type.WindowUpdate:
        case type.Data:
            const stream = this.frameStream(f)
            if (stream == null) {
                return
            }
            stream.pushFrame(f)
            break
        }
    }
    

}