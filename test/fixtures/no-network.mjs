// Preloaded into a CLI run: any attempt at a socket, a DNS lookup or a fetch writes the canary and fails.
import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const canary = process.env.KEEPUP_NETWORK_CANARY;
const trip = (what) => () => {
  appendFileSync(canary, `${what}\n`);
  throw new Error(`no network allowed: ${what}`);
};
net.Socket.prototype.connect = trip('socket');
tls.connect = trip('tls');
dns.lookup = trip('dns');
http.request = trip('http');
https.request = trip('https');
globalThis.fetch = trip('fetch');
