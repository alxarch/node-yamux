"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
exports.__esModule = true;
var stream_1 = require("stream");
var events_1 = require("events");
function defaultOptions(options) {
    return Object.assign({
        keepAliveInterval: 30 * 1000,
        keepAliveTimeout: 10 * 1000
    }, options, {
        maxWindowSize: (options && options.maxWindowSize > exports.initialWindowSize) ? options.maxWindowSize : exports.initialWindowSize
    });
}
exports.defaultOptions = defaultOptions;
var nopResume = function (err) { };
exports.version = 0;
var headerSize = 12;
exports.initialWindowSize = 256 * 1024;
exports.errUnexpectedEOF = new Error('Unexpected EOF');
var type;
(function (type) {
    type[type["Data"] = 0] = "Data";
    type[type["WindowUpdate"] = 1] = "WindowUpdate";
    type[type["Ping"] = 2] = "Ping";
    type[type["GoAway"] = 3] = "GoAway";
})(type = exports.type || (exports.type = {}));
var flag;
(function (flag) {
    flag[flag["SYN"] = 1] = "SYN";
    flag[flag["ACK"] = 2] = "ACK";
    flag[flag["FIN"] = 4] = "FIN";
    flag[flag["RST"] = 8] = "RST";
})(flag = exports.flag || (exports.flag = {}));
function isClosed(f) {
    return (f & flag.FIN) == flag.FIN;
}
exports.isClosed = isClosed;
function isReset(f) {
    return (f & flag.RST) == flag.RST;
}
exports.isReset = isReset;
function isEstablished(f) {
    return (f & flag.ACK) == flag.ACK;
}
exports.isEstablished = isEstablished;
function isOpen(f) {
    return (f & flag.SYN) == flag.SYN;
}
exports.isOpen = isOpen;
var FrameReader = /** @class */ (function (_super) {
    __extends(FrameReader, _super);
    function FrameReader(src, options) {
        var _this = _super.call(this, Object.assign({}, options, {
            objectMode: true,
            read: function (size) {
                _this._pushable = true;
                process.nextTick(function () { return _this._readloop(); });
            }
        })) || this;
        src.pause();
        _this._src = src.on('readable', function () {
            _this._readable = true;
            process.nextTick(function () { return _this._readloop(); });
        });
        return _this;
    }
    FrameReader.readFrame = function (src) {
        var h = src.read(headerSize);
        if (h == null) {
            return undefined;
        }
        if (h.length < headerSize) {
            throw exports.errUnexpectedEOF;
        }
        var frame = {
            version: h.readUInt8(0, true),
            type: h.readUInt8(1, true),
            flags: h.readUInt16BE(2, true),
            sid: h.readUInt32BE(4, true),
            length: h.readInt32BE(8, true)
        };
        if (frame.version != exports.version) {
            throw new Error('Invalid frame version ' + frame.version);
        }
        return frame;
    };
    FrameReader.prototype._readError = function (err) {
        var _this = this;
        this.push(null);
        this._pushable = false;
        this._readable = false;
        this._frame = undefined;
        process.nextTick(function () { return _this.emit('error', err); });
    };
    FrameReader.prototype._readloop = function () {
        while (this._readable && this._pushable) {
            if (this._frame == null) {
                try {
                    this._frame = FrameReader.readFrame(this._src);
                }
                catch (err) {
                    this._readError(err);
                    return;
                }
            }
            if (this._frame == null) {
                this._readable = false;
                return;
            }
            switch (this._frame.type) {
                case type.Data:
                    this._frame.data = this._src.read(this._frame.length);
                    if (this._frame.data == null) {
                        this._readable = false;
                        return;
                    }
                    if (this._frame.data.length < this._frame.length) {
                        this.push(this._frame);
                        this._readError(exports.errUnexpectedEOF);
                        return;
                    }
                // fallthrough
                default:
                    this._pushable = this.push(this._frame);
                    this._frame = undefined;
            }
        }
    };
    return FrameReader;
}(stream_1.Readable));
exports.FrameReader = FrameReader;
var FrameWriter = /** @class */ (function (_super) {
    __extends(FrameWriter, _super);
    function FrameWriter(dst, options) {
        var _this = _super.call(this, Object.assign({}, options, {
            objectMode: true
        })) || this;
        _this._dst = dst.on('drain', function () {
            if (_this._resume == null) {
                return;
            }
            process.nextTick(_this._resume);
            _this._resume = undefined;
        });
        return _this;
    }
    FrameWriter.frameSize = function (frame) {
        return (frame.type == type.Data ? headerSize + frame.length : headerSize);
    };
    FrameWriter.encodeFrame = function (frame) {
        var data = Buffer.alloc(this.frameSize(frame));
        this.writeFrame(frame, data, 0);
        return data;
    };
    FrameWriter.writeFrame = function (frame, data, offset) {
        data.writeUInt8(frame.version, offset++);
        data.writeUInt8(frame.type, offset++);
        data.writeUInt16BE(frame.flags, offset);
        offset += 2;
        data.writeUInt32BE(frame.sid, offset);
        offset += 4;
        data.writeInt32BE(frame.length, offset);
        offset += 4;
        if (frame.type === type.Data && frame.data != null) {
            offset += frame.data.copy(data, offset, 0, frame.length);
        }
        return offset;
    };
    FrameWriter.prototype._write = function (frame, enc, cb) {
        var data = FrameWriter.encodeFrame(frame);
        this._writeData(data, cb);
    };
    FrameWriter.prototype._writev = function (frames, cb) {
        var size = 0;
        for (var i = 0; i < frames.length; i++) {
            size += FrameWriter.frameSize(frames[i].chunk);
        }
        var data = Buffer.alloc(size);
        size = 0;
        for (var i = 0; i < frames.length; i++) {
            size += FrameWriter.writeFrame(frames[i].chunk, data, size);
        }
        this._writeData(data, cb);
    };
    FrameWriter.prototype._writeData = function (data, cb) {
        if (this._dst.write(data)) {
            process.nextTick(cb);
            return;
        }
        // Wait for drain
        this._resume = cb;
    };
    return FrameWriter;
}(stream_1.Writable));
exports.FrameWriter = FrameWriter;
exports.errStreamResetByPeer = new Error("Stream reset by peer");
exports.errStreamReset = new Error("Stream reset");
exports.errStreamClosed = new Error("Stream closed");
exports.errStreamClosedByPeer = new Error("Stream closed by peer");
exports.errReceiveWindowExceeded = new Error('Receive window exceeded');
var Stream = /** @class */ (function (_super) {
    __extends(Stream, _super);
    function Stream(session, id) {
        var _this = _super.call(this, Object.assign({
            readableHighWaterMark: session.options.maxWindowSize,
            writableHighWaterMark: exports.initialWindowSize,
            allowHalfOpen: true,
            read: function (size) {
                _this._pushable = true;
                _this._recvloop();
                // process.nextTick(() => this._recvloop(size))
            }
        })) || this;
        // Receive state
        _this._recvFlags = 0;
        _this._pushable = false;
        _this._readable = false;
        // Send state
        _this._sendFlags = 0;
        _this._resumeSend = nopResume;
        _this._sid = id;
        _this._session = session;
        _this._recvDelta = session.options.maxWindowSize - exports.initialWindowSize;
        // Initialize send window
        _this._sendWindow = _this._recvDelta < 0 ? session.options.maxWindowSize : exports.initialWindowSize;
        _this._recv = new stream_1.PassThrough(Object.assign({
            // Set write buffer size to maxWindowSize
            highWaterMark: session.options.maxWindowSize
        })).on('readable', function () {
            _this._readable = true;
            _this._recvloop();
        }).on('end', function () {
            _this.push(null);
        });
        return _this;
    }
    Object.defineProperty(Stream.prototype, "sid", {
        get: function () {
            return this._sid;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(Stream.prototype, "isLocal", {
        get: function () {
            return this._session.isLocal(this._sid);
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(Stream.prototype, "recvWindow", {
        get: function () {
            return this._recv.writableHighWaterMark;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(Stream.prototype, "sendClosed", {
        get: function () {
            return (this._sendFlags & flag.FIN) == flag.FIN;
        },
        enumerable: true,
        configurable: true
    });
    Stream.prototype.handleFlags = function (f) {
        var _this = this;
        this._recvFlags |= f;
        switch (true) {
            case f == 0:
                // nothing to do
                break;
            case isOpen(f):
                // state is open
                this.sendWindowUpdate(flag.ACK);
                break;
            case isEstablished(f):
                // state is established
                process.nextTick(function () { return _this.emit('yamux_ack'); });
                break;
            case isClosed(f):
                this._recv.end();
                break;
            case isReset(f):
                this.reset(exports.errStreamResetByPeer);
                break;
        }
    };
    Stream.prototype.reset = function (err) {
        var _this = this;
        if (this.destroy) {
            this.destroy(err);
        }
        else {
            process.nextTick(function () { return _this.emit('error', err); });
            this._destroy(err);
        }
    };
    Stream.prototype._destroy = function (err) {
        var _this = this;
        process.nextTick(function () { return _this.emit('yamux_reset', err); });
        if (err === exports.errStreamReset) {
            this.sendWindowUpdate(flag.FIN | flag.RST);
        }
        this._recvFlags |= flag.FIN | (err == null ? 0 : flag.RST);
        this._recv.end();
        this._recvFlags |= flag.FIN | (err == null ? 0 : flag.RST);
        this.end();
    };
    Stream.prototype.pushFrame = function (f) {
        var _this = this;
        switch (f.type) {
            case type.WindowUpdate:
                this._sendWindow += f.length;
                if (this._sendWindow > 0 && this._pendingSend != null) {
                    // Write any leftovers and signal that we're ready to write more
                    if (this._pendingSend != null) {
                        var data_1 = this._pendingSend;
                        var resume_1 = this._resumeSend;
                        this._pendingSend = undefined;
                        this._resumeSend = nopResume;
                        process.nextTick(function () { return _this._write(data_1, '', resume_1); });
                    }
                }
                break;
            case type.Data:
                if (f.data != null && !isClosed(this._recvFlags)) {
                    this._recvDelta += f.length;
                    if (!this._recv.write(f.data)) {
                        this.sendWindowUpdate(flag.RST);
                        this.reset(exports.errReceiveWindowExceeded);
                    }
                }
                break;
        }
        this.handleFlags(f.flags);
    };
    Stream.prototype._recvloop = function (size) {
        while (this._pushable && this._readable) {
            var chunk = this._recv.read(size);
            if (chunk == null) {
                this._readable = false;
                return;
            }
            this._pushable = this.push(chunk);
            this._recvDelta -= chunk.length;
        }
        if (this._pushable) {
            this.sendWindowUpdate(0);
        }
    };
    Object.defineProperty(Stream.prototype, "windowUpdateThreshold", {
        get: function () {
            return this._session.options.maxWindowSize / 2;
        },
        enumerable: true,
        configurable: true
    });
    Stream.prototype._checkReadable = function (cb) {
        if (isClosed(this._recvFlags)) {
            process.nextTick(function () { return cb(exports.errStreamClosedByPeer); });
            return false;
        }
        if (isReset(this._sendFlags)) {
            process.nextTick(function () { return cb(exports.errStreamReset); });
            return false;
        }
        if (isReset(this._recvFlags)) {
            process.nextTick(function () { return cb(exports.errStreamResetByPeer); });
            return false;
        }
        return true;
    };
    Stream.prototype._checkWritable = function (cb) {
        if (isClosed(this._sendFlags)) {
            process.nextTick(function () { return cb(exports.errStreamClosed); });
            return false;
        }
        if (isReset(this._sendFlags)) {
            process.nextTick(function () { return cb(exports.errStreamReset); });
            return false;
        }
        if (isReset(this._recvFlags)) {
            process.nextTick(function () { return cb(exports.errStreamResetByPeer); });
            return false;
        }
        return true;
    };
    Stream.prototype.sendWindowUpdate = function (flags, cb) {
        if (cb === void 0) { cb = nopResume; }
        var delta = this._recvDelta;
        // Unset already sent flags
        flags &= ~this._sendFlags;
        if (flags != 0 || delta < 0 || delta > this.windowUpdateThreshold) {
            this._recvDelta = 0;
            this._sendFlags |= flags;
            var frame = {
                version: exports.version,
                type: type.WindowUpdate,
                flags: flags,
                sid: this._sid,
                length: delta
            };
            if (this._checkWritable(cb)) {
                this._session.writer.write(frame, cb);
                return true;
            }
        }
        return false;
    };
    Stream.prototype._write = function (chunk, encoding, cb) {
        if (!this._checkWritable(cb)) {
            return;
        }
        if (this._sendWindow < chunk.length) {
            this._pendingSend = chunk.slice(this._sendWindow);
            this._resumeSend = cb;
            cb = nopResume;
            chunk = chunk.slice(0, this._sendWindow);
            this._sendWindow = 0;
        }
        else {
            this._sendWindow -= chunk.length;
            this._pendingSend = undefined;
            this._resumeSend = nopResume;
        }
        var frame = {
            version: exports.version,
            type: type.Data,
            flags: 0,
            sid: this._sid,
            length: chunk.length,
            data: chunk
        };
        // Ignore session writer buffer errors
        this._session.writer.write(frame);
        process.nextTick(function () { return cb(undefined); });
    };
    return Stream;
}(stream_1.Duplex));
exports.Stream = Stream;
exports.errGoAway = new Error('Sesion reset by peer');
var Session = /** @class */ (function (_super) {
    __extends(Session, _super);
    function Session(sock, client, options) {
        if (client === void 0) { client = false; }
        var _this = _super.call(this) || this;
        _this._nextID = 0;
        _this._client = 0;
        _this._sock = sock;
        _this._streams = new Map();
        _this._pings = new Map();
        _this._options = Object.freeze(Object.assign(defaultOptions(), options));
        if (client) {
            _this._client = 1;
            _this._nextID = 1;
        }
        else {
            _this._nextID = 2;
        }
        _this._writer = new FrameWriter(sock);
        _this._reader = new FrameReader(sock);
        _this._reader.on('data', _this.onFrame.bind(_this));
        // Setup keep alive
        if (_this._options.keepAliveInterval > 0) {
            _this._keepalive = setInterval(function () {
                _this.ping(0)["catch"](function (err) { return _this.emit('error', err); });
            }, _this.options.keepAliveInterval);
        }
        return _this;
    }
    Object.defineProperty(Session.prototype, "writer", {
        get: function () {
            return this._writer;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(Session.prototype, "options", {
        get: function () {
            return this._options;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(Session.prototype, "socket", {
        get: function () {
            return this._sock;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(Session.prototype, "client", {
        get: function () {
            return this._client == 1;
        },
        enumerable: true,
        configurable: true
    });
    Session.prototype.isLocal = function (sid) {
        return (sid % 2) == this._client;
    };
    Session.prototype.generateSid = function () {
        var id = this._nextID;
        this._nextID += 2;
        return id;
    };
    Session.prototype.open = function () {
        var _this = this;
        var sid = this.generateSid();
        var stream = this.newStream(sid);
        stream.sendWindowUpdate(flag.SYN);
        process.nextTick(function () {
            _this.emit('open', stream);
        });
        return stream;
    };
    Session.prototype.newStream = function (sid) {
        var _this = this;
        var stream = new Stream(this, sid);
        this._streams.set(sid, stream);
        stream.on('finish', function () { return _this.closeStream(sid); });
        return stream;
    };
    Session.prototype.accept = function (sid) {
        var _this = this;
        if (this.isLocal(sid)) {
            process.nextTick(function () {
                _this.emit('error', new Error('Invalid accept stream id'));
                _this.sendWindowUpdate(sid, 0, flag.RST, nopResume);
            });
            return;
        }
        var stream = this.newStream(sid);
        process.nextTick(function () { return _this.emit('accept', stream); });
        return stream;
    };
    Session.prototype.sendWindowUpdate = function (sid, delta, flags, cb) {
        var f = {
            version: exports.version,
            sid: sid,
            type: type.WindowUpdate,
            flags: flags,
            length: delta
        };
        this._writer.write(f, cb);
    };
    Session.prototype.closeStream = function (sid) {
        var stream = this._streams.get(sid);
        if (stream == null) {
            return;
        }
        this._streams["delete"](sid);
        stream.end();
    };
    Session.prototype.frameStream = function (f) {
        var stream;
        if ((f.flags & flag.SYN) === flag.SYN) {
            stream = this.accept(f.sid);
        }
        else {
            stream = this._streams.get(f.sid);
        }
        return stream;
    };
    Session.prototype.close = function (err) {
        this._close(err);
    };
    Session.prototype._close = function (err) {
        var _this = this;
        if (this._closed) {
            return;
        }
        this._closed = true;
        this._closedErr = err;
        this._streams.forEach(function (stream, sid, streams) {
            _this.closeStream(sid);
        });
        if (this._keepalive != null) {
            clearInterval(this._keepalive);
        }
        if (err !== exports.errGoAway) {
            this.writer.end({
                version: 0,
                sid: 0,
                type: type.GoAway,
                flags: 0,
                length: 0
            });
        }
        process.nextTick(function () {
            _this.emit('close', err);
        });
    };
    Session.prototype.ping = function (sid) {
        var _this = this;
        var now = Date.now();
        return new Promise(function (resolve, reject) {
            setTimeout(function () {
                reject(new Error('Ping timeout'));
            }, _this._options.keepAliveTimeout);
            _this._pings.set(now, function (f) {
                if (f.sid == sid && f.length == now) {
                    resolve();
                }
                else {
                    reject(new Error('Invalid ping response'));
                }
            });
        });
    };
    Session.prototype.onPing = function (f) {
        switch (true) {
            case (f.flags & flag.ACK) == flag.ACK:
                var ping = this._pings.get(f.length);
                if (ping != null) {
                    this._pings["delete"](f.sid);
                    ping(f);
                }
                break;
            case (f.flags & flag.SYN) == flag.SYN:
                var pong = {
                    version: exports.version,
                    type: type.Ping,
                    flags: flag.ACK,
                    sid: f.sid,
                    length: f.length
                };
                this.writer.write(pong);
                break;
        }
    };
    Session.prototype.onFrame = function (f) {
        switch (f.type) {
            case type.GoAway:
                this._close(exports.errGoAway);
                return;
            case type.Ping:
                this.onPing(f);
                return;
            case type.WindowUpdate:
            case type.Data:
                var stream = this.frameStream(f);
                if (stream == null) {
                    return;
                }
                stream.pushFrame(f);
                break;
        }
    };
    return Session;
}(events_1.EventEmitter));
exports.Session = Session;
