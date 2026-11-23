import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { lanInterfaces } from '../apps/desktop/src/core/remote-host';
test('Wi-Fi is recommended before VMware; tunnel benchmark addresses are not paired', t => {
  const row = (address: string) => ({ address, family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null });
  t.mock.method(os, 'networkInterfaces', () => ({ 'VMware Network Adapter VMnet1': [row('192.168.137.1')], Mihomo: [row('198.18.0.1')], WLAN: [row('192.168.1.5')] }) as any);
  assert.deepEqual(lanInterfaces().map(r => r.address), ['192.168.1.5', '192.168.137.1']);
});
