# node-yamux
Stream multiplexer compatible wtih Hashicorp's [`yamux`](https://github.com/hashicorp/yamux)  

## Usage

```js
const session = new yamux.Session(sock)
const s = session.open()
// s is a stream.Duplex
s.write('Hello yamux')
s.end()
session.close()
```

Status: *WIP*