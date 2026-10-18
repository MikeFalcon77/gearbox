'use strict';
const net = require('node:net');
// One fixed local demo target, on the host actually running its commands.
// Keep receipt files as history only; PID reuse and disk-full writes cannot
// create an unbreakable or stolen process lock.
async function acquire(port = 49673) {
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(Error(error.code === 'EADDRINUSE'
      ? 'A demo operation is already running (local mutex is busy); check status'
      : 'Cannot acquire the local demo mutex: ' + error.code)));
    server.listen({host: '127.0.0.1', port, exclusive: true}, resolve);
  });
  return {close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), port: server.address().port};
}
module.exports = {acquire};
