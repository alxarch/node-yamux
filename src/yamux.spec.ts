import 'mocha'
import * as yamux from './yamux'
import * as net from 'net'
import * as assert from 'assert'
import { Duplex, PassThrough, Transform } from 'stream';
import { read } from 'fs';

        const msg = "Hello World!"
        const frame :yamux.Frame = {
            version: 0,
            type: yamux.type.Data,
            flags: yamux.flag.ACK,
            sid: 42,
            length: Buffer.byteLength(msg),
            data: Buffer.from(msg)
        }

describe('FrameWriter', () => {
    it('should encode frames', () => {
        const data = yamux.FrameWriter.encodeFrame(frame)
        assert.ok(Buffer.compare(data, Buffer.from([
            0,
            yamux.type.Data,
            0, yamux.flag.ACK,
            0, 0, 0, 42,
            0, 0, 0, 12,
            // H e l l o
            72, 101, 108, 108, 111,
            // ' '
            32,
            // W o r l d
            87, 111, 114, 108, 100, 33
        ])) == 0, 'buffer encode')

    })
})
describe('FrameReader', () => {
    it('should read streams of frames', (done) => {
        const echo = new Duplex({read: () => {
            echo.push(yamux.FrameWriter.encodeFrame(frame))
            echo.push(null)
        }})
        const reader = new yamux.FrameReader(echo)
            reader.once('readable', () => {
                const f = reader.read()
                assert.equal(f.version, frame.version, "Frames match version")
                assert.equal(f.type, frame.type, "Frames match type")
                assert.equal(f.flags, frame.flags, "Frames match flags")
                assert.equal(f.sid, frame.sid, "Frames match sid")
                assert.equal(f.length, 12, "Frames match length")
                assert.ok(frame.data && Buffer.compare(f.data, frame.data) == 0, "Frames match data")
                done()
            })

    })
})
function sockpair() {
    var a :any, b :any

    a = new Duplex({
        read: () => {},
        write: (chunk, enc, cb) => {
            b.push(chunk)
            cb()
        },
    })
    b = new Duplex({
        read: () => {},
        write: (chunk, enc, cb) => {
            a.push(chunk)
            cb()
        }
    })
    return [a, b]


} 
describe('Session', () => {
    it('should open a stream', (done) => {
        var [sockA, sockB] = sockpair()
        const session = new yamux.Session(sockA, false, yamux.defaultOptions())
        const client = new yamux.Session(sockB, true, yamux.defaultOptions({
            maxWindowSize: 4096,
        }))
        client.on('error', console.error)
        session.on('error', console.error)
        const stream = client.open()
        stream.on('data', (msg) => {
            assert.equal('Hello World!', msg.toString())
            client.close()
        })
        session.on('close', (err) => {
            session.close()
            done()
        })
        session.on('accept', (stream :yamux.Stream) => {
            stream.write(msg)
        })

    })
})