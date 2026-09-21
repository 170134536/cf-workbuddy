#!/usr/bin/env node
/**
 * Compare the custom IP against the standard Cloudflare path.
 *
 * Prints the TLS peer certificate issuer and the response headers, which is
 * what actually distinguishes a Cloudflare edge from a third-party relay.
 * Timing is deliberately not compared: FlClash runs in TUN mode here, so all
 * traffic is intercepted at the network layer and any latency reading is
 * meaningless.
 */

import tls from 'node:tls';
import https from 'node:https';

const HOST = 'kz007.ccwu.cc';

function probe(label, address) {
  return new Promise((resolve) => {
    console.log('\n=== ' + label + ' ===');
    console.log('  connecting to ' + (address || '(system DNS)'));

    const opts = {
      host: address || HOST,
      servername: HOST,          // SNI must stay the hostname
      port: 443,
      path: '/admin',
      method: 'GET',
      rejectUnauthorized: false, // inspect the cert even if untrusted
      timeout: 25000,
      headers: { 'User-Agent': 'probe/1.0', Host: HOST },
    };

    const t0 = Date.now();
    const req = https.request(opts, (res) => {
      const sock = res.socket;
      const cert = sock.getPeerCertificate();
      const remote = sock.remoteAddress;

      console.log('  HTTP ' + res.statusCode + '   ' + (Date.now() - t0) + ' ms');
      console.log('  remoteAddress : ' + remote);
      console.log('  cert issuer   : ' + (cert && cert.issuer ? JSON.stringify(cert.issuer.O || cert.issuer.CN) : '?'));
      console.log('  cert subject  : ' + (cert && cert.subject ? JSON.stringify(cert.subject.CN) : '?'));
      console.log('  cert altnames : ' + ((cert && cert.subjectaltname) || '').slice(0, 120));
      console.log('  TLS protocol  : ' + sock.getProtocol());
      console.log('  ALPN          : ' + (sock.alpnProtocol || '(none)'));

      const interesting = ['server', 'cf-ray', 'cf-cache-status', 'date', 'content-type', 'nel', 'report-to', 'alt-svc', 'x-served-by', 'via'];
      console.log('  --- headers ---');
      for (const k of interesting) {
        if (res.headers[k]) console.log('    ' + k + ': ' + String(res.headers[k]).slice(0, 90));
      }
      const all = Object.keys(res.headers);
      const hasCf = all.some((h) => h.startsWith('cf-')) || res.headers.server === 'cloudflare';
      console.log('  >>> looks like Cloudflare edge: ' + (hasCf ? 'YES' : 'NO'));

      res.resume();
      res.on('end', () => resolve({ cf: hasCf, remote }));
    });

    req.on('timeout', () => { console.log('  TIMEOUT'); req.destroy(); resolve({ cf: null }); });
    req.on('error', (e) => { console.log('  ERROR: ' + e.message); resolve({ cf: null }); });
    req.end();
  });
}

const a = await probe('official DNS resolution', null);
const b = await probe('via 8.134.218.35', '8.134.218.35');

console.log('\n--- verdict ---');
console.log('  official path is CF edge : ' + a.cf);
console.log('  custom IP is CF edge     : ' + b.cf);
