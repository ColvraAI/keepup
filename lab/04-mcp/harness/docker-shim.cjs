'use strict';
// The `docker` command inside the sandbox. It hands the example's exact command line to
// lib/bridge.ts on the host, which runs real Docker, then pipes stdin and stdout through,
// so AURA and the MCP client see what `docker run -i` would give them.
const net = require('node:net');

const FAILED = 125;

function fail(message) {
  process.stderr.write(`docker shim: ${message}\n`);
  process.exit(FAILED);
}

/** The value of each `-e NAME`, which real Docker would read from this process's environment. */
function envValues(argv) {
  const pairs = argv.flatMap((arg, i) => (arg === '-e' && argv[i + 1] ? [[argv[i + 1], process.env[argv[i + 1]] ?? '']] : []));
  return Object.fromEntries(pairs);
}

function pipeBoth(socket, rest) {
  if (rest.length) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
}

function main() {
  const address = process.env.BRIDGE_ADDR;
  if (!address) fail('BRIDGE_ADDR is not set, so there is no bridge to real Docker');
  const separator = address.lastIndexOf(':');
  const argv = process.argv.slice(2);
  const socket = net.connect(Number(address.slice(separator + 1)), address.slice(0, separator));
  socket.on('error', (error) => fail(`could not reach the bridge: ${error.message}`));
  socket.write(`${JSON.stringify({ token: process.env.BRIDGE_TOKEN, argv, env: envValues(argv) })}\n`);
  let buffered = Buffer.alloc(0);
  const onHandshake = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf(10);
    if (end < 0) return;
    socket.off('data', onHandshake);
    const line = buffered.subarray(0, end).toString();
    if (line !== 'ok') fail(line);
    pipeBoth(socket, buffered.subarray(end + 1));
  };
  socket.on('data', onHandshake);
  socket.on('close', () => process.exit(0));
}

main();
